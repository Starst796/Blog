"""Flask 应用工厂。

职责划分：
- ``app.py``    组装应用：日志、模板过滤器、全局上下文、错误处理、蓝图注册
- ``views.py``  公开页面（主页 / 项目 / 文章 / 订阅 / SEO）
- ``admin.py``  管理后台（登录、内容增删改、图片上传）
- ``content.py`` Markdown 内容层
"""

from __future__ import annotations

import logging
import secrets
import sys
from datetime import datetime
from pathlib import Path

from flask import Flask, render_template, request, session
from werkzeug.exceptions import HTTPException

import content
from config import Config

# 静态资源版本号取进程启动时刻：每次部署都会重启服务，浏览器据此自动拉取新样式
ASSET_VERSION = datetime.now().strftime("%Y%m%d%H%M%S")


def create_app(config_object: type[Config] = Config) -> Flask:
    app = Flask(__name__)
    app.config.from_object(config_object)

    app.url_map.strict_slashes = False

    _configure_logging(app)
    _ensure_secret_key(app)
    _warn_unset_site_url(app)
    _init_content(app)
    _register_filters(app)
    _register_context(app)
    _register_error_handlers(app)
    _register_preview_guard(app)
    _register_routes(app)

    return app


# --------------------------------------------------------------------- 内部装配


def _configure_logging(app: Flask) -> None:
    """日志输出到 stdout，由 systemd 收集进 journal。"""
    formatter = logging.Formatter(
        "[%(asctime)s] %(levelname)s %(name)s: %(message)s", datefmt="%Y-%m-%d %H:%M:%S"
    )
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(formatter)

    app.logger.handlers = [handler]
    app.logger.setLevel(logging.INFO)
    app.logger.propagate = False

    logging.getLogger("content").setLevel(logging.INFO)


def _ensure_secret_key(app: Flask) -> None:
    """缺少 SECRET_KEY 时降级运行。

    公开页面本就不依赖会话，不该因为后台配置缺失而整站不可用；因此这里生成
    临时密钥保证可用，同时以 ERROR 级别提醒——临时密钥在重启后会变化，
    已登录的后台会话会随之失效。
    """
    if app.config.get("SECRET_KEY"):
        return

    app.config["SECRET_KEY"] = secrets.token_urlsafe(32)
    app.logger.error(
        "未配置 SECRET_KEY，已启用临时密钥（重启后后台登录状态会失效）。"
        "请在项目根目录执行：python manage.py init"
    )


def _init_content(app: Flask) -> None:
    content_dir = Path(app.config["CONTENT_DIR"])
    content_dir.mkdir(parents=True, exist_ok=True)
    for sub in ("articles", "projects", "uploads"):
        (content_dir / sub).mkdir(parents=True, exist_ok=True)
    content.init(content_dir)
    app.logger.info("内容目录：%s", content_dir)


def _register_filters(app: Flask) -> None:
    @app.template_filter("zh_date")
    def zh_date(value) -> str:
        """2026-09-10 → 2026 年 9 月 10 日"""
        if value is None:
            return ""
        return f"{value.year} 年 {value.month} 月 {value.day} 日"

    @app.template_filter("iso_date")
    def iso_date(value) -> str:
        return value.isoformat() if value else ""

    @app.template_filter("rfc3339")
    def rfc3339(value) -> str:
        """Atom 需要 RFC3339；日期按站点配置的时区偏移输出。"""
        offset = app.config["SITE_TZ_OFFSET"]
        return f"{value.isoformat()}T00:00:00{offset}" if value else ""


def _register_context(app: Flask) -> None:
    @app.context_processor
    def inject_globals() -> dict:
        from admin import preview_enabled

        return {
            "site": content.get_site(),
            "site_url": app.config["SITE_URL"],
            "site_lang": app.config["SITE_LANG"],
            "site_tz": app.config["SITE_TZ_OFFSET"],
            "site_icp": app.config["SITE_ICP"],
            "current_year": datetime.now().year,
            "asset_version": ASSET_VERSION,
            "preview_mode": preview_enabled(),
            # 公开页面上的「退出预览」表单需要 CSRF token；只有已登录时它才存在
            "session_csrf": session.get("csrf", ""),
        }


def _warn_unset_site_url(app: Flask) -> None:
    """SITE_URL 忘了改是最常见的上线疏漏：sitemap / canonical 会指向 localhost。"""
    if "127.0.0.1" in app.config["SITE_URL"] or "localhost" in app.config["SITE_URL"]:
        app.logger.warning(
            "SITE_URL 仍为本地默认值（%s）。上线前请在 .env 中设置为真实域名，"
            "否则 sitemap.xml 与 canonical 链接会指向 localhost。",
            app.config["SITE_URL"],
        )


def _register_preview_guard(app: Flask) -> None:
    """预览模式下强制 noindex。

    被预览的草稿与敏感内容绝不能进入搜索引擎；即使只是临时预览，
    也不给爬虫任何抓取并留存的机会。
    """

    @app.after_request
    def _preview_noindex(response):
        from admin import preview_enabled

        if preview_enabled():
            response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
        return response


def _register_error_handlers(app: Flask) -> None:
    @app.errorhandler(404)
    def handle_404(error):
        return render_template("404.html"), 404

    @app.errorhandler(500)
    def handle_500(error):
        return render_template("500.html"), 500

    @app.errorhandler(Exception)
    def handle_unexpected(error):
        # HTTP 异常（如 abort(404)）交回 Flask 的标准处理
        if isinstance(error, HTTPException):
            return error
        app.logger.exception("未处理的异常：%s %s", request.method, request.path)
        return render_template("500.html"), 500


def _register_routes(app: Flask) -> None:
    """公开路由直接挂在应用上（端点名无前缀），后台挂在 /admin 前缀的蓝图上。"""
    import views

    views.register(app)

    from admin import bp as admin_bp

    app.register_blueprint(admin_bp)
