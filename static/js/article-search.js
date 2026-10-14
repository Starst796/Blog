(function () {
  'use strict';

  var panel = document.querySelector('[data-article-find]');
  var prose = document.querySelector('.post .prose');
  if (!panel || !prose) {
    return;
  }

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

  function setOpen(open) {
    panel.hidden = !open;
    toggle.setAttribute('aria-expanded', String(open));
    if (open) {
      var tocPanel = document.querySelector('[data-toc-panel]');
      var tocToggle = document.querySelector('[data-toc-toggle]');
      if (tocPanel && !tocPanel.hidden && tocToggle) {
        tocToggle.click();
      }
      input.focus();
      input.select();
    } else {
      toggle.focus();
    }
  }

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
    if (!panel.hidden && !panel.parentNode.contains(event.target)) {
      setOpen(false);
    }
  });

  document.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && !panel.hidden) {
      setOpen(false);
    }
  });
})();
