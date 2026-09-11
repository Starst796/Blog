"""运维脚本：生成密钥、设置管理密码、初始化内容仓库。

用法（在仓库任意位置执行均可，脚本只操作同目录的 .env）::

    python manage.py init            # 生成 SECRET_KEY，补齐 .env
    python manage.py set-password    # 交互式设置管理密码（推荐）
    python manage.py status          # 查看当前配置状态
    python manage.py init-content    # 把内容目录初始化为独立 git 仓库

设计说明：密码只以哈希形式落盘，明文不经过命令行参数（避免出现在 shell 历史
与进程列表里），也不经过任何自动流程。
"""

from __future__ import annotations

import argparse
import getpass
import os
import secrets
import subprocess
import sys
from pathlib import Path

from werkzeug.security import generate_password_hash

BASE_DIR = Path(__file__).resolve().parent
ENV_PATH = BASE_DIR / ".env"

HEADER = "# 站点机密配置 —— 已被 .gitignore 排除，请勿提交到仓库"
MIN_PASSWORD_LENGTH = 8


# --------------------------------------------------------------------- .env 读写


def read_env() -> dict[str, str]:
    values: dict[str, str] = {}
    if not ENV_PATH.is_file():
        return values
    for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
        stripped = line.strip()
        if not stripped or stripped.startswith("#") or "=" not in stripped:
            continue
        key, value = stripped.split("=", 1)
        values[key.strip()] = _unquote(value.strip())
    return values


def _unquote(value: str) -> str:
    if len(value) >= 2 and value[0] == value[-1] and value[0] in {"'", '"'}:
        return value[1:-1]
    return value


def _quote(value: str) -> str:
    """密码哈希含 ``$``，而 systemd 会解析 EnvironmentFile 中的变量；

    单引号包裹可让 systemd 按字面量处理，python-dotenv 也会正确去掉引号。
    """
    if any(char in value for char in "$`\"'\\ \t"):
        return "'" + value.replace("'", "") + "'"
    return value


def update_env(updates: dict[str, str]) -> None:
    """就地更新 .env：已存在的键替换，缺失的键追加，其余内容原样保留。"""
    lines: list[str] = []
    replaced: set[str] = set()

    if ENV_PATH.is_file():
        for line in ENV_PATH.read_text(encoding="utf-8").splitlines():
            stripped = line.strip()
            if stripped and not stripped.startswith("#") and "=" in stripped:
                key = stripped.split("=", 1)[0].strip()
                if key in updates:
                    lines.append(f"{key}={_quote(updates[key])}")
                    replaced.add(key)
                    continue
            lines.append(line)

    if not any(line.strip() == HEADER for line in lines):
        lines.insert(0, HEADER)

    for key, value in updates.items():
        if key not in replaced:
            lines.append(f"{key}={_quote(value)}")

    ENV_PATH.write_text("\n".join(lines).rstrip("\n") + "\n", encoding="utf-8")
    ENV_PATH.chmod(0o600)


# --------------------------------------------------------------------- 子命令


def cmd_init(args: argparse.Namespace) -> int:
    values = read_env()
    updates: dict[str, str] = {}

    if not values.get("SECRET_KEY"):
        updates["SECRET_KEY"] = secrets.token_urlsafe(48)
        print("✓ 已生成新的 SECRET_KEY")
    else:
        print("· SECRET_KEY 已存在，保持不变")

    if not values.get("ADMIN_USERNAME"):
        updates["ADMIN_USERNAME"] = args.username
        print(f"✓ 已设置管理账号：{args.username}")
    else:
        print(f"· 管理账号已存在：{values['ADMIN_USERNAME']}")

    if updates:
        update_env(updates)

    if not (values.get("ADMIN_PASSWORD_HASH") or updates.get("ADMIN_PASSWORD_HASH")):
        print()
        print("下一步：设置管理密码（需要你本人交互输入）")
        print(f"    {sys.executable} {BASE_DIR / 'manage.py'} set-password")

    print(f"\n配置文件：{ENV_PATH}")
    return 0


def cmd_set_password(args: argparse.Namespace) -> int:
    if not sys.stdin.isatty():
        print("错误：需要在交互式终端中运行（密码通过输入而非参数传递）。", file=sys.stderr)
        return 1

    password = getpass.getpass("新密码：")
    if len(password) < MIN_PASSWORD_LENGTH:
        print(f"错误：密码至少 {MIN_PASSWORD_LENGTH} 位。", file=sys.stderr)
        return 1

    if password != getpass.getpass("再输一次："):
        print("错误：两次输入不一致。", file=sys.stderr)
        return 1

    values = read_env()
    updates = {
        "ADMIN_PASSWORD_HASH": generate_password_hash(password),
        "ADMIN_USERNAME": args.username or values.get("ADMIN_USERNAME") or "admin",
    }
    if not values.get("SECRET_KEY"):
        updates["SECRET_KEY"] = secrets.token_urlsafe(48)

    update_env(updates)

    print("✓ 管理密码已更新（仅保存哈希）")
    print(f"  配置文件：{ENV_PATH}")
    print("\n提示：修改 .env 后需要重启服务才会生效")
    print("    sudo systemctl restart blog.service")
    return 0


def cmd_init_content(args: argparse.Namespace) -> int:
    """把内容目录初始化为独立的 git 仓库。

    内容与代码分开版本化：部署代码不会覆盖线上写作，而每次保存都会自动提交，
    因此可以精确回滚到某一篇文章的某个版本。
    """
    root = Path(args.path).resolve()
    root.mkdir(parents=True, exist_ok=True)
    for sub in ("articles", "projects", "uploads"):
        (root / sub).mkdir(parents=True, exist_ok=True)

    if (root / ".git").exists():
        print(f"· {root} 已经是 git 仓库，跳过初始化")
        return 0

    subprocess.run(["git", "init", "-b", "main", "--quiet", str(root)], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.name", args.author], check=True)
    subprocess.run(["git", "-C", str(root), "config", "user.email", args.email], check=True)

    gitignore = root / ".gitignore"
    if not gitignore.exists():
        gitignore.write_text("*.tmp\n.DS_Store\n", encoding="utf-8")

    subprocess.run(["git", "-C", str(root), "add", "-A"], check=True)
    subprocess.run(
        ["git", "-C", str(root), "commit", "-q", "-m", "chore: 初始化内容仓库"], check=True
    )

    print(f"✓ 内容仓库已创建：{root}")
    print("  此后在编辑页面每保存一次，都会自动生成一个提交。")
    print(f"  查看历史：git -C {root} log --oneline")
    return 0


def cmd_status(args: argparse.Namespace) -> int:
    values = read_env()
    print(f"配置文件：{ENV_PATH}（{'存在' if ENV_PATH.is_file() else '不存在'}）")
    print(f"SECRET_KEY          : {'已设置' if values.get('SECRET_KEY') else '缺失'}")
    print(f"ADMIN_USERNAME      : {values.get('ADMIN_USERNAME') or '（默认 admin）'}")
    print(f"ADMIN_PASSWORD_HASH : {'已设置' if values.get('ADMIN_PASSWORD_HASH') else '缺失'}")
    print(f"内容目录            : {_default_content_dir()}")
    return 0


def _default_content_dir() -> str:
    """优先级：CONTENT_DIR 环境变量 > .env 中的 CONTENT_DIR > 仓库内的 content/。"""
    env = os.environ.get("CONTENT_DIR") or read_env().get("CONTENT_DIR")
    return str(Path(env).expanduser()) if env else str(BASE_DIR / "content")


def main() -> int:
    parser = argparse.ArgumentParser(description="站点运维脚本")
    sub = parser.add_subparsers(dest="command", required=True)

    p_init = sub.add_parser("init", help="生成 SECRET_KEY 并补齐 .env")
    p_init.add_argument("--username", default="admin", help="管理账号名")
    p_init.set_defaults(func=cmd_init)

    p_password = sub.add_parser("set-password", help="交互式设置管理密码")
    p_password.add_argument("--username", default=None, help="同时更新管理账号名")
    p_password.set_defaults(func=cmd_set_password)

    p_status = sub.add_parser("status", help="查看配置状态")
    p_status.set_defaults(func=cmd_status)

    p_content = sub.add_parser("init-content", help="把内容目录初始化为独立 git 仓库")
    p_content.add_argument(
        "--path",
        default=None,
        help="内容目录路径（默认取 CONTENT_DIR，未设置则为仓库内的 content/）",
    )
    p_content.add_argument("--author", default="Site Author", help="提交者名称")
    p_content.add_argument("--email", default="author@example.com", help="提交者邮箱")
    p_content.set_defaults(func=cmd_init_content)

    args = parser.parse_args()
    if getattr(args, "path", None) is None:
        args.path = _default_content_dir()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
