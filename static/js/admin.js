/* 后台交互，两块互相独立：
   1) Markdown 编辑器：格式工具栏、图片上传与 md 导入导出、实时预览
   2) 路径字段（头像 / 封面）：上传后把地址回填到输入框
   页面里只存在其中之一也能正常工作。 */
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
  var PREVIEW_DELAY = 250; // 输入停顿多久后渲染，避免逐字请求
  var previewTimer = null;
  var previewSeq = 0; // 丢弃过期响应，防止旧结果覆盖新结果
  var previewVisible = Boolean(preview);
  var paintedHtml = null; // 上一次写入预览的 HTML，内容没变就不重绘（重绘会丢滚动位置）
  var paintToken = 0; // 每次重绘递增，用来让过期的图片回调失效
  var stashedScroll = null; // 预览被隐藏时暂存的滚动位置

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

  /* 把正文渲染到右侧预览栏。请求带序号，只有最新一次的结果会生效。 */
  function renderPreview() {
    if (!preview || !previewVisible) {
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

  if (textarea && preview) {
    // 记下预览自身的底部内边距：文末留白写的是同一个属性，算的时候得先把它扣掉
    previewPadBottom = parseFloat(window.getComputedStyle(preview).paddingBottom) || 0;

    textarea.addEventListener('input', function () {
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

    // 首次进入即渲染已有正文，编辑旧文章时预览与输入框内容一致。
    refreshLineTops();
    schedulePreview(0);
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
     光标、标尺、预览的刷新都集中在这一处。 */
  function replaceRange(start, end, text, selStart, selEnd) {
    textarea.value = textarea.value.slice(0, start) + text + textarea.value.slice(end);
    if (selStart == null) {
      selStart = selEnd = start + text.length;
    }
    textarea.focus();
    textarea.setSelectionRange(selStart, selEnd);
    syncSource = 'editor';
    refreshLineTops();
    schedulePreview(0);
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

    // 颜色按钮：色条实时跟着选择走，选好后写进正文
    Array.prototype.forEach.call(toolbar.querySelectorAll('[data-color]'), function (field) {
      var input = field.querySelector('input');
      if (!input) {
        return;
      }
      field.style.setProperty('--tool-color', input.value);
      input.addEventListener('input', function () {
        field.style.setProperty('--tool-color', input.value);
      });
      input.addEventListener('change', function () {
        field.style.setProperty('--tool-color', input.value);
        applyColor(field.getAttribute('data-color') === 'back' ? 'background-color' : 'color',
                   input.value);
      });
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
})();
