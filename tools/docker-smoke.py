"""Exercise a locally built image using isolated, synthetic data.

Usage: python3 tools/docker-smoke.py --image model-lab:local
Requires Docker and Python 3. No API provider requests are performed.
The generated credentials and backup archive stay in memory; all temporary
containers and named volumes created by this run are removed on exit.
"""
import argparse
import http.cookiejar
import json
import secrets
import subprocess
import time
import urllib.error
import urllib.request
import uuid

parser = argparse.ArgumentParser(description=__doc__)
parser.add_argument('--image', default='model-lab:local', help='Locally built Model Lab image to verify')
image = parser.parse_args().image
run_id = uuid.uuid4().hex
prefix = 'model-lab-smoke-' + run_id
owner_label = 'model-lab.smoke.run'
containers, volumes, checks = [], [], []
def docker(*args, input=None):
    run = subprocess.run(['docker', *args], input=input, stdout=subprocess.PIPE, stderr=subprocess.PIPE, timeout=120)
    if run.returncode:
        raise RuntimeError('docker operation failed: ' + args[0])
    return run.stdout

def check(name, condition):
    if not condition: raise AssertionError(name)
    checks.append(name)

def create(label, start=True):
    name = prefix + '-' + label
    volume = name + '-data'
    docker('volume', 'create', '--label', owner_label + '=' + run_id, volume); volumes.append(volume)
    docker('create', '--name', name, '--label', owner_label + '=' + run_id,
           '-p', '127.0.0.1::3000', '-v', volume + ':/app/.data', image); containers.append(name)
    if start: docker('start', name)
    return name

def client(name):
    for _ in range(60):
        info = json.loads(docker('inspect', name))[0]
        ports = info['NetworkSettings']['Ports'].get('3000/tcp')
        if ports:
            origin = 'http://127.0.0.1:' + ports[0]['HostPort']
            try:
                with urllib.request.urlopen(origin + '/api/health', timeout=2) as r:
                    if r.status == 200: break
            except (OSError, urllib.error.URLError): pass
        time.sleep(0.5)
    else: raise AssertionError('healthy server startup')
    opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    def request(path, payload=None, method=None, extra_headers=None):
        headers = {'Origin': origin}
        if extra_headers: headers.update(extra_headers)
        if payload is not None: headers['Content-Type'] = 'application/json'
        req = urllib.request.Request(origin + path, data=json.dumps(payload).encode() if payload is not None else None, headers=headers, method=method)
        try:
            with opener.open(req, timeout=15) as r: return r.status, r.headers, r.read()
        except urllib.error.HTTPError as e: return e.code, e.headers, e.read()
    return request

def login(request, token):
    status, headers, _ = request('/api/auth/login', {'token': token})
    check('administrator login', status == 200)
    cookie = headers.get('Set-Cookie', '')
    check('HttpOnly SameSite cookie', 'HttpOnly' in cookie and 'SameSite=Strict' in cookie)

try:
    docker('image', 'inspect', image)
    first = create('primary')
    request = client(first)
    token = docker('exec', first, 'cat', '/app/.data/admin-token').decode().strip()
    encryption_key = docker('exec', first, 'cat', '/app/.data/encryption-key')
    check('fresh random administrator token', len(token) >= 40)
    check('32 byte encryption key', len(encryption_key) == 32)
    check('non-root runtime', docker('exec', first, 'id', '-u').strip() == b'1000')
    modes = docker('exec', first, 'stat', '-c', '%a', '/app/.data', '/app/.data/admin-token', '/app/.data/encryption-key').decode().split()
    check('private directory and secret permissions', modes == ['700', '600', '600'])
    status, _, page = request('/')
    check('production frontend', status == 200 and b'<html' in page and b'/assets/' in page)
    check('unauthenticated admin access denied', request('/api/admin/data')[0] == 401)
    status, _, raw = request('/api/public/data')
    data = json.loads(raw)
    check('fresh demo prompts and no configured keys', status == 200 and len(data['prompts']) == 2 and not data['providers'] and data['stats']['apiRuns'] == 0)
    check('wrong Origin denied', request('/api/auth/login', {'token': token}, extra_headers={'Origin': 'https://untrusted.example'})[0] == 403)
    login(request, token)
    api_key = 'sk-TEST' + secrets.token_urlsafe(24) + 'TAIL5'
    status, _, raw = request('/api/admin/providers', {'name': 'Synthetic Docker smoke', 'baseUrl': 'https://api.example.com/v1', 'protocol': 'responses', 'apiKey': api_key})
    provider = json.loads(raw)['provider']
    check('synthetic provider creation and key masking', status == 201 and api_key.encode() not in raw and provider['apiKeyPreview'] == 'sk-TEST...TAIL5')
    status, _, raw = request('/api/admin/models', {'providerId': provider['id'], 'name': 'Synthetic model', 'modelId': 'test-model', 'reasoningEffort': 'max'})
    model = json.loads(raw)['model']
    check('model configuration', status == 201 and model['reasoningEffort'] == 'max')
    status, _, raw = request('/api/admin/schedules', {'name': 'Synthetic schedule', 'promptIds': ['prompt-candy'], 'modelIds': [model['id']], 'enabled': False, 'scheduleType': 'cron', 'cronExpression': '0 7-23,0-1 * * *', 'timezone': 'Asia/Shanghai'})
    check('disabled cron configuration', status == 201)
    status, _, _ = request('/api/admin/settings', {'maxRetries': 4}, method='PATCH')
    check('global settings write', status == 200)
    password = secrets.token_urlsafe(32)
    status, _, raw = request('/api/admin/config/export', {'password': password})
    backup = json.loads(raw)
    check('encrypted configuration export', status == 200 and backup['format'] == 'model-lab-config' and api_key.encode() not in raw and token.encode() not in raw)
    status, _, raw = request('/api/public/data')
    check('public API excludes saved secret material', api_key.encode() not in raw and encryption_key not in raw and token.encode() not in raw and b'apiKeyPreview' not in raw)
    check('database does not contain plaintext provider key', api_key.encode() not in docker('exec', first, 'cat', '/app/.data/app.db'))
    docker('restart', first)
    request = client(first)
    check('persistent generated secrets after restart', docker('exec', first, 'cat', '/app/.data/admin-token').decode().strip() == token and docker('exec', first, 'cat', '/app/.data/encryption-key') == encryption_key)
    login(request, token)
    status, _, raw = request('/api/admin/data')
    persisted = json.loads(raw)
    check('persistent configuration after restart', len(persisted['providers']) == 1 and len(persisted['models']) == 1 and len(persisted['schedules']) == 1 and persisted['settings']['maxRetries'] == 4)
    check('licenses shipped and local secrets excluded', docker('exec', first, 'sh', '-c', 'test -f /app/LICENSE && test -f /app/THIRD_PARTY_NOTICES.md && test ! -e /app/.env && test ! -e /app/.deploy && test ! -e /app/.git').strip() == b'')
    docker('stop', first)
    archive = docker('run', '--rm', '--volumes-from', first + ':ro', '--entrypoint', 'tar', image, '-C', '/app/.data', '-czf', '-', '.')
    check('stopped volume backup archive', len(archive) > 100)
    restored = create('restored', start=False)
    docker('run', '--rm', '-i', '--volumes-from', restored, '--entrypoint', 'tar', image, '-C', '/app/.data', '-xzf', '-', input=archive)
    docker('start', restored)
    restored_request = client(restored)
    login(restored_request, token)
    status, _, raw = restored_request('/api/admin/data')
    restored_data = json.loads(raw)
    check('volume restore preserves configuration and key decryption', status == 200 and restored_data['providers'][0]['apiKeyPreview'] == 'sk-TEST...TAIL5' and restored_data['models'][0]['reasoningEffort'] == 'max' and restored_data['settings']['maxRetries'] == 4)
    imported = create('imported')
    imported_request = client(imported)
    imported_token = docker('exec', imported, 'cat', '/app/.data/admin-token').decode().strip()
    check('independent installation password', imported_token != token)
    login(imported_request, imported_token)
    status, _, raw = imported_request('/api/admin/config/preview', {'password': password, 'backup': backup})
    preview = json.loads(raw)['preview']
    check('configuration import preview', status == 200 and preview['providers'] == 1 and preview['models'] == 1 and preview['schedules'] == 1)
    status, _, raw = imported_request('/api/admin/config/import', {'password': password, 'backup': backup})
    check('encrypted configuration import', status == 200 and json.loads(raw)['imported']['providers'] == 1)
    status, _, raw = imported_request('/api/admin/data')
    imported_data = json.loads(raw)
    check('imported credentials reencrypted and schedule disabled', len(imported_data['providers']) == 1 and imported_data['providers'][0]['apiKeyPreview'] == 'sk-TEST...TAIL5' and imported_data['schedules'][0]['enabled'] is False and imported_data['settings']['maxRetries'] == 4)
    check('configuration import preserves target password', docker('exec', imported, 'cat', '/app/.data/admin-token').decode().strip() == imported_token)
    check('no real API calls during smoke test', all(r['source'] == 'sample' for r in imported_data['runs']))
    print(json.dumps({'passed': len(checks), 'checks': checks, 'image': image}, ensure_ascii=False))
finally:
    cleanup_failures = []
    for name in reversed(containers):
        try:
            details = json.loads(docker('inspect', name))[0]
            if details['Config'].get('Labels', {}).get(owner_label) != run_id:
                raise RuntimeError('temporary container ownership changed')
            docker('rm', '-f', name)
        except Exception:
            cleanup_failures.append(name)
    for volume in reversed(volumes):
        try:
            details = json.loads(docker('volume', 'inspect', volume))[0]
            if details.get('Labels', {}).get(owner_label) != run_id:
                raise RuntimeError('temporary volume ownership changed')
            docker('volume', 'rm', volume)
        except Exception:
            cleanup_failures.append(volume)
    if cleanup_failures:
        raise RuntimeError('Could not clean temporary smoke resources: ' + ', '.join(cleanup_failures))
