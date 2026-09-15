/* 后台交互，三块互相独立：
   1) Markdown 编辑器：格式工具栏、图片上传与 md 导入导出、实时预览、Ctrl+S 保存
   2) 路径字段（头像 / 封面）：上传后把地址回填到输入框
   3) 本地草稿缓存：预览渲染完成后把整份草稿写进 localStorage，保存到服务器后清掉；
      后台列表据此给对应条目挂上「恢复 / 丢弃」
   页面里只存在其中之一也能正常工作。

   预览默认在浏览器本地渲染（static/js/markdown-local.js），编辑过程不发任何请求，
   出图速度只取决于本机；本地渲染不可用时（依赖没加载上）退回服务端 /admin/preview。 */
(function () {
  'use strict';

  function csrfToken() {
    var field = document.querySelector('input[name="csrf_token"]');
    return field ? field.value : '';
  }

  /** 上传一个文件，返回后端 JSON（形如 {ok, path, url, markdown, error}）。 */
  function upload(file) {
    var payload = new FormData();
    payload.append('file', file);
    return fetch('/admin/upload', {
      method: 'POST',
      body: payload,
      headers: { 'X-CSRF-Token': csrfToken() },
      credentials: 'same-origin'
    }).then(function (response) {
      return response.json().catch(function () {
        return { ok: false, error: '服务返回异常（HTTP ' + response.status + '）' };
      });
    });
  }

  /* ------------------------------------------------ 1. Markdown 编辑器 */

  var editor = document.querySelector('[data-editor]');

  function pick(selector) {
    return editor ? editor.querySelector(selector) : null;
  }

  var textarea = pick('[data-editor-input]');
  var preview = pick('[data-editor-preview]');
  var fileInput = pick('[data-upload-input]');
  var status = pick('[data-editor-status]');
  var toggle = pick('[data-toggle-preview]');

  var EMPTY_PREVIEW = '<p class="muted">还没有内容。</p>';
  var PREVIEW_DELAY = 120; // 输入停顿多久后重排，纯本地渲染，只是别让每次按键都重画
  var previewTimer = null;
  var previewSeq = 0; // 走服务端渲染时丢弃过期响应，防止旧结果覆盖新结果
  var previewVisible = Boolean(preview);
  var paintedHtml = null; // 上一次写入预览的 HTML，内容没变就不重绘（重绘会丢滚动位置）
  var paintToken = 0; // 每次重绘递增，用来让过期的图片回调失效
  var stashedScroll = null; // 预览被隐藏时暂存的滚动位置
  var toolbarEditing = false; // 工具栏正在改正文，见 replaceRange

  /* 滚动联动（详见下方「滚动联动」小节） */
  var ruler = null;          // 隐藏标尺，用来把源码行换算成像素
  var lineTops = [];         // lineTops[行号] = 该行在编辑框内容区的像素位置
  var contentBottom = 0;     // 编辑框正文（所有行）的底边位置，= 标尺去掉底内边距后的高度
  var anchors = [];          // [{ e, p, line }]：编辑框像素 ↔ 预览像素，两列都单调递增
  var syncSource = 'editor'; // 最近一次是谁在滚：editor / preview
  var syncLock = null;       // 联动写入对面时的目标值，用来吞掉自己触发的 scroll 事件
  var previewPadBottom = 0;  // 预览自身的底部内边距，算文末留白时要扣掉

  function csrfToken() {
    var field = document.querySelector('input[name="csrf_token"]');
    return field ? field.value : '';
  }

  function setStatus(text, isError) {
    if (!status) {
      return;
    }
    status.textContent = text || '';
    status.classList.toggle('is-error', Boolean(isError));
  }

  /* 重绘预览会让滑块位置变：整体替换 innerHTML 后滚动位置可能被重置或被新内容长度钳住，
     图片、代码块又要等解码/排版完成才有高度，之后还会再漂一次。
     办法是重绘前记下滚动位置，重绘后原样还原；还原是幂等的，图片加载完成后再调一次即可。 */
  function captureScroll(element) {
    var max = element.scrollHeight - element.clientHeight;
    return {
      top: element.scrollTop,
      written: element.scrollTop, // 我们最后写进去的值，用来识别用户是否自己滚过
      atBottom: max > 0 && max - element.scrollTop <= 1
    };
  }

  function restoreScroll(element, snapshot) {
    var max = element.scrollHeight - element.clientHeight;
    if (max <= 0) {
      element.scrollTop = 0;
      snapshot.written = 0;
      return;
    }
    // 贴底时保持贴底（继续在文末输入才能一直看到结尾），否则原样还原
    element.scrollTop = snapshot.atBottom ? max : Math.min(snapshot.top, max);
    snapshot.written = element.scrollTop;
  }

  /* ------------------------------------------------ 滚动联动

     目标是「编辑框滚到哪，预览就滚到哪」，反向亦然。
     难点在于源码行宽与渲染后的段落宽不同（自动换行点不一样），图片、代码块两端
     的高度也不成比例，所以不能简单按整体比例映射。这里用两张坐标表做锚定插值：

       lineTops —— 每一行源码在编辑框里的像素位置（含自动换行）。编辑框自己算不出
                   「第 N 行在哪」，于是用一个隐藏标尺：复制编辑框的字体、内边距和
                   宽度，逐行放一个 span，span 的顶边就是该行位置。
       anchors  —— 预览顶层块 ↔ 源码行。按文档顺序做一次单调的文本比对，
                   图片、分隔线这类没有文字的元素沿用上一处位置。

     这样任意一侧的滚动像素都能先换算成源码行，再线性插值到另一侧。 */

  // 与 site.css 的断点一致：窄屏两个框上下堆叠，不联动
  function panesStacked() {
    return window.matchMedia('(max-width: 900px)').matches;
  }

  function scrollMax(element) {
    return Math.max(0, element.scrollHeight - element.clientHeight);
  }

  /* ------------------------------------------------ 文末留白（可以滚过末尾）

     两个框本来都只能滚到「内容底边贴住视口底边」，于是文末那几行永远停在屏幕下半截：
     正文通常比预览短，编辑到最后一行时，预览里对应的段落也只能压在底下，联动就散了。
     这里给两侧各补一段底部留白，多出来的高度刚好够把「最后一行 / 最后一个块」顶到
     视口上沿；再往下就是空白，本来也没有内容可显示。

     留白加在末尾，标尺量的是每行行顶、预览块的位置也是量出来的，前面的坐标都不动，
     锚点表和行内插值都不受影响。两侧都按「还差多少才够把末尾顶上去」反推，
     不需要知道上一次垫了多少，重复调用得到同一个结果。 */

  /* 编辑框：垫到刚好能把最后一行顶到上沿。
     「正文底边」到「末行行顶」的距离就是需要多出来的高度——末行自己有多高
     （换没换行）都会在这个差值里体现，不用另外去量行高。 */
  function refreshEditorPad() {
    var lastTop = lineTops[lineTops.length - 1];
    if (!(lastTop >= 0)) {
      return; // 还没量过行位置，先不垫
    }
    var pad = Math.max(0, textarea.clientHeight - (contentBottom - lastTop));
    textarea.style.paddingBottom = pad + 'px';
  }

  /* 预览：垫到刚好能把最后一个块顶到上沿。末块比自己还高时无处可垫，保持原样即可。 */
  function refreshPreviewPad() {
    if (!previewVisible) {
      return; // 隐藏时量到的都是 0，先别动，等重新渲染时再算
    }
    var last = preview.lastElementChild;
    if (!last || panesStacked()) {
      // 窄屏上下堆叠时预览高度跟着内容走，再垫留白只会把盒子越撑越高
      preview.style.paddingBottom = '';
      return;
    }
    // 末块的下边距也占位置，漏掉它最后一块就顶不到上沿
    var margin = parseFloat(window.getComputedStyle(last).marginBottom) || 0;
    var height = last.getBoundingClientRect().height;
    var pad = Math.max(0, preview.clientHeight - previewPadBottom - height - margin);
    preview.style.paddingBottom = pad + 'px';
  }

  /* 标尺要复制的排版参数，少一个换行点就会偏。 */
  var RULER_STYLES = [
    'fontFamily', 'fontSize', 'fontWeight', 'fontStyle', 'letterSpacing',
    'lineHeight', 'wordSpacing', 'textAlign', 'textTransform', 'textIndent',
    'paddingTop', 'paddingRight', 'paddingBottom', 'paddingLeft', 'tabSize'
  ];

  function ensureRuler() {
    if (!ruler) {
      ruler = document.createElement('div');
      ruler.className = 'editor-ruler';
      ruler.setAttribute('aria-hidden', 'true');
      document.body.appendChild(ruler);
    }
    return ruler;
  }

  /* 量一遍每一行源码的像素位置，返回量的时候用的可用宽度。 */
  function measureLineTops() {
    var width = textarea.clientWidth;
    var computed = window.getComputedStyle(textarea);
    RULER_STYLES.forEach(function (name) {
      ruler.style[name] = computed[name];
    });
    // 宽度取编辑框内容区：clientWidth 已扣掉滚动条占的宽度，换行点才能对上
    ruler.style.boxSizing = 'border-box';
    ruler.style.width = textarea.clientWidth + 'px';
    ruler.style.whiteSpace = 'pre-wrap';
    ruler.style.overflowWrap = 'break-word';
    // 标尺的高度要拿来量「正文底边」，底部内边距不参与
    ruler.style.paddingBottom = '0px';

    var lines = textarea.value.split('\n');
    var fragment = document.createDocumentFragment();
    var spans = [];
    for (var i = 0; i < lines.length; i++) {
      var span = document.createElement('span');
      span.textContent = lines[i] + '\n'; // 补换行，空行也有行高
      spans.push(span);
      fragment.appendChild(span);
    }
    ruler.textContent = '';
    ruler.appendChild(fragment);

    var base = ruler.getBoundingClientRect().top;
    lineTops = [];
    for (i = 0; i < spans.length; i++) {
      lineTops.push(spans[i].getBoundingClientRect().top - base);
    }
    contentBottom = ruler.getBoundingClientRect().height;
    return width;
  }

  /* 重新量一遍（正文变了、编辑框变宽变窄时都要重来）。
     垫上文末留白后编辑框一定会出现滚动条，可用宽度随之变窄、换行点也跟着变，
     所以宽度对不上就再量一次——只在第一次垫留白时会发生。 */
  function refreshLineTops() {
    if (!textarea) {
      return;
    }
    ensureRuler();
    var width = measureLineTops();
    refreshEditorPad();
    if (textarea.clientWidth !== width) {
      measureLineTops();
    }
  }

  /* 把一行源码还原成「渲染后会长成什么样」的纯文本，用来和预览块比对。 */
  function sourceText(line) {
    if (/^\s*(```|~~~)/.test(line)) {
      return ''; // 围栏行本身不渲染成文字
    }
    return line
      .replace(/!\[[^\]]*\]\([^)]*\)/g, '')                // 图片没有文字
      .replace(/\[([^\]]*)\]\([^)]*\)/g, '$1')             // 链接保留文字
      .replace(/`([^`]*)`/g, '$1')                         // 行内代码
      .replace(/^\s{0,3}(?:#{1,6}|>|[-*+]|\d+\.)\s+/, '')  // 行首标记
      .replace(/[*_~|]/g, '')                              // 强调、表格竖线
      .replace(/\s+/g, '');
  }

  function domText(element) {
    return (element.textContent || '').replace(/\s+/g, '');
  }

  /* 预览每个顶层块在「预览滚动坐标系」里的顶边。 */
  function measurePreviewTops() {
    var previewRect = preview.getBoundingClientRect();
    var delta = preview.scrollTop - previewRect.top;
    var tops = [];
    for (var i = 0; i < preview.children.length; i++) {
      tops.push(preview.children[i].getBoundingClientRect().top + delta);
    }
    return tops;
  }

  var ANCHOR_PROBE = 6; // 用块开头这几个字去源码里认领行
  var ANCHOR_SCAN_LIMIT = 400; // 认领不到时最多往后翻多少行，防止扫遍全文

  function commonPrefix(a, b) {
    var n = Math.min(a.length, b.length);
    var i = 0;
    while (i < n && a.charAt(i) === b.charAt(i)) {
      i++;
    }
    return i;
  }

  /* 重算「预览块 ↔ 源码行」的对应表。
     只按每个块开头的几个字去源码里认领起始行，认到就把游标推到这行之后，
     整块文本长度不再参与比对——源码和 DOM 的排版细节（缩进、强调符）总有出入，
     逐字对整块很容易差一两个字符，进而多吞掉后面好几行，越往后偏得越多。
     认领不到（图片、分隔线这类）就沿用当前游标。 */
  function rebuildAnchors() {
    anchors = [];
    if (!textarea || !preview || !lineTops.length || !preview.children.length) {
      return;
    }

    var lines = textarea.value.split('\n');
    var previewTops = measurePreviewTops();
    var cursor = 0;
    var lastLine = 0;

    for (var i = 0; i < preview.children.length; i++) {
      var want = domText(preview.children[i]);
      var startLine = cursor;

      if (want) {
        var probe = want.slice(0, ANCHOR_PROBE);
        var need = Math.min(4, probe.length);
        var j = cursor;
        while (j < lines.length && j - cursor < ANCHOR_SCAN_LIMIT) {
          var piece = sourceText(lines[j]);
          if (piece && commonPrefix(piece, probe) >= need) {
            startLine = j;
            cursor = j + 1; // 下一块从这行之后接着找
            break;
          }
          j++;
        }
      }

      startLine = Math.max(startLine, lastLine); // 行号必须单调，插值才有意义
      lastLine = startLine;

      var editorTop = lineTops[Math.min(startLine, lineTops.length - 1)];
      anchors.push({ e: editorTop, p: previewTops[i], line: startLine });
    }
  }

  /* 在单调的锚点表上插值：给定 x 求 y；首尾区间按端点比例外推。 */
  function interpolate(table, xKey, yKey, x, xEnd, yEnd) {
    if (!table.length) {
      return 0;
    }
    if (x <= table[0][xKey]) {
      return table[0][xKey] > 0 ? (x / table[0][xKey]) * table[0][yKey] : table[0][yKey];
    }
    for (var i = table.length - 1; i >= 0; i--) {
      if (table[i][xKey] > x) {
        continue;
      }
      var from = table[i];
      var to = table[i + 1];
      if (to) {
        var spanX = to[xKey] - from[xKey] || 1;
        return from[yKey] + ((x - from[xKey]) / spanX) * (to[yKey] - from[yKey]);
      }
      // 末尾区间：对面已经没余量了（yEnd 反而落在锚点前面，例如末块比自己还高）
      // 就停在原地，别倒着滚回去
      var tailX = xEnd - from[xKey];
      var tailY = yEnd - from[yKey];
      if (tailX <= 0 || tailY <= 0) {
        return from[yKey];
      }
      return from[yKey] + ((x - from[xKey]) / tailX) * tailY;
    }
    return 0;
  }

  function editorToPreview() {
    return interpolate(anchors, 'e', 'p', textarea.scrollTop, scrollMax(textarea), scrollMax(preview));
  }

  function previewToEditor() {
    return interpolate(anchors, 'p', 'e', preview.scrollTop, scrollMax(preview), scrollMax(textarea));
  }

  function applyScroll(element, top) {
    var next = Math.max(0, Math.min(top, scrollMax(element)));
    if (Math.abs(element.scrollTop - next) <= 1) {
      return; // 位置没变就不写，也就不会触发对面回弹
    }
    syncLock = { element: element, top: next };
    element.scrollTop = next;
  }

  function handleScroll(source) {
    if (!previewVisible || panesStacked() || !anchors.length) {
      return;
    }
    if (syncLock) {
      var mine = syncLock.element === source && Math.abs(syncLock.top - source.scrollTop) <= 1;
      syncLock = null;
      if (mine) {
        return; // 这次滚动是联动写进去的，不是用户操作
      }
    }
    if (source === preview) {
      syncSource = 'preview';
      applyScroll(textarea, previewToEditor());
    } else {
      syncSource = 'editor';
      applyScroll(preview, editorToPreview());
    }
  }

  function paintPreview(html) {
    if (html === paintedHtml) {
      return; // 内容没变就别重绘，省一次滚动位置抖动
    }

    var token = ++paintToken; // 本次重绘的代号
    var snapshot = captureScroll(preview);
    paintedHtml = html;
    preview.innerHTML = html;
    refreshPreviewPad(); // 末块高度变了，文末留白要跟着重算（它决定了预览能滚多远）

    // DOM 换了，锚点表要重算。若最近是编辑框在滚，就把预览对回编辑框的位置；
    // 否则（用户在滚预览 / 窄屏堆叠）保持原来的滚动位置不动。
    rebuildAnchors();
    if (syncSource === 'editor' && !panesStacked() && anchors.length) {
      applyScroll(preview, editorToPreview());
    } else {
      restoreScroll(preview, snapshot);
    }

    Array.prototype.forEach.call(preview.querySelectorAll('img'), function (img) {
      if (img.complete) {
        return; // 已解码，高度已定
      }
      var settle = function () {
        // 图片要等解码完才有高度，但那可能发生在很久以后：
        // 若期间又重绘过（token 变了）或预览已隐藏，就不要再动滚动位置。
        if (token !== paintToken || !previewVisible) {
          return;
        }
        refreshPreviewPad(); // 图片把末块撑高了，留白要跟着变
        rebuildAnchors();
        if (syncSource === 'editor' && !panesStacked()) {
          applyScroll(preview, editorToPreview());
        } else if (Math.abs(preview.scrollTop - snapshot.written) <= 1) {
          restoreScroll(preview, snapshot);
        }
      };
      img.addEventListener('load', settle, { once: true });
      img.addEventListener('error', settle, { once: true });
    });
  }

  /* 把正文渲染到右侧预览栏。默认本地渲染：整篇正文不出浏览器，也没有等待服务器的延迟。
     只有本地渲染不可用（vendor 脚本没加载上）时才退回服务端，那条路径的请求带序号，
     只有最新一次的结果会生效。

     两条路径都在「预览画完」之后调一次 storeDraft()（见第 3 节）：写缓存跟着预览的节拍走，
     不必另起一个防抖定时器，也不会每次按键都去动 localStorage。 */
  function renderPreview() {
    if (!preview || !previewVisible) {
      return;
    }

    var local = window.BlogMarkdown;
    if (local && local.available) {
      paintPreview(local.render(textarea.value) || EMPTY_PREVIEW);
      // 只清掉上一次的渲染错误，不影响「已插入图片」这类提示。
      if (status && status.classList.contains('is-error')) {
        setStatus('');
      }
      storeDraft();
      return;
    }

    var seq = ++previewSeq;

    fetch('/admin/preview', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-CSRF-Token': csrfToken()
      },
      credentials: 'same-origin',
      body: JSON.stringify({ body: textarea.value })
    })
      .then(function (response) {
        return response.json();
      })
      .then(function (result) {
        if (seq !== previewSeq || !previewVisible) {
          return;
        }
        paintPreview(result.html || EMPTY_PREVIEW);
        // 只清掉上一次的渲染错误，不影响「已插入图片」这类提示。
        if (status && status.classList.contains('is-error')) {
          setStatus('');
        }
        storeDraft();
      })
      .catch(function () {
        if (seq !== previewSeq) {
          return;
        }
        setStatus('预览失败，请重试', true);
      });
  }

  function schedulePreview(delay) {
    if (!preview || !previewVisible) {
      return;
    }
    window.clearTimeout(previewTimer);
    previewTimer = window.setTimeout(renderPreview, delay == null ? PREVIEW_DELAY : delay);
  }

  /* 工具栏改完正文的收尾：标尺重新量一遍、预览立刻重画，不等输入停顿。
     input 的处理函数做的是同一件事，只是预览晚一拍（见那里的说明）。 */
  function refreshAfterEdit() {
    syncSource = 'editor';
    refreshLineTops();
    schedulePreview(0);
  }

  /* ------------------------------------------------ 保存后回到原来的位置

     保存走的是原生提交（必填校验、flash、跳转都归浏览器与后端管），代价是一次
     POST → 302 → GET 的重渲染：页面滚回顶部、正文滚回开头，写了半天的位置就丢了。
     提交前把「页面滚动 + 编辑框滚动 + 光标」记进 sessionStorage，重渲染后放回去。
     记录只用一次：读出来就删掉，否则下次再打开这一页会莫名跳到上次的位置。 */

  var RETURN_KEY = 'editor-return';

  function rememberSpot() {
    try {
      sessionStorage.setItem(RETURN_KEY, JSON.stringify({
        // 只在同一页面里还原：改了 slug 路径就变了，那就当没记过
        path: location.pathname,
        // 页面位置记「编辑框在视口里的位置」，上方多出一条 flash 提示也不受影响
        editorTop: editor ? Math.round(editor.getBoundingClientRect().top) : 0,
        scrollTop: Math.round(textarea.scrollTop),
        selStart: textarea.selectionStart,
        selEnd: textarea.selectionEnd
      }));
    } catch (error) {
      /* 隐身模式等场景下 sessionStorage 会抛异常；没记住位置不影响保存 */
    }
  }

  /* 取出并立刻删掉上次留下的位置，取不到就返回 null。 */
  function takeSpot() {
    try {
      var raw = sessionStorage.getItem(RETURN_KEY);
      sessionStorage.removeItem(RETURN_KEY);
      return raw ? JSON.parse(raw) : null;
    } catch (error) {
      return null;
    }
  }

  /* 把位置放回去。正文是重新渲染的，光标位置先夹到当前长度内再用。 */
  function restoreSpot(record) {
    if (!record || record.path !== location.pathname) {
      return;
    }
    var end = textarea.value.length;
    // 先摆光标再滚：setSelectionRange 也会把光标带进视野，让后面写的 scrollTop 说话
    textarea.setSelectionRange(
      Math.min(record.selStart, end),
      Math.min(record.selEnd, end)
    );
    textarea.scrollTop = record.scrollTop;
    if (editor) {
      window.scrollBy(0, editor.getBoundingClientRect().top - record.editorTop);
    }
  }

  if (textarea && preview) {
    // 记下预览自身的底部内边距：文末留白写的是同一个属性，算的时候得先把它扣掉
    previewPadBottom = parseFloat(window.getComputedStyle(preview).paddingBottom) || 0;

    textarea.addEventListener('input', function () {
      if (toolbarEditing) {
        return; // 这次改动来自工具栏，它自己会收尾，别重复量一遍标尺
      }
      syncSource = 'editor'; // 在编辑框里输入，就以编辑框为基准
      refreshLineTops();
      schedulePreview();
    });
    // 滚动联动：一边滚，另一边跟着走
    textarea.addEventListener('scroll', function () {
      handleScroll(textarea);
    });
    preview.addEventListener('scroll', function () {
      handleScroll(preview);
    });

    // 编辑框宽度变了（窗口缩放），换行点会变，标尺和锚点都得重量
    var rulerTimer = null;
    window.addEventListener('resize', function () {
      window.clearTimeout(rulerTimer);
      rulerTimer = window.setTimeout(function () {
        refreshLineTops();
        refreshPreviewPad();
        rebuildAnchors();
        if (syncSource === 'editor' && !panesStacked()) {
          applyScroll(preview, editorToPreview());
        }
      }, 150);
    });

    // 手动拖右下角改编辑框高度时不会触发 window 的 resize，交给 ResizeObserver
    if (window.ResizeObserver) {
      new ResizeObserver(function () {
        refreshLineTops();
        rebuildAnchors();
        if (syncSource === 'editor' && !panesStacked()) {
          applyScroll(preview, editorToPreview());
        }
      }).observe(textarea);
    }

    // 原生提交会整页重渲染，先把编辑位置记下来（见「保存后回到原来的位置」）
    if (textarea.form) {
      textarea.form.addEventListener('submit', rememberSpot);
    }

    // 首次进入即渲染已有正文，编辑旧文章时预览与输入框内容一致。
    refreshLineTops();
    schedulePreview(0);
    // 上一页如果是保存后跳回来的，位置按提交前记下的还原；预览会跟着一起归位
    restoreSpot(takeSpot());
  }

  if (fileInput) {
    fileInput.addEventListener('change', function () {
      var file = fileInput.files && fileInput.files[0];
      if (!file) {
        return;
      }

      setStatus('上传中…');
      upload(file)
        .then(function (result) {
          if (result.ok) {
            insertBlock(result.markdown);
            setStatus('已插入 ' + result.url);
          } else {
            setStatus(result.error || '上传失败', true);
          }
        })
        .catch(function () {
          setStatus('上传失败，请检查网络后重试', true);
        })
        .then(function () {
          fileInput.value = '';
        });
    });
  }

  if (toggle && preview) {
    toggle.addEventListener('click', function () {
      previewVisible = !previewVisible;

      if (!previewVisible) {
        // display:none 会让浏览器把 scrollTop 清零，先存下位置
        stashedScroll = captureScroll(preview);
      }

      preview.classList.toggle('is-hidden', !previewVisible);
      if (editor) {
        editor.classList.toggle('is-preview-hidden', !previewVisible);
      }
      toggle.setAttribute('aria-pressed', String(previewVisible));
      toggle.textContent = previewVisible ? '隐藏预览' : '显示预览';

      if (!previewVisible) {
        window.clearTimeout(previewTimer);
        return;
      }

      if (stashedScroll) {
        restoreScroll(preview, stashedScroll);
      }
      renderPreview();
    });
  }

  /* ------------------------------------------------ 1.1 格式工具栏

     工具栏只做「改文本」一件事：把选中的内容包上标记，或者插入一段模板。
     按钮在模板里声明（data-tool / data-value），动作按名字查表，加按钮时补一行即可。

     其中下划线、颜色、对齐都不是 Markdown 原生语法，按 content.py 里启用的扩展来写：
     extra 带 attr_list，段落对齐用独占一行的 {: style="text-align: …"}；下划线与颜色
     用行内 HTML，Markdown 会原样透传。 */

  /* 用文本替换 [start, end)，并把选区放到指定位置。工具栏的每个动作最后都走这里，
     光标、标尺、预览的刷新都集中在这一处。

     替换走浏览器的原生编辑命令（execCommand + insertText），而不是直接给 value 赋值：
     赋值会把光标挪到文末，还会清空浏览器的撤销栈，于是 Ctrl+Z 再也退不回工具栏的改动。
     原生编辑命令是浏览器自己的编辑动作，撤销栈照旧，光标也留在我们摆好的位置上。
     它会自己派发 input，所以下面用一个标记把 input 那边的收尾挡掉，免得标尺量两遍。
     没有这个命令的浏览器退回直接赋值：功能不变，只是这次改动进不了撤销栈。

     滚动位置由我们自己负责：原生编辑命令会把光标滚进视野（贴着文末时，文末留白刚好
     让末行顶在视口上沿，浏览器会顺手把它再往里推一两行），而点工具栏本就不该让编辑框
     动。前后各存还原一次，「原来贴底就继续贴底」——与预览那侧用的是同一套规则，
     还原放在留白重算之后，钳制边界才是新的。 */
  function replaceRange(start, end, text, selStart, selEnd) {
    if (selStart == null) {
      selStart = selEnd = start + text.length;
    }

    var snapshot = captureScroll(textarea);

    textarea.focus();
    textarea.setSelectionRange(start, end);

    var edited = false;
    toolbarEditing = true;
    try {
      edited = document.execCommand('insertText', false, text);
    } catch (error) {
      edited = false;
    }
    toolbarEditing = false;

    if (!edited) {
      textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    }
    textarea.setSelectionRange(selStart, selEnd);
    refreshAfterEdit();
    restoreScroll(textarea, snapshot);
  }

  /* 当前选区的整行范围：光标在哪一行就取哪一行，选了多行就取这几行。 */
  function lineRange() {
    var value = textarea.value;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;

    var lineStart = value.lastIndexOf('\n', start - 1) + 1;
    if (end > start && value.charAt(end - 1) === '\n') {
      end -= 1; // 选区正好停在下一行行首时，别把那一行也带进来
    }
    var lineEnd = value.indexOf('\n', end);
    return { start: lineStart, end: lineEnd === -1 ? value.length : lineEnd };
  }

  /* 把内容包上前后标记；没选中文字就插入占位符并选中它，可以直接改写。 */
  function wrapSelection(before, after, placeholder, content) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var text = content == null ? textarea.value.slice(start, end) : content;
    if (!text) {
      text = placeholder;
    }
    var caret = start + before.length;
    replaceRange(start, end, before + text + after, caret, caret + text.length);
  }

  /* 行内标记：光标贴着标记内侧，或者整个选中都包着标记时，再点一次就是取消。 */
  function toggleInline(before, after, placeholder) {
    var value = textarea.value;
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;

    if (start >= before.length &&
        value.slice(start - before.length, start) === before &&
        value.slice(end, end + after.length) === after) {
      var inner = value.slice(start, end);
      var from = start - before.length;
      replaceRange(from, end + after.length, inner, from, from + inner.length);
      return;
    }

    var selected = value.slice(start, end);
    if (selected.length >= before.length + after.length &&
        selected.indexOf(before) === 0 &&
        selected.slice(-after.length) === after) {
      var text = selected.slice(before.length, selected.length - after.length);
      replaceRange(start, end, text, start, start + text.length);
      return;
    }

    wrapSelection(before, after, placeholder);
  }

  /* 从选区里剥掉同一属性的 span（换颜色时用，免得一次叠一层），保留里面的文字。 */
  function stripSpans(html, prop) {
    var pattern = new RegExp(
      '<span style="(?:[^"]*;\\s*)?' + prop + ':[^"]*">([\\s\\S]*?)</span>', 'g'
    );
    return html.replace(pattern, '$1');
  }

  /* 颜色：Markdown 没有颜色语法，用内联 span 表达，前端预览与站点渲染都能原样输出。 */
  function applyColor(prop, color) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var stripped = stripSpans(textarea.value.slice(start, end), prop);
    wrapSelection('<span style="' + prop + ':' + color + '">', '</span>', '文字', stripped);
  }

  var HEADING_RE = /^\s{0,3}#{1,6}\s+/;

  /* 标题：换级别时先把原来的 # 摘掉，画成「## # 标题」就不好看了；
     已经在这一级，再点一次即回到正文。 */
  function applyHeading(level) {
    var range = lineRange();
    var prefix = level ? new Array(level + 1).join('#') + ' ' : '';
    var lines = textarea.value.slice(range.start, range.end).split('\n');

    var marked = lines.filter(function (line) { return line.trim(); });
    var same = prefix && marked.length > 0 && marked.every(function (line) {
      return line.indexOf(prefix) === 0;
    });
    var adding = same ? '' : prefix;

    var next = lines
      .map(function (line) { return line.replace(HEADING_RE, ''); })
      .map(function (line) {
        // 多行选区里的空行不补标记，否则会多出一个空标题
        if (!adding || (!line.trim() && lines.length > 1)) {
          return line;
        }
        return adding + line;
      });

    var text = next.join('\n');
    replaceRange(range.start, range.end, text, range.start, range.start + text.length);
  }

  var ORDERED_RE = /^\s*\d+\.\s+/;

  /* 列表与引用：逐行加行首标记；已经全部标记过，再点一次就是取消。 */
  function toggleLinePrefix(prefix, numbered) {
    var range = lineRange();
    var lines = textarea.value.slice(range.start, range.end).split('\n');
    var marked = lines.filter(function (line) { return line.trim(); });

    function isMarked(line) {
      return numbered ? ORDERED_RE.test(line) : line.indexOf(prefix) === 0;
    }

    var has = marked.length > 0 && marked.every(isMarked);
    var number = 0;

    var next = lines.map(function (line) {
      if (has) {
        return isMarked(line) ? line.replace(numbered ? ORDERED_RE : prefix, '') : line;
      }
      if (!line.trim()) {
        // 空行只在「就一行」时补标记，多行选区里的空行补上会变成空列表项
        return lines.length > 1 ? line : (numbered ? '1. ' : prefix);
      }
      number += 1;
      return (numbered ? number + '. ' : prefix) + line;
    });

    var text = next.join('\n');
    replaceRange(range.start, range.end, text, range.start, range.start + text.length);
  }

  var ALIGN_RE = /^\{:\s*style="text-align:\s*(?:left|center|right)\s*"\s*\}\s*$/;

  /* 对齐：段落下面补一行 attr_list，左对齐就是把这行摘掉（默认即左对齐）。
     标记必须紧贴段落、独占一行，所以按「空行分段」处理，而不是逐行加。 */
  function applyAlign(align) {
    var range = lineRange();
    var lines = textarea.value.slice(range.start, range.end).split('\n');
    var out = [];
    var paragraph = [];
    var hasText = false;

    function flush() {
      if (!paragraph.length) {
        return;
      }
      hasText = true;
      if (ALIGN_RE.test(paragraph[paragraph.length - 1])) {
        paragraph.pop(); // 摘掉旧标记，改成这次选的对齐方式
      }
      var kept = paragraph;
      paragraph = [];
      if (!kept.length) {
        return;
      }
      out = out.concat(kept);
      if (align) {
        out.push('{: style="text-align: ' + align + '"}');
      }
    }

    lines.forEach(function (line) {
      if (line.trim()) {
        paragraph.push(line);
        return;
      }
      flush();
      out.push(line);
    });
    flush();

    var text = out.join('\n');
    var selectEnd = range.start + text.length;
    if (!hasText && align) {
      // 光标停在空行上时没有段落可挂标记，补一段占位文字，标记挂在它下面
      text = '文字\n{: style="text-align: ' + align + '"}';
      selectEnd = range.start + 2;
    }
    replaceRange(range.start, range.end, text, range.start, selectEnd);
  }

  /* 块级插入物（分割线这类要独占一段的内容）：前后各留一个空行，
     否则会粘到相邻段落上——紧跟在一行文字下面的 --- 会被当成二级标题。 */
  function insertBlock(text) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var value = textarea.value;
    var head = value.slice(0, start);
    var tail = value.slice(end);
    var lead = head && !/\n$/.test(head) ? '\n\n' : (head && !/\n\n$/.test(head) ? '\n' : '');
    var follow = tail && !/^\n/.test(tail) ? '\n\n' : (tail && !/^\n\n/.test(tail) ? '\n' : '');
    var caret = start + lead.length + text.length;
    replaceRange(start, end, lead + text + follow, caret, caret);
  }

  /* 链接：选中文字就当链接文字，插入后选中网址部分，可以直接粘贴覆盖。 */
  function insertLink() {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var label = textarea.value.slice(start, end) || '链接文字';
    var urlStart = start + label.length + 3;
    replaceRange(start, end, '[' + label + '](https://)', urlStart, urlStart + 8);
  }

  var TOOL_ACTIONS = {
    heading: function (value) { applyHeading(Number(value)); },
    bold: function () { toggleInline('**', '**', '粗体文字'); },
    italic: function () { toggleInline('*', '*', '斜体文字'); },
    underline: function () { toggleInline('<u>', '</u>', '下划线文字'); },
    strike: function () { toggleInline('~~', '~~', '删除文字'); },
    align: function (value) { applyAlign(value === 'left' ? '' : value); },
    ordered: function () { toggleLinePrefix('', true); },
    unordered: function () { toggleLinePrefix('- '); },
    quote: function () { toggleLinePrefix('> '); },
    rule: function () { insertBlock('---'); },
    link: insertLink,
    image: function () { if (fileInput) { fileInput.click(); } },
    'import-md': function () { if (importInput) { importInput.click(); } },
    'export-md': function () { exportMarkdown(); }
  };

  var toolbar = pick('[data-toolbar]');
  var importInput = pick('[data-import-input]');

  if (toolbar && textarea) {
    toolbar.addEventListener('click', function (event) {
      var button = event.target.closest('[data-tool]');
      var action = button && TOOL_ACTIONS[button.getAttribute('data-tool')];
      if (!action) {
        return;
      }
      event.preventDefault();
      action(button.getAttribute('data-value'));
    });

    /* 颜色按钮：单击把当前颜色应用到选中文字（直接做，不等任何手势）；鼠标移到按钮上
       浮出一排预置色，换颜色在浮层里完成。

       为什么浮层是自己画的：系统调色板只能由用户手势打开，鼠标移上去时浏览器会直接
       拒绝（控制台留一句 "A user gesture is required to show the color picker"），
       所以「移上来就显示」的这张只能是页面里的调色板——预置色见 COLOR_SWATCHES，
       末尾那块彩虹色才是系统调色板，点它算用户手势，能正常打开。

       在浮层里选颜色（预置色或系统调色板）只做记录：更新按钮下的色条、写进 localStorage。
       「换色」与「应用」是两步，免得顺手改掉正文。存 localStorage 是因为保存走原生提交、
       整页重渲染，不记的话按钮会回到 HTML 里写死的默认色。 */
    var COLOR_SWATCHES = [
      '#e06c75', '#e5c07b', '#98c379', '#56b6c2',
      '#61afef', '#c678dd', '#f0f0f0', '#ffd54f'
    ];
    var COLOR_STORE_PREFIX = 'editor-color:';

    function readStoredColor(name, fallback) {
      try {
        return window.localStorage.getItem(COLOR_STORE_PREFIX + name) || fallback;
      } catch (error) {
        return fallback; // 隐身模式等场景会抛异常，退回 HTML 里的默认值
      }
    }

    function storeColor(name, color) {
      try {
        window.localStorage.setItem(COLOR_STORE_PREFIX + name, color);
      } catch (error) {
        /* 记不住颜色不影响使用 */
      }
    }

    Array.prototype.forEach.call(toolbar.querySelectorAll('[data-color]'), function (box) {
      var face = box.querySelector('[data-color-apply]');
      var palette = box.querySelector('.color-palette');
      if (!face || !palette) {
        return;
      }

      var name = box.getAttribute('data-color') || '';
      var prop = name === 'back' ? 'background-color' : 'color';
      var current = readStoredColor(name, box.getAttribute('data-default') || '#000000');
      var swatches = [];

      // 预置色一个个画出来，两个颜色按钮共用同一份列表
      COLOR_SWATCHES.forEach(function (color) {
        var swatch = document.createElement('button');
        swatch.type = 'button';
        swatch.className = 'color-swatch';
        swatch.setAttribute('data-swatch', color);
        swatch.style.setProperty('--swatch', color);
        swatch.title = color;
        swatch.setAttribute('aria-label', color);
        swatch.addEventListener('click', function () {
          choose(color);
        });
        swatches.push(swatch);
        palette.appendChild(swatch);
      });

      // 末尾这块彩虹色才是系统调色板：点它算用户手势，浏览器才肯打开
      var custom = document.createElement('label');
      custom.className = 'color-swatch color-swatch-custom';
      custom.title = '自定义颜色（打开系统调色板）';

      var input = document.createElement('input');
      input.type = 'color';
      input.setAttribute('aria-label', '自定义颜色');
      input.addEventListener('input', function () {
        current = input.value; // 拖系统调色板时按钮下的色条实时跟着走
        paint();
      });
      input.addEventListener('change', function () {
        current = input.value;
        storeColor(name, current);
        paint();
      });

      custom.appendChild(input);
      palette.appendChild(custom);

      /* 当前颜色的三处表现：按钮下的色条、预置色里的选中标记、系统调色板的初始值 */
      function paint() {
        face.style.setProperty('--tool-color', current);
        swatches.forEach(function (swatch) {
          var active = swatch.getAttribute('data-swatch') === current;
          swatch.classList.toggle('is-active', active);
          swatch.setAttribute('aria-pressed', String(active));
        });
        custom.classList.toggle('is-active', COLOR_SWATCHES.indexOf(current) === -1);
        input.value = current;
      }

      function choose(color) {
        current = color;
        storeColor(name, current);
        paint();
      }

      face.addEventListener('click', function () {
        applyColor(prop, current);
      });

      paint();
    });
  }

  /* ------------------------------------------------ 1.2 导入 / 导出 md

     导出的是「front matter + 正文」的完整文件，格式与 content/ 目录里保存的一致，
     所以导出的文件既能留档，也能直接放回站点；导入时反过来：认识的字段回填表单，
     剩下的当正文。front matter 的字段名与表单控件的 name 一一对应，不必两处维护。 */

  var LIST_FIELDS = ['tags', 'stack'];
  var LINK_FIELDS = ['links'];

  function formField(name) {
    var form = textarea.form;
    return form ? form.querySelector('[name="' + name + '"]') : null;
  }

  function splitList(value) {
    return value.split(/[,，;；]/).map(function (part) {
      return part.trim();
    }).filter(Boolean);
  }

  /* 「名称 https://…」一行一条，与 admin.py 里的解析规则保持一致。 */
  function parseLinkLine(line) {
    var parts = line.trim().split(/\s+/);
    var url = parts.pop();
    if (parts.length < 1 || !url || !/^(https?:\/\/|mailto:)/.test(url)) {
      return null;
    }
    return { label: parts.join(' '), url: url };
  }

  /* YAML 标量：长得容易歧义（含 : # 引号等、像数字或布尔值、首尾有空格）就加引号，
     其余原样输出，与 content/ 里的文件保持同一种朴素写法。 */
  function yamlScalar(value) {
    var text = String(value == null ? '' : value);
    var plain = text &&
      !/^\s|\s$/.test(text) &&
      !/[:#\[\]{}&*!|>'"%@`,?]/.test(text) &&
      !/^[-?]/.test(text) &&
      !/^(true|false|null|~|[-+]?[\d.]+)$/i.test(text) &&
      !/^\d{4}-\d{2}-\d{2}$/.test(text);
    if (plain) {
      return text;
    }
    return '"' + text.replace(/\\/g, '\\\\').replace(/"/g, '\\"') + '"';
  }

  /* 表单里除正文之外的字段都进 front matter：文本直接写，勾选框写 true / false，
     多值字段写列表，链接写 label / url，日期与排序这类则保持裸值。 */
  function frontMatterEntries() {
    var form = textarea.form;
    if (!form) {
      return [];
    }
    var entries = [];

    Array.prototype.forEach.call(form.elements, function (field) {
      var name = field.name;
      if (!name || name === 'csrf_token' || name === 'body') {
        return;
      }
      if (field.type === 'checkbox') {
        entries.push([name, field.checked ? 'true' : 'false']);
        return;
      }
      if (field.type === 'file' || field.type === 'submit' || field.type === 'button') {
        return;
      }
      var value = (field.value || '').trim();
      if (!value) {
        return;
      }
      if (LIST_FIELDS.indexOf(name) !== -1) {
        entries.push([name, splitList(value)]);
        return;
      }
      if (LINK_FIELDS.indexOf(name) !== -1) {
        entries.push([name, value.split('\n').map(parseLinkLine).filter(Boolean)]);
        return;
      }
      entries.push([name, /^\d{4}-\d{2}-\d{2}$/.test(value) || field.type === 'number'
        ? value
        : yamlScalar(value)]);
    });

    // yaml.safe_dump 默认按键名排序，这里也排一次，导出的文件与保存的文件才长得一样
    return entries.sort(function (left, right) {
      return left[0] < right[0] ? -1 : 1;
    });
  }

  function buildMarkdown() {
    var lines = ['---'];

    frontMatterEntries().forEach(function (entry) {
      var name = entry[0];
      var value = entry[1];
      if (!Array.isArray(value)) {
        lines.push(name + ': ' + value);
        return;
      }
      if (!value.length) {
        return;
      }
      lines.push(name + ':');
      value.forEach(function (item) {
        if (item && typeof item === 'object') {
          lines.push('- label: ' + yamlScalar(item.label));
          lines.push('  url: ' + yamlScalar(item.url));
          return;
        }
        lines.push('- ' + yamlScalar(item));
      });
    });

    lines.push('---', '', textarea.value.replace(/\s+$/, ''));
    return lines.join('\n');
  }

  function saveFile(filename, text) {
    var blob = new Blob([text], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.href = url;
    link.download = filename;
    document.body.appendChild(link);
    link.click();
    link.remove();
    window.setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
  }

  function exportMarkdown() {
    var slug = formField('slug');
    var name = slug && /^[a-z0-9][a-z0-9-]*$/.test(slug.value.trim()) ? slug.value.trim() : 'untitled';
    saveFile(name + '.md', buildMarkdown());
    setStatus('已导出 ' + name + '.md');
  }

  /* 极简 YAML：只认 front matter 里常见的几种写法——标量、内联列表、块状列表，
     以及 links 那种「- label: … / url: …」的小映射。读不懂的行直接跳过，
     不因为某个生僻写法就让整个导入失败。 */
  function parseFrontMatter(block) {
    var meta = {};
    var list = null;  // 正在收集的列表字段
    var entry = null; // 列表里正在写的映射项

    function scalar(raw) {
      var text = raw.trim();
      if (text.length > 1 &&
          ((text.charAt(0) === '"' && text.charAt(text.length - 1) === '"') ||
           (text.charAt(0) === "'" && text.charAt(text.length - 1) === "'"))) {
        return text.slice(1, -1);
      }
      return text;
    }

    block.split('\n').forEach(function (line) {
      if (!line.trim() || /^\s*#/.test(line)) {
        return;
      }

      var nested = /^\s+([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (nested && entry) {
        entry[nested[1]] = scalar(nested[2]);
        return;
      }

      var item = /^\s*-\s*(.*)$/.exec(line);
      if (item && list) {
        var inline = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(item[1]);
        if (inline) {
          entry = {};
          entry[inline[1]] = scalar(inline[2]);
          list.push(entry);
        } else {
          entry = null;
          list.push(scalar(item[1]));
        }
        return;
      }

      var pair = /^([A-Za-z0-9_-]+)\s*:\s*(.*)$/.exec(line);
      if (!pair) {
        return;
      }
      entry = null;
      var raw = pair[2].trim();
      if (!raw) {
        meta[pair[1]] = [];
        list = meta[pair[1]];
        return;
      }
      list = null;
      if (raw.charAt(0) === '[' && raw.charAt(raw.length - 1) === ']') {
        meta[pair[1]] = raw.slice(1, -1).split(',').map(scalar).filter(Boolean);
        return;
      }
      meta[pair[1]] = scalar(raw);
    });

    return meta;
  }

  /* 把 front matter 里读到的字段回填到表单，字段名对不上就跳过。 */
  function fillForm(meta) {
    var form = textarea.form;
    if (!form) {
      return;
    }

    Array.prototype.forEach.call(form.elements, function (field) {
      var name = field.name;
      if (!name || !(name in meta)) {
        return;
      }
      var value = meta[name];

      if (field.type === 'checkbox') {
        field.checked = /^(true|yes|on|1)$/i.test(String(value));
        return;
      }
      if (!field.tagName || field.name === 'body' || field.type === 'file') {
        return;
      }

      if (Array.isArray(value)) {
        var links = value.length > 0 && typeof value[0] === 'object';
        value = value.map(function (item) {
          return links ? [item.label || '', item.url || ''].join(' ') : String(item);
        }).join(links ? '\n' : ', ');
      }
      if (name === 'date' && !/^\d{4}-\d{2}-\d{2}$/.test(String(value))) {
        return;
      }
      if (name === 'slug' && !/^[a-z0-9][a-z0-9-]*$/.test(String(value))) {
        return;
      }
      field.value = String(value == null ? '' : value);
    });
  }

  function applyImported(text) {
    var normalized = String(text || '').replace(/\r\n?/g, '\n');
    var lead = /^---\s*\n([\s\S]*?)\n---\s*\n?/.exec(normalized);
    var body = normalized;

    if (lead) {
      // 有 front matter 就按「字段回表单、其余进正文」拆开；没有就整篇当正文
      fillForm(parseFrontMatter(lead[1]));
      body = normalized.slice(lead[0].length);
    }
    replaceRange(0, textarea.value.length, body, 0, 0);
  }

  if (importInput && textarea) {
    importInput.addEventListener('change', function () {
      var file = importInput.files && importInput.files[0];
      if (!file) {
        return;
      }
      if (textarea.value.trim() &&
          !window.confirm('导入会替换编辑器里的现有正文' +
                          (textarea.form ? '，并覆盖同名字段' : '') + '，确定继续？')) {
        importInput.value = '';
        return;
      }

      var reader = new FileReader();
      reader.onload = function () {
        applyImported(reader.result);
        setStatus('已导入 ' + file.name);
      };
      reader.onerror = function () {
        setStatus('读取文件失败', true);
      };
      reader.readAsText(file);
      importInput.value = '';
    });
  }

  /* ------------------------------------------------ 1.3 Ctrl+S 保存

     浏览器把 Ctrl+S 留给了「保存网页」，对着一份正在写的正文按下去只会弹出另存为
     对话框。拦下来提交当前表单即可——提交前的必填校验、submit 事件上的处理都还是
     原生那套，所以用 requestSubmit 而不是 submit（后者会跳过校验）。

     监听挂在 document 上而不是表单上：焦点落在标题、标签这些字段里时也要能保存。
     要提交的表单从正文输入框反查，页面上那些预览模式 / 退出 / 删除用的表单不会被
     误提交。 */

  var editorForm = textarea ? textarea.form : null;

  if (editorForm) {
    document.addEventListener('keydown', function (event) {
      if (!(event.ctrlKey || event.metaKey) || event.shiftKey || event.altKey) {
        return; // 只认不带其他修饰键的 Ctrl+S / Cmd+S
      }
      if (String(event.key).toLowerCase() !== 's') {
        return;
      }
      event.preventDefault(); // 拦掉浏览器默认的「保存网页」
      if (editorForm.requestSubmit) {
        editorForm.requestSubmit();
      } else {
        editorForm.submit();
      }
    });
  }

  /* ------------------------------------------------ 2. 路径字段上传

     头像、封面这类字段旁边放一个「上传」按钮，选好图片后自动把地址
     回填到输入框，使用者不必关心路径规则。 */

  Array.prototype.forEach.call(
    document.querySelectorAll('[data-upload-path]'),
    function (input) {
      var field = input.closest('.field');
      if (!field) {
        return;
      }

      var target = field.querySelector('[data-path-input]');
      var previewImage = field.querySelector('[data-path-preview]');
      var message = field.querySelector('[data-upload-status]');

      function say(text, isError) {
        if (!message) {
          return;
        }
        message.textContent = text || '';
        message.classList.toggle('is-error', Boolean(isError));
      }

      input.addEventListener('change', function () {
        var file = input.files && input.files[0];
        if (!file) {
          return;
        }

        say('上传中…');
        upload(file)
          .then(function (result) {
            if (!result.ok) {
              say(result.error || '上传失败', true);
              return;
            }
            if (target) {
              target.value = result.url;
              target.dispatchEvent(new Event('change', { bubbles: true }));
            }
            if (previewImage) {
              previewImage.src = result.url;
              previewImage.hidden = false;
            }
            say('已上传：' + result.url);
          })
          .catch(function () {
            say('上传失败，请检查网络后重试', true);
          })
          .then(function () {
            input.value = '';
          });
      });
    }
  );

  /* ------------------------------------------------ 3. 编辑器本地缓存

     编辑器里的改动在点「保存」之前只活在当前页面：误关标签页、刷新、浏览器崩了，
     写了半天的正文就跟着没了。这里在「预览渲染完成」的那一刻，把整份草稿（表单字段
     加正文）写进 localStorage，下次打开同一个页面就能捞回来。

     记录按页面路径分开存（/admin/articles/new、/admin/projects/<slug>/edit 各一份），
     互相不覆盖。内容一旦落到服务器就删掉——那时它已经是正式内容，再留一份本地副本
     只会让人分不清哪份是新的。

     三个时机：
       写 —— 预览渲染完成后（跟预览同一个节拍，见 renderPreview）；与打开页面时的那份
             一致就不写，改回原样还会把记录删掉，所以「动过才留痕迹」。
       删 —— 保存成功（后端重定向回来带着 flash-ok，见 flushClearedDrafts）、在提示条
             或后台列表上点「丢弃」、记录过期。
       读 —— 打开编辑页时记录与服务器内容不同，就在页顶提示「恢复 / 不用了」；从后台
             列表点「恢复」进来（?restore=1）则直接套用，不再问。

     只存在浏览器里，且不带过期时间以外的清理：同一台机器上的另一个浏览器看不到，
     换台机器也看不到——它是「这一份的兜底」，不是同步方案。 */

  var DRAFT_PREFIX = 'editor-cache:';            // 键前缀 + 页面路径
  var DRAFT_VERSION = 1;
  var DRAFT_MAX_AGE = 7 * 24 * 60 * 60 * 1000;   // 一星期没动过的记录顺手丢掉
  var CLEAR_KEY = 'editor-clear';                // sessionStorage：提交后等着核销的记录
  var CLEAR_MAX_AGE = 5 * 60 * 1000;

  var draftBaseline = null; // 打开页面时那份草稿的指纹，用来判断「有没有改过」

  /* localStorage 在隐身模式等场景下取用就可能抛异常，取值、写入也各要兜一层。 */
  function localStore() {
    try {
      return window.localStorage;
    } catch (error) {
      return null;
    }
  }

  function readDraft(path) {
    var store = localStore();
    if (!store) {
      return null;
    }
    try {
      var raw = store.getItem(DRAFT_PREFIX + path);
      var data = raw ? JSON.parse(raw) : null;
      // 记录里必须有字段表和正文，否则当作坏记录，交给 eachDraft 清掉
      return data && data.fields && typeof data.body === 'string' ? data : null;
    } catch (error) {
      return null;
    }
  }

  function writeDraft(path, data) {
    var store = localStore();
    if (!store) {
      return;
    }
    try {
      store.setItem(DRAFT_PREFIX + path, JSON.stringify(data));
    } catch (error) {
      /* 配额满或被禁用：缓存写不进去，不影响正在写的内容 */
    }
  }

  function dropDraft(path) {
    var store = localStore();
    if (!store) {
      return;
    }
    try {
      store.removeItem(DRAFT_PREFIX + path);
    } catch (error) {
      /* 删不掉也没什么可补救的 */
    }
  }

  /* 遍历所有记录。遍历途中删键会让 key(i) 错位，所以先把键收集齐再处理。 */
  function eachDraft(visit) {
    var store = localStore();
    if (!store) {
      return;
    }
    var keys = [];
    try {
      for (var i = 0; i < store.length; i++) {
        var key = store.key(i);
        if (key && key.indexOf(DRAFT_PREFIX) === 0) {
          keys.push(key);
        }
      }
    } catch (error) {
      return;
    }
    keys.forEach(function (key) {
      visit(key.slice(DRAFT_PREFIX.length), readDraft(key.slice(DRAFT_PREFIX.length)));
    });
  }

  /* 「多久以前」按粗粒度说：本地缓存只关心「是不是刚存的那份」。 */
  function timeAgo(at) {
    var minutes = Math.round((Date.now() - at) / 60000);
    if (!(minutes > 0)) {
      return '刚刚';
    }
    if (minutes < 60) {
      return minutes + ' 分钟前';
    }
    var hours = Math.round(minutes / 60);
    if (hours < 24) {
      return hours + ' 小时前';
    }
    return Math.round(hours / 24) + ' 天前';
  }

  /* -------------------------------------------- 3.1 编辑页 */

  /* 除正文外的所有字段：勾选框存布尔，其余存字符串。空值也照存，
     否则「把摘要清空」这种改动还原不出来。 */
  function collectFields() {
    var fields = {};
    if (!editorForm) {
      return fields;
    }
    Array.prototype.forEach.call(editorForm.elements, function (field) {
      var name = field.name;
      if (!name || name === 'csrf_token' || name === 'body' || field.type === 'file') {
        return;
      }
      if (field.type === 'submit' || field.type === 'button' || field.type === 'reset') {
        return;
      }
      fields[name] = field.type === 'checkbox' ? field.checked : field.value;
    });
    return fields;
  }

  function draftState() {
    return { fields: collectFields(), body: textarea.value };
  }

  /* 指纹按表单里的顺序序列化，同一份内容每次得到同一个字符串。 */
  function stateSignature(state) {
    return JSON.stringify([state.fields, state.body]);
  }

  function draftKind() {
    return location.pathname.indexOf('/projects/') !== -1 ? 'project' : 'article';
  }

  function draftTitle() {
    var title = formField('title');
    var text = title ? title.value.trim() : '';
    if (text) {
      return text;
    }
    var slug = formField('slug');
    return (slug && slug.value.trim()) || '（未命名）';
  }

  /* 预览渲染完成后调用。与打开页面时一致就删掉记录：那种情况下缓存里的内容和
     服务器上的没有区别，留着只会在后台列表上多出一个没有意义的小红点。 */
  function storeDraft() {
    if (draftBaseline === null) {
      return; // 不是编辑页：没有「打开时的那份」可比，也就无从判断改没改
    }
    var state = draftState();
    if (stateSignature(state) === draftBaseline) {
      dropDraft(location.pathname);
      return;
    }
    writeDraft(location.pathname, {
      v: DRAFT_VERSION,
      at: Date.now(),
      kind: draftKind(),
      title: draftTitle(),
      fields: state.fields,
      body: state.body
    });
  }

  /* 把草稿放回表单：字段逐个覆盖（空值也覆盖），正文整篇换掉。 */
  function restoreDraft(data) {
    Array.prototype.forEach.call(editorForm.elements, function (field) {
      var name = field.name;
      if (!name || !(name in data.fields) || name === 'body' || field.type === 'file') {
        return;
      }
      if (field.type === 'submit' || field.type === 'button' || field.type === 'reset') {
        return;
      }
      if (field.type === 'checkbox') {
        field.checked = Boolean(data.fields[name]);
        return;
      }
      field.value = String(data.fields[name] == null ? '' : data.fields[name]);
    });
    replaceRange(0, textarea.value.length, data.body, 0, 0);
  }

  /* -------------------------------------------- 3.2 编辑页顶部的提示条

     提示条本身写在 admin/base.html 里（flash 提示下面），这里只负责填内容。
     按钮是当场建的：不进 HTML 就不会在没缓存的页面上留下空壳。 */

  var notice = document.querySelector('[data-draft-notice]');

  function dismissNotice() {
    if (!notice) {
      return;
    }
    notice.textContent = '';
    notice.hidden = true;
  }

  function showNoticeLine(text) {
    if (!notice) {
      return;
    }
    notice.textContent = '';
    var line = document.createElement('span');
    line.className = 'draft-notice-text';
    line.textContent = text;
    notice.appendChild(line);
    notice.hidden = false;
  }

  function showDraftNotice(data) {
    if (!notice) {
      return;
    }
    notice.textContent = '';

    var line = document.createElement('span');
    line.className = 'draft-notice-text';
    line.textContent = '这个浏览器里存着 ' + timeAgo(data.at) + '的本地草稿「' + data.title +
      '」（' + data.body.length + ' 字），服务器上还没有这份改动。';

    var restore = document.createElement('button');
    restore.type = 'button';
    restore.className = 'button button-small';
    restore.textContent = '恢复草稿';
    restore.addEventListener('click', function () {
      restoreDraft(data);
      setStatus('已恢复 ' + timeAgo(data.at) + '的本地草稿，保存后会同步到服务器');
      showNoticeLine('已恢复本地草稿「' + data.title + '」——它还没有保存到服务器。');
    });

    /* 「不用了」只删记录，不动页面上的内容：页面上本来就是服务器上的那份。
       真要回到服务器版本，刷新一下就行（刷新后提示条会再出现一次，可以再点「不用了」）。 */
    var discard = document.createElement('button');
    discard.type = 'button';
    discard.className = 'button button-small button-ghost';
    discard.textContent = '不用了';
    discard.title = '删除这份本地缓存，页面内容不动';
    discard.addEventListener('click', function () {
      dropDraft(location.pathname);
      dismissNotice();
      setStatus('已删除本地草稿');
    });

    notice.appendChild(line);
    notice.appendChild(restore);
    notice.appendChild(discard);
    notice.hidden = false;
  }

  /* -------------------------------------------- 3.3 提交后的核销 */

  /* 保存走的是原生提交（POST → 302 → GET），这条路径里没有「服务器已经写好了」的
     回执可读。退一步用回来那一页上的 flash 判断：重定向前把当前路径记进
     sessionStorage，回到后台看到成功提示（.flash-ok）就把那份记录删掉。保存失败会带
     flash-error 回来，那时记录继续留在本地，提示条也还在，没写完的东西不会丢。 */
  function rememberClear() {
    try {
      window.sessionStorage.setItem(CLEAR_KEY, JSON.stringify({
        at: Date.now(),
        paths: [location.pathname] // 改了 slug 就是换了路径，删的是提交前那份
      }));
    } catch (error) {
      /* 记不住就退化成「保存成功后由编辑页自己对账」（见 initDrafts） */
    }
  }

  function flushClearedDrafts() {
    var raw = null;
    try {
      raw = window.sessionStorage.getItem(CLEAR_KEY);
      window.sessionStorage.removeItem(CLEAR_KEY);
    } catch (error) {
      return;
    }
    if (!raw) {
      return;
    }
    var record = null;
    try {
      record = JSON.parse(raw);
    } catch (error) {
      return;
    }
    // 只在带成功提示的那一页核销，且认「刚刚提交的」那一份
    if (!record || !(Date.now() - (record.at || 0) <= CLEAR_MAX_AGE)) {
      return;
    }
    if (!document.querySelector('.flash-ok')) {
      return;
    }
    (record.paths || []).forEach(dropDraft);
  }

  /* 过期记录清掉，免得攒下一堆早就不用的草稿。 */
  function pruneDrafts() {
    var now = Date.now();
    eachDraft(function (path, data) {
      if (!data || typeof data.at !== 'number' || now - data.at > DRAFT_MAX_AGE) {
        dropDraft(path);
      }
    });
  }

  /* -------------------------------------------- 3.4 后台列表 */

  /* 列表页的两个容器：一排「本地草稿」记录单列一节的地方，见 dashboard.html */
  var draftSection = document.querySelector('[data-draft-section]');
  var draftList = document.querySelector('[data-draft-list]');

  /* 后台内容列表：给有本地草稿的条目挂上标记与「恢复 / 丢弃」。
     标记就放在操作列里，用的是行上的 data-cache-path（编辑页地址）当记录键。 */
  function paintRowDraft(slot, path, data) {
    slot.textContent = '';
    slot.hidden = false;

    var badge = document.createElement('span');
    badge.className = 'badge badge-local';
    badge.textContent = '本地草稿 · ' + timeAgo(data.at);
    badge.title = '这个浏览器里还存着「' + data.title + '」的未保存改动';

    var restore = document.createElement('a');
    restore.className = 'link-more';
    restore.href = path + '?restore=1';
    restore.textContent = '恢复';
    restore.title = '打开编辑页并套用这份草稿';

    var drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'link-button link-danger';
    drop.textContent = '丢弃';
    drop.title = '删除这份本地缓存，服务器上的内容不动';
    drop.addEventListener('click', function () {
      dropDraft(path);
      slot.textContent = '';
      slot.hidden = true;
    });

    slot.appendChild(badge);
    slot.appendChild(restore);
    slot.appendChild(drop);
  }

  /* 新建页的缓存没有对应的行可挂（那条内容还没建出来），单列一节，
     按「继续编辑」回去即可。 */
  function draftItem(item) {
    var li = document.createElement('li');
    li.className = 'draft-item';

    var title = document.createElement('span');
    title.className = 'draft-item-title';
    title.textContent = item.data.title;

    var meta = document.createElement('span');
    meta.className = 'muted';
    meta.textContent = (item.data.kind === 'project' ? '项目' : '文章') +
      ' · 保存于 ' + timeAgo(item.data.at) + ' · ' + item.data.body.length + ' 字';

    var actions = document.createElement('span');
    actions.className = 'draft-item-actions';

    var resume = document.createElement('a');
    resume.className = 'link-more';
    resume.href = item.path + '?restore=1';
    resume.textContent = '继续编辑';

    var drop = document.createElement('button');
    drop.type = 'button';
    drop.className = 'link-button link-danger';
    drop.textContent = '丢弃';
    drop.addEventListener('click', function () {
      dropDraft(item.path);
      li.remove();
      if (!draftList.firstChild) {
        draftSection.hidden = true;
      }
    });

    actions.appendChild(resume);
    actions.appendChild(drop);
    li.appendChild(title);
    li.appendChild(meta);
    li.appendChild(actions);
    return li;
  }

  function initDashboardDrafts() {
    var rows = Array.prototype.slice.call(document.querySelectorAll('[data-cache-path]'));
    if (!rows.length && !draftList) {
      return; // 不是内容列表页
    }

    var attached = {};
    rows.forEach(function (row) {
      var path = row.getAttribute('data-cache-path');
      var slot = row.querySelector('[data-draft-slot]');
      var data = path ? readDraft(path) : null;
      if (!slot || !data) {
        return;
      }
      attached[path] = true; // 这条记录的「主人」还在，不必列进下面那一节
      paintRowDraft(slot, path, data);
    });

    if (!draftSection || !draftList) {
      return;
    }

    var orphans = [];
    eachDraft(function (path, data) {
      if (!data) {
        dropDraft(path); // 坏记录：解析不出来，留着也没用
        return;
      }
      if (!attached[path]) {
        orphans.push({ path: path, data: data });
      }
    });

    if (!orphans.length) {
      draftSection.hidden = true;
      return;
    }

    draftList.textContent = '';
    orphans.sort(function (left, right) {
      return right.data.at - left.data.at; // 最近动过的排前面
    });
    orphans.forEach(function (item) {
      draftList.appendChild(draftItem(item));
    });
    draftSection.hidden = false;
  }

  /* -------------------------------------------- 3.5 入口 */

  /* 保存成功后要核销、过期记录要清理，这两件事在任何后台页面都得做一遍
     （新建文章保存完是跳回列表的，不在编辑页）。 */
  flushClearedDrafts();
  pruneDrafts();

  if (editorForm && textarea) {
    editorForm.addEventListener('submit', rememberClear);

    // 打开页面时的那份内容：之后写不写缓存、要不要提示，都拿它当基准
    draftBaseline = stateSignature(draftState());

    var stored = readDraft(location.pathname);
    if (stored) {
      if (stateSignature({ fields: stored.fields, body: stored.body }) === draftBaseline) {
        dropDraft(location.pathname); // 服务器上就是这份，记录可以扔了
      } else if (/(?:^|[?&])restore=1(?:&|$)/.test(location.search)) {
        // 从列表点「恢复」进来：直接套用，并把参数摘掉（刷新时不再自动套一遍）
        restoreDraft(stored);
        if (window.history.replaceState) {
          window.history.replaceState(null, '', location.pathname);
        }
        showNoticeLine('已恢复本地草稿「' + stored.title + '」（' + timeAgo(stored.at) +
          '保存）——它还没有保存到服务器。');
      } else {
        showDraftNotice(stored);
      }
    }
  } else {
    initDashboardDrafts();
  }
})();
