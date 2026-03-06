# 负结果通讯 — Negative Results Review

> 一个非正式学术交流与电子选刊平台，专注于记录和展示科研中的失败、被拒、无法复现等"负结果"内容。

## 项目简介

《负结果通讯》（NRR）是一个面向学术研究者的投稿与发布平台。在科研中，大量有价值的"负结果"——实验失败、方法翻车、论文被拒、无法复现的发现——往往被忽视和丢弃。本平台旨在为这些"不成功"的经验提供一个非正式的记录与交流空间。

平台采用 **Node.js + Express + EJS + MySQL** 技术栈，前后端一体化，无需额外前端框架，部署简单。

## 功能特性

### 前台（面向公众）

- **首页展示**：平台介绍、栏目导航、专题内容、最新入选稿件、编辑原则、投稿入口
- **在线投稿**：支持匿名 / 笔名 / 实名三种署名方式，填写标题、学科、栏目、正文和价值说明后提交
- **稿件追踪**：通过投稿编号（如 `NRR-2026-001`）查询审稿进度，退修时可查看编辑意见
- **文章归档**：按栏目、年份、精选等条件筛选和浏览已发布文章，支持关键词搜索和分页
- **文章详情**：查看已发布文章的完整内容、标签、编辑短评
- **关于页面**：平台宗旨、记录范围、非正式声明、编辑原则、匿名与脱敏说明

### 后台（面向编辑）

- **仪表盘**：稿件统计概览（各状态数量）、最新投稿列表
- **稿件管理**：按状态、栏目、风险等级筛选，支持搜索、排序、分页
- **稿件详情编辑**：
  - 修改标题和正文（用于脱敏处理）
  - 设置风险等级（低 / 中 / 高）和脱敏状态
  - 管理标签（逗号分隔）
  - 标记为精选 / 置顶 / 编辑推荐 / 加热中
  - 填写编辑备注（退修时作者可见）
- **状态流转**：待审 → 审核中 → 退修/录用/拒稿 → 发布 → 归档，支持状态重置
- **密码管理**：修改管理员密码（最少 6 位）

### 安全特性

- **CSRF 防护**：所有 POST 请求需携带 CSRF Token
- **投稿限流**：每 IP 每小时最多 5 次投稿
- **密码安全**：使用 bcrypt 哈希存储
- **会话管理**：8 小时自动过期

## 栏目设置

| 栏目 | 说明 |
|------|------|
| 负结果档案 | 记录实验中的负面发现 |
| 废稿回收站 | 被拒稿件的二次展示 |
| 方法翻车实录 | 失败的研究方法记录 |
| Reviewer 鬼话档案 | 审稿意见中的奇葩评论 |
| 选题尸检报告 | 被放弃课题的反思 |
| 学术情绪标本室 | 科研过程中的情绪记录 |
| 年度学术垃圾奖 | 年度"最佳"失败评选 |

## 稿件状态流转

```
投稿 → 待审(pending)
         ↓
      审核中(under_review)
       ↓      ↓       ↓
   退修    已录用    已拒稿
(revision) (accepted) (rejected)
     ↓         ↓
  重新审核   已发布(published)
                ↓
            已归档(archived)
```

## 技术栈

- **运行环境**：Node.js >= 16
- **Web 框架**：Express 4.x
- **模板引擎**：EJS
- **数据库**：MySQL 5.7+ / 8.0+
- **密码加密**：bcryptjs
- **会话管理**：express-session
- **限流**：express-rate-limit

## 快速开始（本地开发）

```bash
# 1. 克隆仓库
git clone https://github.com/wuya521/negative-results-review.git
cd negative-results-review

# 2. 安装依赖
npm install

# 3. 配置环境变量
cp .env.example .env
# 编辑 .env，填入你的 MySQL 连接信息和会话密钥

# 4. 确保 MySQL 已运行，并创建数据库
mysql -u root -p -e "CREATE DATABASE IF NOT EXISTS nrr DEFAULT CHARACTER SET utf8mb4;"

# 5. 启动项目（首次启动会自动建表和插入默认数据）
npm start

# 6. 访问
# 前台：http://localhost:3000
# 后台：http://localhost:3000/admin/login
# 默认管理员：admin / admin2026
```

## 环境变量说明

在项目根目录创建 `.env` 文件（参考 `.env.example`）：

```env
# 数据库配置
DB_HOST=127.0.0.1          # MySQL 主机地址
DB_PORT=3306                # MySQL 端口
DB_USER=root                # MySQL 用户名
DB_PASSWORD=your_password   # MySQL 密码
DB_NAME=nrr                 # 数据库名称

# 应用配置
SESSION_SECRET=your-random-secret-key  # 会话密钥，请使用随机字符串
PORT=3000                              # 服务端口
```

## 宝塔面板部署指南

### 前置要求

- 已安装宝塔面板（https://www.bt.cn）
- 已安装 Nginx
- 已安装 MySQL 5.7+ 或 8.0
- 已安装 PM2 管理器（在宝塔软件商店中安装）
- 已安装 Node.js（建议 >= 16，在宝塔 PM2 管理器中可安装）

### 第一步：创建数据库

1. 登录宝塔面板
2. 进入 **数据库** → **添加数据库**
3. 填写：
   - 数据库名：`nrr`（或自定义名称）
   - 用户名：`nrr`（或自定义）
   - 密码：设置一个强密码
   - 编码：选择 `utf8mb4`
4. 点击 **提交**

### 第二步：上传项目代码

**方式一：通过 Git 拉取（推荐）**

1. 通过宝塔终端或 SSH 连接服务器
2. 执行以下命令：

```bash
cd /www/wwwroot
git clone https://github.com/wuya521/negative-results-review.git
cd negative-results-review
npm install --production
```

**方式二：手动上传**

1. 在宝塔 **文件** 管理器中，进入 `/www/wwwroot/`
2. 上传项目压缩包并解压
3. 通过终端进入项目目录执行 `npm install --production`

### 第三步：配置环境变量

1. 在项目根目录创建 `.env` 文件：

```bash
cd /www/wwwroot/negative-results-review
cp .env.example .env
```

2. 编辑 `.env` 文件，填入第一步创建的数据库信息：

```env
DB_HOST=127.0.0.1
DB_PORT=3306
DB_USER=nrr
DB_PASSWORD=你的数据库密码
DB_NAME=nrr

SESSION_SECRET=这里填一串随机字符串建议32位以上
PORT=3000
```

> 提示：可用 `openssl rand -hex 32` 生成随机密钥

### 第四步：使用 PM2 启动项目

1. 打开宝塔 **软件商店** → **PM2 管理器**
2. 点击 **添加项目**
3. 配置：
   - 启动文件：`/www/wwwroot/negative-results-review/server.js`
   - 项目名称：`negative-results-review`
   - 运行目录：`/www/wwwroot/negative-results-review`
4. 点击 **提交**，项目将自动启动

或者通过命令行：

```bash
cd /www/wwwroot/negative-results-review
pm2 start server.js --name "nrr"
pm2 save
pm2 startup   # 设置开机自启
```

### 第五步：配置 Nginx 反向代理

1. 在宝塔 **网站** → **添加站点**
2. 填写你的域名（如 `nrr.yourdomain.com`）
3. 创建完成后，点击站点名称进入设置
4. 进入 **反向代理** → **添加反向代理**
5. 配置：
   - 代理名称：`nrr`
   - 目标 URL：`http://127.0.0.1:3000`
   - 发送域名：`$host`
6. 点击 **提交**

或者手动编辑 Nginx 配置，在 `server` 块中添加：

```nginx
location / {
    proxy_pass http://127.0.0.1:3000;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
    proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    proxy_set_header X-Forwarded-Proto $scheme;
}
```

### 第六步：配置 SSL（可选但推荐）

1. 在站点设置中，进入 **SSL**
2. 选择 **Let's Encrypt** 免费证书
3. 勾选域名，点击 **申请**
4. 开启 **强制 HTTPS**

### 部署完成

- 前台访问：`https://你的域名/`
- 后台登录：`https://你的域名/admin/login`
- 默认管理员账号：`admin`，密码：`admin2026`

> ⚠️ **重要**：首次部署后请立即登录后台修改默认密码！

### 常见问题

**Q: 启动后无法访问？**
- 检查宝塔防火墙是否放行了 3000 端口（使用反向代理则无需放行）
- 检查 PM2 中项目是否正常运行：`pm2 status`
- 查看错误日志：`pm2 logs nrr`

**Q: 数据库连接失败？**
- 确认 `.env` 中的数据库用户名和密码是否正确
- 确认 MySQL 服务是否正常运行
- 确认数据库用户有足够权限

**Q: 如何更新版本？**
```bash
cd /www/wwwroot/negative-results-review
git pull
npm install --production
pm2 restart nrr
```

## 项目结构

```
negative-results-review/
├── db/
│   └── init.js              # 数据库初始化（建表、迁移、种子数据）
├── middleware/
│   └── auth.js              # 登录认证中间件
├── public/
│   ├── admin.css            # 后台样式
│   ├── script.js            # 前台交互脚本
│   └── style.css            # 前台样式
├── routes/
│   ├── admin.js             # 后台路由
│   └── public.js            # 前台路由
├── views/
│   ├── admin/               # 后台页面模板
│   │   ├── partials/        # 后台公共组件
│   │   ├── dashboard.ejs    # 仪表盘
│   │   ├── detail.ejs       # 稿件详情
│   │   ├── login.ejs        # 登录页
│   │   ├── manuscripts.ejs  # 稿件列表
│   │   └── password.ejs     # 修改密码
│   ├── partials/            # 前台公共组件
│   ├── about.ejs            # 关于页
│   ├── archive.ejs          # 归档列表
│   ├── article.ejs          # 文章详情
│   ├── index.ejs            # 首页
│   ├── submit.ejs           # 投稿页
│   └── track.ejs            # 追踪页
├── .env.example             # 环境变量示例
├── .gitignore
├── package.json
└── server.js                # 应用入口
```

## 开源协议

MIT License
