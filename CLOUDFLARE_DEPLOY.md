# Cloudflare 部署

前端静态页面、API、配置、历史记录和生成的 HTML/SVG 都部署在 Cloudflare。后端使用一个 SQLite Durable Object，定时计划通过持久化 Alarm 执行。默认无需服务器、R2、D1、KV 或自定义域名。

想让 AI 帮你操作，直接复制 [AI 部署提示词](docs/AI_CLOUDFLARE_PROMPT.md)，填上本机令牌文件路径即可。AI 必须能运行终端命令并访问 Cloudflare API。

## 准备

- Linux 或 macOS，Node.js **24 或更新版本**、npm、Python **3.10 或更新版本**、Git。
- 一个 Cloudflare 账号。默认方案支持 Workers Free；每日请求、存储读写和容量仍受账号配额约束，超额可能停止服务。部署脚本不会升级套餐或启用付费存储。实际模型调用费用由你配置的 API 服务商收取。[Cloudflare 官方配额](https://developers.cloudflare.com/durable-objects/platform/limits/)、[Durable Objects 计费说明](https://developers.cloudflare.com/durable-objects/platform/pricing/)。
- Cloudflare **API Token**，不要使用 Global API Key。令牌只保存在仓库之外的本机文件，文件内只有令牌文本，或通过环境变量 `CLOUDFLARE_API_TOKEN` 提供；不要把令牌贴到公开 Issue、聊天截图、命令参数或 Git 仓库。

令牌权限限定到目标账号：

| 权限 | 用途 |
| --- | --- |
| Account / Workers Scripts / Edit | 上传 Worker、静态资源、SQLite Durable Object 迁移、应用 Secrets，读取或首次创建 workers.dev 子域 |
| Account / Account Settings / Read | 自动识别账号；多账号时使用 `--account-id` 指定目标 |

默认不需要 DNS 编辑、Zone 编辑、R2 或 D1 权限。API 文档中的 `Workers Scripts Write` 对应控制台的 Edit 权限。[上传 Worker](https://developers.cloudflare.com/api/resources/workers/subresources/scripts/methods/update/)、[workers.dev 子域 API](https://developers.cloudflare.com/api/resources/workers/subresources/subdomains/methods/update/)。

## 一次部署

```bash
git clone https://github.com/jinshenganyuci/model-lab.git
cd model-lab
npm ci
python3 cloudflare/tools/deploy.py --token-file /absolute/path/to/cloudflare-token.txt --init-subdomain
```

`--init-subdomain` 只在账号尚未注册 workers.dev 子域时，为该账号创建随机子域；已有子域始终沿用，不会改名。Cloudflare 可能要求新账号先在控制台完成验证或接受服务条款，遇到此类平台限制应完成提示后重试，不要改动其他站点。

脚本默认创建唯一名称，例如 `model-lab-随机串`，返回 `https://模型实验室名称.账号子域.workers.dev`。可追加 `--name my-model-lab` 指定名称；**发现同名 Worker 就停止，绝不覆盖**。如果令牌能访问多个账号，追加 `--account-id 目标账号ID`。

脚本会自动完成：

1. 检查账号、子域及名称，构建前后都检查覆盖风险。
2. 生成随机后台密码和 32 字节加密密钥，保存在被 Git 忽略的 `.deploy/` 内，目录权限 `0700`、文件 `0600`。
3. 构建前端并检查 Worker 类型，上传 Worker 和静态页面，通过标准输入写入 Cloudflare Secrets；构建阶段不注入 Cloudflare 令牌。
4. 在**空数据库**中初始化鹈鹕、糖果两道题，并永久封闭旧迁移接口。不会预置任何 API Key，也不会调用模型。
5. 验证 HTTPS、健康接口、后台登录、Cookie、公开数据和管理接口隔离。

完成后终端只给出网站地址、后台地址、密码文件路径。后台密码位于 `.deploy/admin-password.txt`，请在本机私下打开；不要把该文件的内容发到 GitHub。完整应用密钥位于 `.deploy/secrets.json`，**必须私下备份整个 `.deploy/`**：原加密密钥丢失后，无法解密数据库里保存的 API Key。

`.deploy/wrangler.deploy.json` 是实际部署配置，含账号和实例信息；仓库中的 `cloudflare/wrangler.jsonc` 只是通用模板。不要直接把模板里的示例地址当成你的线上地址。

## 配置 API 与定时任务

进入 `/admin`，用生成的密码登录。在“API 接口”保存服务地址和 Key，选择接口后自动获取模型；在“参测模型”设置模型 ID、推理强度和最大输出。然后到“定时任务”选择题目与模型。

支持固定间隔或五段 Cron，并可以选择时区。例如 `Asia/Shanghai` 时区下，`0 0-1,7-23 * * *` 表示每天 07:00 到次日 01:00 每小时一次。个别接口或模型停用时，计划跳过它并继续运行其他可用项目。

“全局设置”可设置默认重试次数、请求超时和历史保留时间。默认等待 600 秒，最多 720 秒；更长的 `max` 推理仍受上游服务的超时限制。每轮队列及清理拆分运行，为 [Alarm 的 15 分钟执行上限](https://developers.cloudflare.com/durable-objects/platform/limits/#wall-time-limits-by-invocation-type) 留出余量。

在另一台 Model Lab 导出加密配置后，可在新实例“配置备份”导入，恢复 API、模型、提示词、定时计划和全局设置，无需逐项填写。**配置备份不包含历史测试正文**。导入加密配置会使用新实例的加密密钥重新保存 API Key，不需要复制旧服务器的密钥。

## 失败后继续

保留 `.deploy/`，修复网络或权限问题后：

```bash
python3 cloudflare/tools/deploy.py --token-file /absolute/path/to/cloudflare-token.txt --resume
```

脚本核对账号、workers.dev 地址和远端实例标记，继续使用原有密码及加密密钥。它不会删除失败部署、随机重建密钥或接管其他人的 Worker。已经验证完成的实例使用 `--resume` 只重新检查服务；需要更新代码请使用下一节命令。

## 更新

先在后台暂停定时计划，等待排队和运行中的测试结束，并导出一份加密配置备份。保留原 `.deploy/` 后：

```bash
git pull --ff-only
npm ci
python3 cloudflare/tools/deploy.py --token-file /absolute/path/to/cloudflare-token.txt --update
```

脚本要求原本地状态与远端实例匹配，并在上传前再次检查队列。更新不会重新生成或上传应用密钥，也不会清空记录。完成后在后台恢复之前暂停的计划。不要在有长请求执行时手动直接运行 Wrangler deploy。

若 `.deploy/` 丢失，先恢复自己的私密备份。不要用新装命令覆盖已有 Worker，也不要随意替换 `ENCRYPTION_KEY`。

## 自定义域名

默认安装只使用 workers.dev。需要自定义域名时，另外明确指定一个**未使用的新子域名**，先核对该域名的 DNS、现有 Worker 路由和 Custom Domain。任何现有 A、AAAA、CNAME、DDNS 或其他绑定都视为已占用，不能覆盖。

在 Cloudflare 控制台给 Worker 添加 Custom Domain 后，把该 HTTPS 源地址加入私有部署配置的 `ADDITIONAL_ORIGINS`，保留 workers.dev 主地址，以支持两个入口的后台登录。自定义域名涉及额外 Zone 权限，属于手动高级配置；本脚本的 `--update` 仅管理默认 workers.dev 配置，**有手动自定义路由时应自行保留路由和允许源后使用 Wrangler 更新**。

## 旧实例完整历史迁移（高级）

普通迁移推荐后台导入加密配置。必须搬迁历史正文时，`cloudflare/tools/migrate.py` 提供分片迁移和清单核对；目标必须是专门创建、尚未初始化的新实例，不能使用默认新装数据库。

该模式需关闭 `FRESH_INSTALL` 和 `AUTOMATION_ENABLED`，提供与旧数据一致的加密密钥、一次性 `MIGRATION_TOKEN` 和完整的私密数据库/正文备份。核对清单后完成、封闭迁移接口，再移除 `MIGRATION_TOKEN`，停止旧实例的定时执行后启用新实例。**不要对正在使用的 Worker 测试这套流程**。本仓库不包含任何人的数据库、旧密钥或迁移快照。

## 本地验证

```bash
npm test
npm run typecheck:cloudflare
npm run build
npm run test:cloudflare
python3 -m unittest discover -s tests -p 'test_cf_deploy.py'
```

`test:cloudflare` 用实际本地 workerd 检查 SQLite 持久化、认证和秘密隔离，完全不连接 Cloudflare 账号、不调用模型。部署脚本的测试使用模拟 Cloudflare 响应，覆盖同名拒绝、只读令牌、空账号子域初始化、恢复及更新边界。
