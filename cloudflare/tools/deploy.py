#!/usr/bin/env python3
"""Install a NEW Model Lab Worker without storing the Cloudflare API token.

Only account Workers APIs are used. This tool never changes DNS, existing domains,
billing, other Workers, or stored application data. Private state enables resume/update.
"""
import argparse
import base64
import hashlib
import http.cookiejar
import json
import os
from pathlib import Path
import re
import secrets
import subprocess
import sys
import time
import urllib.error
import urllib.request

ROOT = Path(__file__).resolve().parents[2]
API = 'https://api.cloudflare.com/client/v4'


class DeploymentError(Exception):
    pass


class NoRedirect(urllib.request.HTTPRedirectHandler):
    def redirect_request(self, req, fp, code, msg, headers, newurl):
        # Never send a credential to a different URL or silently accept a login redirect.
        return None


def token_from(path=None):
    try:
        value = Path(path).read_text(encoding='utf-8-sig').strip() if path else os.environ.get('CLOUDFLARE_API_TOKEN', '').strip()
    except OSError:
        raise DeploymentError('无法读取令牌文件；文件内容未输出。') from None
    if not re.fullmatch(r'[A-Za-z0-9_-]{30,200}', value):
        raise DeploymentError('令牌格式无效：文件应仅包含 API Token，或设置 CLOUDFLARE_API_TOKEN。')
    return value


def worker_name(value):
    if not re.fullmatch(r'[a-z][a-z0-9-]{0,61}[a-z0-9]|[a-z]', value):
        raise DeploymentError('Worker 名称须为 1–63 位小写字母、数字或连字符，首位字母，末位不能为连字符。')
    return value


def private_write(path, value, *, exclusive=False):
    flags = os.O_WRONLY | os.O_CREAT | (os.O_EXCL if exclusive else os.O_TRUNC)
    if hasattr(os, 'O_NOFOLLOW'):
        flags |= os.O_NOFOLLOW
    descriptor = os.open(path, flags, 0o600)
    with os.fdopen(descriptor, 'w', encoding='utf-8') as stream:
        os.fchmod(stream.fileno(), 0o600)
        stream.write(value)


class Cloudflare:
    def __init__(self, token):
        self.token = token
        self.opener = urllib.request.build_opener(NoRedirect())

    def call(self, path, method='GET', data=None, *, missing=False):
        request = urllib.request.Request(API + path, method=method,
            headers={'Authorization': 'Bearer ' + self.token, 'Content-Type': 'application/json', 'User-Agent': 'ModelLab-Installer/1.0'},
            data=None if data is None else json.dumps(data).encode())
        try:
            with self.opener.open(request, timeout=45) as response:
                payload = json.load(response)
        except urllib.error.HTTPError as error:
            if missing and error.code == 404:
                return None
            raise DeploymentError(f'Cloudflare API 返回 HTTP {error.code}；请核对账号和令牌权限。响应正文未输出。') from None
        except (OSError, ValueError):
            raise DeploymentError('Cloudflare API 网络或响应异常；尚未确认操作成功，请检查后显式恢复。') from None
        if not payload.get('success'):
            raise DeploymentError('Cloudflare API 未确认成功；响应正文未输出。')
        return payload.get('result')

    def account(self, explicit):
        if explicit:
            if not re.fullmatch('[a-fA-F0-9]{32}', explicit):
                raise DeploymentError('account-id 必须为 32 位十六进制。')
            # The Workers call validates scope even for tokens that cannot list accounts.
            return explicit
        accounts = self.call('/accounts?per_page=50')
        if not isinstance(accounts, list) or len(accounts) != 1:
            raise DeploymentError('令牌可访问零个或多个账号，请用 --account-id 明确选择目标账号。')
        return accounts[0]['id']

    def subdomain(self, account, initialize=False):
        path = f'/accounts/{account}/workers/subdomain'
        result = self.call(path, missing=True)
        suffix = (result or {}).get('subdomain', '')
        if not suffix and initialize:
            # Account-wide setting: only create it when absent, never rename an existing one.
            result = self.call(path, missing=True)
            suffix = (result or {}).get('subdomain', '')
            if not suffix:
                candidate = 'model-lab-' + secrets.token_hex(6)
                self.call(path, 'PUT', {'subdomain': candidate})
                suffix = (self.call(path) or {}).get('subdomain', '')
                if suffix != candidate:
                    raise DeploymentError('workers.dev 子域创建后读回不一致，停止部署；未改动已有 DNS。')
        if not re.fullmatch(r'[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?', suffix):
            raise DeploymentError('账号尚未注册 workers.dev；可添加 --init-subdomain 仅在空账号上创建随机子域，或先在控制台注册。')
        return suffix


def config_for(state):
    template = json.loads((ROOT / 'cloudflare/wrangler.jsonc').read_text())
    # Paths are relative to .deploy/wrangler.deploy.json, not the tracked template.
    template.update(name=state['name'], account_id=state['accountId'], main='../cloudflare/index.ts')
    template['$schema'] = '../node_modules/wrangler/config-schema.json'
    template['assets']['directory'] = '../dist'
    template.pop('routes', None)
    template['vars'] = {'APP_ORIGIN': state['origin'], 'ADDITIONAL_ORIGINS': '',
        'AUTOMATION_ENABLED': 'true', 'FRESH_INSTALL': 'true', 'DEPLOYMENT_ID': state['deploymentId']}
    return template


def validate_local_state(state, credentials):
    if state.get('version') != 1 or not re.fullmatch(r'[a-f0-9]{32}', state.get('deploymentId', '')):
        raise DeploymentError('本地部署状态格式无效。')
    worker_name(state['name'])
    if not re.fullmatch(r'[a-fA-F0-9]{32}', state['accountId']):
        raise DeploymentError('本地账号标识无效。')
    expected = r'https://' + re.escape(state['name']) + r'\.[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.workers\.dev'
    if not re.fullmatch(expected, state['origin']):
        raise DeploymentError('本地站点地址必须是原 Worker 的 HTTPS workers.dev 地址。')
    if set(credentials) != {'ADMIN_TOKEN', 'ENCRYPTION_KEY'} or not re.fullmatch(r'[A-Za-z0-9_-]{32,128}', credentials['ADMIN_TOKEN']):
        raise DeploymentError('本地应用密钥格式无效；禁止重新生成。')
    try:
        if len(base64.b64decode(credentials['ENCRYPTION_KEY'], validate=True)) != 32:
            raise ValueError()
    except (ValueError, TypeError):
        raise DeploymentError('本地加密密钥格式无效；禁止重新生成。') from None


def config_fingerprint(config):
    return hashlib.sha256(json.dumps(config, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def ensure_managed_config(path, state):
    if path.is_symlink():
        raise DeploymentError('私有部署配置不允许使用符号链接。')
    try:
        previous = json.loads(path.read_text())
    except (OSError, ValueError):
        raise DeploymentError('缺少原私有部署配置；请先恢复 .deploy 备份，不能自动重建更新配置。') from None
    expected = state.get('configFingerprint') or config_fingerprint(config_for(state))
    if config_fingerprint(previous) != expected:
        raise DeploymentError('私有部署配置已有手动修改（可能含域名、R2 或其他绑定）；已保留原文件，请使用 Wrangler 手动更新。')


def safe_environment(token=None, account=None):
    # Inherited CF_API_BASE_URL and Wrangler overrides could redirect credentials.
    # Standard HTTP(S)_PROXY remains available for legitimate network access.
    environment = {key: value for key, value in os.environ.items()
                   if not re.match(r'^(?:CLOUDFLARE_|CF_|WRANGLER_)', key)}
    environment.update(CI='true', WRANGLER_SEND_METRICS='false', WRANGLER_LOG_SANITIZE='true',
                       WRANGLER_WRITE_LOGS='false', WRANGLER_LOG='warn')
    if token is not None:
        environment.update(CLOUDFLARE_API_TOKEN=token, CLOUDFLARE_ACCOUNT_ID=account)
    return environment


def run(command, environment, redactions, *, stdin=None):
    result = subprocess.run(command, cwd=ROOT, env=environment, input=stdin, capture_output=True, text=True)
    output = result.stdout + result.stderr
    for value in redactions:
        output = output.replace(value, '[REDACTED]')
    # Wrangler may display account identifiers and paths; all output stays on the local terminal.
    if result.returncode:
        sys.stderr.write(output[-12000:])
        raise DeploymentError('构建或 Wrangler 执行失败；未删除资源，可保留 .deploy 后使用 --resume。')


def site_request(opener, origin, path, method='GET', data=None):
    request = urllib.request.Request(origin + path, method=method,
        headers={'Origin': origin, 'Content-Type': 'application/json', 'User-Agent': 'ModelLab-Installer/1.0'},
        data=None if data is None else json.dumps(data).encode())
    try:
        with opener.open(request, timeout=30) as response:
            body = response.read()
            return response.status, response.headers, json.loads(body) if body else None
    except urllib.error.HTTPError as error:
        return error.code, error.headers, None
    except (OSError, ValueError):
        raise DeploymentError('站点验证失败；HTTPS 或网络可能尚未就绪，未输出请求凭据。') from None


def authenticated_site(state, credentials):
    opener = urllib.request.build_opener(NoRedirect(), urllib.request.HTTPCookieProcessor(http.cookiejar.CookieJar()))
    status, headers, _ = site_request(opener, state['origin'], '/api/auth/login', 'POST', {'token': credentials['ADMIN_TOKEN']})
    cookie = headers.get('Set-Cookie', '').lower()
    if status != 200 or not all(flag in cookie for flag in ('httponly', 'secure', 'samesite=strict')):
        raise DeploymentError('后台登录或安全 Cookie 检查未通过；请保留原有密钥，禁止自动重置。')
    return opener


def verify_site(state, credentials, *, fresh):
    public = urllib.request.build_opener(NoRedirect())
    for attempt in range(12):
        try:
            status, _, health = site_request(public, state['origin'], '/api/health')
            if status == 200 and health == {'ok': True}:
                break
        except DeploymentError:
            pass
        if attempt == 11:
            raise DeploymentError('部署后健康检查未通过；未回滚或删除资源。等待域名生效后使用 --resume 验证。')
        time.sleep(5)
    if site_request(public, state['origin'], '/api/admin/data')[0] != 401:
        raise DeploymentError('未登录管理接口隔离检查失败。')
    if site_request(public, state['origin'], '/api/_migration/status')[0] != 404:
        raise DeploymentError('迁移接口未封闭。')
    status, _, data = site_request(public, state['origin'], '/api/public/data')
    if status != 200 or not isinstance(data, dict):
        raise DeploymentError('公开页面数据验证失败。')
    encoded = json.dumps(data)
    if any(value in encoded for value in credentials.values()) or any(key in encoded for key in ('encryptedApiKey', 'ENCRYPTION_KEY', 'ADMIN_TOKEN')):
        raise DeploymentError('公开数据的密钥隔离检查失败。')
    if fresh and not {'prompt-pelican', 'prompt-candy'}.issubset({row['id'] for row in data.get('prompts', [])}):
        raise DeploymentError('默认测试题初始化未通过。')
    private = authenticated_site(state, credentials)
    status, _, data = site_request(private, state['origin'], '/api/admin/data')
    if status != 200 or 'settings' not in data or 'schedules' not in data:
        raise DeploymentError('后台配置读回失败。')
    # An authenticated POST from an unrelated origin must still be blocked.
    request = urllib.request.Request(state['origin'] + '/api/admin/settings', method='PATCH', data=b'{}',
        headers={'Origin': 'https://untrusted.invalid', 'Content-Type': 'application/json'})
    try:
        with private.open(request, timeout=30) as response:
            code = response.status
    except urllib.error.HTTPError as error:
        code = error.code
    if code != 403:
        raise DeploymentError('管理接口来源检查失败。')


def ensure_idle(state, credentials):
    private = authenticated_site(state, credentials)
    status, _, data = site_request(private, state['origin'], '/api/admin/data')
    if status != 200:
        raise DeploymentError('无法确认后台状态，停止更新。')
    if any(row.get('enabled') for row in data.get('schedules', [])):
        raise DeploymentError('更新前请在后台暂停定时计划，并等待现有任务结束；更新后手动恢复原计划。')
    for status_filter in ('queued', 'running'):
        status, _, page = site_request(private, state['origin'], '/api/admin/runs?limit=1&status=' + status_filter)
        if status != 200 or page.get('total', 1):
            raise DeploymentError('仍有排队或运行中的测试，请等待结束后更新。')


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--token-file', help='只读令牌文件；省略时读取 CLOUDFLARE_API_TOKEN')
    parser.add_argument('--account-id')
    parser.add_argument('--name', help='新 Worker 名称，默认 model-lab-随机串，绝不覆盖已有同名 Worker')
    parser.add_argument('--init-subdomain', action='store_true', help='仅账号尚无 workers.dev 子域时初始化随机子域，已有子域不变')
    mode = parser.add_mutually_exclusive_group()
    mode.add_argument('--resume', action='store_true', help='使用本机 .deploy 状态继续未完成的新部署')
    mode.add_argument('--update', action='store_true', help='仅更新本机 .deploy 对应实例，保留全部密钥；要求计划暂停和队列空闲')
    args = parser.parse_args(argv)
    os.umask(0o077)
    token = token_from(args.token_file)
    cloud = Cloudflare(token)
    deployment = ROOT / '.deploy'
    if deployment.is_symlink():
        raise DeploymentError('.deploy 不允许使用符号链接。')
    deployment.mkdir(mode=0o700, exist_ok=True)
    deployment.chmod(0o700)
    state_file, secret_file = deployment / 'state.json', deployment / 'secrets.json'
    if args.resume or args.update:
        if state_file.is_symlink() or secret_file.is_symlink():
            raise DeploymentError('部署状态和密钥文件不允许使用符号链接。')
        try:
            state = json.loads(state_file.read_text())
            credentials = json.loads(secret_file.read_text())
        except (OSError, ValueError):
            raise DeploymentError('缺少原 .deploy 状态或密钥，不能接管已有 Worker 或重新生成加密密钥。') from None
        if args.account_id and args.account_id != state['accountId'] or args.name and args.name != state['name']:
            raise DeploymentError('指定账号或名称与原部署不一致。')
        validate_local_state(state, credentials)
        account = cloud.account(state['accountId'])
        suffix = cloud.subdomain(account)
        if state['origin'] != f"https://{state['name']}.{suffix}.workers.dev":
            raise DeploymentError('账号 workers.dev 地址与原部署不一致，停止发送管理员凭据。')
    else:
        if state_file.exists() or secret_file.exists():
            raise DeploymentError('.deploy 已存在，请显式使用 --resume 或 --update；部署第二个实例请使用另一份仓库目录。')
        account = cloud.account(args.account_id)
        name = worker_name(args.name or 'model-lab-' + secrets.token_hex(4))
        if cloud.call(f'/accounts/{account}/workers/scripts/{name}/settings', missing=True) is not None:
            raise DeploymentError('同名 Worker 已存在，已停止；请使用其他 --name，绝不覆盖。')
        suffix = cloud.subdomain(account, args.init_subdomain)
        state = {'version': 1, 'name': name, 'accountId': account, 'deploymentId': secrets.token_hex(16),
            'origin': f'https://{name}.{suffix}.workers.dev', 'phase': 'prepared'}
        credentials = {'ADMIN_TOKEN': secrets.token_urlsafe(32), 'ENCRYPTION_KEY': base64.b64encode(secrets.token_bytes(32)).decode()}
        private_write(secret_file, json.dumps(credentials, indent=2) + '\n', exclusive=True)
        private_write(deployment / 'admin-password.txt', credentials['ADMIN_TOKEN'] + '\n', exclusive=True)
        private_write(state_file, json.dumps(state, indent=2) + '\n', exclusive=True)
    remote_path = f"/accounts/{account}/workers/scripts/{state['name']}/settings"
    remote = cloud.call(remote_path, missing=True)
    if remote is not None:
        marker = next((binding.get('text') for binding in remote.get('bindings', []) if binding.get('name') == 'DEPLOYMENT_ID'), None)
        if marker != state['deploymentId']:
            raise DeploymentError('远端 Worker 不是本地状态创建的实例，停止操作。')
        if args.update:
            bindings = {binding.get('name'): binding for binding in remote.get('bindings', [])}
            if bindings.get('APP_ORIGIN', {}).get('text') != state['origin'] or bindings.get('ADDITIONAL_ORIGINS', {}).get('text', ''):
                raise DeploymentError('远端存在手工配置的允许源或域名；请保留该配置并使用 Wrangler 更新，脚本不会覆盖。')
            if any(bindings.get(name, {}).get('type') != 'secret_text' for name in ('ADMIN_TOKEN', 'ENCRYPTION_KEY')):
                raise DeploymentError('远端应用 Secrets 不完整，停止更新；请恢复原有密钥。')
    elif args.update:
        raise DeploymentError('原 Worker 不存在，不能用 --update 新建或恢复数据库。')
    if args.update:
        ensure_managed_config(deployment / 'wrangler.deploy.json', state)
        ensure_idle(state, credentials)
    if args.resume and state.get('phase') == 'verified':
        verify_site(state, credentials, fresh=False)
    else:
        config = deployment / 'wrangler.deploy.json'
        if args.resume and config.exists():
            ensure_managed_config(config, state)
        generated = config_for(state)
        private_write(config, json.dumps(generated, indent=2) + '\n')
        state['configFingerprint'] = config_fingerprint(generated)
        private_write(state_file, json.dumps(state, indent=2) + '\n')
        environment = safe_environment(token, account)
        redactions = [token, *credentials.values()]
        # Dependencies must come from the checked-in lockfile, not a globally installed Wrangler.
        if not (ROOT / 'node_modules/.bin/wrangler').exists():
            raise DeploymentError('请先运行 npm ci 安装锁定依赖，再用 --resume 继续。')
        build_environment = safe_environment()
        run(['npm', 'run', 'build'], build_environment, redactions)
        run(['npm', 'run', 'typecheck:cloudflare'], build_environment, redactions)
        wrangler = [str(ROOT / 'node_modules/.bin/wrangler')]
        run([*wrangler, 'deploy', '--config', str(config), '--dry-run'], build_environment, redactions)
        if args.update:
            ensure_idle(state, credentials)
        # Recheck the target immediately before upload, including a first-run name collision.
        current = cloud.call(remote_path, missing=True)
        if current is not None and not any(binding.get('name') == 'DEPLOYMENT_ID' and binding.get('text') == state['deploymentId'] for binding in current.get('bindings', [])):
            raise DeploymentError('上传前目标名称已被其他 Worker 占用，停止操作。')
        print('正在上传 Worker 与静态页面；API Token 和应用密钥不会显示。', flush=True)
        run([*wrangler, 'deploy', '--config', str(config)], environment, redactions)
        state['phase'] = 'uploaded'
        private_write(state_file, json.dumps(state, indent=2) + '\n')
        if not args.update:
            # stdin keeps the values out of argv; a resume resends the SAME local secrets.
            run([*wrangler, 'secret', 'bulk', '--config', str(config)], environment, redactions, stdin=json.dumps(credentials))
        verify_site(state, credentials, fresh=not args.update)
        state['phase'] = 'verified'
        private_write(state_file, json.dumps(state, indent=2) + '\n')
    print('部署与隔离检查通过。')
    print('网站：' + state['origin'])
    print('后台：' + state['origin'] + '/admin')
    print('管理员密码文件：' + str(deployment / 'admin-password.txt'))
    print('请私下备份整个 .deploy 目录；切勿提交、截图或发送 secrets.json。')


if __name__ == '__main__':
    try:
        main()
    except (DeploymentError, OSError, KeyError, ValueError) as error:
        # Known errors are authored above. OS/parser exceptions could embed private paths or input.
        message = str(error) if isinstance(error, DeploymentError) else '本地状态或执行环境错误；未输出文件内容或凭据。'
        print('停止：' + message, file=sys.stderr)
        sys.exit(1)
