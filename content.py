"""内容层：从 Markdown 文件读取文章与项目，并渲染为 HTML。

设计要点
--------
1. 内容存放在 ``CONTENT_DIR``（部署树 ``program/`` 之外），因此 ``git checkout -f``
   执行部署时不会覆盖线上写作的内容；代码发布与内容发布彻底解耦。
2. front matter 使用 YAML，正文使用 Markdown，无需数据库，可直接用 git 版本化。
3. 进程内缓存，依据内容树的最大 mtime 自动失效——写入后下一次读取即刷新，
   ``invalidate()`` 用于显式失效。该策略在多 worker 下同样正确。
4. 读盘失败或 front matter 非法时跳过该文件并记录告警，绝不因单篇文章导致整站 500。

目录约定::

    content/
      site.yml             站点信息（昵称、定位、简介、社交链接）
      articles/*.md        文章，文件名即 slug
      projects/*.md        项目，文件名即 slug
      uploads/...          图片
"""

from __future__ import annotations

import logging
import re
import subprocess
import threading
from dataclasses import dataclass, field
from datetime import date, datetime, time
from pathlib import Path
from typing import Any

import frontmatter
import markdown as md
import yaml
from markdown.extensions.toc import slugify_unicode

logger = logging.getLogger(__name__)

# slug 仅允许小写字母、数字与连字符，从源头杜绝 `../` 一类的路径穿越
SLUG_RE = re.compile(r"^[a-z0-9][a-z0-9-]{0,80}$")

# 图片对外的 URL 前缀（由 Flask 路由或 nginx alias 提供）
MEDIA_URL_PREFIX = "/uploads"

# 文章「文集」的默认值：front matter 未写 collection 的文章都归入这里
DEFAULT_COLLECTION = "未归档"

# ---------------------------------------------------------------- 内部状态

_root: Path | None = None
_cache: dict[str, Any] | None = None
_cache_stamp: float | None = None
_upload_sizes: dict[str, list[int]] | None = None
_upload_stamp: float | None = None
_lock = threading.Lock()
_local = threading.local()


def init(content_dir: Path | str) -> None:
    """指定内容根目录。应在应用工厂中调用一次。"""
    global _root
    _root = Path(content_dir).resolve()
    invalidate()


def content_dir() -> Path:
    if _root is None:
        raise RuntimeError("content.init() 尚未调用")
    return _root


def invalidate() -> None:
    """令缓存失效，下一次读取时重建。写入内容后调用。"""
    global _cache, _cache_stamp, _upload_sizes, _upload_stamp
    with _lock:
        _cache = None
        _cache_stamp = None
        _upload_sizes = None
        _upload_stamp = None


# ---------------------------------------------------------------- Markdown


def _markdown() -> md.Markdown:
    """返回当前线程专属的 Markdown 实例。

    Markdown 对象在 convert 期间持有内部状态，不线程安全，故用线程局部变量隔离。
    """
    instance = getattr(_local, "md", None)
    if instance is None:
        instance = md.Markdown(
            extensions=[
                "extra",       # tables / fenced_code / attr_list / footnotes / abbr / def_list
                "codehilite",  # 代码高亮，依赖 Pygments
                "toc",         # 提取目录
                "sane_lists",
                "admonition",
                # 删除线：`extra` 并不包含 GFM 的 ~~文字~~，少了它工具栏的删除线按钮
                # 只会插入一对原样输出的波浪号。
                "pymdownx.tilde",
            ],
            extension_configs={
                "codehilite": {
                    "css_class": "highlight",
                    "guess_lang": False,
                    "linenums": False,
                },
                # 只保留 ~~删除~~，关掉单个 ~ 的下标写法：中文里「约 3 ~ 5 个」
                # 这类区间很常见，若开下标会被吃掉。
                "pymdownx.tilde": {"subscript": False},
                # 中文标题若用默认 slugify 会退化成 _1、_2 这类编号，标题顺序一变
                # 锚点就失效；保留 Unicode 可得到稳定且可读的锚点。
                "toc": {"permalink": False, "toc_depth": "2-4", "slugify": slugify_unicode},
            },
            output_format="html5",
        )
        _local.md = instance
    return instance


def render(markdown_text: str) -> tuple[str, str]:
    """渲染 Markdown，返回 ``(html, toc_html)``。"""
    engine = _markdown()
    html = engine.convert(markdown_text or "")
    return html, getattr(engine, "toc", "")


# ---------------------------------------------------------------- 解析工具

_MD_NOISE_RE = [
    (re.compile(r"```.*?```", re.S), " "),      # 代码块
    (re.compile(r"`[^`]*`"), " "),               # 行内代码
    (re.compile(r"!\[[^\]]*\]\([^)]*\)"), " "),  # 图片
    (re.compile(r"\[([^\]]*)\]\([^)]*\)"), r"\1"),  # 链接保留文字
    (re.compile(r"^\s{0,3}#{1,6}\s*", re.M), ""),   # 标题标记
    (re.compile(r"</?[A-Za-z][^>]*>"), " "),     # 行内 HTML（下划线、颜色等）
    (re.compile(r"\{:[^}]*\}"), " "),            # attr_list 属性（对齐等）
    (re.compile(r"[*_~>]"), ""),                 # 强调等标记
]


def _plain_text(markdown_text: str) -> str:
    text = markdown_text
    for pattern, repl in _MD_NOISE_RE:
        text = pattern.sub(repl, text)
    return re.sub(r"\s+", " ", text).strip()


def _derive_summary(meta: dict[str, Any], body: str, limit: int = 140) -> str:
    """优先取 front matter 的 summary，否则从正文首个非空段落截取。"""
    explicit = (meta.get("summary") or "").strip()
    if explicit:
        return explicit

    for block in re.split(r"\n\s*\n", body or ""):
        candidate = _plain_text(block)
        if candidate and not candidate.startswith(":::"):
            return candidate if len(candidate) <= limit else candidate[: limit - 1] + "…"
    return ""


def _parse_date(value: Any, fallback: date | None = None) -> date:
    if isinstance(value, datetime):
        return value.date()
    if isinstance(value, date):
        return value
    if isinstance(value, str):
        raw = value.strip()
        for fmt in ("%Y-%m-%d", "%Y/%m/%d", "%Y.%m.%d", "%Y-%m-%d %H:%M"):
            try:
                return datetime.strptime(raw, fmt).date()
            except ValueError:
                continue
    return fallback or date.today()


def _parse_time(value: Any, fallback: time | None = None) -> time:
    """解析 front matter 中的 ``time``，无法识别时退回 ``fallback``（默认 00:00）。

    兼容 ``HH:MM``、``HH:MM:SS`` 与 ``HH:MM:SS.ffffff``。早期文章没有 ``time``
    字段，一律按 00:00 处理。

    注意 YAML 1.1 的「六十进制整数」：裸写的 ``12:30`` 会被 PyYAML 解析成整数
    ``750``（``09:30`` 因为首位是 0 反而仍是字符串），因此这里额外把整数按
    ``H*3600 + M*60 + S`` 还原，并提醒作者加引号——后台保存时写出的字符串
    会被 PyYAML 自动加引号，不受此影响。
    """
    if isinstance(value, datetime):
        return value.time()
    if isinstance(value, time):
        return value
    if isinstance(value, str):
        raw = value.strip()
        for fmt in ("%H:%M:%S.%f", "%H:%M:%S", "%H:%M", "%H%M%S", "%H%M"):
            try:
                return datetime.strptime(raw, fmt).time()
            except ValueError:
                continue
    elif isinstance(value, int) and not isinstance(value, bool) and 0 <= value < 86400:
        logger.warning(
            "文章 front matter 的 time 被 YAML 当成六十进制整数 %s，已按 %s 解释；"
            "建议写成带引号的 \"HH:MM\"",
            value,
            f"{value // 3600:02d}:{value % 3600 // 60:02d}:{value % 60:02d}",
        )
        return time(value // 3600, value % 3600 // 60, value % 60)
    return fallback or time(0, 0)


def _parse_str_list(value: Any) -> list[str]:
    """兼容 ``tags: [a, b]``、``tags: a, b`` 与 ``tags: a`` 三种写法。"""
    if value is None:
        return []
    if isinstance(value, (list, tuple, set)):
        return [str(item).strip() for item in value if str(item).strip()]
    return [part.strip() for part in re.split(r"[,，;；]", str(value)) if part.strip()]


def _parse_collection(value: Any) -> str:
    """解析文章所属文集，缺省（或留空）时归入「未归档」。"""
    name = str(value or "").strip()
    return name or DEFAULT_COLLECTION


def _estimate_words(text: str) -> int:
    """输出字符数量"""
    return len(text or "")


def _as_bool(value: Any, default: bool = False) -> bool:
    if value is None:
        return default
    if isinstance(value, bool):
        return value
    return str(value).strip().lower() in {"1", "true", "yes", "on"}


def _media_url(value: Any) -> str | None:
    """把 front matter 中的图片路径转换为对外 URL。

    兼容几种等价写法，避免使用者去记前缀规则：
        ``2026/09/x.png``            → ``/uploads/2026/09/x.png``
        ``uploads/2026/09/x.png``    → ``/uploads/2026/09/x.png``
        ``/uploads/2026/09/x.png``   → 原样
        ``https://…``                → 原样（支持外链图床）
    """
    raw = str(value or "").strip()
    if not raw:
        return None
    if raw.startswith(("http://", "https://", "/")):
        return raw

    # 允许写出 ``uploads/`` 前缀，但不要重复叠加
    relative = raw.lstrip("./")
    if relative.startswith("uploads/"):
        relative = relative[len("uploads/"):]
    return f"{MEDIA_URL_PREFIX}/{relative}"


# ---------------------------------------------------------------- 数据模型


@dataclass(slots=True)
class Article:
    slug: str
    title: str
    date: date
    time: time
    updated: date | None
    summary: str
    collection: str
    tags: list[str]
    draft: bool
    sensitive: bool
    cover: str | None
    body: str
    html: str
    toc: str
    words: int
    source: Path

    @property
    def url(self) -> str:
        return f"/articles/{self.slug}"

    @property
    def published(self) -> datetime:
        """日期与时刻合并后的发布时刻，供排序与订阅源使用。"""
        return datetime.combine(self.date, self.time)

    @property
    def modified(self) -> datetime:
        """最后修订时刻。没有 ``updated`` 字段时等同于发布时间。"""
        if self.updated and self.updated != self.date:
            return datetime.combine(self.updated, self.time)
        return self.published

    @property
    def year(self) -> int:
        return self.date.year

    @property
    def has_toc(self) -> bool:
        """有没有小标题可用。

        ``toc`` 扩展在没有 2–4 级标题时也会给一个空的 ``<ul>``，字段非空却没东西可列，
        所以按里面有没有链接来判断，模板据此决定要不要显示目录。
        """
        return "<a " in self.toc


@dataclass(slots=True)
class Project:
    slug: str
    title: str
    status: str
    period: str
    summary: str
    stack: list[str]
    links: list[dict[str, str]]
    featured: bool
    order: int
    body: str
    html: str
    source: Path

    @property
    def url(self) -> str:
        return f"/projects/{self.slug}"

    @property
    def primary_link(self) -> dict[str, str] | None:
        return self.links[0] if self.links else None

    @property
    def links_text(self) -> str:
        """供编辑表单回填：每行一条「名称 URL」。"""
        return "\n".join(f"{item['label']} {item['url']}" for item in self.links)


DEFAULT_SITE: dict[str, Any] = {
    "name": "Starst",
    "tagline": "",
    "bio": "",
    "location": "",
    "avatar": None,
    "email": "",
    "social": [],
    "nav": [
        {"label": "主页", "url": "/"},
        {"label": "项目", "url": "/projects"},
        {"label": "文章", "url": "/articles"},
    ],
}


# ---------------------------------------------------------------- 读盘


def _load_articles(root: Path) -> dict[str, Article]:
    directory = root / "articles"
    if not directory.is_dir():
        return {}

    items: dict[str, Article] = {}
    for path in sorted(directory.glob("*.md")):
        slug = path.stem
        if not SLUG_RE.match(slug):
            logger.warning("跳过非法 slug 的文章：%s（仅允许小写字母、数字与连字符）", path.name)
            continue
        try:
            post = frontmatter.load(str(path))
        except Exception as exc:  # noqa: BLE001 - 单文件损坏不应影响整站
            logger.warning("解析文章 front matter 失败：%s（%s）", path.name, exc)
            continue

        meta = post.metadata or {}
        body = post.content or ""
        html, toc = render(body)
        created = _parse_date(meta.get("date"), fallback=date.fromtimestamp(path.stat().st_mtime))
        # 缺失 time 的老文章一律按 00:00 处理，不拿文件 mtime 兜底：
        # mtime 会被「拉取内容仓库」这类与写作无关的操作改掉，反而破坏既有顺序。
        created_time = _parse_time(meta.get("time"))
        updated_raw = meta.get("updated") or meta.get("modified")

        items[slug] = Article(
            slug=slug,
            title=str(meta.get("title") or slug),
            date=created,
            time=created_time,
            updated=_parse_date(updated_raw) if updated_raw else None,
            summary=_derive_summary(meta, body),
            # 兼容 ``series:`` 这个常见写法，二者等价
            collection=_parse_collection(meta.get("collection") or meta.get("series")),
            tags=_parse_str_list(meta.get("tags")),
            draft=_as_bool(meta.get("draft"), False),
            sensitive=_as_bool(meta.get("sensitive"), False),
            cover=_media_url(meta.get("cover")),
            body=body,
            html=html,
            toc=toc,
            words=_estimate_words(body),
            source=path,
        )
    return items


def _load_projects(root: Path) -> dict[str, Project]:
    directory = root / "projects"
    if not directory.is_dir():
        return {}

    items: dict[str, Project] = {}
    for path in sorted(directory.glob("*.md")):
        slug = path.stem
        if not SLUG_RE.match(slug):
            logger.warning("跳过非法 slug 的项目：%s（仅允许小写字母、数字与连字符）", path.name)
            continue
        try:
            post = frontmatter.load(str(path))
        except Exception as exc:  # noqa: BLE001
            logger.warning("解析项目 front matter 失败：%s（%s）", path.name, exc)
            continue

        meta = post.metadata or {}
        body = post.content or ""
        html, _ = render(body)

        links: list[dict[str, str]] = []
        for entry in meta.get("links") or []:
            if isinstance(entry, dict) and entry.get("url"):
                links.append(
                    {
                        "label": str(entry.get("label") or "链接"),
                        "url": str(entry["url"]),
                    }
                )

        try:
            order = int(meta.get("order", 100))
        except (TypeError, ValueError):
            order = 100

        items[slug] = Project(
            slug=slug,
            title=str(meta.get("title") or slug),
            status=str(meta.get("status") or "进行中"),
            period=str(meta.get("period") or ""),
            summary=_derive_summary(meta, body),
            stack=_parse_str_list(meta.get("stack")),
            links=links,
            featured=_as_bool(meta.get("featured"), False),
            order=order,
            body=body,
            html=html,
            source=path,
        )
    return items


def _load_site(root: Path) -> dict[str, Any]:
    site = dict(DEFAULT_SITE)
    path = root / "site.yml"
    if not path.is_file():
        return site
    try:
        loaded = yaml.safe_load(path.read_text(encoding="utf-8")) or {}
    except Exception as exc:  # noqa: BLE001
        logger.warning("解析 site.yml 失败，使用默认站点信息：%s", exc)
        return site

    if isinstance(loaded, dict):
        site.update(loaded)
    site["avatar"] = _media_url(site.get("avatar"))
    if not isinstance(site.get("social"), list):
        site["social"] = []
    if not isinstance(site.get("nav"), list) or not site["nav"]:
        site["nav"] = DEFAULT_SITE["nav"]
    return site


# ---------------------------------------------------------------- 缓存


def _tree_stamp(root: Path) -> float:
    """内容树中最新修改时间，用于判断缓存是否过期。"""
    latest = 0.0
    if not root.exists():
        return latest
    for path in root.rglob("*"):
        if path.is_file():
            try:
                mtime = path.stat().st_mtime
            except OSError:
                continue
            if mtime > latest:
                latest = mtime
    return latest


def _store() -> dict[str, Any]:
    """返回内容缓存，必要时重建。"""
    global _cache, _cache_stamp

    root = content_dir()
    stamp = _tree_stamp(root)

    with _lock:
        if _cache is not None and _cache_stamp == stamp:
            return _cache

        _cache = {
            "site": _load_site(root),
            "articles": _load_articles(root),
            "projects": _load_projects(root),
        }
        _cache_stamp = stamp
        return _cache


# ---------------------------------------------------------------- 上传图片尺寸


def upload_sizes() -> dict[str, list[int]]:
    """``uploads`` 目录下每张图片的尺寸：``{"2026/09/x.png": [宽, 高]}``。

    只服务后台编辑器。预览每次重绘都会重建整棵 DOM，图片若是「先是 0 高、解码完才
    变高」，预览的高度就会先塌下去再长回来，滚动位置跟着被顶走。编辑器拿这份尺寸
    给 ``<img>`` 补上 width/height，浏览器先撑出占位盒，高度从头就是定值（见
    ``static/js/admin.js`` 的 ``reserveImageSpace``）。

    刻意不并进上面的 ``_store()``：那份缓存每次保存文章都要重建，而这里得逐个打开
    图片文件，热盘约 0.05ms/张、冷盘首次约 10ms/张（实测 42 张：热 2.3ms / 冷 400ms），
    不该让写作路径替它买单。改成就地缓存，键是 uploads 目录树的最新 mtime——
    与内容缓存同一套失效规则，新上传一张图即自动过期。
    """
    global _upload_sizes, _upload_stamp

    try:
        from PIL import Image
    except ImportError:  # 没装 Pillow：退回「等图片解码」，编辑照常可用
        return {}

    root = content_dir() / "uploads"
    stamp = _tree_stamp(root)

    with _lock:
        if _upload_sizes is not None and _upload_stamp == stamp:
            return _upload_sizes

        sizes: dict[str, list[int]] = {}
        for path in sorted(root.rglob("*")):
            if not path.is_file():
                continue
            try:
                # Image.open 只读文件头，不解码像素
                with path.open("rb") as handle:
                    width, height = Image.open(handle).size
            except Exception:  # noqa: BLE001 - 非图片、损坏文件一律跳过
                continue
            if width and height:
                sizes[path.relative_to(root).as_posix()] = [width, height]

        _upload_sizes = sizes
        _upload_stamp = stamp
        return sizes


# ---------------------------------------------------------------- 查询 API


def get_site() -> dict[str, Any]:
    return _store()["site"]


def list_articles(
    *,
    include_drafts: bool = False,
    tag: str | None = None,
    collection: str | None = None,
    limit: int | None = None,
    offset: int = 0,
) -> list[Article]:
    """按发布时间（date + time）倒序返回文章列表，可按文集与标签筛选。

    同一时刻的两篇再按 slug 倒序，顺序稳定且可复现。
    """
    articles = list(_store()["articles"].values())
    if not include_drafts:
        # draft 是「暂时不发布」，sensitive 是「任何情况下都不对外输出」：
        # 后者用于存放含密钥一类内容，即使有人误把 draft 改成 false 也不会泄露。
        articles = [item for item in articles if not item.draft and not item.sensitive]
    if collection:
        wanted = collection.strip().lower()
        articles = [item for item in articles if item.collection.lower() == wanted]
    if tag:
        needle = tag.strip().lower()
        articles = [item for item in articles if needle in {t.lower() for t in item.tags}]

    articles.sort(key=lambda item: (item.published, item.slug), reverse=True)

    if offset:
        articles = articles[offset:]
    if limit is not None:
        articles = articles[:limit]
    return articles


def count_articles(
    *, include_drafts: bool = False, tag: str | None = None, collection: str | None = None
) -> int:
    return len(list_articles(include_drafts=include_drafts, tag=tag, collection=collection))


def get_article(slug: str, *, include_drafts: bool = False) -> Article | None:
    if not slug or not SLUG_RE.match(slug):
        return None
    article = _store()["articles"].get(slug)
    if article is None:
        return None
    if (article.draft or article.sensitive) and not include_drafts:
        return None
    return article


def list_tags(*, include_drafts: bool = False, collection: str | None = None) -> list[tuple[str, int]]:
    """返回 ``[(标签, 篇数)]``，按篇数倒序。可限定在某个文集内统计。"""
    counter: dict[str, int] = {}
    for article in _store()["articles"].values():
        if (article.draft or article.sensitive) and not include_drafts:
            continue
        if collection and article.collection.lower() != collection.strip().lower():
            continue
        for tag in article.tags:
            counter[tag] = counter.get(tag, 0) + 1
    return sorted(counter.items(), key=lambda pair: (-pair[1], pair[0]))


def list_collections(*, include_drafts: bool = False) -> list[tuple[str, int]]:
    """返回 ``[(文集, 篇数)]``，按篇数倒序；「未归档」始终排在最后。"""
    counter: dict[str, int] = {}
    for article in _store()["articles"].values():
        if (article.draft or article.sensitive) and not include_drafts:
            continue
        counter[article.collection] = counter.get(article.collection, 0) + 1
    return sorted(
        counter.items(),
        key=lambda pair: (pair[0] == DEFAULT_COLLECTION, -pair[1], pair[0]),
    )


def list_articles_by_year(*, include_drafts: bool = False) -> list[tuple[int, list[Article]]]:
    """按年份分组，用于文章归档页。"""
    grouped: dict[int, list[Article]] = {}
    for article in list_articles(include_drafts=include_drafts):
        grouped.setdefault(article.year, []).append(article)
    return sorted(grouped.items(), key=lambda pair: -pair[0])


def list_projects(*, featured_only: bool = False, include_drafts: bool = False) -> list[Project]:
    """按 ``order`` 升序、其次按 slug 返回项目列表。"""
    projects = list(_store()["projects"].values())
    if featured_only:
        projects = [item for item in projects if item.featured]
    projects.sort(key=lambda item: (item.order, item.slug))
    return projects


def get_project(slug: str) -> Project | None:
    if not slug or not SLUG_RE.match(slug):
        return None
    return _store()["projects"].get(slug)


def stats() -> dict[str, int]:
    """供管理后台仪表盘展示。"""
    articles = list(_store()["articles"].values())
    projects = list(_store()["projects"].values())
    return {
        "articles": len(articles),
        "drafts": sum(1 for item in articles if item.draft),
        "sensitive": sum(1 for item in articles if item.sensitive),
        "projects": len(projects),
        "tags": len({tag for item in articles for tag in item.tags}),
    }


# ---------------------------------------------------------------- 写入支持
# Phase 3 的编辑页复用以下工具，保证生成的文件名与 front matter 格式一致。

ARTICLE_TEMPLATE = """---
title: {title}
date: {date}
time: "{time}"
summary: {summary}
collection: 未归档
tags: []
draft: true
---

在这里开始写作。
"""

PROJECT_TEMPLATE = """---
title: {title}
status: 进行中
period: {period}
summary: {summary}
stack: []
featured: false
order: 100
links: []
---

这是更详细的说明段落，用于描述项目背景与实现方式。
"""


def slugify(text: str, fallback: str = "untitled") -> str:
    """把标题转换为合法 slug。中文标题会得到空串，此时回退到日期式命名。"""
    slug = re.sub(r"[^a-z0-9]+", "-", (text or "").strip().lower()).strip("-")
    slug = slug[:80].strip("-")
    return slug or fallback


def unique_slug(directory: Path, base: str) -> str:
    """若目标文件名已存在，追加 ``-2``、``-3`` 等序号。"""
    candidate = base
    index = 2
    while (directory / f"{candidate}.md").exists():
        candidate = f"{base}-{index}"
        index += 1
    return candidate


SITE_FILE_HEADER = """\
# 站点信息 —— 主页 hero 区域与顶部导航直接读取本文件。
# 可通过管理后台 /admin/site 可视化编辑；注意：保存时本文件会被整体重写，
# 因此手写的注释不会保留，需要长期保留的说明请写在这里。
# 图片建议在后台点「上传」，会自动填入形如 /uploads/2026/09/avatar.png 的地址；
# 也接受 2026/09/avatar.png 这样的相对路径，或 http(s) 外链。

"""


def _git_commit(root: Path, message: str) -> None:
    """内容目录若已初始化为 git 仓库，则提交本次改动。

    目的是让「线上写作」也具备版本控制：每篇文章的每次改动都能 diff 与回滚。
    任何失败都只记录告警——内容已经落盘，绝不能因为版本化失败而影响保存。
    """
    if not (root / ".git").exists():
        return

    identity = ["-c", "user.name=content", "-c", "user.email=content@localhost"]
    try:
        subprocess.run(
            ["git", "-C", str(root), "add", "-A"],
            check=True, capture_output=True, timeout=20,
        )
        subprocess.run(
            ["git", "-C", str(root), *identity, "commit", "-q", "-m", message],
            check=True, capture_output=True, timeout=20,
        )
        logger.info("内容已自动提交：%s", message)
    except FileNotFoundError:
        logger.warning("未找到 git 命令，跳过内容版本化")
    except subprocess.TimeoutExpired:
        logger.warning("内容自动提交超时，已跳过")
    except subprocess.CalledProcessError as exc:
        detail = (exc.stderr or b"").decode(errors="replace").strip()
        if "nothing to commit" in detail:
            return
        logger.warning("内容自动提交失败：%s", detail or exc)


def _as_lf(text: str) -> str:
    """把换行统一成 LF。

    表单提交上来的正文是 CRLF：HTML 规范要求浏览器提交前把 LF 规范化成 CRLF，所以
    Python 这侧拿到的是 ``\\r\\n``。而 Windows 上 ``write_text`` 默认又会把每个 ``\\n``
    翻译成 ``os.linesep``（同样是 ``\\r\\n``），两者叠在一起写出的是 ``\\r\\r\\n``；
    读回来时 ``\\r\\r\\n`` 被当成一个空行，于是每保存一次，正文里的空行就翻一倍。
    写成 LF 还让 ``content/`` 目录里的文件跨平台一致，git 里不会出现混合换行。
    """
    return text.replace("\r\n", "\n").replace("\r", "\n")


@dataclass(slots=True)
class ContentWriter:
    """把文档写回磁盘，并负责缓存失效与（可选的）git 提交。"""

    root: Path = field(default_factory=content_dir)

    def _write(self, directory: str, slug: str, payload: str, message: str) -> Path:
        target_dir = self.root / directory
        target_dir.mkdir(parents=True, exist_ok=True)
        target = target_dir / f"{slug}.md"
        temp = target.with_suffix(".md.tmp")
        # 先写临时文件再原子替换，避免写入过程中被读到半截内容
        temp.write_text(_as_lf(payload), encoding="utf-8", newline="\n")
        temp.replace(target)
        invalidate()
        _git_commit(self.root, message)
        return target

    def write_article(self, slug: str, metadata: dict[str, Any], body: str) -> Path:
        post = frontmatter.Post(body, **metadata)
        action = "更新" if (self.root / "articles" / f"{slug}.md").exists() else "新建"
        return self._write(
            "articles", slug, frontmatter.dumps(post), f"{action}文章：{metadata.get('title', slug)}"
        )

    def write_project(self, slug: str, metadata: dict[str, Any], body: str) -> Path:
        post = frontmatter.Post(body, **metadata)
        action = "更新" if (self.root / "projects" / f"{slug}.md").exists() else "新建"
        return self._write(
            "projects", slug, frontmatter.dumps(post), f"{action}项目：{metadata.get('title', slug)}"
        )

    def write_site(self, payload: dict[str, Any]) -> Path:
        target = self.root / "site.yml"
        target.parent.mkdir(parents=True, exist_ok=True)
        temp = target.with_suffix(".yml.tmp")
        temp.write_text(
            _as_lf(
                SITE_FILE_HEADER + yaml.safe_dump(payload, allow_unicode=True, sort_keys=False)
            ),
            encoding="utf-8",
            newline="\n",
        )
        temp.replace(target)
        invalidate()
        _git_commit(self.root, "更新站点信息")
        return target

    def delete(self, directory: str, slug: str) -> bool:
        if not SLUG_RE.match(slug):
            return False
        target = self.root / directory / f"{slug}.md"
        if not target.is_file():
            return False
        target.unlink()
        invalidate()
        _git_commit(self.root, f"删除{'文章' if directory == 'articles' else '项目'}：{slug}")
        return True
