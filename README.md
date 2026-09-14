# 个人主页 & 博客

[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)
![Python](https://img.shields.io/badge/Python-3.10%2B-blue)
![Flask](https://img.shields.io/badge/Flask-3.x-black)

一个**克隆即用、按需改造**的个人站点：主页 + 项目展示 + 博客 + 管理后台。

Flask 服务端渲染，内容用 Markdown + YAML front matter 管理，**没有数据库、没有构建步骤、
没有前端框架**。改一行 CSS 变量就能换肤，改一个 YAML 文件就能换站点信息，
`git push` 一次就能上线。

> 本项目已去除所有个人化配置（域名、昵称、服务器路径），
> 下面所有 `example.com`、`/srv/blog`、`blog` 都是可替换的占位值。

---

## 目录

- [特性](#特性)
- [技术栈](#技术栈)
- [快速开始](#快速开始)
- [项目结构](#项目结构)
- [内容即文件](#内容即文件)
- [写文章与项目管理](#写文章与项目管理)
- [客制化指南](#客制化指南)
- [环境变量一览](#环境变量一览)
- [部署到自己的服务器](#部署到自己的服务器)
- [日常运维](#日常运维)
- [安全设计](#安全设计)
- [常见问题](#常见问题)
- [参与贡献](#参与贡献)
- [许可证](#许可证)

---

## 特性

| 能力 | 说明 |
| --- | --- |
| **无数据库** | 内容就是 `.md` / `.yml` 文件。备份 = 复制目录，迁移 = 拷到新机器，回滚 = `git checkout` |
| **可视化后台** | 登录 `/admin` 即可增删改文章、项目与站点信息，支持 Markdown 实时预览与图片上传 |
| **草稿与敏感内容** | `draft: true` 表示「还没写完」，`sensitive: true` 表示「永不对外输出」，两者对外都是 404 |
| **预览模式** | 登录后一键在**公开页面**上查看草稿，页面顶部有橙色横幅提示，并自动 `noindex` |
| **SEO / 订阅开箱可用** | `sitemap.xml`、`atom.xml`、canonical 链接、`robots.txt` 全自动生成 |
| **一个变量表换肤** | `static/css/site.css` 顶部的 `:root` 变量控制全部配色、圆角与阴影，内置明暗主题切换 |
| **push 即部署** | 附带 `post-receive` 钩子、systemd 单元与 nginx 示例，一次 `git push` 完成上线 |
| **安全默认值** | CSRF 校验、登录失败限流、签名会话 cookie、上传三重校验、systemd 沙箱 |
| **零外部请求** | 不引用 CDN、外部字体或图标库，首屏不产生额外网络请求 |

## 技术栈

| 层 | 选型 | 为什么 |
| --- | --- | --- |
| Web | Flask + Jinja2 | 服务端渲染，SEO 友好，无构建步骤 |
| 内容 | Markdown + YAML front matter | 可 diff、可迁移、备份即 `clone` |
| 渲染 | Python-Markdown + Pygments | 目录、代码高亮、表格、提示块、脚注 |
| 图像 | Pillow | 上传时真实解码校验，而非只看扩展名 |
| 进程 | gunicorn（1 worker / 4 threads） + systemd | 内容层用进程内缓存，单进程避免多 worker 缓存不一致 |
| 反向代理 | nginx → `127.0.0.1:8080` | 应用只监听本机，不直接对公网暴露 |

## 快速开始

需要 **Python 3.10+**（推荐 3.11 / 3.12）。

```bash
git clone https://github.com/Starst796/blog.git
cd blog

python -m venv .venv
source .venv/bin/activate       # Windows: .venv\Scripts\activate
pip install -r requirements.txt

cp .env.example .env
python manage.py init           # 生成 SECRET_KEY，补齐 .env
python manage.py set-password   # 交互式设置后台密码，只保存哈希

python wsgi.py                  # http://127.0.0.1:8080
```

仓库内自带示例内容（`content/`），启动后主页、文章、项目页都有东西可看。

> **本地用 http 时**，`.env` 里要有 `SESSION_COOKIE_SECURE=0`，
> 否则浏览器不会回传会话 cookie，后台登录会一直跳回登录页。
> `.env.example` 中该项已默认为 `0`，上线时记得改回 `1`。

### 进入管理后台

浏览器打开 <http://127.0.0.1:8080/admin>，用 `manage.py set-password` 设置的账号密码登录。

首次启动若还没设置密码，登录页会提示你回到终端执行 `python manage.py set-password`。

## 项目结构

```text
.
├── app.py                     应用工厂：日志、模板过滤器、错误处理、蓝图装配
├── views.py                   公开路由：主页 / 项目 / 文章 / 订阅源 / SEO
├── admin.py                   管理后台：登录、CRUD、图片上传、预览模式
├── content.py                 内容层：读 Markdown、渲染 HTML、进程内缓存
├── config.py                  全部可调参数（均可用环境变量覆盖）
├── manage.py                  运维脚本：init / set-password / status / init-content
├── wsgi.py                    WSGI 入口（gunicorn 与本地开发共用）
├── content/                   内容目录（默认位置，可改到仓库外）
│   ├── site.yml               站点信息：名称、简介、头像、导航、社交链接
│   ├── articles/*.md          文章，文件名即 URL slug
│   ├── projects/*.md          项目，文件名即 URL slug
│   └── uploads/YYYY/MM/       后台上传的图片
├── templates/                 Jinja2 模板（公开页面在根目录，后台在 admin/）
├── static/                    CSS / JS / 图标
├── deploy/
│   ├── install.sh             一键渲染并安装 systemd 单元、sudoers、部署钩子
│   ├── blog.service.template  systemd 单元模板
│   ├── post-receive.template  git push 自动部署钩子模板
│   ├── blog-sudoers.template  免密重启授权模板
│   └── nginx.conf.example     nginx 反向代理示例
├── .env.example               环境变量模板
└── requirements.txt
```

## 内容即文件

### 文章 `content/articles/<slug>.md`

```yaml
---
title: 标题
date: 2026-09-10
updated: 2026-09-20        # 可选
summary: 一句话摘要         # 留空则自动截取正文首段
tags: [Flask, 随笔]
draft: false              # true 时不出现在站点与订阅源中
sensitive: false          # true 时任何情况下都不对外输出
cover: uploads/2026/09/cover.png   # 可选，也接受外链
---

正文，支持标准 Markdown。
```

正文支持的语法：表格、围栏代码块与高亮、脚注、定义列表、缩写、
`!!! note "标题"` 形式的提示块、`##`~`####` 自动生成中文锚点的目录。

### 项目 `content/projects/<slug>.md`

```yaml
---
title: 项目名
status: 进行中            # 进行中 / 已完成 / 已归档
period: 2026-03 ~ 至今
summary: 一句话简介
stack: [Python, Flask]
featured: true           # 主页「近期项目」优先展示
order: 1                 # 数字越小越靠前
links:
  - { label: GitHub, url: "https://github.com/..." }
  - { label: 在线预览, url: "https://example.com" }
---
```

### 站点信息 `content/site.yml`

控制主页 hero 区域、头像、社交链接与顶部导航，也可以直接在 `/admin/site` 可视化编辑。

`slug` 即文件名，只允许小写字母、数字与连字符（正则 `^[a-z0-9][a-z0-9-]{0,80}$`），
从源头杜绝路径穿越。

## 写文章与项目管理

登录 `/admin` 后可用的功能：

- **内容**：文章与项目的新建 / 编辑 / 删除，含 slug 重命名（旧文件自动清理）
- **写文章 / 新建项目**：Markdown 实时预览、一键上传图片并插入链接
- **站点信息**：名称、标语、简介、所在地、邮箱、头像、社交链接
- **预览草稿与敏感内容**：在公开页面上直接看到未发布内容

### 草稿、敏感内容与预览模式

| 标记 | 含义 | 谁会看到 |
| --- | --- | --- |
| 无标记 | 已发布 | 所有人 |
| `draft: true` | 还没写完 | 仅你在预览模式下 |
| `sensitive: true` | 写完了但不打算公开（如含凭据的运维手册） | 仅你在预览模式下 |

两者对外表现一致，区别只在语义：`draft` 表示「以后可能发布」，
`sensitive` 表示「永远不对外输出」。即使误把 `draft` 改成 `false`，
`sensitive` 的内容也不会泄露——`content.py` 中对它是硬过滤，
而且 `sitemap.xml`、`atom.xml` **无论何时**都只输出已发布内容。

预览期间：

- 页面顶部始终有一条橙色横幅，避免把预览效果误当成线上真实效果；
- 响应带 `X-Robots-Tag: noindex, nofollow`，爬虫不会收录；
- 开关只存在你自己的浏览器会话里，其他访客看到的仍是公开版本。

### 登录状态如何保存

登录态是一个**签名 cookie**（`blog_session`），用 `.env` 里的 `SECRET_KEY` 签名，
服务端不存任何会话数据（无数据库、无会话表）。因此：

- `sudo systemctl restart` **不会**让你掉线；
- 重新生成 `SECRET_KEY`（重跑 `manage.py init`）会让所有会话立即失效；
- 有效期 7 天，属性为 `HttpOnly` + `Secure` + `SameSite=Lax`。

## 客制化指南

**绝大多数改造只需要动配置，不需要改代码。** 按下表找到对应位置：

| 我想改… | 改哪里 | 怎么做 |
| --- | --- | --- |
| 站点名称、标语、简介、所在地、邮箱 | `content/site.yml` | 后台 `/admin/site` 可视化编辑，或直接改文件 |
| 头像、社交链接 | `content/site.yml` | 头像在后台点「上传」；社交链接按 `名称 URL` 每行一条 |
| 顶部导航菜单 | `content/site.yml` 的 `nav` | 增删 `{ label, url }` 即可，支持外链 |
| 域名、语言、时区、端口、分页 | `.env` | 见[环境变量一览](#环境变量一览) |
| **整体配色与风格** | `static/css/site.css` | 只改文件顶部「1. 设计令牌」的 `:root` 变量 |
| 页面文案（按钮、空状态、页脚） | `templates/*.html` 与 `templates/_macros.html` | 纯 HTML，直接改文字 |
| 页面结构与排版 | `templates/` | 修改模板或新增 Jinja 块 |
| 内容存放位置 | `.env` 的 `CONTENT_DIR` | 生产环境建议指向部署树之外 |
| 路由与页面功能 | `views.py` | 用 `@bp.get("/path")` 添加新页面 |
| 后台功能 | `admin.py` | 蓝图前缀 `/admin`，新增表单参考 `article_form.html` |
| Markdown 能力（目录深度、提示块…） | `content.py` 的 `_markdown()` | 调整扩展列表与 `extension_configs` |

### 换个配色（30 秒）

打开 `static/css/site.css`，把主色改成你的品牌色即可，明暗两套主题都会跟着变：

```css
:root {                     /* 深色主题 */
  --primary: #5865f2;       /* 主色：按钮、链接、强调 */
  --primary-strong: #4752e0;
  --accent: #8ea1ff;
  --radius: 16px;           /* 圆角，调小更硬朗，调大更柔和 */
  --container: 1040px;      /* 内容区最大宽度 */
}
:root[data-theme="light"] { /* 浅色主题 */
  --primary: #4f6bed;
}
```

改完重启服务即可生效（静态资源带进程启动时间的版本号，浏览器会自动拉新）。

### 换掉项目名称

仓库名、README 标题、`LICENSE` 里的版权人、页脚文案，按需替换。
`templates/base.html` 中的 `<meta name="theme-color">` 也可以改成与新配色一致的值。

## 环境变量一览

所有变量都写在 `.env`（从 `.env.example` 复制），**未设置时使用 `config.py` 中的默认值**。

| 变量 | 默认值 | 说明 |
| --- | --- | --- |
| `SITE_URL` | `http://127.0.0.1:8080` | 对外地址，用于 canonical / sitemap / atom。**上线必须改**，否则会打到 localhost（启动日志会提醒） |
| `SITE_ICP` | `` | 该网址的备案号，用于在 footer 中显示 |
| `SITE_LANG` | `zh-CN` | `<html lang="…">` |
| `SITE_TZ_OFFSET` | `+08:00` | Atom 输出中的时区偏移 |
| `CONTENT_DIR` | 仓库内的 `content/` | 内容目录。生产建议指向部署树之外，如 `/srv/blog/content` |
| `HOST` / `PORT` | `127.0.0.1` / `8080` | 监听地址，一般由 nginx 反向代理 |
| `FLASK_DEBUG` | `0` | `1` 开启调试与自动重载，**不要用于生产** |
| `SESSION_COOKIE_SECURE` | `true` | 生产 https 必须为 `1`；本地 http 调试设为 `0` |
| `PAGE_SIZE` | `10` | 文章列表每页篇数 |
| `HOMEPAGE_LIMIT` | `3` | 主页展示的项目数与文章数 |
| `LOGIN_ATTEMPT_IP_LIMIT` | `8` | 登录失败限流阈值（次） |
| `LOGIN_ATTEMPT_IP_WINDOW` | `300` | 限流窗口（秒） |
| `SECRET_KEY` | 自动生成 | 由 `manage.py init` 写入，**不要手工填写，也不要提交** |
| `ADMIN_USERNAME` | `admin` | 后台账号，由 `manage.py` 维护 |
| `ADMIN_PASSWORD_HASH` | — | 由 `manage.py set-password` 写入，仅保存 werkzeug 哈希 |

## 部署到自己的服务器

下面以 Ubuntu/Debian、用户 `blog`、目录 `/srv/blog`、域名 `example.com` 为例，
全部路径与用户名都可以替换。

### 1. 建用户与目录

```bash
sudo useradd -r -m -d /srv/blog -s /bin/bash blog
sudo -u blog mkdir -p /srv/blog/program /srv/blog/content
sudo -u blog git init --bare -b main /srv/blog/blog.git
```

### 2. 一键安装服务与部署钩子

把代码放到服务器上任意位置（例如直接 `git clone` 一份），然后执行：

```bash
# 先预览会生成什么（不需要 root）
bash deploy/install.sh --dry-run \
    --app-dir /srv/blog/program \
    --venv-dir /srv/blog/venv \
    --content-dir /srv/blog/content \
    --user blog --service blog --domain example.com

# 确认无误后正式安装
sudo bash deploy/install.sh \
    --app-dir /srv/blog/program \
    --venv-dir /srv/blog/venv \
    --content-dir /srv/blog/content \
    --user blog --service blog --domain example.com \
    --bare-repo /srv/blog/blog.git
```

脚本会：

1. 把 `deploy/*.template` 中的占位符替换成你的路径与用户名；
2. 安装 `/etc/systemd/system/blog.service`（含防写入沙箱）；
3. 安装 `/etc/sudoers.d/blog`（仅供钩子免密重启本服务，并用 `visudo -c` 校验）；
4. 安装 `/srv/blog/blog.git/hooks/post-receive` 部署钩子。

> 不想用脚本也可以：`--dry-run` 的产物在 `deploy/out/`，手工
> `install -m 0644 deploy/out/blog.service /etc/systemd/system/` 等即可。

### 3. 推送代码并准备运行环境

在**本地**仓库添加部署远端并推送：

```bash
git remote add deploy ssh://blog@example.com/srv/blog/blog.git
git push deploy main
```

钩子会把代码检出到 `/srv/blog/program`、按需同步依赖、重启服务。
接着在服务器上创建虚拟环境并写入机密配置：

```bash
cd /srv/blog/program
python3 -m venv /srv/blog/venv
/srv/blog/venv/bin/pip install -r requirements.txt

# 生成 .env：至少设置 SITE_URL 与 CONTENT_DIR
cp .env.example .env
# 编辑 .env：SITE_URL=https://example.com、CONTENT_DIR=/srv/blog/content、
#            SESSION_COOKIE_SECURE=1
/srv/blog/venv/bin/python manage.py set-password

sudo chown -R blog:blog /srv/blog
sudo systemctl enable --now blog.service
curl -s localhost:8080/healthz     # {"status":"ok"}
```

> `.env` 与 `venv/` 都是未跟踪文件，`git checkout -f` 不会删除它们，
> 因此后续部署不会冲掉配置。

### 4. 配置 nginx 与 HTTPS

```bash
sudo cp deploy/nginx.conf.example /etc/nginx/sites-available/blog
sudo sed -i 's|example\.com|你的域名|g' /etc/nginx/sites-available/blog
sudo ln -s /etc/nginx/sites-available/blog /etc/nginx/sites-enabled/blog
sudo nginx -t && sudo systemctl reload nginx

sudo apt install certbot python3-certbot-nginx
sudo certbot --nginx -d 你的域名
```

记得把 nginx 配置里的 `alias` 路径改成你自己的
（`/srv/blog/program/static/` 与 `/srv/blog/content/uploads/`）。

### 5. 以后每次发布

```bash
git add -A && git commit -m "更新文章"
git push deploy main
```

钩子自动完成：检出 → 依赖有变化时同步 → 重启服务。

### 可选：让内容也纳入版本控制

若希望每篇文章的每次保存都能 diff 与回滚，可把内容目录初始化为独立 git 仓库
（**建议只对部署树之外的内容目录这么做**，避免与代码仓库嵌套）：

```bash
/srv/blog/venv/bin/python manage.py init-content \
    --path /srv/blog/content --author 你的名字 --email you@example.com
```

此后在后台每保存一次，都会自动生成一个提交。

## 日常运维

```bash
sudo systemctl status blog.service
sudo journalctl -u blog.service -f          # 实时日志
curl -s localhost:8080/healthz              # 健康检查

python manage.py status                     # 查看密钥与账号配置状态
git -C /srv/blog/content log --oneline      # 内容改动历史（若已 init-content）
```

回滚某一篇文章：

```bash
git -C /srv/blog/content log --oneline -- articles/xxx.md
git -C /srv/blog/content checkout <commit> -- articles/xxx.md
```

忘记后台密码：

```bash
cd /srv/blog/program
/srv/blog/venv/bin/python manage.py set-password
sudo systemctl restart blog.service
```

## 安全设计

- 密码只存 werkzeug 哈希，写在 `.env`（`chmod 600`，已被 `.gitignore` 排除）；明文不经过命令行参数。
- 会话 cookie：`HttpOnly` + `Secure` + `SameSite=Lax`，仅存一个布尔标记。
- 所有写操作校验一次性 CSRF token；登录失败按来源 IP 限流（默认 5 分钟 8 次）。
- 登录跳转只接受以 `/admin` 开头的 `next`，防止开放重定向。
- 图片上传按扩展名、MIME、Pillow 实际解码三重校验，并重命名后按年月分目录存放。
- slug 正则白名单 + `send_from_directory`，双重防路径穿越。
- `/admin` 全部响应带 `X-Robots-Tag: noindex`，且已被 `robots.txt` 排除。
- systemd 单元限制进程可写范围（`ProtectHome=read-only` + `ReadWritePaths` 仅内容目录）。
- 应用只监听 `127.0.0.1`，公网流量必须经过 nginx。

## 常见问题

<details>
<summary><b>本地登录后台一直跳回登录页</b></summary>

本地用 http 访问时，`Secure` cookie 不会被浏览器回传。请在 `.env` 中设置
`SESSION_COOKIE_SECURE=0`，重启进程后重试。
</details>

<details>
<summary><b>改了 CSS / JS 但浏览器没更新</b></summary>

静态资源 URL 带进程启动时间的版本号，重启服务即可让所有访客拉到新文件：
`sudo systemctl restart blog.service`。
</details>

<details>
<summary><b>sitemap / 分享链接里是 localhost</b></summary>

`SITE_URL` 没设置。在 `.env` 里写上真实域名（带 `https://`、不带末尾斜杠）。
启动日志里也会有一条 WARNING 提醒。
</details>

<details>
<summary><b>上传的图片打不开（404）</b></summary>

生产环境由 nginx 直接返回 `/uploads/`，检查 nginx 配置中的 `alias` 是否指向
`CONTENT_DIR/uploads/`。本地开发由 Flask 路由提供，确认文件确实存在
`content/uploads/YYYY/MM/` 下。
</details>

<details>
<summary><b>中文标题生成的文件名为什么是 <code>post-20260101</code></b></summary>

slug 白名单只允许小写字母、数字与连字符（避免 URL 编码与路径问题），
中文标题会被压缩为空，于是回退为日期式命名。建议在编辑页手动填一个英文 slug，
它同时决定文章的永久链接。
</details>

<details>
<summary><b>部署后线上写作的内容被覆盖了</b></summary>

说明 `CONTENT_DIR` 落在了部署树内，而钩子会 `git checkout -f`。
把内容目录移到部署树之外（如 `/srv/blog/content`）并更新 `.env` 即可。
</details>

<details>
<summary><b>能不能多作者 / 多用户</b></summary>

本项目刻意保持单用户（无数据库）。多用户需要引入真正的存储与权限模型，
那已经超出「文件即内容」的设计范围，建议改用其它方案。
</details>

<details>
<summary><b>Markdown 里的 HTML 会被过滤吗</b></summary>

不会。站点只有一个可信作者，因此不做 HTML 消毒（也正因此可以自由嵌入 HTML）。
若将来开放投稿，请先引入 `nh3` 一类的消毒步骤。
</details>

<details>
<summary><b><code>site.yml</code> 里手写的注释保存后没了</b></summary>

后台保存会用 `yaml.safe_dump` 整体重写该文件。需要长期保留的说明请写在
文件开头固定的那段说明头里（`content.py` 的 `SITE_FILE_HEADER`）。
</details>

## 参与贡献

欢迎提交 Issue 与 Pull Request，请先阅读 [CONTRIBUTING.md](CONTRIBUTING.md)。