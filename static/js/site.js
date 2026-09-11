/* 全站交互：明暗主题切换 + 危险操作二次确认。
   刻意保持极简——没有任何第三方依赖，也不做阻塞渲染的事情。 */
(function () {
  'use strict';

  var root = document.documentElement;

  function currentTheme() {
    return root.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
  }

  document.addEventListener('click', function (event) {
    var toggle = event.target.closest('[data-theme-toggle]');
    if (!toggle) {
      return;
    }

    var next = currentTheme() === 'light' ? 'dark' : 'light';
    root.setAttribute('data-theme', next);

    try {
      localStorage.setItem('theme', next);
    } catch (error) {
      /* 隐私模式下写入会抛错，忽略即可 */
    }

    toggle.setAttribute(
      'aria-label',
      next === 'light' ? '切换到深色主题' : '切换到浅色主题'
    );
  });

  // 带 data-confirm 的表单（删除等不可撤销操作）提交前二次确认
  document.addEventListener('submit', function (event) {
    var form = event.target;
    var message = form.getAttribute && form.getAttribute('data-confirm');
    if (message && !window.confirm(message)) {
      event.preventDefault();
    }
  });
})();
