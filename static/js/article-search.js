(function () {
  'use strict';

  var fab = document.querySelector('[data-article-find-fab]');
  var panel = document.querySelector('[data-article-find]');
  var prose = document.querySelector('.post .prose');
  if (!fab || !panel || !prose) {
    return;
  }

  var EDGE = 8;  // 离视口边缘至少留出的空隙（与 toc.js 一致）
  var GAP = 10;  // 面板与按钮之间的距离（与 CSS 保持一致）

  var input = panel.querySelector('[data-article-find-query]');
  var status = panel.querySelector('[data-article-find-status]');
  var toggle = document.querySelector('[data-article-find-toggle]');
  var close = panel.querySelector('[data-article-find-close]');
  var marks = [];
  var matches = [];
  var current = -1;

  function clearHighlights() {
    marks.forEach(function (mark) {
      if (mark.parentNode) {
        var parent = mark.parentNode;
        parent.replaceChild(document.createTextNode(mark.textContent), mark);
        parent.normalize();
      }
    });
    marks = [];
    matches = [];
  }

  function highlight(query) {
    clearHighlights();
    current = -1;
    if (!query) {
      status.textContent = '';
      return;
    }

    var needle = query.toLocaleLowerCase();
    var walker = document.createTreeWalker(prose, NodeFilter.SHOW_TEXT);
    var nodes = [];
    var node;
    while ((node = walker.nextNode())) {
      if (node.nodeValue && node.nodeValue.toLocaleLowerCase().indexOf(needle) !== -1) {
        nodes.push(node);
      }
    }

    nodes.forEach(function (textNode) {
      var text = textNode.nodeValue;
      var lower = text.toLocaleLowerCase();
      var offset = 0;
      var fragment = document.createDocumentFragment();
      var found = false;
      var position;

      while ((position = lower.indexOf(needle, offset)) !== -1) {
        if (position > offset) {
          fragment.appendChild(document.createTextNode(text.slice(offset, position)));
        }
        var mark = document.createElement('mark');
        mark.className = 'search-hit';
        mark.textContent = text.slice(position, position + query.length);
        fragment.appendChild(mark);
        marks.push(mark);
        matches.push(mark);
        offset = position + query.length;
        found = true;
      }

      if (found) {
        if (offset < text.length) {
          fragment.appendChild(document.createTextNode(text.slice(offset)));
        }
        textNode.parentNode.replaceChild(fragment, textNode);
      }
    });

    status.textContent = matches.length ? '找到 ' + matches.length + ' 处' : '无匹配';
    if (matches.length) {
      selectMatch(0);
    }
  }

  function selectMatch(index) {
    if (!matches.length) {
      return;
    }
    if (current >= 0) {
      matches[current].classList.remove('is-current');
    }
    current = (index + matches.length) % matches.length;
    var match = matches[current];
    match.classList.add('is-current');
    match.scrollIntoView({ behavior: 'smooth', block: 'center' });
    status.textContent = (current + 1) + ' / ' + matches.length;
  }

  /* 面板往哪边开：默认挂在按钮上方、右边缘对齐；按钮贴近视口上/左边缘时翻到
     下方 / 向右展开。与目录面板同一套 is-below / is-right 约定（见 site.css）。 */
  function updateFlip() {
    if (panel.hidden) {
      return;
    }
    var rect = fab.getBoundingClientRect();
    var width = panel.offsetWidth;
    var height = panel.offsetHeight;

    var fitsLeft = rect.right - width >= EDGE;
    var fitsRight = rect.left + width <= window.innerWidth - EDGE;
    fab.classList.toggle('is-right', !fitsLeft && fitsRight);

    var fitsAbove = rect.top - height - GAP >= EDGE;
    var fitsBelow = rect.bottom + height + GAP <= window.innerHeight - EDGE;
    fab.classList.toggle('is-below', !fitsAbove && fitsBelow);
  }

  /* 只改开合状态，不动焦点：供别的浮层抢开时静默收起自己。 */
  function applyOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      updateFlip();
    }
  }

  function setOpen(open) {
    if (open) {
      // 通知目录浮层让位；两个浮层靠这个事件保持互斥，不再互相直查
      document.dispatchEvent(new CustomEvent('article-fab-open', { detail: fab }));
    }
    applyOpen(open);
    if (open) {
      input.focus();
      input.select();
    } else {
      toggle.focus();
    }
  }

  document.addEventListener('article-fab-open', function (event) {
    if (event.detail !== fab && !panel.hidden) {
      applyOpen(false);
    }
  });

  window.addEventListener('resize', updateFlip);

  toggle.addEventListener('click', function () {
    setOpen(panel.hidden);
  });
  close.addEventListener('click', function () {
    setOpen(false);
  });
  input.addEventListener('input', function () {
    highlight(input.value);
  });
  input.addEventListener('keydown', function (event) {
    if (event.key === 'Enter' && matches.length) {
      event.preventDefault();
      selectMatch(current + (event.shiftKey ? -1 : 1));
    } else if (event.key === 'Escape') {
      setOpen(false);
    }
  });
  panel.querySelector('[data-article-find-prev]').addEventListener('click', function () {
    selectMatch(current - 1);
  });
  panel.querySelector('[data-article-find-next]').addEventListener('click', function () {
    selectMatch(current + 1);
  });

  document.addEventListener('pointerdown', function (event) {
    if (!panel.hidden && !fab.contains(event.target)) {
      setOpen(false);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
    }
  });
})();
