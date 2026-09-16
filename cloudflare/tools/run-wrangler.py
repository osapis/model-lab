#!/usr/bin/env python3
"""Run Wrangler using a token file without putting credentials in argv or logs."""
import argparse
import os
from pathlib import Path
import re
import subprocess
import sys

def redact(value, secrets):
    for secret in sorted(set(secrets), key=len, reverse=True):
        if secret:
            value = value.replace(secret, '[REDACTED]')
    return value


def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--token-file', required=True)
    parser.add_argument('--account-id', required=True)
    parser.add_argument('command', nargs=argparse.REMAINDER)
    args = parser.parse_args()
    if not re.fullmatch(r'[a-fA-F0-9]{32}', args.account_id):
        raise SystemExit('Account ID must contain 32 hexadecimal characters.')
    # The supplied token file is strictly read-only: never chmod, rewrite or delete it.
    with Path(args.token_file).open(encoding='utf-8') as token_file:
        token = token_file.read(2048).lstrip('\ufeff').strip()
    if not re.fullmatch(r'[A-Za-z0-9_-]{30,200}', token):
        raise SystemExit('Token file has an unexpected format; contents were not printed.')
    command = args.command[1:] if args.command[:1] == ['--'] else args.command
    if not command:
        raise SystemExit('A Wrangler command is required after --.')
    root = Path(__file__).resolve().parents[2]
    environment = dict(os.environ)
    secrets = [token, *[value for name, value in environment.items()
                       if len(value) >= 8 and re.search(r'(?:TOKEN|PASSWORD|SECRET|API_KEY|ENCRYPTION_KEY)$', name, re.I)]]
    if any(secret in argument for secret in secrets for argument in command):
        raise SystemExit('Do not put secret values in Wrangler command arguments; use stdin or environment variables.')
    # Ignore alternate API endpoints/global-key auth inherited from unrelated tools.
    for name in ['CLOUDFLARE_API_BASE_URL', 'CF_API_BASE_URL', 'CLOUDFLARE_API_KEY', 'CF_API_KEY',
                 'CLOUDFLARE_EMAIL', 'CF_EMAIL']:
        environment.pop(name, None)
    environment.update(CLOUDFLARE_API_TOKEN=token, CLOUDFLARE_ACCOUNT_ID=args.account_id,
                       WRANGLER_SEND_METRICS='false', WRANGLER_LOG_SANITIZE='true',
                       WRANGLER_WRITE_LOGS='false', WRANGLER_LOG='log')
    result = subprocess.run([str(root / 'node_modules/.bin/wrangler'), *command],
                            cwd=root, env=environment, capture_output=True, text=True)
    sys.stdout.write(redact(result.stdout, secrets))
    sys.stderr.write(redact(result.stderr, secrets))
    return result.returncode


if __name__ == '__main__':
    try:
        raise SystemExit(main())
    except KeyboardInterrupt:
        raise SystemExit('Wrangler interrupted; verify the deployment state before retrying.') from None
    except Exception:
        raise SystemExit('Could not run Wrangler; check the token file and local installation. No exception details were printed.') from None
