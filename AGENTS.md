# Repository guidance for coding agents

- Read README.md and the relevant deployment guide before changing deployment behavior.
- Use Node.js 24+ and the locked dependencies (`npm ci`). Run the checks documented in CONTRIBUTING.md for functional changes.
- Keep Node and Cloudflare behavior consistent; use synthetic credentials and local mock upstreams in tests.
- Do not commit .env, .data, .deploy, .wrangler, databases, credentials, exported user configuration, or runtime logs. Do not include a user's account IDs, hostnames, API names, or screenshots in public examples.
- Treat user-supplied token files as read-only. Never echo their contents, put tokens in command-line arguments, or copy them into tracked files.
- When deployment is requested, follow CLOUDFLARE_DEPLOY.md and the bundled installer. Use a new unique Worker by default. Never repoint an existing DNS record, change an existing workers.dev account subdomain, replace unrelated Workers, or rotate an existing encryption key.
- Publishing source code does not authorize changing an existing live deployment or its DNS. Keep source-only changes separate from runtime data.
- Public test outputs are intentional; admin settings and credentials must remain behind authentication and server-side public DTO projection.
