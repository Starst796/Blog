/* 公式排版：把 content.py 交给浏览器的 \(…\) / \[…\] 分隔符交给 KaTeX 排出来。

   服务端只负责保留 TeX（pymdownx.arithmatex，输出 <span|div class="arithmatex">），
   真正排版在这里做。后台预览（markdown-local.js 输出同样的分隔符）复用同一个入口，
   所以在编辑器里看到的样子与线上文章一致。

   KaTeX 与 auto-render 都是随仓库提交的本地文件（static/js/vendor/katex/），
   不向 CDN 发请求。

   对外的接口是 BlogMath.render(root)：只处理 root 里面的公式，返回是否成功。
   公开文章页由本文件在 DOMContentLoaded 时自动扫一遍带 data-math-page 的容器；
   后台预览是分块重绘的，由 admin.js 在每块插进 DOM 之后调用（见 typesetMath）。 */
(function (global) {
  'use strict';

  // 与 content.py 的输出对齐：行内 \(…\)，块级 \[…\]。
  // 不把 $…$ 交给 auto-render：服务端已经把美元符号换成了这两组分隔符，
  // 留着它反而会让正文里没被当成公式的 $（比如价格）被误排版。
  var DELIMITERS = [
    { left: '\\(', right: '\\)', display: false },
    { left: '\\[', right: '\\]', display: true }
  ];

  var options = {
    delimiters: DELIMITERS,
    throwOnError: false,   // 写错公式时显示红色原文，而不是让预览整块报错
    strict: false,         // 中文、Unicode 符号不必每处都包 \text{}
    ignoredTags: ['script', 'noscript', 'style', 'textarea', 'pre', 'code', 'option']
  };

  function render(root) {
    if (!root || typeof global.renderMathInElement !== 'function') {
      return false;
    }
    try {
      global.renderMathInElement(root, options);
      return true;
    } catch (error) {
      return false; // 排版失败不影响正文显示
    }
  }

  global.BlogMath = {
    available: typeof global.renderMathInElement === 'function',
    render: render
  };

  // 公开页面：整页扫一次。后台页面上没有 data-math-page，由 admin.js 按块调用。
  function autoRender() {
    render(document.querySelector('[data-math-page]'));
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', autoRender);
  } else {
    autoRender();
  }
})(window);
