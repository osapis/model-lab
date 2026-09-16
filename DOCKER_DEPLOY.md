# Docker Compose 部署

需要 Docker Engine 和 Docker Compose 插件。此方式从当前仓库源码构建 `model-lab:local`，不依赖作者的私人镜像或运行数据。容器使用 Node.js 24，以非 root 用户运行。

## 1. 下载并启动

```bash
git clone https://github.com/jinshenganyuci/model-lab.git
cd model-lab
cp .env.example .env
chmod 600 .env
docker compose up -d --build
docker compose ps
```

首次构建需要下载基础镜像和 npm 依赖；后续更新会复用构建缓存。所有 Compose 命令都在此目录执行。

默认访问地址为服务器本机的 `http://127.0.0.1:3000`，后台为 `/admin`。远程服务器可以先在自己的电脑建立隧道，再访问该地址：

```bash
ssh -L 3000:127.0.0.1:3000 your-user@your-server
```

局域网直连可以把 `.env` 中的 `BIND_ADDRESS` 改成服务器的局域网 IP；`0.0.0.0` 会监听所有 IPv4 网卡。修改后执行 `docker compose up -d`。公开访问请配置下一节的 HTTPS 入口。

首次启动会自动生成独立的管理口令。**仅在自己的终端**执行下面命令查看，然后在 `/admin` 登录：

```bash
docker compose exec model-lab cat /app/.data/admin-token
```

口令不会输出到普通容器日志。若 `.env` 设置了非空 `ADMIN_TOKEN`，登录使用该环境变量中的口令，文件里的默认口令不会生效。不要把口令、`.env`、数据目录或终端截图提交到 GitHub。

## 2. 使用 HTTPS 域名

让 Nginx、Caddy、Lucky 等反向代理把 HTTPS 请求转发到 `http://127.0.0.1:3000`，并保留正确的 `Host`。将 `.env` 改为自己的访问地址：

```dotenv
BIND_ADDRESS=127.0.0.1
APP_ORIGIN=https://lab.example.com
COOKIE_SECURE=true
```

`APP_ORIGIN` 必须包含协议和实际端口（如有），不带路径。它用于校验管理操作的请求来源；`COOKIE_SECURE=true` 使登录 Cookie 仅通过 HTTPS 发送。随后执行：

```bash
docker compose up -d
```

如果代理也在 Docker 容器内，代理容器的 `127.0.0.1` 并非宿主机。请将代理与本服务加入同一 Docker 网络，转发到 `http://model-lab:3000`，或使用经过限制的宿主机地址。不要为解决代理问题关闭请求来源校验。

## 3. 设置 API、模型与存储

登录后台后添加自己的 API 接口，在参测模型里读取接口支持的模型，再配置提示词、重试、超时和定时任务。初始仓库提供两个提示词和明确标记的演示样例，不含任何真实 API 接口或密钥。

接口密钥、模型配置、提示词、计划、测试记录元数据保存在命名卷 `model-lab-data` 对应的 `/app/.data`；接口密钥在数据库中加密，加密密钥保存在同一私有卷的 `encryption-key` 文件中。

**Node/Docker 默认正文存储为内存模式。** 生成的 HTML、SVG 和完整回答不会写入本地磁盘，但容器重启或内存缓存淘汰后，这些正文将不可用，历史元数据仍保留。需要长期查看生成结果时，请在后台「结果存储」配置自己的 Cloudflare R2 或兼容 S3 的对象存储，再开始正式测试。保留期到期或管理员删除记录时，相关远程正文也会进入清理流程。

Cloudflare Workers 版本使用不同的原生存储实现，见 [Cloudflare 部署](CLOUDFLARE_DEPLOY.md)。

## 4. 导出配置并导入新服务器

1. 在旧站后台的配置导出区域设置一个备份密码，下载加密配置文件。
2. 在新服务器按上文部署，使用新生成的管理员口令登录。
3. 选择导入文件，输入原来的备份密码，先查看导入预览，再确认导入。
4. 检查接口、模型和存储；确认后启用导入的定时任务。

加密配置包含 API 密钥、接口、模型、提示词、定时计划、全局设置和可迁移的对象存储配置。它**不包含历史测试结果、管理员口令、登录会话或本站数据加密密钥**。导入会新增接口、模型、提示词与计划，重复导入会重复新增；全局设置和可迁移的存储配置会随备份更新。导入的定时任务默认关闭，避免新旧服务器同时调用 API。

在 Docker 与 Cloudflare 原生存储之间导入时，不能迁移的原生存储绑定会保留新站现有设置；历史正文不会通过配置文件迁移。备份密码丢失后无法恢复该配置文件，文件与密码请分开保存。

## 5. 完整备份与恢复

配置导出适合迁移设置；备份 Docker 数据卷才能保留本站历史元数据和加密密钥。先在后台暂停定时任务，等待当前调用结束，再执行以下命令。此步骤会短暂停站，但不会删除卷。

```bash
(
set -eu
umask 077
mkdir -p private-backups
backup_file="private-backups/model-lab-data-$(date +%Y%m%d-%H%M%S).tar.gz"
model_lab_container="$(docker compose ps -q model-lab)"
test -n "$model_lab_container"
docker compose stop model-lab
trap 'docker compose start model-lab >/dev/null' EXIT
docker run --rm --volumes-from "$model_lab_container":ro \
  --entrypoint tar model-lab:local -C /app/.data -czf - . > "$backup_file"
docker compose start model-lab
trap - EXIT
cp .env "${backup_file%.tar.gz}.env"
)
```

脚本遇到错误会停止后续步骤，停站后的退出处理会尝试重新启动服务；必要时可手动执行 `docker compose start model-lab`。确认命令成功、归档可读后，把 `private-backups/` 移到仓库之外的私有备份位置。备份包含管理员口令与加密密钥，应按明文密钥同等级保护，不可上传到公开仓库。

若正文位于 R2/S3，需同时备份对应的远程对象并记录 bucket/prefix。数据卷归档不会下载这些对象；内存模式中已经丢失的正文无法从卷恢复。恢复后使用同一对象存储的两个站点可能分别执行过期清理，因此只启用需要继续运行的站点。

恢复应在**新建的空数据卷**上进行，避免覆盖现有站点。下载相同版本源码，准备 `.env`，然后：

```bash
(
set -eu
docker compose build
docker compose create model-lab
model_lab_container="$(docker compose ps -aq model-lab)"
test -n "$model_lab_container"
docker run --rm -i --volumes-from "$model_lab_container" \
  --entrypoint tar model-lab:local -C /app/.data -xzf - < /private/path/model-lab-data.tar.gz
docker compose up -d
)
```

使用原归档里的管理员口令；如 `.env` 设置了 `ADMIN_TOKEN`，以环境变量为准。必须同时恢复原 `encryption-key`，否则已有 API 密钥及存储配置无法解密。归档只应来自你信任的备份。

## 6. 更新、日志与停服

先完成备份并阅读目标版本说明。推荐切换到明确的 Release 标签后构建，例如：

```bash
git fetch --tags origin
git checkout v1.0.0
docker compose up -d --build
docker compose ps
docker compose logs --tail=100 model-lab
```

把 `v1.0.0` 替换为要安装的版本；命名卷会继续挂载，更新镜像不会清空数据。若某个版本改变数据格式，回退源码前应按该版本说明恢复匹配的备份。

仅停止服务：

```bash
docker compose stop
```

删除容器及默认网络、保留数据卷：

```bash
docker compose down
```

**不要添加 `-v`**，那会删除 Compose 管理的数据卷。迁移目录或修改 Compose 项目名称后，会使用另一套命名卷；请显式恢复备份或保持原项目名称，不要把空白新站误判为数据被清空。
