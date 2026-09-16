"""Offline installer boundary tests. No real Cloudflare calls or application calls."""
import base64
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import stat
import tempfile
import unittest
from unittest.mock import patch

MODULE = Path(__file__).resolve().parents[1] / 'cloudflare/tools/deploy.py'
spec = importlib.util.spec_from_file_location('model_lab_deploy', MODULE)
deploy = importlib.util.module_from_spec(spec)
spec.loader.exec_module(deploy)


class InstallerTests(unittest.TestCase):
    def setUp(self):
        self.directory = tempfile.TemporaryDirectory()
        self.root = Path(self.directory.name)
        self.state = {'version': 1, 'name': 'test-lab', 'accountId': '1' * 32,
                      'deploymentId': '2' * 32, 'origin': 'https://test-lab.test-account.workers.dev', 'phase': 'prepared'}
        self.credentials = {'ADMIN_TOKEN': 'a' * 43, 'ENCRYPTION_KEY': base64.b64encode(bytes(32)).decode()}

    def tearDown(self):
        self.directory.cleanup()

    def test_token_file_read_only_and_bom_supported(self):
        path = self.root / 'token.txt'
        path.write_text('\ufeff' + 'T' * 40 + '\n')
        path.chmod(0o400)
        before = path.read_bytes(), path.stat().st_mode
        self.assertEqual(deploy.token_from(path), 'T' * 40)
        self.assertEqual((path.read_bytes(), path.stat().st_mode), before)

    def test_malformed_token_never_in_exception(self):
        path = self.root / 'token.txt'
        path.write_text('PRIVATE TOKEN CONTENT')
        with self.assertRaises(deploy.DeploymentError) as caught:
            deploy.token_from(path)
        self.assertNotIn('PRIVATE TOKEN CONTENT', str(caught.exception))

    def test_token_environment_supported(self):
        with patch.dict(os.environ, {'CLOUDFLARE_API_TOKEN': 'T' * 40}):
            self.assertEqual(deploy.token_from(), 'T' * 40)

    def test_name_rejects_paths_shell_and_invalid_hostname(self):
        for name in ('../existing', 'existing;command', 'UPPER', '-lab', 'lab-', 'a' * 64, 'a.example'):
            with self.assertRaises(deploy.DeploymentError):
                deploy.worker_name(name)
        for name in ('a', 'model-lab-test', 'a' * 63):
            self.assertEqual(deploy.worker_name(name), name)

    def test_private_files_no_overwrite_or_symlink_following(self):
        path = self.root / 'secret'
        deploy.private_write(path, 'first', exclusive=True)
        self.assertEqual(stat.S_IMODE(path.stat().st_mode), 0o600)
        with self.assertRaises(FileExistsError):
            deploy.private_write(path, 'second', exclusive=True)
        self.assertEqual(path.read_text(), 'first')
        link = self.root / 'link'
        link.symlink_to(path)
        with self.assertRaises(OSError):
            deploy.private_write(link, 'second')
        self.assertEqual(path.read_text(), 'first')

    def test_generated_config_has_no_dns_or_secrets(self):
        config = deploy.config_for(self.state)
        self.assertNotIn('routes', config)
        self.assertNotIn('secrets', config)
        self.assertEqual(config['vars']['APP_ORIGIN'], self.state['origin'])
        self.assertEqual(config['vars']['FRESH_INSTALL'], 'true')
        self.assertEqual(config['vars']['DEPLOYMENT_ID'], self.state['deploymentId'])
        self.assertEqual(config['main'], '../cloudflare/index.ts')
        self.assertEqual(config['assets']['directory'], '../dist')

    def test_invalid_state_cannot_send_credentials_offsite(self):
        deploy.validate_local_state(self.state, self.credentials)
        for origin in ('https://attacker.invalid', 'http://test-lab.test-account.workers.dev',
                       'https://test-lab.test-account.workers.dev@attacker.invalid', self.state['origin'] + '/path'):
            with self.assertRaises(deploy.DeploymentError):
                deploy.validate_local_state({**self.state, 'origin': origin}, self.credentials)
        with self.assertRaises(deploy.DeploymentError):
            deploy.validate_local_state(self.state, {**self.credentials, 'ENCRYPTION_KEY': 'wrong'})

    def test_update_preserves_manual_domain_storage_and_other_config(self):
        config = deploy.config_for(self.state)
        state = {**self.state, 'configFingerprint': deploy.config_fingerprint(config)}
        path = self.root / 'wrangler.deploy.json'
        path.write_text(json.dumps(config))
        deploy.ensure_managed_config(path, state)
        for modified in ({**config, 'routes': [{'pattern': 'lab.example.test', 'custom_domain': True}]},
                         {**config, 'r2_buckets': [{'binding': 'ARTIFACTS', 'bucket_name': 'private-artifacts'}]},
                         {**config, 'vars': {**config['vars'], 'ADDITIONAL_ORIGINS': 'https://lab.example.test'}},
                         {**config, 'limits': {'cpu_ms': 1000}}):
            path.write_text(json.dumps(modified))
            before = path.read_bytes()
            with self.assertRaisesRegex(deploy.DeploymentError, '手动修改'):
                deploy.ensure_managed_config(path, state)
            self.assertEqual(path.read_bytes(), before)

    def test_multiple_accounts_require_choice_without_mutation(self):
        cloud = deploy.Cloudflare('T' * 40)
        with patch.object(cloud, 'call', return_value=[{'id': '1' * 32}, {'id': '2' * 32}]) as call:
            with self.assertRaises(deploy.DeploymentError):
                cloud.account(None)
            call.assert_called_once_with('/accounts?per_page=50')

    def test_subdomain_creation_requires_opt_in_and_an_empty_account(self):
        cloud = deploy.Cloudflare('T' * 40)
        with patch.object(cloud, 'call', return_value=None) as call:
            with self.assertRaisesRegex(deploy.DeploymentError, 'init-subdomain'):
                cloud.subdomain('1' * 32)
            self.assertEqual(call.call_count, 1)
        with patch.object(cloud, 'call', return_value={'subdomain': 'existing-account'}) as call:
            self.assertEqual(cloud.subdomain('1' * 32, True), 'existing-account')
            self.assertEqual(call.call_count, 1)

    def test_empty_subdomain_initialization_reads_back_and_preserves_races(self):
        cloud = deploy.Cloudflare('T' * 40)
        with patch.object(deploy.secrets, 'token_hex', return_value='abcd'), \
             patch.object(cloud, 'call', side_effect=[None, None, {'subdomain': 'model-lab-abcd'}, {'subdomain': 'model-lab-abcd'}]) as call:
            self.assertEqual(cloud.subdomain('1' * 32, True), 'model-lab-abcd')
            self.assertEqual(call.call_args_list[2].args, ('/accounts/' + '1' * 32 + '/workers/subdomain', 'PUT', {'subdomain': 'model-lab-abcd'}))
        with patch.object(cloud, 'call', side_effect=[None, {'subdomain': 'created-elsewhere'}]) as call:
            self.assertEqual(cloud.subdomain('1' * 32, True), 'created-elsewhere')
            self.assertEqual(call.call_count, 2)

    def test_existing_worker_fails_before_secrets_or_subprocess(self):
        def call(_, path, *args, **kwargs):
            if path == '/accounts?per_page=50':
                return [{'id': '1' * 32}]
            if path.endswith('/subdomain'):
                return {'subdomain': 'test-account'}
            return {'bindings': []}
        with patch.object(deploy, 'ROOT', self.root), patch.object(deploy.Cloudflare, 'call', call), \
             patch.object(deploy, 'token_from', return_value='T' * 40), patch.object(deploy, 'run') as run:
            with self.assertRaisesRegex(deploy.DeploymentError, '同名 Worker'):
                deploy.main(['--name', 'test-lab'])
            run.assert_not_called()
        self.assertFalse((self.root / '.deploy/secrets.json').exists())

    def test_resume_cannot_take_over_foreign_worker(self):
        directory = self.root / '.deploy'
        directory.mkdir()
        (directory / 'state.json').write_text(json.dumps(self.state))
        (directory / 'secrets.json').write_text(json.dumps(self.credentials))
        before = (directory / 'secrets.json').read_bytes()
        def call(_, path, *args, **kwargs):
            return {'subdomain': 'test-account'} if path.endswith('/subdomain') else {'bindings': []}
        with patch.object(deploy, 'ROOT', self.root), patch.object(deploy.Cloudflare, 'call', call), \
             patch.object(deploy, 'token_from', return_value='T' * 40), patch.object(deploy, 'run') as run:
            with self.assertRaisesRegex(deploy.DeploymentError, '不是本地状态'):
                deploy.main(['--resume'])
            run.assert_not_called()
        self.assertEqual((directory / 'secrets.json').read_bytes(), before)

    def test_update_requires_paused_schedules_and_entire_queue_idle(self):
        with patch.object(deploy, 'authenticated_site', return_value=object()), \
             patch.object(deploy, 'site_request', return_value=(200, {}, {'schedules': [{'enabled': True}]})):
            with self.assertRaisesRegex(deploy.DeploymentError, '暂停定时'):
                deploy.ensure_idle(self.state, self.credentials)
        replies = [(200, {}, {'schedules': []}), (200, {}, {'total': 0}), (200, {}, {'total': 1})]
        with patch.object(deploy, 'authenticated_site', return_value=object()), \
             patch.object(deploy, 'site_request', side_effect=replies):
            with self.assertRaisesRegex(deploy.DeploymentError, '排队或运行'):
                deploy.ensure_idle(self.state, self.credentials)

    def test_command_failure_redacts_secrets(self):
        result = type('Result', (), {'returncode': 1, 'stdout': 'first-secret token-value', 'stderr': ''})()
        stream = io.StringIO()
        with patch.object(deploy.subprocess, 'run', return_value=result), contextlib.redirect_stderr(stream):
            with self.assertRaises(deploy.DeploymentError):
                deploy.run(['not-executed'], {}, ['first-secret', 'token-value'])
        self.assertNotIn('first-secret', stream.getvalue())
        self.assertNotIn('token-value', stream.getvalue())

    def test_subprocess_environment_cannot_redirect_credentials_or_write_logs(self):
        with patch.dict(os.environ, {'CF_API_BASE_URL': 'https://untrusted.invalid', 'CLOUDFLARE_API_TOKEN': 'inherited-token',
                'CF_EMAIL': 'private@example.test', 'WRANGLER_LOG_SANITIZE': 'false', 'WRANGLER_WRITE_LOGS': 'true',
                'WRANGLER_LOG_PATH': '/tmp/should-not-be-written', 'HTTPS_PROXY': 'http://127.0.0.1:1234'}, clear=True):
            build = deploy.safe_environment()
            upload = deploy.safe_environment('explicit-token', '1' * 32)
        for environment in (build, upload):
            self.assertNotIn('CF_API_BASE_URL', environment)
            self.assertNotIn('CF_EMAIL', environment)
            self.assertNotIn('WRANGLER_LOG_PATH', environment)
            self.assertEqual(environment['WRANGLER_LOG_SANITIZE'], 'true')
            self.assertEqual(environment['WRANGLER_WRITE_LOGS'], 'false')
            self.assertEqual(environment['HTTPS_PROXY'], 'http://127.0.0.1:1234')
        self.assertNotIn('CLOUDFLARE_API_TOKEN', build)
        self.assertEqual(upload['CLOUDFLARE_API_TOKEN'], 'explicit-token')
        self.assertEqual(upload['CLOUDFLARE_ACCOUNT_ID'], '1' * 32)


if __name__ == '__main__':
    unittest.main()
