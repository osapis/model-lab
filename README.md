# Model Lab · AI 模型测试站

用相同提示词测试不同 API 接口和模型，直接查看原始回答、SVG 动画、推理答案与历史变化。支持 Docker Compose 自托管，也支持将前后端部署到 Cloudflare Workers。

[Docker 搭建](DOCKER_DEPLOY.md) · [Cloudflare 搭建](CLOUDFLARE_DEPLOY.md) · [交给 AI 的部署提示词](docs/AI_CLOUDFLARE_PROMPT.md) · [安全说明](SECURITY.md)

## 能做什么

- **API 与模型管理**：支持兼容 Chat Completions / Responses 的接口；根据所选接口获取模型列表；设置输出长度、推理强度（`low / medium / high / xhigh / max`）。实际支持范围取决于上游。
- **自定义测试题**：内置鹈鹕骑自行车 HTML/SVG 动画、黑袋糖果推理题，也可以添加自己的提示词。
- **结果广场**：保留原始回答，隔离预览生成的 HTML/SVG；桌面四列、手机双列，同批次同接口和模型的测试相邻显示。
- **历史观察**：按测试批次分组，显示实际完成时间；糖果推理的最近 24 小时图按预设答案 `21` 标记正确与错误，可点击查看答案和时间。该图仅针对内置糖果题，不是通用智能评分。
- **自动执行**：固定间隔或 Cron 表达式，可选择时区；部分 API / 模型停用时跳过相应项，其余继续运行，恢复启用后自动参与后续测试。
- **失败重试与超时**：全局设置，默认失败后最多额外重试 5 次；请求超时默认 600 秒，可设置为 30–720 秒。等待重试时不反复展示失败卡片。
- **数据管理**：按全局或接口配置保留历史，支持批量清理；删除记录时联动清理对应作品。
- **配置迁移**：接口凭证、模型、提示词、定时计划和全局设置通过密码加密的 JSON 导入导出。导入后新计划保持暂停，确认后再启用。

## Docker Compose 快速开始

需要 Docker Engine 和 Compose 插件。默认在本机从源码构建，不依赖私人镜像或仓库密钥。

```bash
git clone https://github.com/jinshenganyuci/model-lab.git
cd model-lab
cp .env.example .env
chmod 600 .env
docker compose up -d --build
```

默认只绑定服务器本机，打开 `http://localhost:3000`；远程访问可使用 SSH 隧道或配置 HTTPS 反向代理，见部署说明。首次管理口令随机生成，**在自己的终端**读取：

```bash
docker compose exec model-lab cat /app/.data/admin-token
```

进入后台添加接口和模型，即可运行测试。公网使用前配置 HTTPS；更新、反向代理和数据备份见 [Docker 部署说明](DOCKER_DEPLOY.md)。

向仓库推送 `v*` tag 时，CI 会在测试通过后将镜像发布到 GitHub Container Registry，可按版本拉取，例如 `docker pull ghcr.io/jinshenganyuci/model-lab:v1.0.0`。需要使用宿主机目录或命名卷时，在运行容器或 Compose 文件中自行选择挂载方式。

## Cloudflare：把提示词交给 AI

[复制完整部署提示词](docs/AI_CLOUDFLARE_PROMPT.md)，向具有终端权限的 AI 提供你自己的 Cloudflare API Token 文件路径。AI 可使用仓库内的安装脚本完成构建、创建独立 Worker、配置 Secrets 和首次初始化。

默认提供 `workers.dev` 地址，使用 Durable Objects 的 SQLite 存储；不用迁移已有网站，也不用修改 DNS。脚本会拒绝覆盖同名现有 Worker。可选 R2 与自定义域名需按 [Cloudflare 部署说明](CLOUDFLARE_DEPLOY.md) 单独配置。

Token 仅用于部署控制面，**不是被测模型的 API Key**。模型接口可在部署后从后台填写，也可导入已有的加密配置备份。

## 数据与安全边界

本仓库仅含通用源码、合成测试数据和演示样例，不包含作者的部署数据库、真实接口配置、API Key、管理员密码、Cloudflare 账户标识或私有部署地址。

管理接口需要登录；配置凭证在服务端加密保存，公开接口只返回展示所需字段。**测试结果和生成作品是公开内容**，不要在提示词或模型输出中放入不愿公开的信息。配置备份不包含历史测试、作品或管理员密码；完整备份需要另外保存数据和加密密钥。

Docker 使用 `/app/.data` 保存配置、记录元数据和密钥；Compose 默认使用命名卷，也可以改成宿主机目录映射。结果正文可在后台选择服务器内存、本地硬盘或 R2/S3：内存模式重启后不可恢复，本地硬盘模式写入 `/app/.data/artifacts`，长期云端保留需配置 R2/S3。Cloudflare 默认在云端 Durable Objects 保存数据和作品，不占用自己的服务器磁盘。具体用量与账单取决于平台套餐和测试频率，开源软件与免费托管均不意味着无限容量或零攻击风险。详见 [安全说明](SECURITY.md)。

## 本地开发

需要 Node.js 24+、npm；Cloudflare 安装工具另需 Python 3.10+。

```bash
npm ci
npm run dev
```

开发前端：`http://localhost:5173`；后端：`http://localhost:3000`。

```bash
npm test
npm run build
npm run typecheck:cloudflare
npm run build:cloudflare
npm run test:cloudflare
```

前端使用 React / TypeScript / Vite；Node 后端使用 Express / SQLite；Cloudflare 后端使用 Workers / Durable Objects。两种部署共享测试队列、定时逻辑、配置备份和公开数据投影。

## 许可证

[MIT](LICENSE)。第三方依赖遵循各自许可证，见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
