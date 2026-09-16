# 参与开发

欢迎通过 Issue 提交可复现问题，或提交 Pull Request。日志、截图和配置样例必须先删除账号、域名、凭证、会话 Cookie 和私人测试内容；安全漏洞请使用 [私密报告](SECURITY.md)。

需要 Node.js 24+ 和 Python 3.10+。执行 `npm ci` 后修改代码，提交前运行：

```bash
npm test
npm run build
npm run typecheck:cloudflare
npm run build:cloudflare
npm run test:cloudflare
python3 -m unittest discover -s tests -p 'test_*.py'
```

Cloudflare smoke 使用本地 workerd、临时数据和合成凭证，不调用真实模型或创建云端资源。新增行为测试也应使用本地模拟上游。

Node 与 Cloudflare 共享业务逻辑。修改队列、调度、配置备份、数据投影时，确认两种运行环境都可用。格式调整不应丢弃原始模型输出，重试不能把待重试记录提前当作最终失败。

`.data/`、`.deploy/`、`.env` 和 `.wrangler/` 不能提交。忽略规则不是秘密检测工具；提交前检查 `git diff --cached`，不要强行添加生成配置、用户备份或数据库。

如有 Docker 环境，可以验证完整安装与备份恢复：

```bash
docker build -t model-lab:ci .
python3 tools/docker-smoke.py --image model-lab:ci
```

此脚本仅使用临时容器、临时卷和合成数据，完成后自动清理自己创建的资源。
