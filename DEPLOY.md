# Emby Proxy 部署教程

本教程将详细介绍如何部署 Emby Proxy 到 Cloudflare Workers。即使你是完全的新手，按照下面的步骤操作也能顺利完成部署。

---

## 目录

- [前置准备](#前置准备)
- [方式一：手动部署（推荐小白用户）](#方式一手动部署推荐小白用户)
- [方式二：GitHub Actions 自动部署（推荐有经验用户）](#方式二github-actions-自动部署推荐有经验用户)
- [配置自定义域名](#配置自定义域名可选强烈推荐)
- [部署后验证](#部署后验证)
- [常见问题](#常见问题)

---

## 前置准备

在开始部署之前，你需要准备以下内容：

### 1. 注册 Cloudflare 账号

1. 打开浏览器，访问 https://dash.cloudflare.com/
2. 点击 **Sign Up**（注册）
3. 输入你的邮箱和密码，完成注册
4. 登录进入 Cloudflare 控制台

### 2. 准备一个域名（可选但强烈推荐）

> **为什么推荐自定义域名？**
>
> Cloudflare Workers 默认提供 `xxx.workers.dev` 域名，但这个域名在国内被墙，无法直接访问。使用自定义域名可以避免这个问题。

**没有域名？** 你可以：

- 在 [DNSHE](https://my.dnshe.com/index.php?m=domain_hub) 注册一个免费域名并托管到 Cloudflare（邀请码：`ZPB06CED7F`）
- 或者购买一个便宜的域名（如 `.xyz`、`.top` 等后缀）

**已有域名？** 将域名的 DNS 托管到 Cloudflare 即可：

1. 在 Cloudflare 控制台点击 **Add a site**（添加站点）
2. 输入你的域名，按提示操作
3. 将域名的 Nameserver 修改为 Cloudflare 提供的 NS 地址
4. 等待 DNS 生效（通常几分钟到几小时）

---

## 方式一：手动部署（推荐小白用户）

手动部署全程在浏览器中操作，不需要安装任何软件。

### 步骤 1：创建 D1 数据库

> D1 数据库用于存储别名配置和播放统计数据。**必须先创建数据库，再部署 Worker。**

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)
2. 在左侧菜单中找到并点击 **Workers & Pages**
3. 在页面顶部的标签栏中，点击 **D1**
4. 点击右上角的 **Create database**（创建数据库）按钮
5. 数据库名称填写：`emby-proxy-db`（可以自定义名称）
6. 点击 **Create**（创建）按钮
7. **记录数据库 ID**：创建完成后，点击数据库名称进入详情页，在右侧信息面板中可以看到 **Database ID**，复制保存这个 ID，后面会用到

### 步骤 2：创建数据库表

1. 在数据库详情页，点击顶部的 **Console**（控制台）标签
2. 在 SQL 输入框中，粘贴以下 SQL 语句：

```sql
CREATE TABLE IF NOT EXISTS auto_emby_daily_stats (
    date TEXT PRIMARY KEY,
    playing_count INTEGER DEFAULT 0,
    playback_info_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alias_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias_id INTEGER NOT NULL,
    target_url TEXT NOT NULL,
    mode TEXT DEFAULT 'off',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (alias_id) REFERENCES aliases(id) ON DELETE CASCADE
);
```

3. 点击 **Execute**（执行）按钮
4. 确认显示执行成功（绿色提示）

### 步骤 3：创建 Worker

1. 返回 Cloudflare 控制台首页
2. 在左侧菜单点击 **Workers & Pages**
3. 点击 **Create**（创建应用程序）按钮
4. 选择 **Create Worker**（从 hello world 开始）
5. Worker 名称填写：`emby-proxy`（可以自定义，只能用小写字母、数字和连字符）
6. 点击 **Deploy**（部署）按钮
7. 等待部署完成后，点击 **Edit code**（编辑代码）进入代码编辑器

### 步骤 4：上传代码

1. 在代码编辑器中，你会看到默认的示例代码
2. **全选**（Ctrl+A）编辑器中的所有默认代码，然后**删除**它们
3. 打开本项目中的 `worker.js` 文件，**复制全部内容**
4. 将复制的代码**粘贴**到 Cloudflare 代码编辑器中
5. 点击右上角的 **Save and deploy**（保存并部署）按钮
6. 确认部署成功

### 步骤 5：配置环境变量

1. 回到 Worker 的管理页面（点击左上角的返回箭头）
2. 点击顶部的 **Settings**（设置）标签
3. 在左侧菜单点击 **Variables and Secrets**（变量和密钥）
4. 点击 **Add variable**（添加变量）
5. 配置以下变量：

| 变量名 | 值 | 说明 |
|--------|------|------|
| `ADMIN_TOKEN` | 你自定义的密码 | 管理后台登录密码，请设置一个安全的密码 |

6. 点击变量右侧的 **Encrypt**（加密）按钮，将 `ADMIN_TOKEN` 设为加密状态
7. 点击 **Save and deploy**（保存并部署）

### 步骤 6：绑定 D1 数据库

1. 在 Worker 的 **Settings**（设置）页面
2. 在左侧菜单点击 **Bindings**（绑定）
3. 点击 **Add binding**（添加绑定）
4. 选择 **D1 database**
5. 配置以下信息：

| 字段 | 值 |
|------|------|
| Variable name（变量名） | `DB` |
| D1 database（D1 数据库） | 选择你刚才创建的数据库 |

6. 点击 **Save and deploy**（保存并部署）

### 步骤 7：访问你的 Worker

1. 部署完成后，你可以通过默认域名访问你的 Worker：
   ```
   https://emby-proxy.你的用户名.workers.dev
   ```
2. 访问管理后台：
   ```
   https://emby-proxy.你的用户名.workers.dev/admin
   ```
3. 使用你设置的 `ADMIN_TOKEN` 登录

> **注意**：`workers.dev` 域名在国内可能无法访问，建议配置自定义域名。详见下方 [配置自定义域名](#配置自定义域名可选强烈推荐) 章节。

---

## 方式二：GitHub Actions 自动部署（推荐有经验用户）

通过 GitHub Actions 可以实现代码推送后自动部署，方便后续更新和版本管理。

### 步骤 1：Fork 仓库

1. 访问本项目的 GitHub 仓库页面
2. 点击右上角的 **Fork** 按钮
3. 选择你的 GitHub 账户，点击 **Create fork**
4. 等待 Fork 完成，你将拥有一个属于自己的仓库副本

### 步骤 2：获取 Cloudflare API Token

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)
2. 点击右上角的 **头像图标**
3. 选择 **My Profile**（我的个人资料）
4. 在左侧菜单中点击 **API Tokens**（API 令牌）
5. 点击 **Create Token**（创建令牌）按钮
6. 找到 **Edit Cloudflare Workers** 模板，点击 **Use template**（使用模板）
7. 在配置页面：
   - **Token name**（令牌名称）：可以保持默认或自定义
   - **Permissions**（权限）：确认包含 `Account > Workers Scripts > Edit` 和 `Account > D1 > Edit`
   - **Account Resources**（账户资源）：选择你的账户
   - **Zone Resources**（区域资源）：如果需要自定义域名，选择对应的域名区域；否则可以保持默认
8. 点击 **Continue to summary**（继续到摘要）
9. 点击 **Create Token**（创建令牌）
10. **立即复制并保存令牌值**！这个令牌只会显示一次，离开页面后将无法再查看

### 步骤 3：获取 Cloudflare Account ID

1. 在 [Cloudflare 控制台](https://dash.cloudflare.com/) 首页
2. 在左侧菜单点击 **Workers & Pages**
3. 在页面**右下角**可以看到 **Account ID**（账户 ID）
4. 复制并保存这个 ID

> **也可以通过 URL 获取**：登录 Cloudflare 后，查看浏览器地址栏，URL 中的那串字符就是你的 Account ID，格式类似：
> `https://dash.cloudflare.com/abc123def456...`

### 步骤 4：创建 D1 数据库

1. 在 Cloudflare 控制台左侧菜单点击 **Workers & Pages**
2. 在顶部标签栏点击 **D1**
3. 点击 **Create database**（创建数据库）
4. 数据库名称填写：`emby-proxy-db`
5. 点击 **Create**（创建）
6. 进入数据库详情页，点击 **Console** 标签
7. 粘贴并执行以下 SQL：

```sql
CREATE TABLE IF NOT EXISTS auto_emby_daily_stats (
    date TEXT PRIMARY KEY,
    playing_count INTEGER DEFAULT 0,
    playback_info_count INTEGER DEFAULT 0
);

CREATE TABLE IF NOT EXISTS aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias TEXT UNIQUE NOT NULL,
    created_at TEXT DEFAULT (datetime('now')),
    updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS alias_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    alias_id INTEGER NOT NULL,
    target_url TEXT NOT NULL,
    mode TEXT DEFAULT 'off',
    sort_order INTEGER DEFAULT 0,
    created_at TEXT DEFAULT (datetime('now')),
    FOREIGN KEY (alias_id) REFERENCES aliases(id) ON DELETE CASCADE
);
```

8. 记录 **Database ID**（在数据库详情页右侧信息面板中）

### 步骤 5：配置 GitHub Secrets

1. 打开你 Fork 的 GitHub 仓库页面
2. 点击 **Settings**（设置）标签
3. 在左侧菜单中展开 **Secrets and variables**，点击 **Actions**
4. 点击 **New repository secret**（新建仓库密钥）按钮
5. 逐个添加以下 Secrets：

| Secret 名称 | 值 | 说明 |
|-------------|------|------|
| `CLOUDFLARE_API_TOKEN` | 步骤 2 获取的 API Token | Cloudflare API 令牌 |
| `CLOUDFLARE_ACCOUNT_ID` | 步骤 3 获取的 Account ID | Cloudflare 账户 ID |
| `CLOUDFLARE_WORKER_NAME` | `emby-proxy` | Worker 名称（自定义，小写字母+数字+连字符） |

每添加一个 Secret 后点击 **Add secret** 保存，然后再添加下一个。

### 步骤 6：配置 Worker 环境变量

部署后还需要在 Cloudflare 控制台手动配置环境变量和 D1 绑定：

1. 首次部署完成后，登录 [Cloudflare 控制台](https://dash.cloudflare.com/)
2. 进入 **Workers & Pages**，找到刚创建的 Worker
3. 点击进入 Worker 详情页
4. 点击 **Settings** → **Variables and Secrets**
5. 添加变量 `ADMIN_TOKEN`，值为你自定义的管理密码，点击 **Encrypt** 加密
6. 点击 **Save and deploy**

### 步骤 7：绑定 D1 数据库

1. 在 Worker 的 **Settings** → **Bindings** 页面
2. 点击 **Add binding**，选择 **D1 database**
3. Variable name 填写：`DB`
4. D1 database 选择你创建的数据库
5. 点击 **Save and deploy**

### 步骤 8：触发部署

1. 在 GitHub 仓库页面，点击 **Actions**（操作）标签
2. 你会看到一个名为 **部署到Workers** 的工作流
3. 点击 **Run workflow**（运行工作流）按钮
4. 在弹出的下拉菜单中再次点击 **Run workflow**
5. 等待工作流运行完成（通常 1-2 分钟）
6. 看到绿色的勾号表示部署成功

### 步骤 9：后续更新

以后每次修改代码并推送到 `main` 或 `master` 分支时，GitHub Actions 会自动触发部署。你也可以随时在 Actions 页面手动触发部署。

---

## 配置自定义域名（可选，强烈推荐）

> **强烈建议配置自定义域名！** `workers.dev` 域名在国内无法访问。

### 前提条件

- 你已有一个域名，并且该域名的 DNS 已托管到 Cloudflare

### 配置步骤

1. 登录 [Cloudflare 控制台](https://dash.cloudflare.com/)
2. 进入你的 **Worker** 详情页
3. 点击 **Settings**（设置）标签
4. 在左侧菜单点击 **Domains & Routes**（域名和路由）
5. 点击 **Add**（添加）按钮
6. 选择 **Domain**（域名）
7. 输入你想使用的域名，例如：`emby.你的域名.com`
8. 点击 **Add domain**（添加域名）
9. Cloudflare 会自动为你配置 DNS 记录和 SSL 证书
10. 等待几分钟，域名即可生效

### 配置自定义域名（手动 DNS 方式）

如果你想使用子域名但不想通过 Cloudflare 的自动配置：

1. 进入 Cloudflare 的 **DNS** 设置页面
2. 添加一条 **CNAME** 记录：

| 字段 | 值 |
|------|------|
| 类型 | `CNAME` |
| 名称 | `emby`（或你想用的子域名） |
| 目标 | `你的Worker名称.你的用户名.workers.dev` |
| 代理状态 | 已代理（橙色云朵图标） |

3. 回到 Worker 的 **Settings** → **Domains & Routes**，添加该域名

---

## 部署后验证

部署完成后，按以下步骤验证是否成功：

### 1. 访问首页

在浏览器中打开你的 Worker 域名：

```
https://你的Worker域名/
```

应该能看到一个欢迎页面或延迟测试页面。

### 2. 访问管理后台

```
https://你的Worker域名/admin
```

- 输入你设置的 `ADMIN_TOKEN` 登录
- 如果能成功登录并看到管理界面，说明部署成功

### 3. 测试代理功能

在管理后台创建一个别名，然后访问：

```
https://你的Worker域名/你的别名
```

如果能正常打开 Emby 界面，说明代理功能正常。

### 4. 验证统计功能

访问以下地址查看统计数据：

```
https://你的Worker域名/stats
```

如果返回 JSON 数据，说明 D1 数据库配置正确。

---

## 常见问题

### Q1：访问 Worker 返回 404 或空白页面？

**原因**：Worker 可能没有正确部署。

**解决方案**：
- 确认 Worker 已经部署成功（在 Cloudflare 控制台能看到 Worker）
- 检查代码是否完整粘贴，没有遗漏
- 重新部署一次

### Q2：`workers.dev` 域名无法访问？

**原因**：`workers.dev` 域名在国内被墙。

**解决方案**：
- 配置自定义域名（推荐）
- 使用代理工具访问

### Q3：管理后台登录后提示 Token 错误？

**原因**：`ADMIN_TOKEN` 环境变量未正确配置。

**解决方案**：
- 进入 Worker → Settings → Variables and Secrets
- 确认 `ADMIN_TOKEN` 已添加且值正确
- 确认已点击 **Encrypt** 加密
- 保存后重新部署

### Q4：创建别名后无法访问？

**原因**：D1 数据库未正确绑定或表未创建。

**解决方案**：
- 确认 D1 数据库已绑定（Settings → Bindings → DB）
- 确认数据库中已执行建表 SQL（aliases 表和 alias_lines 表）
- 在管理后台的数据库状态中检查连接是否正常

### Q5：GitHub Actions 部署失败？

**可能原因及解决方案**：

1. **API Token 权限不足**：重新创建 Token，确保包含 Workers 和 D1 的编辑权限
2. **Account ID 错误**：检查 GitHub Secrets 中的 `CLOUDFLARE_ACCOUNT_ID` 是否正确
3. **Worker 名称不合法**：确保只使用小写字母、数字和连字符

### Q6：代理后 Emby 播放失败？

**可能原因**：
- 目标 Emby 服务器不可访问
- 目标服务器有防火墙限制
- 代理模式设置不正确

**解决方案**：
- 直接访问目标 Emby 服务器确认其正常运行
- 在别名线路设置中尝试切换代理模式（`off` 或 `dual`）
- 检查 Worker 日志排查具体错误

### Q7：如何查看 Worker 运行日志？

**方式一：Cloudflare 控制台**
1. 进入 Worker 详情页
2. 点击 **Logs**（日志）标签
3. 开启 **Live tail**（实时日志）

**方式二：Wrangler CLI**

确保已安装 Node.js，然后运行：

```bash
npx wrangler tail --format pretty
```

### Q8：Cloudflare 免费账户有什么限制？

| 资源 | 免费额度 |
|------|---------|
| 请求数 | 每天 100,000 次 |
| CPU 时间 | 每次请求 10ms |
| D1 数据库存储 | 5GB |
| D1 数据库读取 | 每天 500 万行 |
| D1 数据库写入 | 每天 10 万行 |

对于个人 Emby 使用来说，免费额度完全够用。如果不够，可以考虑升级到 Workers Paid 计划（$5/月）。

---

## 更新日志

- **v3.0**：新增别名管理、多线路故障转移、管理后台、D1 数据库统计
- **v2.5**：集成 D1 数据库统计功能，优化重定向处理
- **v2.0**：优化性能，修复重定向问题
- **v1.0**：初始版本，基础反向代理功能

---

**声明**：本工具仅用于学习和研究目的，请勿用于非法用途。使用本工具产生的一切后果由使用者自行承担。
