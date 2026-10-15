"""预览态：访客凭 .env 中的密钥查看草稿。

两种预览互不影响，都只写进当前浏览器会话，因此不会改变其他访客（包括搜索引擎）
看到的内容：

- **后台预览**：登录后在公开页面上开启，草稿与 ``sensitive`` 内容都可见；
- **访客预览**：任何访客在 ``/preview`` 输入 ``PREVIEW_KEY`` 后开启，只显示草稿，
  ``sensitive`` 内容（含凭据一类东西）始终不出现。

只要有任一预览生效，``app.py`` 就会给响应加上 ``noindex``，避免草稿被收录。
"""

from __future__ import annotations

import hmac
import time
from collections import defaultdict, deque
from urllib.parse import urlsplit

from flask import (
    Blueprint,
    current_app,
    redirect,
    render_template,
    request,
    session,
    url_for,
)

bp = Blueprint("preview", __name__)

# 后台预览开关：只有已登录的会话才可能为真
ADMIN_SESSION_KEY = "preview"
# 访客预览标记：任何会话都可以置位
GUEST_SESSION_KEY = "guest_preview"

# 预览档位
SCOPE_NONE = "none"
SCOPE_DRAFT = "draft"
SCOPE_ALL = "all"

# 访客密钥尝试记录：{来源 IP: 失败时间戳队列}
_key_attempts: dict[str, deque[float]] = defaultdict(deque)


# --------------------------------------------------------------------- 会话状态


def admin_preview_enabled() -> bool:
    """后台预览是否开启。"""
    return bool(session.get("authenticated") and session.get(ADMIN_SESSION_KEY))


def guest_preview_enabled() -> bool:
    """访客预览是否开启。"""
    return bool(session.get(GUEST_SESSION_KEY))


def preview_enabled() -> bool:
    """是否有任一预览生效。"""
    return admin_preview_enabled() or guest_preview_enabled()


def preview_scope() -> str:
    """当前预览档位：``none`` / ``draft``（访客）/ ``all``（后台）。"""
    if admin_preview_enabled():
        return SCOPE_ALL
    if guest_preview_enabled():
        return SCOPE_DRAFT
    return SCOPE_NONE


def visibility() -> tuple[bool, bool]:
    """``(是否显示草稿, 是否显示敏感内容)``，直接喂给 ``content`` 的查询 API。"""
    scope = preview_scope()
    return scope != SCOPE_NONE, scope == SCOPE_ALL


# --------------------------------------------------------------------- 密钥校验


def preview_configured() -> bool:
    return bool(current_app.config.get("PREVIEW_KEY"))


def _matches_key(raw: str) -> bool:
    expected = current_app.config.get("PREVIEW_KEY") or ""
    if not expected or not raw:
        return False
    # 定长比较，避免逐字符比较从耗时上泄露前缀
    return hmac.compare_digest(raw.encode("utf-8"), expected.encode("utf-8"))


def _client_ip() -> str:
    """取真实来源 IP，与 ``admin._client_ip`` 同源。

    服务只监听 127.0.0.1，能连上的只有本机 nginx，因此信任 nginx 写入的
    X-Forwarded-For 不会引入伪造风险。
    """
    forwarded = request.headers.get("X-Forwarded-For", "")
    if forwarded:
        return forwarded.split(",")[0].strip()
    return request.remote_addr or "unknown"


def _throttled(ip: str) -> bool:
    limit = current_app.config["PREVIEW_ATTEMPT_IP_LIMIT"]
    window = current_app.config["PREVIEW_ATTEMPT_IP_WINDOW"]
    queue = _key_attempts[ip]
    cutoff = time.time() - window
    while queue and queue[0] < cutoff:
        queue.popleft()
    return len(queue) >= limit


def _safe_target(default: str) -> str:
    """回跳目标：只接受站内路径，且不会绕回预览页自身，避免开放重定向。"""
    raw = (request.form.get("next") or request.referrer or "").strip()
    path = urlsplit(raw).path if raw.startswith(("http://", "https://")) else raw
    # 以 // 开头的是协议相对地址，同样会跳到外站
    if not path.startswith("/") or path.startswith("//") or path.startswith("/preview"):
        return default
    return path


# --------------------------------------------------------------------- 路由


@bp.get("/preview")
def preview_page():
    """访客输入密钥的入口页。未配置 PREVIEW_KEY 时明确提示功能未开启。"""
    return render_template(
        "preview.html",
        configured=preview_configured(),
        unlocked=guest_preview_enabled(),
    )


@bp.post("/preview")
def unlock():
    if not preview_configured():
        return render_template("preview.html", configured=False, unlocked=False), 503

    ip = _client_ip()
    if _throttled(ip):
        current_app.logger.warning("访客预览密钥尝试过多，来源 %s", ip)
        return (
            render_template(
                "preview.html",
                configured=True,
                unlocked=False,
                error="尝试次数过多，请稍后再试。",
            ),
            429,
        )

    if not _matches_key(request.form.get("key") or ""):
        _key_attempts[ip].append(time.time())
        current_app.logger.warning("访客预览密钥错误，来源 %s", ip)
        return (
            render_template(
                "preview.html", configured=True, unlocked=False, error="密钥不正确。"
            ),
            401,
        )

    _key_attempts.pop(ip, None)
    session[GUEST_SESSION_KEY] = True
    session.permanent = True
    current_app.logger.info("访客预览已开启，来源 %s", ip)
    return redirect(_safe_target(url_for("articles")))


@bp.post("/preview/exit")
def exit_preview():
    session.pop(GUEST_SESSION_KEY, None)
    current_app.logger.info("访客预览已关闭，来源 %s", _client_ip())
    return redirect(_safe_target(url_for("index")))
