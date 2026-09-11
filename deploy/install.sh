#!/usr/bin/env bash
# ============================================================================
# 一键安装脚本：把 deploy/*.template 渲染成真实配置并装进系统。
#
# 渲染规则：模板里的 __APP_DIR__ / __VENV_DIR__ / __CONTENT_DIR__ / __APP_USER__
# / __SERVICE_NAME__ / __DOMAIN__ / __BIND_ADDR__ / __BRANCH__ 会被替换为下面的参数。
#
# 先看看会生成什么（不需要 root，产物在 deploy/out/）：
#   bash deploy/install.sh --dry-run
#
# 正式安装：
#   sudo bash deploy/install.sh \
#        --app-dir /srv/blog/program \
#        --content-dir /srv/blog/content \
#        --user blog --service blog --domain blog.example.com \
#        --bare-repo /srv/blog/blog.git
# ============================================================================

set -euo pipefail

APP_DIR="/srv/blog/program"
VENV_DIR=""
CONTENT_DIR=""
APP_USER="blog"
SERVICE_NAME="blog"
DOMAIN="example.com"
BIND_ADDR="127.0.0.1:8080"
BARE_REPO=""
BRANCH="main"
DRY_RUN=0

usage() {
    cat <<'EOF'
用法： sudo bash deploy/install.sh [选项]

  --app-dir DIR       应用运行目录（包含代码与 .env）   默认 /srv/blog/program
  --venv-dir DIR      Python 虚拟环境目录               默认 <app-dir>/../venv
  --content-dir DIR   内容目录（写作与上传落盘处）      默认 <app-dir>/../content
  --user USER         运行服务的系统用户                默认 blog
  --service NAME      systemd 服务名                    默认 blog
  --domain DOMAIN     对外域名，写入服务描述与文档      默认 example.com
  --bind ADDR         gunicorn 监听地址                 默认 127.0.0.1:8080
  --bare-repo DIR     裸仓库路径；提供则同时安装部署钩子
  --branch NAME       触发自动部署的分支                默认 main
  --dry-run           只渲染到 deploy/out/，不安装任何系统文件
  -h, --help          显示本帮助
EOF
}

while [ $# -gt 0 ]; do
    case "$1" in
        --app-dir)     APP_DIR="$2"; shift 2 ;;
        --venv-dir)    VENV_DIR="$2"; shift 2 ;;
        --content-dir) CONTENT_DIR="$2"; shift 2 ;;
        --user)        APP_USER="$2"; shift 2 ;;
        --service)     SERVICE_NAME="$2"; shift 2 ;;
        --domain)      DOMAIN="$2"; shift 2 ;;
        --bind)        BIND_ADDR="$2"; shift 2 ;;
        --bare-repo)   BARE_REPO="$2"; shift 2 ;;
        --branch)      BRANCH="$2"; shift 2 ;;
        --dry-run)     DRY_RUN=1; shift ;;
        -h|--help)     usage; exit 0 ;;
        *) echo "未知参数：$1" >&2; usage >&2; exit 1 ;;
    esac
done

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"

if [ -d "$APP_DIR" ]; then
    APP_DIR="$(cd "$APP_DIR" && pwd)"
fi
PARENT_DIR="$(dirname "$APP_DIR")"
VENV_DIR="${VENV_DIR:-$PARENT_DIR/venv}"
CONTENT_DIR="${CONTENT_DIR:-$PARENT_DIR/content}"

render() {
    local template="$1" target="$2"
    sed -e "s|__APP_DIR__|${APP_DIR}|g" \
        -e "s|__VENV_DIR__|${VENV_DIR}|g" \
        -e "s|__CONTENT_DIR__|${CONTENT_DIR}|g" \
        -e "s|__APP_USER__|${APP_USER}|g" \
        -e "s|__SERVICE_NAME__|${SERVICE_NAME}|g" \
        -e "s|__DOMAIN__|${DOMAIN}|g" \
        -e "s|__BIND_ADDR__|${BIND_ADDR}|g" \
        -e "s|__BRANCH__|${BRANCH}|g" \
        "$template" > "$target"
}

echo "渲染参数："
cat <<EOF
  服务名      : $SERVICE_NAME
  运行用户    : $APP_USER
  应用目录    : $APP_DIR
  虚拟环境    : $VENV_DIR
  内容目录    : $CONTENT_DIR
  监听地址    : $BIND_ADDR
  域名        : $DOMAIN
  部署分支    : $BRANCH
  裸仓库      : ${BARE_REPO:-（未提供，跳过钩子安装）}
EOF
echo

if [ "$DRY_RUN" -eq 1 ]; then
    OUT_DIR="$SCRIPT_DIR/out"
    mkdir -p "$OUT_DIR"
    render "$SCRIPT_DIR/blog.service.template" "$OUT_DIR/$SERVICE_NAME.service"
    render "$SCRIPT_DIR/blog-sudoers.template" "$OUT_DIR/blog-sudoers"
    render "$SCRIPT_DIR/post-receive.template" "$OUT_DIR/post-receive"
    echo "✓ 已渲染到 $OUT_DIR（未改动系统）"
    exit 0
fi

if [ "$(id -u)" -ne 0 ]; then
    echo "错误：安装 systemd 单元与 sudoers 需要 root，请用 sudo 运行（或加 --dry-run 预览）。" >&2
    exit 1
fi

mkdir -p "$CONTENT_DIR"
TMP_DIR="$(mktemp -d)"
trap 'rm -rf "$TMP_DIR"' EXIT

render "$SCRIPT_DIR/blog.service.template" "$TMP_DIR/$SERVICE_NAME.service"
install -m 0644 "$TMP_DIR/$SERVICE_NAME.service" "/etc/systemd/system/$SERVICE_NAME.service"
echo "✓ 已安装 /etc/systemd/system/$SERVICE_NAME.service"

render "$SCRIPT_DIR/blog-sudoers.template" "$TMP_DIR/sudoers"
install -m 0440 "$TMP_DIR/sudoers" "/etc/sudoers.d/$SERVICE_NAME"
if command -v visudo >/dev/null 2>&1; then
    visudo -c -f "/etc/sudoers.d/$SERVICE_NAME" >/dev/null
fi
echo "✓ 已安装 /etc/sudoers.d/$SERVICE_NAME"

if [ -n "$BARE_REPO" ]; then
    if [ -d "$BARE_REPO" ]; then
        mkdir -p "$BARE_REPO/hooks"
        render "$SCRIPT_DIR/post-receive.template" "$BARE_REPO/hooks/post-receive"
        chmod 0755 "$BARE_REPO/hooks/post-receive"
        echo "✓ 已安装 $BARE_REPO/hooks/post-receive"
    else
        echo "⚠️  裸仓库不存在，已跳过钩子安装：$BARE_REPO" >&2
    fi
fi

systemctl daemon-reload
echo
echo "完成。接下来："
echo "  1. 确认 $APP_DIR/.env 已配置（SECRET_KEY / ADMIN_PASSWORD_HASH）"
echo "  2. sudo systemctl enable --now $SERVICE_NAME.service"
echo "  3. curl -s $BIND_ADDR/healthz   # 应返回 {\"status\":\"ok\"}"
