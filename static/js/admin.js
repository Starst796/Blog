/* 后台交互，两块互相独立：
   1) Markdown 编辑器：图片上传后插入 Markdown，并支持实时预览
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
  var anchors = [];          // [{ e, p, line }]：编辑框像素 ↔ 预览像素，两列都单调递增
  var syncSource = 'editor'; // 最近一次是谁在滚：editor / preview
  var syncLock = null;       // 联动写入对面时的目标值，用来吞掉自己触发的 scroll 事件

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

  function insertAtCursor(text) {
    var start = textarea.selectionStart;
    var end = textarea.selectionEnd;
    var value = textarea.value;
    var head = value.slice(0, start);
    var tail = value.slice(end);

    if (head && !/\n$/.test(head)) {
      head += '\n';
    }

    var insertion = head + text + '\n';
    textarea.value = insertion + tail;
    textarea.selectionStart = textarea.selectionEnd = insertion.length;
    textarea.focus();
    syncSource = 'editor';
    refreshLineTops();
    schedulePreview(0);
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

  /* 重新量一遍每一行源码的像素位置（正文变了、编辑框变宽变窄时都要重来）。 */
  function refreshLineTops() {
    if (!textarea) {
      return;
    }
    ensureRuler();

    var computed = window.getComputedStyle(textarea);
    RULER_STYLES.forEach(function (name) {
      ruler.style[name] = computed[name];
    });
    // 宽度取编辑框内容区：clientWidth 已扣掉滚动条占的宽度，换行点才能对上
    ruler.style.boxSizing = 'border-box';
    ruler.style.width = textarea.clientWidth + 'px';
    ruler.style.whiteSpace = 'pre-wrap';
    ruler.style.overflowWrap = 'break-word';

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
      var tailX = xEnd - from[xKey];
      return tailX > 0
        ? from[yKey] + ((x - from[xKey]) / tailX) * (yEnd - from[yKey])
        : from[yKey];
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
        rebuildAnchors();
        if (syncSource === 'editor' && !panesStacked()) {
          applyScroll(preview, editorToPreview());
        }
      }, 150);
    });

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
            insertAtCursor(result.markdown);
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
