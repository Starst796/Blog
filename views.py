"""公开页面路由：主页、项目、文章、订阅源与 SEO 相关端点。"""

from __future__ import annotations

import math
from datetime import date

from flask import (
    Flask,
    Response,
    abort,
    current_app,
    redirect,
    render_template,
    request,
    send_from_directory,
    url_for,
)

import content
from admin import preview_enabled


class _Registrar:
    """极小的路由注册器。

    保留 ``@bp.get(...)`` 这种写法，但把端点直接挂到应用上而不是蓝图，
    因此模板里可以直接写 ``url_for('index')``，无需带 ``main.`` 前缀。
    规则会先暂存，等 ``register(app)`` 被调用时再统一挂载。
    """

    def __init__(self) -> None:
        self._rules: list[tuple[str, object]] = []

    def get(self, rule: str):
        def decorator(view):
            self._rules.append((rule, view))
            return view

        return decorator

    def apply(self, app: Flask) -> None:
        for rule, view in self._rules:
            app.add_url_rule(rule, endpoint=view.__name__, view_func=view, methods=["GET"])


bp = _Registrar()


# --------------------------------------------------------------------- 主页


def _homepage_projects(limit: int) -> list[content.Project]:
    """优先展示标了 featured 的项目，不足时用其余项目补齐。"""
    ordered = content.list_projects()
    featured = [item for item in ordered if item.featured]
    others = [item for item in ordered if not item.featured]
    return (featured + others)[:limit]


@bp.get("/")
def index():
    limit = current_app.config["HOMEPAGE_LIMIT"]
    preview = preview_enabled()
    return render_template(
        "index.html",
        projects=_homepage_projects(limit),
        project_total=len(content.list_projects()),
        articles=content.list_articles(include_drafts=preview, limit=limit),
        article_total=content.count_articles(include_drafts=preview),
    )


# --------------------------------------------------------------------- 项目


@bp.get("/projects")
def projects():
    items = content.list_projects()
    return render_template("projects.html", projects=items, total=len(items))


@bp.get("/projects/<slug>")
def project_detail(slug: str):
    project = content.get_project(slug)
    if project is None:
        abort(404)
    return render_template("project_detail.html", project=project)


# --------------------------------------------------------------------- 文章


@bp.get("/articles")
def articles():
    per_page = current_app.config["PAGE_SIZE"]
    tag = (request.args.get("tag") or "").strip() or None
    collection = (request.args.get("collection") or "").strip() or None
    preview = preview_enabled()
    total = content.count_articles(include_drafts=preview, tag=tag, collection=collection)
    total_pages = max(1, math.ceil(total / per_page))
    page = min(max(request.args.get("page", type=int) or 1, 1), total_pages)

    items = content.list_articles(
        include_drafts=preview,
        tag=tag,
        collection=collection,
        limit=per_page,
        offset=(page - 1) * per_page,
    )

    return render_template(
        "articles.html",
        articles=items,
        collections=content.list_collections(include_drafts=preview),
        tags=content.list_tags(include_drafts=preview, collection=collection),
        active_collection=collection,
        active_tag=tag,
        total=total,
        page=page,
        total_pages=total_pages,
    )


@bp.get("/articles/<slug>")
def article_detail(slug: str):
    preview = preview_enabled()
    article = content.get_article(slug, include_drafts=preview)
    if article is None:
        abort(404)

    # 相邻文章只在同一文集内寻找：跨文集的文章互不串联，
    # 阅读体验上等同于「把这篇文集从头读到尾」。
    # 列表按日期倒序，因此 index-1 更新、index+1 更早。
    siblings = content.list_articles(include_drafts=preview, collection=article.collection)
    slugs = [item.slug for item in siblings]
    position = slugs.index(slug) if slug in slugs else None

    older = siblings[position + 1] if position is not None and position + 1 < len(siblings) else None
    newer = siblings[position - 1] if position is not None and position > 0 else None

    return render_template(
        "article_detail.html",
        article=article,
        older_article=older,
        newer_article=newer,
        collection_total=len(siblings),
    )


# --------------------------------------------------------------------- 媒体


@bp.get("/uploads/<path:filename>")
def uploaded_file(filename: str):
    """提供内容目录中的图片。send_from_directory 自带路径穿越防护。"""
    return send_from_directory(content.content_dir() / "uploads", filename, max_age=60 * 60 * 24 * 30)


@bp.get("/favicon.ico")
def favicon():
    return redirect(url_for("static", filename="img/favicon.svg"), code=301)


# --------------------------------------------------------------------- SEO


@bp.get("/robots.txt")
def robots():
    lines = [
        "User-agent: *",
        "Allow: /",
        "Disallow: /admin",
        f"Sitemap: {current_app.config['SITE_URL']}/sitemap.xml",
    ]
    return Response("\n".join(lines) + "\n", mimetype="text/plain")


@bp.get("/sitemap.xml")
def sitemap():
    xml = render_template(
        "sitemap.xml",
        projects=content.list_projects(),
        articles=content.list_articles(),
        lastmod=date.today().isoformat(),
    )
    return Response(xml, mimetype="application/xml")


@bp.get("/atom.xml")
def atom():
    articles = content.list_articles(limit=20)
    stamp = articles[0].date if articles else date.today()
    offset = current_app.config["SITE_TZ_OFFSET"]
    return Response(
        render_template("atom.xml", articles=articles, updated=f"{stamp.isoformat()}T00:00:00{offset}"),
        mimetype="application/atom+xml",
    )


# --------------------------------------------------------------------- 运维


@bp.get("/healthz")
def healthz():
    """供 systemd / 监控探测，不做磁盘与内容检查以保持轻量。"""
    return {"status": "ok", "service": "personal-site"}


def register(app: Flask) -> None:
    """把公开路由挂载到应用，由应用工厂调用。"""
    bp.apply(app)
