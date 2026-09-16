"""Credential safety checks using synthetic data and a loopback HTTP server only."""
import contextlib
import importlib.util
import io
import os
from pathlib import Path
import stat
import subprocess
import sys
import tempfile
import threading
import unittest
import urllib.error
import urllib.request
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from unittest.mock import patch


ROOT = Path(__file__).resolve().parents[1]
TOKEN = 'synthetic_migration_token_for_safety_tests_only'


def load_tool(name, filename):
    spec = importlib.util.spec_from_file_location(name, ROOT / 'cloudflare' / 'tools' / filename)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module


migration = load_tool('migration_security_test', 'migrate.py')
wrapper = load_tool('wrangler_security_test', 'run-wrangler.py')


class ToolSecurityTests(unittest.TestCase):
    def test_rejects_http_credentials_paths_queries_fragments(self):
        for origin in [
            'http://example.test', 'https://user:synthetic@example.test',
            'https://example.test/path', 'https://example.test/?secret=synthetic',
            'https://example.test/#synthetic', 'https://example.test?',
            'https://example.test#', 'https://example.test\n',
            'https://example.test:bad', 'https://example.test:65536',
        ]:
            with self.subTest(origin=origin), self.assertRaises(migration.MigrationError):
                migration.validate_origin(origin)

    def test_normalizes_https_origin(self):
        self.assertEqual(migration.validate_origin('https://EXAMPLE.test:443/'), 'https://example.test')
        self.assertEqual(migration.validate_origin('https://example.test:8443'), 'https://example.test:8443')

    def test_migration_token_format_validated_before_requests(self):
        with self.assertRaises(migration.MigrationError):
            migration.MigrationClient('https://example.test', 'unsafe\r\ntoken')

    def test_no_redirect_for_secret_headers(self):
        seen = []

        class Handler(BaseHTTPRequestHandler):
            def log_message(self, *_args):
                pass

            def do_GET(self):
                seen.append(self.path)
                if self.path.startswith('/redirect/'):
                    self.send_response(int(self.path.rsplit('/', 1)[1]))
                    self.send_header('Location', '/secret-destination')
                    self.end_headers()
                else:
                    self.send_response(200)
                    self.end_headers()

        server = ThreadingHTTPServer(('127.0.0.1', 0), Handler)
        thread = threading.Thread(target=server.serve_forever, daemon=True)
        thread.start()
        try:
            opener = urllib.request.build_opener(migration.NoRedirect())
            for code in [301, 302, 303, 307, 308]:
                request = urllib.request.Request(
                    f'http://127.0.0.1:{server.server_port}/redirect/{code}',
                    headers={'x-model-lab-migration': TOKEN},
                )
                with self.assertRaises(urllib.error.HTTPError) as caught:
                    opener.open(request, timeout=5)
                self.assertEqual(caught.exception.code, code)
                caught.exception.close()
            self.assertNotIn('/secret-destination', seen)
        finally:
            server.shutdown()
            thread.join()
            server.server_close()

    def test_private_header_excluded_for_public_readback(self):
        client = migration.MigrationClient('https://example.test', TOKEN)
        seen = []

        def respond(request, timeout):
            self.assertEqual(timeout, 60)
            seen.append(request)
            return io.BytesIO(b'{"ok":true}')

        with patch.object(client.opener, 'open', side_effect=respond):
            self.assertEqual(client.call('/api/_migration/status'), {'ok': True})
            self.assertEqual(client.call('/api/public/runs/test', private=False), {'ok': True})
        self.assertEqual(seen[0].get_header('X-model-lab-migration'), TOKEN)
        self.assertIsNone(seen[1].get_header('X-model-lab-migration'))

    def test_http_errors_do_not_expose_body_or_redirect_destination(self):
        client = migration.MigrationClient('https://example.test', TOKEN)
        error = urllib.error.HTTPError(
            'https://example.test/' + TOKEN, 302, TOKEN,
            {'Location': 'https://attacker.invalid/' + TOKEN}, io.BytesIO(TOKEN.encode()),
        )
        with patch.object(client.opener, 'open', side_effect=error), self.assertRaises(migration.MigrationError) as caught:
            client.call('/api/_migration/status')
        self.assertNotIn(TOKEN, str(caught.exception))
        self.assertNotIn('attacker', str(caught.exception))

    def test_invalid_json_does_not_expose_payload(self):
        client = migration.MigrationClient('https://example.test', TOKEN)
        with patch.object(client.opener, 'open', return_value=io.BytesIO(TOKEN.encode())), self.assertRaises(migration.MigrationError) as caught:
            client.call('/api/_migration/status')
        self.assertNotIn(TOKEN, str(caught.exception))

    def test_wrapper_token_readonly_logs_redacted_and_hardened(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'token.txt'
            path.write_text(TOKEN)
            path.chmod(0o400)
            before = path.stat()
            seen = []
            other = 'synthetic_admin_token_value_12345'

            def run(command, **kwargs):
                seen.append((command, kwargs))
                return subprocess.CompletedProcess(command, 0, stdout=TOKEN + ' ' + other, stderr=TOKEN)

            argv = ['run-wrangler.py', '--token-file', str(path), '--account-id', 'a' * 32, '--', 'deploy']
            environment = {
                'ADMIN_TOKEN': other, 'CF_API_BASE_URL': 'https://attacker.invalid',
                'WRANGLER_LOG_SANITIZE': 'false', 'WRANGLER_WRITE_LOGS': 'true',
            }
            with patch.object(sys, 'argv', argv), patch.dict(os.environ, environment, clear=True), \
                    patch.object(wrapper.subprocess, 'run', side_effect=run), \
                    contextlib.redirect_stdout(io.StringIO()) as out, contextlib.redirect_stderr(io.StringIO()) as err:
                self.assertEqual(wrapper.main(), 0)
            self.assertNotIn(TOKEN, out.getvalue() + err.getvalue())
            self.assertNotIn(other, out.getvalue() + err.getvalue())
            self.assertEqual(path.read_text(), TOKEN)
            self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o400)
            self.assertEqual(path.stat().st_mtime_ns, before.st_mtime_ns)
            command, options = seen[0]
            self.assertNotIn(TOKEN, ' '.join(command))
            self.assertNotIn('CF_API_BASE_URL', options['env'])
            self.assertEqual(options['env']['WRANGLER_LOG_SANITIZE'], 'true')
            self.assertEqual(options['env']['WRANGLER_WRITE_LOGS'], 'false')

    def test_wrapper_rejects_secret_in_arguments(self):
        with tempfile.TemporaryDirectory() as directory:
            path = Path(directory) / 'token.txt'
            path.write_text(TOKEN)
            argv = ['tool', '--token-file', str(path), '--account-id', 'a' * 32, '--', 'deploy', TOKEN]
            with patch.object(sys, 'argv', argv), patch.dict(os.environ, {}, clear=True), self.assertRaises(SystemExit):
                wrapper.main()

    def test_cli_errors_are_sanitized(self):
        result = subprocess.run([
            sys.executable, str(ROOT / 'cloudflare/tools/migrate.py'), '--origin',
            'http://invalid.test/' + TOKEN, '--backup', 'does-not-exist',
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn(TOKEN, result.stdout + result.stderr)
        self.assertNotIn('Traceback', result.stderr)
        result = subprocess.run([
            sys.executable, str(ROOT / 'cloudflare/tools/run-wrangler.py'), '--token-file',
            'does-not-exist', '--account-id', 'a' * 32, '--', 'deploy',
        ], capture_output=True, text=True)
        self.assertEqual(result.returncode, 1)
        self.assertNotIn('Traceback', result.stderr)


if __name__ == '__main__':
    unittest.main()
