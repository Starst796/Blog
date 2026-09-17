/* 本地 Markdown 渲染：后台编辑预览用，全程在浏览器里完成，不发任何请求。
   预览速度只取决于本机，与服务器负载无关。

   目标是贴近服务端 content.py 的 Python-Markdown 输出，好让预览与线上文章尽量一致。
   两套引擎终究不同，只能做到结构与观感相近，不能逐字节相同。以下是刻意的对齐：

     Python-Markdown                     这里
     ---------------------------------   -------------------------------------------
     extra: tables / fenced_code         markdown-it 核心
     extra: attr_list（{: style="…"}）    markdown-it-attrs
     extra: footnotes / def_list / abbr  对应的 markdown-it 插件
     codehilite（Pygments）              highlight.js + 类名翻译成 Pygments 短码，
                                         复用 site.css 里已有的配色，不再写一份样式
     admonition（!!! note "标题"）       自定义块级规则，输出同样的 div/p 结构
     toc（标题锚点，保留中文）            自定义 core 规则，复刻 slugify_unicode
     pymdownx.tilde（~~删除~~）          markdown-it 的 <s> 改写为 <del>
     这里多出来的一样：每个顶层块带 data-line / data-line-end（源码行号），
     只有 admin.js 的滚动联动会读它，正文与线上渲染都不受影响。

   已知差异（见文件末尾注释）：列表与上文的空行、代码高亮的细腻程度、属性顺序。

   依赖 static/js/vendor/ 下的库，由模板按固定顺序加载；任何依赖缺失都会让
   available 为 false，调用方据此退回服务端渲染。 */
(function (global) {
  'use strict';

  var markdownit = global.markdownit;
  var hljs = global.hljs;

  /* ------------------------------------------------ 代码高亮

     Pygments 的 class 是 k / s / c 这类短码，highlight.js 是 hljs-* 长名。
     site.css 里已经写好了 Pygments 短码的配色（含明暗两套），所以这里把 hljs 的
     类名翻译成对应短码，而不是再补一份 CSS——预览里代码块的颜色就与线上一致。 */
  var HLJS_TO_PYGMENTS = {
    keyword: 'k',
    literal: 'kc',
    built_in: 'nb',
    type: 'kt',
    string: 's',
    regexp: 'sr',
    comment: 'c',
    doctag: 'c',
    quote: 'c',
    number: 'm',
    title: 'nf',
    function: 'nf',
    function_: 'nf',
    class: 'nc',
    class_: 'nc',
    section: 'nf',
    attr: 'na',
    attribute: 'na',
    property: 'nv',
    variable: 'nv',
    'template-variable': 'nv',
    params: 'n',
    operator: 'o',
    punctuation: 'p',
    symbol: 's',
    bullet: 's',
    link: 's',
    tag: 'nt',
    name: 'nt',
    'selector-tag': 'k',
    'selector-class': 'nc',
    'selector-id': 'nc',
    meta: 'nd',
    'meta-keyword': 'nd',
    'meta-string': 's',
    addition: 'gi',
    deletion: 'gd'
  };

  /* 把 class="hljs-title function_" 换成 class="nf"。
     同时出现多个 hljs 类名时取最后一个：highlight.js 把更具体的子类名放在后面。
     没有对应短码的类名（如 hljs-code）把整个 class 属性去掉——那些类在 site.css 里
     本来就没有样式，留着只会把 highlight.js 的类名漏进预览的 DOM。 */
  function translateClasses(html) {
    return html.replace(/(<[a-zA-Z][a-zA-Z0-9]*)\s+class="hljs-([^"]*)"/g,
      function (whole, tag, names) {
        var mapped = null;
        names.split(/\s+/).forEach(function (name) {
          var code = HLJS_TO_PYGMENTS[name.replace(/^hljs-/, '')];
          if (code) {
            mapped = code;
          }
        });
        return mapped ? tag + ' class="' + mapped + '"' : tag;
      });
  }

  function highlightBody(code, language, escape) {
    if (hljs && language && hljs.getLanguage(language)) {
      try {
        // guess_lang 在服务端是关的，这里也只在语言明确写出来时才高亮
        return translateClasses(hljs.highlight(code, {
          language: language,
          ignoreIllegals: true
        }).value);
      } catch (error) {
        return escape(code); // 高亮失败就退回纯文本，不影响预览
      }
    }
    return escape(code);
  }

  /* ------------------------------------------------ 块级属性（attr_list）

     Python-Markdown 的属性写法带冒号——独占一行的 {: style="text-align: center"}；
     markdown-it-attrs 认的是花括号里直接写属性名，冒号会被当成一个空属性
     （<p :="" style="…">）。这里在行内解析之前把独占一行的 {: …} 改写成 {…}。

     只改 inline token 的源码：代码块在 markdown-it 里是 fence / code_block 这些另外的
     token，写在代码块里的 {: …} 是示例文字，不会被顺手改掉。 */
  function blockAttrListPlugin(md) {
    md.core.ruler.after('block', 'blog_colon_attr_list', function (state) {
      state.tokens.forEach(function (token) {
        if (token.type === 'inline' && token.content) {
          token.content = token.content.replace(/^\{:[ \t]*(.*?)\}[ \t]*$/gm, '{$1}');
        }
      });
    });
  }

  /* ------------------------------------------------ 标题锚点

     复刻 markdown-it 之外的 Python-Markdown slugify_unicode：小写、丢掉非字母数字、
     空白与连字符折叠成一个 -、首尾的 - 和 _ 去掉。\w 在 Python 里对 Unicode 生效，
     所以中文标题会原样保留成锚点。重复标题按 Python-Markdown 的规则加 _1、_2。 */
  function slugify(text) {
    return text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}_\s-]/gu, '')
      .replace(/[-\s]+/g, '-')
      .replace(/^[-_]+|[-_]+$/g, '');
  }

  function uniqueSlug(base, used) {
    var slug = base || '_1';
    while (used[slug]) {
      var matched = /^(.*)_(\d+)$/.exec(slug);
      slug = matched ? matched[1] + '_' + (Number(matched[2]) + 1) : slug + '_1';
    }
    used[slug] = true;
    return slug;
  }

  /* 取标题的可见文字。inline.content 是源码（含 ** 与 []），直接用会把链接网址也算进
     锚点；这里按子节点取文字，与 Python-Markdown 用渲染结果生成锚点一致。 */
  function inlineText(token) {
    if (!token || !token.children) {
      return token ? token.content : '';
    }
    var text = '';
    token.children.forEach(function (child) {
      // 图片的 alt 是属性、不是文字，不参与锚点
      if (child.type === 'text' || child.type === 'code_inline') {
        text += child.content;
      } else if (child.children) {
        text += inlineText(child);
      }
    });
    return text;
  }

  function headingIdsPlugin(md) {
    md.core.ruler.push('blog_heading_ids', function (state) {
      var used = Object.create(null);
      var tokens = state.tokens;
      for (var i = 0; i < tokens.length; i++) {
        if (tokens[i].type !== 'heading_open') {
          continue;
        }
        tokens[i].attrSet('id', uniqueSlug(slugify(inlineText(tokens[i + 1])), used));
      }
    });
  }

  /* ------------------------------------------------ 源码行号（滚动联动用）

     给每个顶层块标上它在源码里的行号。此前 admin.js 只能拿块首几个字去源码里
     「认领」起始行，分隔线没有文字、引用块跨多段时块首文字又和单行源码对不上，
     认领不到就退回上一个块的位置，于是分隔线与后面的段落会错开好几行。
     markdown-it 的 token.map 本来就知道每个块占哪几行，写上就不用猜了。 */
  function sourceLinePlugin(md) {
    md.core.ruler.push('blog_source_lines', function (state) {
      state.tokens.forEach(function (token) {
        // 只标顶层块：嵌套块的行号由它所属的顶层块代表
        if (token.level !== 0 || token.nesting === -1 || !token.map) {
          return;
        }
        token.attrSet('data-line', String(token.map[0]));
        token.attrSet('data-line-end', String(token.map[1]));
      });
    });
  }

  /* ------------------------------------------------ 提示块（admonition）

     Python-Markdown 的写法是独占一行的 !!! 类型 "标题"，正文缩进四个空格；
     输出 <div class="admonition 类型"><p class="admonition-title">标题</p>…</div>。 */
  var ADMONITION_RE = /^!!!\s*([A-Za-z0-9_-]+)(?:\s+(?:"([^"]*)"|'([^']*)'|([^\s"']+)))?/;
  var ADMONITION_INDENT = 4;

  function admonitionPlugin(md) {
    function rule(state, startLine, endLine, silent) {
      if (state.sCount[startLine] - state.blkIndent >= ADMONITION_INDENT) {
        return false; // 缩进够了就是代码块，不是提示块
      }
      var start = state.bMarks[startLine] + state.tShift[startLine];
      var matched = ADMONITION_RE.exec(state.src.slice(start, state.eMarks[startLine]));
      if (!matched) {
        return false;
      }
      if (silent) {
        return true;
      }

      var type = matched[1].toLowerCase();
      var title = (matched[2] || matched[3] || matched[4] || '').trim();

      // 正文到第一个「不缩进的非空行」为止，中间的空行不算结束
      var lastContent = startLine;
      var nextLine = startLine + 1;
      for (; nextLine < endLine; nextLine++) {
        if (state.isEmpty(nextLine)) {
          continue;
        }
        if (state.sCount[nextLine] - state.blkIndent < ADMONITION_INDENT) {
          break;
        }
        lastContent = nextLine;
      }

      var open = state.push('admonition_open', 'div', 1);
      open.markup = '!!!';
      open.map = [startLine, lastContent + 1];
      open.attrSet('class', 'admonition ' + type);

      // 标题单独成一个 token、整段渲染：拆成开/闭两个 token 的话，块级 token 之间
      // 会被渲染器补上换行，标题就和服务端的 <p class="admonition-title">标题</p> 走样了
      var titleToken = state.push('admonition_title', '', 0);
      titleToken.markup = '!!!';
      titleToken.map = [startLine, startLine + 1];
      // 没写标题时 Python-Markdown 用类型名首字母大写充当标题
      titleToken.content = title || type.charAt(0).toUpperCase() + type.slice(1);

      // 正文交给嵌套解析：把四个空格的缩进算作本块的基准缩进
      var oldParentType = state.parentType;
      var oldLineMax = state.lineMax;
      state.parentType = 'admonition';
      state.blkIndent += ADMONITION_INDENT;
      state.lineMax = lastContent + 1;
      state.md.block.tokenize(state, startLine + 1, lastContent + 1);
      state.blkIndent -= ADMONITION_INDENT;
      state.lineMax = oldLineMax;
      state.parentType = oldParentType;

      state.push('admonition_close', 'div', -1);
      return lastContent + 1;
    }

    md.block.ruler.before('fence', 'admonition', rule);
    md.renderer.rules.admonition_title = function (tokens, idx) {
      return '<p class="admonition-title">' + md.utils.escapeHtml(tokens[idx].content) + '</p>\n';
    };
  }

  /* ------------------------------------------------ 脚注

     markdown-it-footnote 的标记（上标 [1]、<section class="footnotes">）与
     Python-Markdown（上标 1、<div class="footnote">）不同，这里换成后者的写法。

     id 也要跟着换：Python-Markdown 用脚注标签而不是序号，fn:a / fnref:a；
     同一个脚注被引用多次时，第二次起在 fnref 后面加引用序号，写成 fnref2:a。 */
  function alignFootnotes(md) {
    var rules = md.renderer.rules;

    function label(token) {
      return token.meta.label || String(token.meta.id + 1);
    }

    function refSuffix(token) {
      return token.meta.subId > 0 ? String(token.meta.subId + 1) : '';
    }

    function caption(token) {
      return String(token.meta.id + 1);
    }

    rules.footnote_ref = function (tokens, idx) {
      var token = tokens[idx];
      return '<sup id="fnref' + refSuffix(token) + ':' + label(token) +
        '"><a class="footnote-ref" href="#fn:' + label(token) + '">' +
        caption(token) + '</a></sup>';
    };
    rules.footnote_block_open = function (tokens, idx) {
      return '<div class="footnote"' + md.renderer.renderAttrs(tokens[idx]) +
        '>\n<hr>\n<ol>\n';
    };
    rules.footnote_block_close = function () {
      return '</ol>\n</div>\n';
    };
    rules.footnote_open = function (tokens, idx) {
      return '<li id="fn:' + label(tokens[idx]) + '">\n';
    };
    rules.footnote_close = function () {
      return '</li>\n';
    };
    rules.footnote_anchor = function (tokens, idx) {
      var token = tokens[idx];
      // 第一个反链前面用不换行空格与正文隔开，后面的引用直接接上
      return (token.meta.subId > 0 ? '' : '&#160;') +
        '<a class="footnote-backref" href="#fnref' + refSuffix(token) + ':' +
        label(token) + '" title="Jump back to footnote ' + caption(token) +
        ' in the text">&#8617;</a>';
    };
  }

  /* ------------------------------------------------ 渲染器 */

  function createEngine() {
    var md = markdownit({
      html: true,        // 工具栏会插入 <u>、<span style>，需要原样透传
      xhtmlOut: false,   // 服务端输出的是 <hr> / <br>，不自闭合
      breaks: false,     // 服务端不把单个换行当 <br>
      linkify: false,    // 服务端也不自动链接裸网址
      typographer: false // 服务端没开 smarty
    });

    // 每块都包成 codehilite 的结构，并用 Pygments 短码输出高亮
    md.renderer.rules.fence = function (tokens, idx) {
      var token = tokens[idx];
      var info = token.info ? md.utils.unescapeAll(token.info).trim() : '';
      var language = info ? info.split(/\s+/)[0] : '';
      var body = highlightBody(token.content, language, md.utils.escapeHtml);
      // <pre><span></span><code> 里的空 span 是 Pygments 自己会补的，位置照抄
      // 这条规则绕开了默认规则，源码行号要自己带上
      return '<div class="highlight"' + md.renderer.renderAttrs(token) +
        '><pre><span></span><code>' + body + '</code></pre></div>\n';
    };

    // 同理：默认的 hr 规则不输出属性，行号会丢
    md.renderer.rules.hr = function (tokens, idx, options) {
      return '<hr' + md.renderer.renderAttrs(tokens[idx]) +
        (options.xhtmlOut ? ' /' : '') + '>\n';
    };

    // pymdownx.tilde 输出 <del>，markdown-it 的删除线是 <s>
    md.renderer.rules.s_open = function () { return '<del>'; };
    md.renderer.rules.s_close = function () { return '</del>'; };

    if (global.markdownitFootnote) {
      md.use(global.markdownitFootnote);
      alignFootnotes(md);
    }
    if (global.markdownItAttrs) {
      md.use(global.markdownItAttrs);
    }
    if (global.markdownitDeflist) {
      md.use(global.markdownitDeflist);
    }
    if (global.markdownitAbbr) {
      md.use(global.markdownitAbbr);
    }

    md.use(headingIdsPlugin);
    md.use(admonitionPlugin);
    md.use(blockAttrListPlugin);
    // 放最后：上面几个插件建出来的块也要能带上行号
    md.use(sourceLinePlugin);
    return md;
  }

  var engine = markdownit && hljs ? createEngine() : null;

  global.BlogMarkdown = {
    available: Boolean(engine),
    render: function (text) {
      return engine ? engine.render(text || '') : null;
    }
  };
})(window);

/* 已知差异（相对于服务端 content.py 的渲染结果）：
   1. sane_lists：服务端开了这个扩展，列表必须与上文隔一个空行才会变成列表，
      紧跟段落的 `1.` / `-` 在线上只是普通文字，预览却会排成列表。
      所以写列表时记得在前面留一个空行——预览比线上宽松。这一条没有对齐，
      是因为它牵扯到 markdown-it 列表项切分的内部机制，硬改会连带弄坏正常的列表。
   2. 代码高亮：highlight.js 不产出标点与运算符的 span，site.css 里 .p / .o 的浅蓝
      在预览里会缺一点；两边认得的语言也不完全重合，认不出的语言预览退回纯文本
      （不使用自动猜测）。颜色与结构一致的部分完全一致。
   3. 属性顺序：如 <img> 的 alt/src 顺序与 Python-Markdown 不同，不影响渲染。 */
