# 第三方前端库（vendored）

后台编辑器的本地 Markdown 预览与公开页面的公式排版用到的库，随仓库提交，不从 CDN 加载。
想升级时按下面的版本号重新下载同名文件即可，注意 `markdown-local.js` 里的类名映射
（highlight.js → Pygments 短码）可能需要跟着调整。

| 文件 | 包 | 版本 | 许可证 | 来源 |
| --- | --- | --- | --- | --- |
| `markdown-it.min.js` | markdown-it | 14.1.0 | MIT | <https://cdn.jsdelivr.net/npm/markdown-it@14.1.0/dist/markdown-it.min.js> |
| `markdown-it-attrs.js` | markdown-it-attrs | 4.3.1 | MIT | <https://cdn.jsdelivr.net/npm/markdown-it-attrs@4.3.1/markdown-it-attrs.browser.js> |
| `markdown-it-footnote.min.js` | markdown-it-footnote | 4.0.0 | MIT | <https://cdn.jsdelivr.net/npm/markdown-it-footnote@4.0.0/dist/markdown-it-footnote.min.js> |
| `markdown-it-deflist.min.js` | markdown-it-deflist | 3.0.0 | MIT | <https://cdn.jsdelivr.net/npm/markdown-it-deflist@3.0.0/dist/markdown-it-deflist.min.js> |
| `markdown-it-abbr.min.js` | markdown-it-abbr | 1.0.4 | MIT | <https://cdn.jsdelivr.net/npm/markdown-it-abbr@1.0.4/dist/markdown-it-abbr.min.js> |
| `highlight.min.js` | @highlightjs/cdn-assets（common 构建） | 11.11.1 | BSD-3-Clause | <https://cdn.jsdelivr.net/npm/@highlightjs/cdn-assets@11.11.1/highlight.min.js> |
| `katex/katex.min.js` | katex | 0.16.47 | MIT | <https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.js> |
| `katex/katex.min.css` | katex | 0.16.47 | MIT | <https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/katex.min.css> |
| `katex/auto-render.min.js` | katex | 0.16.47 | MIT | <https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/contrib/auto-render.min.js> |
| `katex/fonts/*.woff2` | katex | 0.16.47 | MIT | <https://cdn.jsdelivr.net/npm/katex@0.16.47/dist/fonts/> |

KaTeX 只提交了 CSS 里用到的 `woff2` 字体（20 个）；CSS 里还列着 `woff` / `ttf` 作为
老浏览器的回退，现代浏览器按 `src` 顺序只会请求 `woff2`，不会产生 404。
许可证原文见 `katex/LICENSE`。

加载顺序见 `templates/admin/_editor_scripts.html`（后台）与
`templates/article_detail.html` / `project_detail.html`（公开页，仅有公式时加载）；
渲染规则与已知差异见 `static/js/markdown-local.js`，公式入口见 `static/js/math.js`。
