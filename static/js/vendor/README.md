# 第三方前端库（vendored）

后台编辑器的本地 Markdown 预览用到的库，随仓库提交，不从 CDN 加载。
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

加载顺序见 `templates/admin/_editor_scripts.html`；渲染规则与已知差异见
`static/js/markdown-local.js`。
