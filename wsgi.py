"""WSGI 入口。

生产：gunicorn 以 `wsgi:app` 加载。
本地：`python wsgi.py` 直接起开发服务器。
"""

from app import create_app
from config import Config

app = create_app()

if __name__ == "__main__":
    app.run(host=Config.HOST, port=Config.PORT, debug=Config.DEBUG)
