"""管理后台：单用户登录、内容增删改、图片上传。

设计要点
--------
- **单用户**：账号与密码哈希来自 ``.env``，仓库中永不出现明文或哈希。
- **会话**：HttpOnly + Secure + SameSite=Lax 的签名 cookie，仅存一个布尔标记。
- **CSRF**：所有写操作校验会话内一次性 token（表单字段或 ``X-CSRF-Token`` 头）。
- **限流**：登录失败按来源 IP 计数，窗口内超限即冷却，避免被暴力破解。
- **搜索引擎隔离**：全部响应带 ``X-Robots-Tag: noindex``，且已被 robots.txt 排除。
- **写入安全**：slug 经正则校验，图片经扩展名、MIME 与 Pillow 解码三重检查。
"""

from __future__ import annotations

import hmac
import logging
import re
import secrets
import time
from collections import defaultdict, deque
from datetime import date, datetime
from functools import wraps
from pathlib import Path
from urllib.parse import urlsplit

from flask import (
    Blueprint,
    abort,
    current_app,
    flash,
    redirect,
    render_template,
    request,
    session,
    url_for,
)
from werkzeug.security import check_password_hash
from werkzeug.utils import secure_filename

import content

bp = Blueprint("admin", __name__, url_prefix="/admin")

logger = logging.getLogger(__name__)

# 登录失败记录：{来源 IP: 失败时间戳队列}
_login_failures: dict[str, deque[float]] = defaultdict(deque)

_WRITE_METHODS = {"POST", "PUT", "PATCH", "DELETE"}
_TAG_SPLIT_RE = re.compile(r"[,，;；]")


# --------------------------------------------------------------------- 基础工具


def csrf_token() -> str:
    """返回当前会话的 CSRF token，不存在则新建。"""
    token = session.get("csrf")
    if not token:
        token = secrets.token_urlsafe(32)
        session["csrf"] = token
    return token


def _client_ip() -> str:
    """取真实来源 IP。

    服务只监听 127.0.0.1，能连上的只有本机 nginx，因此信任 nginx 写入的
    X-Forwarded-For 不会引入伪造风险。
    """
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


# --------------------------------------------------------------------- 预览模式

# 开关只存在浏览器会话里，因此只影响你自己看到的内容，
# 不会改变任何其他访客（包括搜索引擎）看到的结果。
PREVIEW_SESSION_KEY = "preview"


def preview_enabled() -> bool:
    """当前请求是否处于预览模式。必须已登录，否则恒为 False。"""
    return bool(session.get("authenticated") and session.get(PREVIEW_SESSION_KEY))


def _safe_redirect_target() -> str:
    """决定开关预览后回到哪里，只接受站内路径，避免开放重定向。"""
    raw = (request.form.get("next") or request.referrer or "").strip()
    path = urlsplit(raw).path if raw.startswith(("http://", "https://")) else raw
    # 以 // 开头的是协议相对地址，同样会跳到外站
    if not path.startswith("/") or path.startswith("//"):
        return url_for("index")
    return path


def _is_throttled(ip: str) -> bool:
    limit = current_app.config["LOGIN_ATTEMPT_IP_LIMIT"]
    window = current_app.config["LOGIN_ATTEMPT_IP_WINDOW"]
    queue = _login_failures[ip]
    cutoff = time.time() - window
    while queue and queue[0] < cutoff:
        queue.popleft()
    return len(queue) >= limit


def _record_failure(ip: str) -> None:
    _login_failures[ip].append(time.time())


def login_required(view):
    @wraps(view)
    def wrapped(*args, **kwargs):
        if not session.get("authenticated"):
            return redirect(url_for("admin.login", next=request.path))
        return view(*args, **kwargs)

    return wrapped


# --------------------------------------------------------------------- 横切关注点


@bp.before_request
def _verify_csrf():
    if request.method not in _WRITE_METHODS or request.endpoint == "admin.login":
        return

    # 未登录时不在这里拦：交给 login_required 跳转到登录页，
    # 否则会话过期后用户点任何按钮都只会看到一个 400。
    if not session.get("authenticated"):
        return

    sent = request.form.get("csrf_token") or request.headers.get("X-CSRF-Token", "")
    expected = session.get("csrf", "")
    if not expected or not hmac.compare_digest(sent, expected):
        abort(400, description="CSRF 校验失败，请刷新页面后重试。")


@bp.after_request
def _noindex(response):
    response.headers["X-Robots-Tag"] = "noindex, nofollow, noarchive"
    return response


@bp.context_processor
def _inject_admin_globals():
    return {
        "csrf_token": csrf_token,
        "admin_username": current_app.config["ADMIN_USERNAME"],
        "password_configured": bool(current_app.config["ADMIN_PASSWORD_HASH"]),
        "preview_mode": preview_enabled(),
        # 供文章表单的「文集」输入框做候选项，方便复用已有文集名
        "collection_options": [name for name, _ in content.list_collections(include_drafts=True)],
    }


# --------------------------------------------------------------------- 登录


@bp.route("/login", methods=["GET", "POST"])
def login():
    if session.get("authenticated"):
        return redirect(url_for("admin.dashboard"))

    error = None
    ip = _client_ip()

    if request.method == "POST":
        if not current_app.config["ADMIN_PASSWORD_HASH"]:
            error = "尚未设置管理密码。请在服务器上运行 manage.py set-password，然后重试。"
        elif _is_throttled(ip):
            error = "尝试次数过多，请稍后再试。"
        else:
            username = (request.form.get("username") or "").strip()
            password = request.form.get("password") or ""
            valid = username == current_app.config["ADMIN_USERNAME"] and check_password_hash(
                current_app.config["ADMIN_PASSWORD_HASH"], password
            )
            if valid:
                _login_failures.pop(ip, None)
                session.clear()
                session["authenticated"] = True
                session.permanent = True
                csrf_token()
                logger.info("管理员登录成功，来源 %s", ip)
                target = request.args.get("next", "")
                if not target.startswith("/admin"):
                    target = url_for("admin.dashboard")
                return redirect(target)

            _record_failure(ip)
            logger.warning("管理员登录失败，来源 %s", ip)
            error = "账号或密码不正确。"

    return render_template("admin/login.html", error=error)


@bp.post("/logout")
@login_required
def logout():
    session.clear()
    flash("已退出登录。", "ok")
    return redirect(url_for("admin.login"))


@bp.post("/preview-mode")
@login_required
def toggle_preview_mode():
    """开关预览模式，然后回到刚才浏览的页面。

    开启后，公开页面（主页 / 文章列表 / 文章详情）会额外显示草稿与敏感内容，
    顶部始终有一条醒目横幅提示，避免把它误当成线上真实效果。
    """
    enabled = not session.get(PREVIEW_SESSION_KEY, False)
    session[PREVIEW_SESSION_KEY] = enabled
    logger.info("预览模式：%s（来源 %s）", "开启" if enabled else "关闭", _client_ip())
    return redirect(_safe_redirect_target())


# --------------------------------------------------------------------- 仪表盘


@bp.get("")
@bp.get("/")
@login_required
def dashboard():
    return render_template(
        "admin/dashboard.html",
        stats=content.stats(),
        articles=content.list_articles(include_drafts=True),
        projects=content.list_projects(),
    )


# --------------------------------------------------------------------- 文章


def _read_article_form() -> tuple[dict, str, list[str]]:
    form = request.form
    errors: list[str] = []

    title = (form.get("title") or "").strip()
    if not title:
        errors.append("标题不能为空。")

    raw_date = (form.get("date") or "").strip()
    try:
        published = datetime.strptime(raw_date, "%Y-%m-%d").date() if raw_date else date.today()
    except ValueError:
        errors.append("日期格式应为 YYYY-MM-DD。")
        published = date.today()

    metadata: dict = {
        "title": title,
        "date": published,
        "tags": [part.strip() for part in _TAG_SPLIT_RE.split(form.get("tags") or "") if part.strip()],
        "draft": form.get("draft") == "on",
        # 敏感内容即使取消草稿也不会对外输出，用于存放密钥、凭据一类文本
        "sensitive": form.get("sensitive") == "on",
    }

    # 文集留空即归入默认的「未归档」。默认值不写进 front matter，
    # 保持文件干净；非默认文集则显式写入。
    collection = (form.get("collection") or "").strip()
    if collection and collection != content.DEFAULT_COLLECTION:
        metadata["collection"] = collection

    summary = (form.get("summary") or "").strip()
    if summary:
        metadata["summary"] = summary

    cover = (form.get("cover") or "").strip()
    if cover:
        metadata["cover"] = cover

    return metadata, form.get("body") or "", errors


@bp.route("/articles/new", methods=["GET", "POST"])
@login_required
def article_new():
    if request.method == "POST":
        metadata, body, errors = _read_article_form()
        base = content.slugify(
            request.form.get("slug") or metadata.get("title", ""),
            fallback=f"post-{date.today():%Y%m%d}",
        )
        slug = content.unique_slug(content.content_dir() / "articles", base)

        if errors:
            for message in errors:
                flash(message, "error")
            return render_template(
                "admin/article_form.html",
                article=None,
                form=request.form,
                default_slug=base,
                today=date.today().isoformat(),
            )

        content.ContentWriter().write_article(slug, metadata, body)
        logger.info("新建文章：%s", slug)
        flash(f"文章「{metadata['title']}」已保存。", "ok")
        return redirect(url_for("admin.dashboard"))

    return render_template(
        "admin/article_form.html",
        article=None,
        form={},
        default_slug="",
        today=date.today().isoformat(),
    )


@bp.route("/articles/<slug>/edit", methods=["GET", "POST"])
@login_required
def article_edit(slug: str):
    article = content.get_article(slug, include_drafts=True)
    if article is None:
        abort(404)

    if request.method == "POST":
        metadata, body, errors = _read_article_form()
        wanted = content.slugify(request.form.get("slug") or slug, fallback=slug)

        if wanted != slug and (content.content_dir() / "articles" / f"{wanted}.md").exists():
            errors.append(f"slug「{wanted}」已被占用。")

        if errors:
            for message in errors:
                flash(message, "error")
            return render_template(
                "admin/article_form.html",
                article=article,
                form=request.form,
                default_slug=wanted,
                today=article.date.isoformat(),
            )

        writer = content.ContentWriter()
        writer.write_article(wanted, metadata, body)
        if wanted != slug:
            writer.delete("articles", slug)
            logger.info("文章重命名：%s → %s", slug, wanted)
        else:
            logger.info("更新文章：%s", slug)

        flash(f"文章「{metadata['title']}」已更新。", "ok")
        return redirect(url_for("admin.article_edit", slug=wanted))

    return render_template(
        "admin/article_form.html",
        article=article,
        form={},
        default_slug=article.slug,
        today=article.date.isoformat(),
    )


@bp.post("/articles/<slug>/delete")
@login_required
def article_delete(slug: str):
    if content.ContentWriter().delete("articles", slug):
        logger.info("删除文章：%s", slug)
        flash(f"文章 {slug} 已删除。", "ok")
    else:
        flash("未找到该文章。", "error")
    return redirect(url_for("admin.dashboard"))


# --------------------------------------------------------------------- 项目


def _read_project_form() -> tuple[dict, str, list[str]]:
    form = request.form
    errors: list[str] = []

    title = (form.get("title") or "").strip()
    if not title:
        errors.append("项目名称不能为空。")

    links: list[dict[str, str]] = []
    for line in (form.get("links") or "").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        if len(parts) != 2 or not parts[1].startswith(("http://", "https://", "mailto:")):
            errors.append(f"链接格式应为「名称 https://…」，当前为：{line}")
            continue
        links.append({"label": parts[0], "url": parts[1]})

    try:
        order = int((form.get("order") or "100").strip() or 100)
    except ValueError:
        errors.append("排序值应为整数。")
        order = 100

    metadata: dict = {
        "title": title,
        "status": (form.get("status") or "进行中").strip() or "进行中",
        "period": (form.get("period") or "").strip(),
        "stack": [part.strip() for part in _TAG_SPLIT_RE.split(form.get("stack") or "") if part.strip()],
        "featured": form.get("featured") == "on",
        "order": order,
        "links": links,
    }

    summary = (form.get("summary") or "").strip()
    if summary:
        metadata["summary"] = summary

    return metadata, form.get("body") or "", errors


@bp.route("/projects/new", methods=["GET", "POST"])
@login_required
def project_new():
    if request.method == "POST":
        metadata, body, errors = _read_project_form()
        base = content.slugify(
            request.form.get("slug") or metadata.get("title", ""), fallback=f"project-{date.today():%Y%m%d}"
        )
        slug = content.unique_slug(content.content_dir() / "projects", base)

        if errors:
            for message in errors:
                flash(message, "error")
            return render_template("admin/project_form.html", project=None, form=request.form, default_slug=base)

        content.ContentWriter().write_project(slug, metadata, body)
        logger.info("新建项目：%s", slug)
        flash(f"项目「{metadata['title']}」已保存。", "ok")
        return redirect(url_for("admin.dashboard"))

    return render_template("admin/project_form.html", project=None, form={}, default_slug="")


@bp.route("/projects/<slug>/edit", methods=["GET", "POST"])
@login_required
def project_edit(slug: str):
    project = content.get_project(slug)
    if project is None:
        abort(404)

    if request.method == "POST":
        metadata, body, errors = _read_project_form()
        wanted = content.slugify(request.form.get("slug") or slug, fallback=slug)

        if wanted != slug and (content.content_dir() / "projects" / f"{wanted}.md").exists():
            errors.append(f"slug「{wanted}」已被占用。")

        if errors:
            for message in errors:
                flash(message, "error")
            return render_template(
                "admin/project_form.html", project=project, form=request.form, default_slug=wanted
            )

        writer = content.ContentWriter()
        writer.write_project(wanted, metadata, body)
        if wanted != slug:
            writer.delete("projects", slug)
            logger.info("项目重命名：%s → %s", slug, wanted)
        else:
            logger.info("更新项目：%s", slug)

        flash(f"项目「{metadata['title']}」已更新。", "ok")
        return redirect(url_for("admin.project_edit", slug=wanted))

    return render_template(
        "admin/project_form.html", project=project, form={}, default_slug=project.slug
    )


@bp.post("/projects/<slug>/delete")
@login_required
def project_delete(slug: str):
    if content.ContentWriter().delete("projects", slug):
        logger.info("删除项目：%s", slug)
        flash(f"项目 {slug} 已删除。", "ok")
    else:
        flash("未找到该项目。", "error")
    return redirect(url_for("admin.dashboard"))


# --------------------------------------------------------------------- 站点信息


@bp.route("/site", methods=["GET", "POST"])
@login_required
def site_edit():
    site = content.get_site()

    if request.method == "POST":
        form = request.form

        social: list[dict[str, str]] = []
        errors: list[str] = []
        for line in (form.get("social") or "").splitlines():
            line = line.strip()
            if not line:
                continue
            parts = line.split(None, 1)
            if len(parts) != 2 or not parts[1].startswith(("http://", "https://", "mailto:")):
                errors.append(f"社交链接格式应为「名称 https://…」，当前为：{line}")
                continue
            social.append({"label": parts[0], "url": parts[1]})

        if errors:
            for message in errors:
                flash(message, "error")
            return render_template(
                "admin/site_form.html",
                site=site,
                social_text=(form.get("social") or "").strip(),
            )

        payload = {
            "name": (form.get("name") or "").strip() or site.get("name", ""),
            "tagline": (form.get("tagline") or "").strip(),
            "bio": (form.get("bio") or "").strip(),
            "location": (form.get("location") or "").strip(),
            "email": (form.get("email") or "").strip(),
            "avatar": (form.get("avatar") or "").strip(),
            "social": social,
            "nav": site.get("nav") or [],
        }
        content.ContentWriter().write_site(payload)
        logger.info("更新站点信息")
        flash("站点信息已保存。", "ok")
        return redirect(url_for("admin.site_edit"))

    social_text = "\n".join(
        f"{item.get('label', '')} {item.get('url', '')}" for item in site.get("social") or []
    )
    return render_template("admin/site_form.html", site=site, social_text=social_text)


# --------------------------------------------------------------------- 图片与预览


@bp.post("/upload")
@login_required
def upload_image():
    upload = request.files.get("file")
    if upload is None or not upload.filename:
        return {"ok": False, "error": "没有选择文件。"}, 400

    filename = secure_filename(upload.filename)
    suffix = filename.rsplit(".", 1)[-1].lower() if "." in filename else ""
    allowed_ext = current_app.config["ALLOWED_IMAGE_EXT"]
    if suffix not in allowed_ext:
        return {"ok": False, "error": f"仅支持 {' / '.join(sorted(allowed_ext))} 格式。"}, 400
    if upload.mimetype not in current_app.config["ALLOWED_IMAGE_MIME"]:
        return {"ok": False, "error": "文件类型与扩展名不符。"}, 400

    # 真正解码一次，确认是图片而不是改了扩展名的其他文件
    try:
        from PIL import Image

        Image.open(upload.stream).verify()
        upload.stream.seek(0)
    except Exception:  # noqa: BLE001 - 任何解码失败都视为非法文件
        return {"ok": False, "error": "文件不是有效的图片。"}, 400

    today = date.today()
    relative_dir = Path(f"{today:%Y/%m}")
    target_dir = content.content_dir() / "uploads" / relative_dir
    target_dir.mkdir(parents=True, exist_ok=True)

    stem = (Path(filename).stem or "image")[:40]
    name = f"{datetime.now():%H%M%S}-{secrets.token_hex(3)}-{stem}.{suffix}"
    upload.save(target_dir / name)

    relative = (relative_dir / name).as_posix()
    url = f"{content.MEDIA_URL_PREFIX}/{relative}"
    logger.info("上传图片：%s", relative)
    return {"ok": True, "path": relative, "url": url, "markdown": f"![{stem}]({url})"}


@bp.post("/preview")
@login_required
def preview_markdown():
    payload = request.get_json(silent=True) or {}
    html, toc = content.render(payload.get("body") or "")
    return {"html": html, "toc": toc}


@bp.errorhandler(413)
def handle_too_large(error):
    return {"ok": False, "error": "文件超过 10 MB 限制。"}, 413
