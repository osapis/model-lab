# 复制给 AI 的 Cloudflare 部署提示词

把下方 `TOKEN_FILE_PATH` 换成本机令牌文件的绝对路径。文件放在仓库外，AI 只需要读取权限，不需要你把令牌正文粘贴到聊天中。需要一个能运行终端、安装 Node.js 依赖和访问网络的 AI 编程助手。

```text
请把开源 Model Lab 部署到我的 Cloudflare 账号，并完成实际访问验证。

仓库：https://github.com/jinshenganyuci/model-lab
Cloudflare API Token 文件：TOKEN_FILE_PATH

请先阅读仓库 README.md、CLOUDFLARE_DEPLOY.md 和 cloudflare/tools/deploy.py，
然后在一个新的本机工作目录完成安装。环境需要 Node.js 24+、Python 3.10+ 和 Git。

执行要求：
1. 令牌文件只能读取，不修改、不删除、不复制进仓库。
   不要打印令牌、后台密码、加密密钥，不要把它们放进命令行参数、日志、截图或提交。
2. 使用仓库锁文件运行 npm ci，然后运行：
   python3 cloudflare/tools/deploy.py --token-file "TOKEN_FILE_PATH" --init-subdomain
   让脚本自动选择唯一 Worker 名称和发现账号。
   多账号无法唯一判断时，只询问我目标 account ID，不要自行任选账号。
3. --init-subdomain 仅授权在账号尚无 workers.dev 子域时创建随机子域；
   已有账号子域必须保留。若平台要求首次账号验证或额外权限，请明确告诉我缺哪一步。
4. 默认使用 workers.dev；不要添加自定义域名、修改 DNS/DDNS、替换已有路由，
   不要覆盖现有 Worker，不要变更其他应用，不要开通付费套餐或 R2。
5. 部署脚本生成的 .deploy/ 是本地私密状态，须保持权限并排除 Git。
   失败时保留它并使用 --resume；禁止删掉它后靠重建或轮换密钥解决问题。
6. 完成后验证前台、/api/health、后台登录、未登录管理接口被拒绝、
   迁移接口已封闭，以及公开 API 不包含应用密钥。不要为了验证而调用付费模型。
7. 保留默认的鹈鹕与糖果题目。若我另外提供加密配置备份，先安全预览再导入；
   除非我明确授权，不立即补跑历史任务或创建额外模型调用。

最后只告诉我：可访问的网站地址、后台地址、私密管理员密码文件路径、
验证结果和仍需我处理的事项。提醒我私下备份 .deploy/。
不要把密码或 Token 正文写进最终回答。
```

你的 Token 至少需要目标账号的 Workers Scripts/Edit 和 Account Settings/Read 权限。脚本不保存 Cloudflare Token；AI 完成后可自行撤销这枚部署令牌，网站继续使用 Cloudflare Secrets 中的应用密钥运行。

如果已用本项目脚本安装过，更新时应保留 `.deploy/`，使用 `--update`。先暂停计划并等队列空闲，更新后恢复计划；不要把“新建部署”提示词用于接管一个已有实例。
