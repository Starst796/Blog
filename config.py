"""站点配置。

所有可调参数集中在此处，并可用环境变量覆盖；机密信息（SECRET_KEY、
ADMIN_PASSWORD_HASH）只从 .env 读取，绝不写入仓库。

开箱即用：不配置任何环境变量也能在本地跑起来（内容目录默认为仓库内的
``content/``，站点名称取自 ``content/site.yml``）。部署到生产环境时，把
``.env.example`` 复制为 ``.env``，至少设置 ``SITE_URL``。
"""

import os
from datetime import timedelta
from pathlib import Path

from dotenv import load_dotenv

BASE_DIR = Path(__file__).resolve().parent

# .env 位于项目根目录，已被 .gitignore 排除
load_dotenv(BASE_DIR / ".env")


def _as_bool(raw: str | None, default: bool = False) -> bool:
    if raw is None or raw.strip() == "":
        return default
    return raw.strip().lower() in {"1", "true", "yes", "on"}


class Config:
    """Flask 配置对象。"""

    # ---------- 站点 ----------
    # 对外访问地址，用于 canonical / sitemap.xml / atom.xml。末尾斜杠会被去掉。
    # 默认值仅供本地开发；上线前请改成真实域名，否则搜索结果会指向 localhost。
    SITE_URL = os.environ.get("SITE_URL", "http://127.0.0.1:8080").rstrip("/")
    SITE_ICP = os.environ.get("SITE_ICP", "")
    # <html lang="…">，同时影响部分搜索引擎与屏幕阅读器的语言判定
    SITE_LANG = os.environ.get("SITE_LANG", "zh-CN")
    # 内容按「自然日」处理，此处只影响输出到 atom.xml 的时区偏移
    SITE_TZ_OFFSET = os.environ.get("SITE_TZ_OFFSET", "+08:00")

    # ---------- 安全 ----------
    SECRET_KEY = os.environ.get("SECRET_KEY", "")

    # ---------- 内容目录 ----------
    # 默认放在仓库内的 content/，clone 下来即可运行。
    # 生产环境建议用 CONTENT_DIR 指向部署树之外（如 /srv/blog/content）：
    # 部署脚本 checkout 时不会触碰该目录，写作与发版互不干扰。
    CONTENT_DIR = Path(
        os.environ.get("CONTENT_DIR") or (BASE_DIR / "content")
    ).resolve()

    # ---------- 监听 ----------
    HOST = os.environ.get("HOST", "127.0.0.1")
    PORT = int(os.environ.get("PORT", "8080"))
    DEBUG = _as_bool(os.environ.get("FLASK_DEBUG"), False)

    # ---------- 管理后台 ----------
    ADMIN_USERNAME = os.environ.get("ADMIN_USERNAME", "admin")
    ADMIN_PASSWORD_HASH = os.environ.get("ADMIN_PASSWORD_HASH", "")
    SESSION_COOKIE_NAME = "blog_session"
    SESSION_COOKIE_HTTPONLY = True
    SESSION_COOKIE_SAMESITE = "Lax"
    # 生产走 https，必须为 True；本地 http 调试时可设 SESSION_COOKIE_SECURE=0
    SESSION_COOKIE_SECURE = _as_bool(os.environ.get("SESSION_COOKIE_SECURE"), True)
    PERMANENT_SESSION_LIFETIME = timedelta(days=7)
    MAX_CONTENT_LENGTH = 10 * 1024 * 1024  # 与 nginx client_max_body_size 10m 对齐

    # ---------- 上传 ----------
    ALLOWED_IMAGE_EXT = {"png", "jpg", "jpeg", "gif", "webp", "avif"}
    ALLOWED_IMAGE_MIME = {
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/avif",
    }

    # ---------- 列表 ----------
    PAGE_SIZE = int(os.environ.get("PAGE_SIZE", "10"))
    HOMEPAGE_LIMIT = int(os.environ.get("HOMEPAGE_LIMIT", "3"))

    # ---------- 登录限流 ----------
    LOGIN_ATTEMPT_IP_LIMIT = int(os.environ.get("LOGIN_ATTEMPT_IP_LIMIT", "8"))
    LOGIN_ATTEMPT_IP_WINDOW = int(os.environ.get("LOGIN_ATTEMPT_IP_WINDOW", "300"))
