#!/usr/bin/env python3
"""Upload a private SQLite snapshot and saved result bodies to a staged Model Lab Worker.

Requires a one-use migration secret already installed with Wrangler. Credentials are
never printed. The manifest prevents activating a partial migration.
"""
import argparse
import concurrent.futures
import hashlib
import json
import os
import re
from pathlib import Path
import sqlite3
import sys
import time
import urllib.error
import urllib.parse
import urllib.request

class MigrationError(Exception):
    """A message that is safe to display without response bodies or credentials."""


def validate_origin(value):
    try:
        if any(character.isspace() or ord(character) < 32 for character in value):
            raise ValueError()
        parsed = urllib.parse.urlsplit(value)
        if (parsed.scheme != 'https' or not parsed.hostname or parsed.username is not None
                or parsed.password is not None or parsed.path not in ('', '/')
                or parsed.query or parsed.fragment or '?' in value or '#' in value):
            raise ValueError()
        port = parsed.port
        if port is not None and not 1 <= port <= 65535:
            raise ValueError()
        hostname = parsed.hostname.encode('idna').decode('ascii').lower()
        if ':' in hostname:
            hostname = '[' + hostname + ']'
        return 'https://' + hostname + (f':{port}' if port and port != 443 else '')
    except (ValueError, UnicodeError):
        raise MigrationError('Origin must be an HTTPS origin without credentials, path, query or fragment.') from None


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, request, response, code, message, headers, new_url):
        # A redirect must never forward the migration secret or database payload.
        return None


class MigrationClient:
    def __init__(self, origin, secret):
        self.origin = validate_origin(origin)
        if not re.fullmatch(r'[A-Za-z0-9_-]{30,200}', secret):
            raise MigrationError('Migration token file has an unexpected format; contents were not printed.')
        self.secret = secret
        self.opener = urllib.request.build_opener(NoRedirect())

    def call(self, path, payload=None, private=True):
        parsed = urllib.parse.urlsplit(path)
        if not path.startswith('/') or path.startswith('//') or parsed.scheme or parsed.netloc or parsed.fragment:
            raise MigrationError('Invalid migration operation path.')
        body = json.dumps(payload, ensure_ascii=False).encode() if payload is not None else None
        headers = {'User-Agent': 'ModelLab-Migration/1.0', 'Content-Type': 'application/json', 'Origin': self.origin}
        if private:
            headers['x-model-lab-migration'] = self.secret
        for attempt in range(3):
            request = urllib.request.Request(self.origin + path, data=body, headers=headers)
            try:
                with self.opener.open(request, timeout=60) as response:
                    return json.load(response)
            except urllib.error.HTTPError as error:
                code = error.code
                error.close()
                if code < 500 or attempt == 2:
                    # Never display response bodies, redirect targets or payloads.
                    raise MigrationError(f'Migration request failed: HTTP {code}; redirects are not followed.') from None
            except (TimeoutError, urllib.error.URLError, OSError):
                if attempt == 2:
                    raise MigrationError('Migration request failed: transport error.') from None
            except (ValueError, UnicodeError):
                raise MigrationError('Migration returned an invalid JSON response.') from None
            time.sleep(attempt + 1)


def canonical(value):
    return json.dumps(value, sort_keys=True, ensure_ascii=False, separators=(',', ':'))


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--origin', required=True)
    parser.add_argument('--backup', required=True)
    parser.add_argument('--complete', action='store_true')
    args = parser.parse_args()
    origin = validate_origin(args.origin)
    backup = Path(args.backup)
    # Read the existing credential without chmod, rewriting or deleting its file.
    with (backup / 'migration-token').open(encoding='utf-8') as token_file:
        secret = token_file.read(2048).lstrip('\ufeff').strip()
    call = MigrationClient(origin, secret).call

    database = sqlite3.connect((backup / "app.db").resolve().as_uri() + "?mode=ro", uri=True)
    tables = {}
    for table in ['providers', 'models', 'prompts', 'schedules', 'runs']:
        tables[table] = [{'id': row[0], 'data': row[1]} for row in database.execute(f'SELECT id,data FROM {table} ORDER BY id')]
    settings_row = database.execute("SELECT data FROM settings WHERE id='global'").fetchone()
    settings = json.loads(settings_row[0]) if settings_row else {}
    settings = {key: settings.get(key, default) for key, default in
                [('retentionDays', 30), ('maxRetries', 5), ('requestTimeoutSeconds', 600)]}
    sessions = [{'token_hash': row[0], 'expires_at': row[1]} for row in database.execute('SELECT token_hash,expires_at FROM sessions WHERE expires_at>?', (int(time.time()*1000),))]
    database.close()
    values = {table: [json.loads(row['data']) for row in tables[table]] for table in ['providers', 'models', 'prompts', 'schedules']}
    values['settings'] = settings
    fingerprint = hashlib.sha256(canonical(values).encode()).hexdigest()
    artifacts = sorted((backup / 'artifacts').glob('*.json'))
    known_ids = {row['id'] for row in tables['runs']}
    artifacts = [path for path in artifacts if path.stem in known_ids]
    manifest = {'counts': {table: len(rows) for table, rows in tables.items()}, 'artifactCount': len(artifacts),
                'configFingerprint': fingerprint, 'unavailableIds': sorted(known_ids - {path.stem for path in artifacts})}
    call('/api/_migration/manifest', manifest)
    for table, rows in tables.items():
        for offset in range(0, len(rows), 50):
            call('/api/_migration/records', {'table': table, 'records': rows[offset:offset+50]})
        print(json.dumps({'table': table, 'imported': len(rows)}), flush=True)
    call('/api/_migration/settings', {'settings': settings, 'sessions': sessions})

    def upload(path):
        payload = json.loads(path.read_text())
        call('/api/_migration/artifact', {'id': path.stem, 'payload': payload})
        # Verify the actual public read path, not just the successful upload receipt.
        restored = call('/api/public/runs/' + urllib.parse.quote(path.stem, safe=''), private=False)['run']
        actual = {key: restored.get(key, '') for key in ['output', 'html', 'reasoning']}
        if actual != payload or not restored.get('artifactAvailable'):
            raise MigrationError('Migrated artifact read-back mismatch.')
        return len(canonical(payload).encode())

    verified_bytes = 0
    with concurrent.futures.ThreadPoolExecutor(max_workers=4) as pool:
        for number, size in enumerate(pool.map(upload, artifacts), 1):
            verified_bytes += size
            if number % 50 == 0:
                print(json.dumps({'artifacts_verified': number}), flush=True)
    result = call('/api/_migration/status')
    if result['counts'] != manifest['counts'] or result['configFingerprint'] != fingerprint or result['artifactCount'] != len(artifacts):
        raise MigrationError('Migration manifest verification failed; automation remains off.')
    if args.complete:
        call('/api/_migration/complete', {})
    receipt = {'counts': result['counts'], 'artifact_count': len(artifacts), 'verified_bytes': verified_bytes,
               'unavailable_count': len(manifest['unavailableIds']), 'config_fingerprint_match': True, 'complete': args.complete}
    receipt_path = backup / 'cloudflare-migration-receipt.json'
    with os.fdopen(os.open(receipt_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600), 'w') as receipt_file:
        receipt_file.write(json.dumps(receipt, indent=2))
    print(json.dumps(receipt), flush=True)


if __name__ == '__main__':
    try:
        main()
    except MigrationError as error:
        print(str(error), file=sys.stderr)
        raise SystemExit(1) from None
    except KeyboardInterrupt:
        print('Migration interrupted; verify the staged state before retrying.', file=sys.stderr)
        raise SystemExit(130) from None
    except Exception:
        # Database values, filenames and upstream errors may contain private data.
        print('Migration failed; check the private backup and staged Worker. No exception details were printed.', file=sys.stderr)
        raise SystemExit(1) from None
