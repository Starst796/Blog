# 贡献指南

感谢你有兴趣改进这个项目。它是一个刻意保持小巧的 Flask 应用，欢迎提交
Issue 与 Pull Request。

## 开始之前

- 请先阅读 `README.md`，确保开发环境可以正常启动。
- 涉及界面或交互的改动，建议在 Issue 里先描述方案再动手，避免方向不一致。
- 涉及安全（认证、CSRF、上传、路径处理）的改动请格外谨慎，并在 PR 中说明影响面。

## 本地开发

```bash
python -m venv .venv
source .venv/bin/activate          # Windows: .venv\Scripts\activate
pip install -r requirements.txt
cp .env.example .env
python manage.py init
python manage.py set-password
python wsgi.py                     # http://127.0.0.1:8080
```

本地使用 http 时，`.env` 里需要 `SESSION_COOKIE_SECURE=0`，否则浏览器不会回传会话 cookie。

## 代码约定

- 保持 `app.py`（组装）/ `views.py`（公开页面）/ `admin.py`（后台）/ `content.py`（内容层）
  的职责边界，不要跨层塞逻辑。
- 注释解释「为什么」而不是「做了什么」，与现有风格保持一致。
- 新增配置项时写进 `config.py` 并支持环境变量覆盖，同时在 `.env.example` 与 README
  的环境变量表中登记。
- 新增模板文案请保持中文，且不要在模板里硬编码站点名、域名等个性化信息——
  这些应从 `site`（`content/site.yml`）或 `config` 读取。

## 提交前自检

```bash
python -m compileall -q .                      # 语法检查
python -c "from app import create_app; create_app(); print('ok')"   # 应用能否装配
python manage.py status                        # 配置是否完整
```

## 提交信息

使用简短的祈使句，可用中文或英文，例如：

```
修复文章重命名后旧文件未删除的问题
feat: 支持自定义时区偏移
```

## 许可证

提交代码即表示你同意以本项目的 MIT 许可证发布你的贡献。
