/* 文章页的悬浮目录。
   两件事：
     1) 按钮可以按住拖到任意位置，松手后位置记进 localStorage，刷新还在原处；
     2) 点一下展开面板，在「本篇目录」（文章小标题）与「文集目录」（同一文集的
        全部文章）之间切换着跳转。

   拖动走指针事件（鼠标 / 触摸 / 触控笔一套代码），并用 4px 的位移阈值把「拖动」
   和「点击」分开：没挪动就当成普通点击开合面板，挪动了就只搬位置、不开关。
   面板是按钮的子元素，所以拖按钮时面板自动跟随；开合方向（上/下、左/右）由
   is-below / is-right 两个类交给 CSS 处理，这里只负责判断哪一边放得下。

   页面里没有这个组件时（其他页面）整个文件直接退出。 */
(function () {
  'use strict';

  var fab = document.querySelector('[data-toc-fab]');
  var toggle = fab && fab.querySelector('[data-toc-toggle]');
  var panel = fab && fab.querySelector('[data-toc-panel]');
  if (!fab || !toggle || !panel) {
    return;
  }

  var POS_KEY = 'toc-fab-pos'; // 与主题一样只存在本机
  var EDGE = 8;                // 离视口边缘至少留出的空隙
  var GAP = 10;                // 面板与按钮之间的距离（与 CSS 保持一致）
  var DRAG_SLOP = 4;           // 位移不超过这么多就还算点击
  var PANEL_MAX_WIDTH = 280;   // 与 CSS 的 width: min(280px, 100vw - 32px) 对应
  var PANEL_FALLBACK_HEIGHT = 240; // 面板关着时量不到高度，用这个先估一下

  /* ------------------------------------------------ 摆放与朝向 */

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function panelWidth() {
    return Math.min(PANEL_MAX_WIDTH, window.innerWidth - 32);
  }

  /* 判断面板往哪边开。横向只用宽度算，竖向需要真实高度——面板关着时量不到
     （display:none），先按估算值定，展开后 setOpen 会立刻再算一次。 */
  function updateFlip() {
    var rect = fab.getBoundingClientRect();
    var width = panelWidth();

    var fitsLeft = rect.right - width >= EDGE;
    var fitsRight = rect.left + width <= window.innerWidth - EDGE;
    fab.classList.toggle('is-right', !fitsLeft && fitsRight);

    var height = panel.hidden ? PANEL_FALLBACK_HEIGHT : panel.offsetHeight;
    var fitsAbove = rect.top - height - GAP >= EDGE;
    var fitsBelow = rect.bottom + height + GAP <= window.innerHeight - EDGE;
    fab.classList.toggle('is-below', !fitsAbove && fitsBelow);
  }

  /* 把按钮放到视口坐标 (left, top)，贴边处会夹回来。 */
  function place(left, top) {
    var maxLeft = Math.max(EDGE, window.innerWidth - fab.offsetWidth - EDGE);
    var maxTop = Math.max(EDGE, window.innerHeight - fab.offsetHeight - EDGE);
    var x = Math.round(clamp(left, EDGE, maxLeft));
    var y = Math.round(clamp(top, EDGE, maxTop));

    fab.style.left = x + 'px';
    fab.style.top = y + 'px';
    // 有了 left/top 之后必须让 right/bottom 让位，否则会互相拉扯
    fab.style.right = 'auto';
    fab.style.bottom = 'auto';
    updateFlip();
    return { x: x, y: y };
  }

  function savePos() {
    var rect = fab.getBoundingClientRect();
    try {
      localStorage.setItem(POS_KEY, JSON.stringify({
        x: Math.round(rect.left),
        y: Math.round(rect.top)
      }));
    } catch (error) {
      /* 隐私模式下写不了，不影响这次拖动 */
    }
  }

  function readPos() {
    try {
      var raw = localStorage.getItem(POS_KEY);
      var data = raw ? JSON.parse(raw) : null;
      return data && typeof data.x === 'number' && typeof data.y === 'number' ? data : null;
    } catch (error) {
      return null;
    }
  }

  /* ------------------------------------------------ 拖动 */

  var drag = null;
  var swallowClick = false;

  toggle.addEventListener('pointerdown', function (event) {
    // 只处理主键（触摸与触控笔的 button 也是 0）
    if (event.button !== 0) {
      return;
    }
    var rect = fab.getBoundingClientRect();
    drag = {
      id: event.pointerId,
      startX: event.clientX,
      startY: event.clientY,
      grabX: event.clientX - rect.left,
      grabY: event.clientY - rect.top,
      moved: false
    };
    swallowClick = false;
    // 捕获指针：手指划出按钮范围也继续收到事件，松手一定落到 pointerup
    if (toggle.setPointerCapture) {
      toggle.setPointerCapture(event.pointerId);
    }
  });

  toggle.addEventListener('pointermove', function (event) {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    var dx = event.clientX - drag.startX;
    var dy = event.clientY - drag.startY;
    if (!drag.moved && Math.abs(dx) + Math.abs(dy) < DRAG_SLOP) {
      return; // 还在抖动范围内，先不动，免得把点击误判成拖动
    }
    drag.moved = true;
    fab.classList.add('is-dragging');
    place(event.clientX - drag.grabX, event.clientY - drag.grabY);
    event.preventDefault();
  });

  function endDrag(event) {
    if (!drag || event.pointerId !== drag.id) {
      return;
    }
    var moved = drag.moved;
    drag = null;
    fab.classList.remove('is-dragging');
    if (toggle.releasePointerCapture) {
      try {
        toggle.releasePointerCapture(event.pointerId);
      } catch (error) {
        /* 指针已经没了（如 pointercancel）时会抛，忽略 */
      }
    }
    if (moved) {
      savePos();
      // 拖完浏览器还会补一次 click，别让它顺手把面板也开关了
      swallowClick = true;
    }
  }

  toggle.addEventListener('pointerup', endDrag);
  toggle.addEventListener('pointercancel', endDrag);

  /* ------------------------------------------------ 面板开合 */

  function setOpen(open) {
    panel.hidden = !open;
    fab.classList.toggle('is-open', open);
    toggle.setAttribute('aria-expanded', String(open));
    toggle.setAttribute('aria-label', open ? '关闭目录' : '打开目录');
    updateFlip(); // 展开后有了真实高度，朝向要按它重算一次
    if (open) {
      highlightCurrent();
    }
  }

  toggle.addEventListener('click', function () {
    if (swallowClick) {
      swallowClick = false;
      return;
    }
    setOpen(panel.hidden);
  });

  // 点面板外面收起；面板里的点击不处理
  document.addEventListener('pointerdown', function (event) {
    if (!panel.hidden && !fab.contains(event.target)) {
      setOpen(false);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
      toggle.focus();
    }
  });

  /* ------------------------------------------------ 两个页签 */

  var tabs = Array.prototype.slice.call(panel.querySelectorAll('[data-toc-tab]'));
  var panes = Array.prototype.slice.call(panel.querySelectorAll('[data-toc-pane]'));

  function selectTab(name) {
    tabs.forEach(function (tab) {
      var active = tab.getAttribute('data-toc-tab') === name;
      tab.setAttribute('aria-selected', String(active));
      // 标签页之间用左右方向键切换，所以没选中的那个不进 Tab 键顺序
      tab.setAttribute('tabindex', active ? '0' : '-1');
    });
    panes.forEach(function (pane) {
      pane.hidden = pane.getAttribute('data-toc-pane') !== name;
    });
  }

  tabs.forEach(function (tab, index) {
    tab.addEventListener('click', function () {
      selectTab(tab.getAttribute('data-toc-tab'));
    });
    tab.addEventListener('keydown', function (event) {
      var step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : 0;
      if (!step) {
        return;
      }
      event.preventDefault();
      var next = tabs[(index + step + tabs.length) % tabs.length];
      selectTab(next.getAttribute('data-toc-tab'));
      next.focus();
    });
  });

  /* ------------------------------------------------ 高亮正在读的一节 */

  var outline = panel.querySelector('[data-toc-outline]');
  var links = outline ? Array.prototype.slice.call(outline.querySelectorAll('a[href^="#"]')) : [];
  var current = null;

  /* 正文字符有 scroll-margin-top，跳转时标题不会钻到吸顶页头下面。
     这里判断「当前读到哪一节」时也得留出同样的余量。 */
  function headerOffset() {
    var value = parseFloat(
      window.getComputedStyle(document.documentElement).getPropertyValue('--header-h')
    );
    return (isNaN(value) ? 62 : value) + 16;
  }

  function highlightCurrent() {
    if (!links.length) {
      return;
    }
    var line = headerOffset();
    var active = null;
    for (var i = 0; i < links.length; i++) {
      var id = decodeURIComponent(links[i].getAttribute('href').slice(1));
      var target = document.getElementById(id);
      if (target && target.getBoundingClientRect().top - line <= 1) {
        active = links[i]; // 取最后一个已经越过分界线的标题
      }
    }

    if (active === current) {
      return;
    }
    if (current) {
      current.classList.remove('is-active');
    }
    current = active;
    if (!active) {
      return;
    }
    active.classList.add('is-active');

    /* 长目录里高亮的项可能在面板外，把它带进视野。只动面板自己的滚动，
       不用 scrollIntoView——那个会连带把页面滚一下。 */
    if (!panel.hidden) {
      var pane = active.closest('.toc-pane');
      if (pane) {
        var rect = active.getBoundingClientRect();
        var paneRect = pane.getBoundingClientRect();
        if (rect.top < paneRect.top) {
          pane.scrollTop -= paneRect.top - rect.top;
        } else if (rect.bottom > paneRect.bottom) {
          pane.scrollTop += rect.bottom - paneRect.bottom;
        }
      }
    }
  }

  var ticking = false;
  window.addEventListener('scroll', function () {
    if (ticking) {
      return;
    }
    ticking = true;
    window.requestAnimationFrame(function () {
      ticking = false;
      highlightCurrent();
    });
  }, { passive: true });

  /* ------------------------------------------------ 视口变化 */

  window.addEventListener('resize', function () {
    if (fab.style.left) {
      // 拖过位置：按新的视口大小重新夹一下，别把按钮留在屏幕外
      var rect = fab.getBoundingClientRect();
      place(rect.left, rect.top);
    } else {
      updateFlip(); // 还是默认的右下角，只需要重算开合方向
    }
  });

  /* ------------------------------------------------ 初始状态 */

  var saved = readPos();
  if (saved) {
    place(saved.x, saved.y);
  } else {
    updateFlip();
  }

  // 没有小标题的文章直接开在「文集目录」上，免得点开看到的是一句空话
  selectTab(links.length ? 'outline' : 'collection');
  setOpen(false);
})();
