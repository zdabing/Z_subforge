# subforge · 订阅配置生成

本地 Web 控制台，把机场订阅 + [AIsouler/MyClash](https://github.com/AIsouler/MyClash) 的 `mihomoScript.js` 生成成完整 mihomo 配置，并可作为客户端的订阅源（`/sub`）。

1. **YAML 版**：同步上游 `Config/mihomoConfig.yaml`，按补丁（订阅链接等）加工 → `mihomoConfig.synced.yaml`
2. **脚本版（动态生成）**：本地执行上游 `Script/mihomoScript.js`，按开关动态生成 → `mihomoScript.synced.yaml`

> 上游仓库本身没有自动更新配置的机制（其 workflow 仅做 prettier 格式化），所以用本工具自行同步。
> 浏览器沙箱不允许网页直接执行 Node / 写文件 / 注册计划任务，因此由本地 Node 服务承载这些能力，页面只做界面。

## 快速开始

```bat
npm install        rem 首次：安装 js-yaml（脚本版需要）
双击 start.cmd    rem 启动服务并自动打开浏览器（http://localhost:8790）
```

页面功能区：
- **状态卡片**：上游/脚本 SHA、上次同步时间、产物大小、定时任务状态
- **YAML 版**：补丁设置（订阅开关 → 立即同步 → 下载产物）、同步日志、差异预览
- **脚本版（动态生成）**：订阅管理（多订阅，第一个同步给 YAML 版补丁）→ 节点归属地标注 / 分流组节点勾选 → 按开关（含 生成地区自动选择组 / 隐藏地区手动选择组 / 分流组添加所有节点 / 过滤高倍率节点 / 过滤非地区节点 / 屏蔽国外QUIC 等）生成配置

关闭 `start.cmd` 的窗口即停止服务。

## 文件说明

| 文件 | 作用 |
|---|---|
| `start.cmd` | 启动 Web 控制台（打开浏览器 + 前台运行服务） |
| `server.js` | 本地 HTTP 服务（Node 内置模块），全部 API |
| `index.html` | Web 控制台页面（静态页，无外部 CDN） |
| `sync.js` | YAML 版同步核心（模块 + CLI 双用） |
| `scriptGenerator.js` | 脚本版生成核心：下载/提取开关/注入/执行上游脚本 |
| `patches.js` | YAML 版补丁配置（订阅链接由脚本版「订阅管理」同步，可加自定义补丁） |
| `sync.cmd` | CLI 兜底：`node sync.js`（YAML 版） |
| `Dockerfile` / `docker-compose.yml` | 容器部署（NAS/服务器，配合 GitHub Actions 自动构建） |
| `script/` | 上游脚本快照（upstream-script.js + meta.json） |
| `snapshot/` | YAML 版上游快照 |
| `settings.json` | 补丁开关、订阅链接、脚本版开关（scriptOptions）持久化 |
| `mihomoConfig.synced.yaml` / `mihomoScript.synced.yaml` | 两类产物 |

## 脚本版开关

来自上游 `mihomoScript.js` 顶部的 `ruleOptionsEnable`（25 项），在页面里分组展示、独立开关：

- **基础策略**：手动选择 / 自动选择 / 负载均衡
- **分流策略**：AI / Media / FCM / Google / Microsoft / Apple / Telegram / Steam / TikTok / Twitter / Emby / PikPak / Spotify / Crypto / EHentai / AdBlock
- **生成配置**：生成地区自动选择组 / 隐藏地区手动选择组 / 分流组添加所有节点 / 过滤高倍率节点 / 过滤非地区节点 / 屏蔽国外QUIC

开关状态存 `settings.json` 的 `scriptOptions`。上游脚本改版后重新「下载上游脚本」即可同步新开关。

## CLI

```bat
node sync.js                    rem YAML 版同步
node scriptGenerator.js sync    rem 下载上游脚本
node scriptGenerator.js generate rem 脚本版生成（需订阅链接有效）
```

## 客户端订阅地址（推荐用法）

服务提供 `/sub` 端点，可直接作为 mihomo 客户端的订阅源：

```
http://127.0.0.1:8790/sub
```

客户端每次点「更新」时，服务端会自动执行：拉最新上游脚本 → 强制拉最新订阅 → 重新生成 YAML → 返回给客户端。正在生成或失败时回退返回上次产物，客户端不中断。订阅元信息（流量/到期/更新间隔）会透传，客户端可正常显示。

## Docker 部署（NAS / 服务器）

代码推送 GitHub 后，仓库自带的 GitHub Actions 会自动构建镜像并推到 Docker Hub，无需手动构建。

### 1. 配置 GitHub Secrets（仅首次）

在 GitHub 仓库 **Settings → Secrets and variables → Actions → New repository secret** 添加两个密钥：

| 密钥名 | 值 |
|---|---|
| `DOCKERHUB_USERNAME` | 你的 Docker Hub 用户名 |
| `DOCKERHUB_TOKEN` | Docker Hub 生成的 Access Token（Docker Hub → Account Settings → Security → Access Tokens → 生成，权限勾选 Read/Write/Delete） |

### 2. 推送代码（首次）

```bash
git init
git add .
git commit -m "init"
git branch -M main
git remote add origin https://github.com/<你的用户名>/<仓库名>.git
git push -u origin main
```

推送后进入仓库 Actions 页，等「构建并推送 Docker 镜像」跑完即可（也可手动触发）。镜像地址：

```
<你的DockerHub用户名>/subforge:latest
```

### 3. NAS 部署（以 docker compose 为例）

在 NAS 上新建目录（如 `/volume1/docker/subforge`），放入 `docker-compose.yml`（改 image 为你的 Docker Hub 地址），然后：

```bash
docker compose up -d
```

或使用群晖 Container Manager / Portainer 界面：镜像填 `<你的DockerHub用户名>/subforge:latest`，端口映射 `8790`，卷挂载 `/data`，环境变量照抄 compose 中的配置。

### 3. 使用

- 首次打开 `http://<NAS_IP>:8790`，填订阅链接 → 点「生成 YAML」
- mihomo 客户端添加订阅：`http://<NAS_IP>:8790/sub`，客户端点「更新」即自动生成最新配置
- 配置（订阅链接、开关、快照、产物）都在挂载卷 `/data`，升级镜像不丢

### 环境变量

| 变量 | 默认 | 说明 |
|---|---|---|
| `HOST` | `127.0.0.1` | 监听地址，容器内必须设 `0.0.0.0` |
| `PORT` | `8790` | 服务端口 |
| `DATA_DIR` | 代码目录 | 数据（settings.json/快照/产物）存放目录，容器内指向挂载卷 |
| `TZ` | — | 时区，容器里设 `Asia/Shanghai` 避免日志差 8 小时 |
| `SUB_TITLE` | 订阅域名 | 客户端显示的订阅名称，可自定义 |

> 容器内没有 Windows 计划任务，页面「定时任务」按钮会显示「无法检测」，属正常现象；日常更新靠客户端点「更新」触发。

## 定时任务

页面里「启用定时任务」注册计划任务 `SubForgeSync`（每周日 09:00 调用 `sync.cmd`），「停用」即卸载。

## 注意

- 脚本版生成需要**有效的订阅链接**（页面「订阅管理」填写）。
- 脚本版生成需要 `npm install` 安装 js-yaml（Docker 镜像已内置）。
