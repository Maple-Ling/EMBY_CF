# Emby Proxy - Cloudflare Worker Emby 反向代理管理版

一个功能强大的 Cloudflare Worker 反向代理脚本，专为 Emby 媒体服务器设计。支持**别名管理**、**多线路故障转移**、**管理后台**、**播放统计**等高级功能。

---

## 功能特性

### 核心功能

- **Emby 反向代理** — 通过 Cloudflare Workers 中转 Emby 服务器流量
- **别名系统** — 为 Emby 服务器创建短别名，支持多线路配置和自动故障转移
- **管理后台** — 内置 Web 管理界面，可视化管理别名和线路
- **D1 数据库** — 使用 Cloudflare D1 存储别名配置和播放统计数据

### 代理能力

- **WebSocket 支持** — 完整代理 Emby 的 WebSocket 连接
- **智能重定向** — 同域名跟随、白名单域名直连、其他走 Worker 代理
- **请求缓存** — 按 content-type 智能设置缓存时间，提升访问速度
- **CORS 支持** — 完整的跨域资源共享头设置

### 统计功能

- **播放次数统计** — 记录 `/Sessions/Playing` 接口调用
- **获取链接统计** — 记录 `/PlaybackInfo` 接口调用
- **按天存储** — 数据按北京时间（UTC+8）按天存储
- **前端展示** — 在管理后台实时查看统计数据

---

## 快速开始

> **两种部署方式任选其一：**
>
> | 方式 | 适合人群 | 说明 |
> |------|---------|------|
> | [手动部署](DEPLOY.md#方式一手动部署推荐小白用户) | 小白用户 | 在 Cloudflare 网页控制台操作，无需安装任何软件 |
> | [GitHub 自动部署](DEPLOY.md#方式二github-actions-自动部署推荐有经验用户) | 有经验的用户 | 通过 GitHub Actions 自动部署，支持代码版本管理 |

**详细部署教程请查看 → [DEPLOY.md](DEPLOY.md)**

---

## 使用方法

### 1. 直接代理模式

访问 Worker 域名即可看到首页，反向代理的使用格式：

```
https://你的Worker域名/Emby服务器地址
```

**示例：**

```
https://your-worker.workers.dev/https://emby.example.com:8096
```

### 2. 别名代理模式（推荐）

通过管理后台创建别名后，可以使用简短的别名访问 Emby 服务器：

```
https://你的Worker域名/别名
```

**示例：**

```
https://your-worker.workers.dev/myemby
```

别名支持配置多条线路，当主线路故障时会自动切换到备用线路。

### 3. 访问管理后台

在 Worker 域名后加上 `/admin` 路径即可访问管理后台：

```
https://你的Worker域名/admin
```

使用你设置的 `ADMIN_TOKEN` 登录后，可以：

- 创建和管理别名
- 为每个别名配置多条线路
- 设置线路优先级和代理模式
- 查看播放统计数据

---

## 配置说明

### 环境变量

| 变量名 | 必填 | 说明 |
|--------|------|------|
| `ADMIN_TOKEN` | 是 | 管理后台登录密码 |

### D1 数据库绑定

| 绑定名 | 必填 | 说明 |
|--------|------|------|
| `DB` | 否 | D1 数据库绑定，用于别名管理和统计功能 |

### 代理模式说明

| 模式 | 说明 |
|------|------|
| `off` | 默认模式，不修改响应中的 URL |
| `dual` | 兼容模式，同时返回原始 URL 和代理 URL |

### 白名单域名

以下域名的重定向会直接跟随，不经过 Worker 代理：

- 阿里云盘系列：`aliyundrive.com`、`aliyuncs.com` 等
- 迅雷系列：`xunlei.com`、`xlusercdn.com` 等
- 115 网盘系列：`115.com`、`115cdn.com` 等
- 天翼云盘：`189.cn`、`ctyunxs.cn` 等
- 夸克网盘：`quark.cn`、`uc.cn` 等
- CDN 服务：`myqcloud.com`、`cloudfront.net`、`akamaized.net` 等

---

## 项目结构

```
├── worker.js                        # Cloudflare Worker 主脚本
├── wrangler.toml                    # Wrangler 部署配置文件
├── README.md                        # 项目说明文档
├── DEPLOY.md                        # 详细部署教程
├── .gitignore                       # Git 忽略规则
└── .github/
    └── workflows/
        └── main.yml                 # GitHub Actions 自动部署配置
```

---

## 故障排查

| 问题 | 解决方案 |
|------|---------|
| 无法访问 Worker | 检查 Worker 是否已部署成功，自定义域名 DNS 是否正确 |
| 代理失败 | 检查目标 Emby 服务器是否可访问，防火墙是否放行 |
| 统计功能不工作 | 确认 D1 数据库已正确绑定，数据库表已创建 |
| WebSocket 连接失败 | 确保目标 Emby 服务器支持 WebSocket |
| GitHub 部署失败 | 检查 API Token 是否有效，账户 ID 是否正确 |
| 别名无法访问 | 确认 D1 数据库已绑定，别名和线路已正确配置 |

### 查看实时日志

安装 Wrangler CLI 后，可以查看 Worker 实时日志：

```bash
npx wrangler tail --format pretty
```

---

## 相关链接

- **Cloudflare 控制台**：https://dash.cloudflare.com/
- **Cloudflare Workers 文档**：https://developers.cloudflare.com/workers/
- **Wrangler CLI 文档**：https://developers.cloudflare.com/workers/wrangler/
- **反馈群组**：https://t.me/Dirige_Proxy

---

## 声明

本工具仅用于学习和研究目的，请勿用于非法用途。使用本工具产生的一切后果由使用者自行承担。
