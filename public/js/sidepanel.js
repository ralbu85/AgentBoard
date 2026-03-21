// ── Side Panel: Files, Editor, History ──

var _spOpen = false;
var _spCurrentFile = null;
var _spDirty = false;
var _spPreviewMode = false;
var _cmEditor = null; // CodeMirror instance
var _cmModes = {
  tex: 'stex', sty: 'stex', cls: 'stex', bib: 'stex',
  js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
  py: 'python', css: 'css', html: 'htmlmixed', xml: 'xml',
  md: 'markdown', yml: 'yaml', yaml: 'yaml',
  sh: 'shell', bash: 'shell', zsh: 'shell',
  sql: 'sql', json: { name: 'javascript', json: true }
};
var _inputHistory = {}; // id → [{text, ts}]

// ── Panel Toggle ──

function toggleSidePanel() {
  _spOpen = !_spOpen;
  var panel = document.getElementById('side-panel');
  var drag = document.getElementById('sp-drag');
  var btn = document.getElementById('sidepanel-btn');
  panel.style.display = _spOpen ? 'flex' : 'none';
  drag.style.display = _spOpen ? 'block' : 'none';
  if (btn) btn.classList.toggle('active', _spOpen);
  if (_spOpen && activeTab) refreshSPFiles();
  setTimeout(sendResize, 100);
}

// ── Drag Resize ──

(function() {
  var drag = document.getElementById('sp-drag');
  var panel = document.getElementById('side-panel');
  if (!drag || !panel) return;

  var startX, startW;

  drag.addEventListener('mousedown', function(e) {
    e.preventDefault();
    startX = e.clientX;
    startW = panel.offsetWidth;
    drag.classList.add('dragging');
    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });

  function onMove(e) {
    var diff = startX - e.clientX;
    var newW = Math.max(200, Math.min(startW + diff, window.innerWidth * 0.6));
    panel.style.width = newW + 'px';
  }

  function onUp() {
    drag.classList.remove('dragging');
    document.removeEventListener('mousemove', onMove);
    document.removeEventListener('mouseup', onUp);
    setTimeout(sendResize, 100);
  }
})();

function switchSPTab(name) {
  document.querySelectorAll('.sp-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.sp === name);
  });
  ['files', 'editor', 'history'].forEach(function(n) {
    var el = document.getElementById('sp-' + n);
    if (el) el.style.display = n === name ? 'flex' : 'none';
  });
  if (name === 'files' && activeTab && !_spBrowseInitialized[activeTab]) refreshSPFiles();
  if (name === 'history' && activeTab) renderHistory(activeTab);
}

// ── Files Tab ──

var _spBrowsePath = '/';
var _spBrowseInitialized = {}; // per-tab: true if already browsing
var _spBrowsePaths = {};       // per-tab: remember last browsed path
var _spRootPath = {};          // per-tab: session CWD (locked root)

function refreshSPFiles() {
  var tab = document.querySelector('.tab[data-id="' + activeTab + '"]');
  if (tab && tab.dataset.cwd) {
    var cwd = tab.dataset.cwd;
    _spRootPath[activeTab] = cwd;
    if (_spBrowsePaths[activeTab]) {
      // Restore last browsed path for this tab
      _spBrowsePath = _spBrowsePaths[activeTab];
    } else {
      _spBrowsePath = cwd;
    }
    _spBrowseInitialized[activeTab] = true;
  }
  loadSPFiles(_spBrowsePath);
}

function loadSPFiles(dir) {
  // Lock to session CWD root
  var root = _spRootPath[activeTab];
  if (root && !dir.startsWith(root) && dir !== '/') {
    dir = root;
  }
  _spBrowsePath = dir;
  if (activeTab) _spBrowsePaths[activeTab] = dir;
  renderSPPath(dir);
  apiGet('/api/files?path=' + encodeURIComponent(dir))
    .then(function(data) {
      var list = document.getElementById('sp-files-list');
      list.innerHTML = '';

      // Parent dir (don't go above session root)
      var root = _spRootPath[activeTab] || '/';
      if (dir !== '/' && dir !== root) {
        var parent = dir.replace(/\/[^/]+\/?$/, '') || '/';
        if (parent.length < root.length) parent = root;
        var up = document.createElement('div');
        up.className = 'sp-file';
        up.innerHTML = '<span class="sp-file-icon">..</span><span class="sp-file-name" style="color:#8b949e">parent</span>';
        up.onclick = function() { loadSPFiles(parent); };
        list.appendChild(up);
      }

      data.entries.forEach(function(e) {
        var fullPath = dir + '/' + e.name;
        var item = document.createElement('div');
        item.className = 'sp-file';
        var icon = e.type === 'dir' ? '📁' : getFileIcon(e.name);
        var size = e.type === 'file' ? formatFileSize(e.size) : '';
        item.innerHTML = '<span class="sp-file-icon">' + icon + '</span>' +
          '<span class="sp-file-name">' + e.name + '</span>' +
          '<span class="sp-file-size">' + size + '</span>';
        if (e.type === 'dir') {
          item.onclick = function() { loadSPFiles(fullPath); };
        } else if (isPDF(e.name)) {
          item.onclick = function() { openPDF(fullPath); };
        } else if (isEditableFile(e.name)) {
          item.onclick = function() { openFileInEditor(fullPath); };
        } else {
          item.style.opacity = '0.4';
          item.style.cursor = 'default';
        }
        // Right-click context menu
        item.addEventListener('contextmenu', function(ev) {
          ev.preventDefault();
          showContextMenu(ev.clientX, ev.clientY, fullPath, e.type, e.name, dir);
        });
        list.appendChild(item);
      });
    })
    .catch(function() {
      document.getElementById('sp-files-list').innerHTML =
        '<div style="padding:10px;color:#f87171;font-size:12px">Cannot read directory</div>';
    });
}

function renderSPPath(dir) {
  var el = document.getElementById('sp-files-path');
  el.innerHTML = '';
  var parts = dir.split('/').filter(Boolean);
  var crumb = document.createElement('span');
  crumb.className = 'crumb';
  crumb.textContent = '/';
  crumb.onclick = function() { loadSPFiles('/'); };
  el.appendChild(crumb);

  var acc = '';
  parts.forEach(function(part) {
    acc += '/' + part;
    el.appendChild(document.createTextNode(' / '));
    var c = document.createElement('span');
    c.className = 'crumb';
    c.textContent = part;
    var target = acc;
    c.onclick = function() { loadSPFiles(target); };
    el.appendChild(c);
  });
}

var _editableExts = ['md', 'txt', 'js', 'ts', 'jsx', 'tsx', 'py', 'json', 'css', 'html', 'yml', 'yaml', 'toml', 'sh', 'bash', 'zsh', 'env', 'cfg', 'ini', 'xml', 'svg', 'sql', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'rb', 'php', 'lua', 'r', 'csv', 'log', 'conf', 'dockerfile', 'makefile', 'tex', 'bib', 'sty', 'cls', 'bbl', 'aux'];

function isPDF(name) {
  return name.toLowerCase().endsWith('.pdf');
}

var _pdfDoc = null;
var _pdfPage = 1;

function openPDF(filePath) {
  var url = '/api/file-raw?path=' + encodeURIComponent(filePath);
  destroyCodeMirror();
  var editor = document.getElementById('sp-editor');
  editor.classList.add('pdf-mode');
  document.getElementById('sp-editor-name').textContent = filePath.split('/').pop();
  document.getElementById('sp-editor-name').title = filePath;

  // Remove old viewer
  var old = document.getElementById('sp-pdf-viewer');
  if (old) old.remove();

  // Create viewer
  var viewer = document.createElement('div');
  viewer.id = 'sp-pdf-viewer';
  viewer.innerHTML =
    '<div id="sp-pdf-nav">' +
      '<button id="sp-pdf-prev" class="sp-btn">← Prev</button>' +
      '<span id="sp-pdf-info">Loading...</span>' +
      '<button id="sp-pdf-next" class="sp-btn">Next →</button>' +
    '</div>' +
    '<div id="sp-pdf-canvas-wrap"><canvas id="sp-pdf-canvas"></canvas></div>';
  editor.appendChild(viewer);

  _spCurrentFile = null;
  _spPreviewMode = false;
  showEditorBackBtn();
  switchSPTab('editor');

  // Load PDF
  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  pdfjsLib.getDocument(url).promise.then(function(pdf) {
    _pdfDoc = pdf;
    _pdfPage = 1;
    var info = document.getElementById('sp-pdf-info');
    info.textContent = pdf.numPages + ' pages';
    document.getElementById('sp-pdf-prev').onclick = function() { gotoPdfPage(_pdfPage - 1); };
    document.getElementById('sp-pdf-next').onclick = function() { gotoPdfPage(_pdfPage + 1); };
    renderAllPages();
  }).catch(function() {
    document.getElementById('sp-pdf-info').textContent = 'Failed to load PDF';
  });
}

function gotoPdfPage(num) {
  if (!_pdfDoc || num < 1 || num > _pdfDoc.numPages) return;
  _pdfPage = num;
  var el = document.getElementById('sp-pdf-page-' + num);
  if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  document.getElementById('sp-pdf-info').textContent = _pdfPage + ' / ' + _pdfDoc.numPages;
}

function renderAllPages() {
  if (!_pdfDoc) return;
  var wrap = document.getElementById('sp-pdf-canvas-wrap');
  if (!wrap) return;
  wrap.innerHTML = '';
  var containerWidth = wrap.clientWidth || 350;
  var dpr = window.devicePixelRatio || 1;

  for (var p = 1; p <= _pdfDoc.numPages; p++) {
    (function(pageNum) {
      var canvas = document.createElement('canvas');
      canvas.id = 'sp-pdf-page-' + pageNum;
      canvas.className = 'sp-pdf-page';
      wrap.appendChild(canvas);

      _pdfDoc.getPage(pageNum).then(function(page) {
        var ctx = canvas.getContext('2d');
        var baseViewport = page.getViewport({ scale: 1 });
        var scale = containerWidth / baseViewport.width;
        var viewport = page.getViewport({ scale: scale * dpr });
        canvas.width = viewport.width;
        canvas.height = viewport.height;
        canvas.style.width = (viewport.width / dpr) + 'px';
        canvas.style.height = (viewport.height / dpr) + 'px';
        page.render({ canvasContext: ctx, viewport: viewport });
      });
    })(p);
  }

  // Update page number on scroll
  wrap.onscroll = function() {
    var pages = wrap.querySelectorAll('.sp-pdf-page');
    var wrapTop = wrap.scrollTop + wrap.clientHeight / 3;
    for (var i = pages.length - 1; i >= 0; i--) {
      if (pages[i].offsetTop <= wrapTop) {
        _pdfPage = i + 1;
        document.getElementById('sp-pdf-info').textContent = _pdfPage + ' / ' + _pdfDoc.numPages;
        break;
      }
    }
  };
}

function isEditableFile(name) {
  var lower = name.toLowerCase();
  if (lower === 'makefile' || lower === 'dockerfile') return true;
  var ext = lower.split('.').pop();
  return _editableExts.indexOf(ext) !== -1;
}

function getFileIcon(name) {
  var ext = name.split('.').pop().toLowerCase();
  var icons = { md: '📝', js: '📜', py: '🐍', json: '📋', css: '🎨', html: '🌐', ts: '📜', txt: '📄', pdf: '📕', tex: '📐', bib: '📚', sty: '⚙️' };
  return icons[ext] || '📄';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + 'K';
  return (bytes / 1048576).toFixed(1) + 'M';
}

// ── Context Menu ──

function showContextMenu(x, y, filePath, type, name, parentDir) {
  closeContextMenu();
  var menu = document.createElement('div');
  menu.id = 'sp-context-menu';
  menu.className = 'sp-context-menu';

  var items = [];
  if (type === 'file') {
    if (isPDF(name)) {
      items.push({ label: 'View PDF', action: function() { openPDF(filePath); } });
    } else if (isEditableFile(name)) {
      items.push({ label: 'Edit', action: function() { openFileInEditor(filePath); } });
    }
    items.push({ label: 'Download', action: function() {
      var a = document.createElement('a');
      a.href = '/api/file-raw?path=' + encodeURIComponent(filePath);
      a.download = name;
      a.click();
    }});
  } else {
    items.push({ label: 'Open', action: function() { loadSPFiles(filePath); } });
  }
  items.push({ label: 'Rename', action: function() {
    var newName = prompt('Rename to:', name);
    if (!newName || newName === name) return;
    var newPath = parentDir + '/' + newName;
    apiPost('/api/rename', { from: filePath, to: newPath })
      .then(function(r) { return r.json(); })
      .then(function(d) { if (d.ok) loadSPFiles(parentDir); else alert(d.error || 'Failed'); });
  }});
  items.push({ label: 'Delete', cls: 'danger', action: function() {
    if (!confirm('Delete "' + name + '"?')) return;
    apiPost('/api/delete', { path: filePath })
      .then(function(r) { return r.json(); })
      .then(function(d) { if (d.ok) loadSPFiles(parentDir); else alert(d.error || 'Failed'); });
  }});

  items.forEach(function(it) {
    var el = document.createElement('div');
    el.className = 'sp-ctx-item' + (it.cls ? ' ' + it.cls : '');
    el.textContent = it.label;
    el.onclick = function() { closeContextMenu(); it.action(); };
    menu.appendChild(el);
  });

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  // Adjust if off screen
  var rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';

  setTimeout(function() {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}

function closeContextMenu() {
  var old = document.getElementById('sp-context-menu');
  if (old) old.remove();
}

// ── Editor Tab ──

function initCodeMirror(mode) {
  destroyCodeMirror();
  var ta = document.getElementById('sp-editor-area');
  ta.style.display = 'none';
  _cmEditor = CodeMirror(function(el) {
    ta.parentNode.insertBefore(el, ta);
  }, {
    value: ta.value,
    mode: mode || 'text',
    theme: 'material-darker',
    lineNumbers: true,
    matchBrackets: true,
    autoCloseBrackets: true,
    indentUnit: 2,
    tabSize: 2,
    indentWithTabs: false,
    lineWrapping: true,
    extraKeys: {
      'Ctrl-S': function() { saveCurrentFile(); },
      'Cmd-S': function() { saveCurrentFile(); }
    }
  });
  _cmEditor.on('change', function() {
    _spDirty = true;
    // Sync to textarea for save
    document.getElementById('sp-editor-area').value = _cmEditor.getValue();
  });
  // Fix height
  _cmEditor.getWrapperElement().style.flex = '1';
  _cmEditor.getWrapperElement().style.overflow = 'hidden';
  setTimeout(function() { _cmEditor.refresh(); }, 100);
}

function destroyCodeMirror() {
  if (_cmEditor) {
    var wrapper = _cmEditor.getWrapperElement();
    if (wrapper && wrapper.parentNode) wrapper.parentNode.removeChild(wrapper);
    _cmEditor = null;
  }
  document.getElementById('sp-editor-area').style.display = 'block';
}

function resetEditor() {
  _spCurrentFile = null;
  _spDirty = false;
  _spPreviewMode = false;
  destroyCodeMirror();
  document.getElementById('sp-editor').classList.remove('pdf-mode');
  document.getElementById('sp-editor-name').textContent = 'No file open';
  document.getElementById('sp-editor-area').value = '';
  document.getElementById('sp-editor-area').style.display = 'block';
  document.getElementById('sp-editor-preview').style.display = 'none';
  document.getElementById('sp-editor-preview').innerHTML = '';
  var oldPdf = document.getElementById('sp-pdf-viewer');
  if (oldPdf) oldPdf.remove();
  _pdfDoc = null;
  var backBtn = document.querySelector('.sp-back-btn');
  if (backBtn) backBtn.remove();
  document.getElementById('sp-preview-btn').classList.remove('active');
}

function showEditorBackBtn() {
  var bar = document.getElementById('sp-editor-bar');
  if (bar.querySelector('.sp-back-btn')) return;
  var btn = document.createElement('button');
  btn.className = 'sp-btn sp-back-btn';
  btn.textContent = '← Files';
  btn.onclick = function() { switchSPTab('files'); };
  bar.insertBefore(btn, bar.firstChild);
}

function openFileInEditor(filePath) {
  if (_spDirty && !confirm('Unsaved changes will be lost. Continue?')) return;
  // Clean up PDF iframe if present
  var oldPdf = document.getElementById('sp-pdf-viewer');
  if (oldPdf) oldPdf.remove();
  _pdfDoc = null;
  document.getElementById('sp-editor').classList.remove('pdf-mode');
  apiGet('/api/file?path=' + encodeURIComponent(filePath))
    .then(function(data) {
      _spCurrentFile = data.path;
      _spDirty = false;
      document.getElementById('sp-editor-name').textContent = data.path.split('/').pop();
      document.getElementById('sp-editor-name').title = data.path;
      document.getElementById('sp-editor-area').value = data.content;
      document.getElementById('sp-editor-preview').style.display = 'none';
      showEditorBackBtn();
      switchSPTab('editor');
      // Auto-preview for markdown files
      if (/\.md$/i.test(filePath)) {
        destroyCodeMirror();
        document.getElementById('sp-editor-area').style.display = 'block';
        setPreviewMode(true);
      } else if (typeof CodeMirror !== 'undefined') {
        // Use CodeMirror for code/tex files
        var ext = filePath.split('.').pop().toLowerCase();
        var mode = _cmModes[ext] || 'text';
        setPreviewMode(false);
        initCodeMirror(mode);
      } else {
        document.getElementById('sp-editor-area').style.display = 'block';
        setPreviewMode(false);
      }
    })
    .catch(function() { alert('Cannot open file'); });
}

function saveCurrentFile() {
  if (!_spCurrentFile) return;
  var content = document.getElementById('sp-editor-area').value;
  apiPost('/api/file', { path: _spCurrentFile, content: content })
    .then(function(r) { return r.json(); })
    .then(function(d) {
      if (d.ok) {
        _spDirty = false;
        document.getElementById('sp-editor-name').style.color = '#3fb950';
        setTimeout(function() { document.getElementById('sp-editor-name').style.color = ''; }, 1500);
      } else {
        alert('Save failed: ' + (d.error || 'unknown'));
      }
    });
}

function setPreviewMode(on) {
  _spPreviewMode = on;
  if (_cmEditor) {
    _cmEditor.getWrapperElement().style.display = on ? 'none' : '';
  } else {
    document.getElementById('sp-editor-area').style.display = on ? 'none' : 'block';
  }
  document.getElementById('sp-editor-preview').style.display = on ? 'block' : 'none';
  document.getElementById('sp-preview-btn').classList.toggle('active', on);
  if (on) {
    renderMarkdownPreview(document.getElementById('sp-editor-area').value);
  }
  if (!on && _cmEditor) setTimeout(function() { _cmEditor.refresh(); }, 50);
}

// ── LaTeX Table Parser ──

function parseLatexTables(text) {
  // Replace \begin{table}...\end{table} or \begin{tabular}...\end{tabular}
  return text.replace(/\\begin\{table\}[\s\S]*?\\end\{table\}/g, function(block) {
    return convertLatexTable(block);
  }).replace(/\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/g, function(_, body) {
    return buildTableHtml(body);
  });
}

function convertLatexTable(block) {
  // Extract caption
  var caption = '';
  var capMatch = block.match(/\\caption\{([\s\S]*?)\}(?:\\label\{[^}]*\})?/);
  if (capMatch) caption = cleanLatex(capMatch[1]);

  // Extract tabular body
  var tabMatch = block.match(/\\begin\{tabular\}\{[^}]*\}([\s\S]*?)\\end\{tabular\}/);
  if (!tabMatch) return block;

  var html = buildTableHtml(tabMatch[1]);
  if (caption) html = '<div class="latex-caption">' + caption + '</div>' + html;
  return html;
}

function buildTableHtml(body) {
  var rows = body.split('\\\\').map(function(r) { return r.trim(); }).filter(Boolean);
  var html = '<table class="latex-table">';
  var inHeader = true;

  rows.forEach(function(row) {
    // Skip rule commands
    if (/^\\(toprule|midrule|bottomrule|hline|cline)/.test(row)) {
      if (/^\\midrule/.test(row) || /^\\bottomrule/.test(row)) inHeader = false;
      // Check if there's content after the rule on same line
      var after = row.replace(/^\\(toprule|midrule|bottomrule|hline|cline\{[^}]*\})\s*/, '').trim();
      if (!after) return;
      row = after;
    }

    var cells = row.split('&').map(function(c) { return cleanLatex(c.trim()); });
    var tag = inHeader ? 'th' : 'td';
    html += '<tr>';
    cells.forEach(function(c) {
      // Handle \multicolumn
      var multiMatch = c.match(/\\multicolumn\{(\d+)\}\{[^}]*\}\{([\s\S]*?)\}/);
      if (multiMatch) {
        html += '<' + tag + ' colspan="' + multiMatch[1] + '">' + cleanLatex(multiMatch[2]) + '</' + tag + '>';
      } else {
        html += '<' + tag + '>' + c + '</' + tag + '>';
      }
    });
    html += '</tr>';
  });

  html += '</table>';
  return html;
}

function cleanLatex(text) {
  // Render inline math
  text = text.replace(/\$([^$]+)\$/g, function(_, expr) {
    if (typeof katex !== 'undefined') {
      try { return katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false }); }
      catch (e) { return expr; }
    }
    return expr;
  });
  // Clean common LaTeX commands
  text = text.replace(/\\textbf\{([^}]*)\}/g, '<strong>$1</strong>');
  text = text.replace(/\\textit\{([^}]*)\}/g, '<em>$1</em>');
  text = text.replace(/\\text\{([^}]*)\}/g, '$1');
  text = text.replace(/\\emph\{([^}]*)\}/g, '<em>$1</em>');
  text = text.replace(/\{,\}/g, ',');  // {,} → comma (number formatting)
  text = text.replace(/\{([^}]*)\}/g, '$1');  // remove remaining braces
  text = text.replace(/~+/g, ' ');  // ~ → space
  text = text.replace(/\\,/g, ' ');
  text = text.replace(/\\\s/g, ' ');
  text = text.replace(/\\%/g, '%');
  text = text.replace(/\\&/g, '&amp;');
  text = text.replace(/\\#/g, '#');
  text = text.replace(/\\_/g, '_');
  return text.trim();
}

function renderMarkdownPreview(text) {
  var html;
  if (typeof marked !== 'undefined') {
    // Convert LaTeX tables first
    text = parseLatexTables(text);
    // Render math blocks before marked processes them
    // Block math: $$...$$
    text = text.replace(/\$\$([\s\S]+?)\$\$/g, function(_, expr) {
      try { return '<div class="math-block">' + katex.renderToString(expr.trim(), { displayMode: true, throwOnError: false }) + '</div>'; }
      catch (e) { return '<div class="math-block">' + expr + '</div>'; }
    });
    // Inline math: $...$
    text = text.replace(/\$([^\$\n]+?)\$/g, function(_, expr) {
      try { return katex.renderToString(expr.trim(), { displayMode: false, throwOnError: false }); }
      catch (e) { return '<code>' + expr + '</code>'; }
    });
    html = marked.parse(text);
  } else {
    html = markdownToHtml(text);
  }
  document.getElementById('sp-editor-preview').innerHTML = html;
}

// ── Minimal Markdown → HTML ──

function markdownToHtml(md) {
  var lines = md.split('\n');
  var html = '';
  var inCode = false;
  var inList = false;
  var listType = '';

  for (var i = 0; i < lines.length; i++) {
    var line = lines[i];

    // Code blocks
    if (line.trim().startsWith('```')) {
      if (inCode) { html += '</code></pre>'; inCode = false; }
      else { html += '<pre><code>'; inCode = true; }
      continue;
    }
    if (inCode) { html += escLine(line) + '\n'; continue; }

    // Close list if non-list line
    if (inList && !/^(\s*[-*+]|\s*\d+\.)/.test(line) && line.trim() !== '') {
      html += '</' + listType + '>'; inList = false;
    }

    // Headings
    if (/^#{1,6}\s/.test(line)) {
      var lvl = line.match(/^(#+)/)[1].length;
      html += '<h' + lvl + '>' + inline(line.replace(/^#+\s*/, '')) + '</h' + lvl + '>';
      continue;
    }
    // HR
    if (/^(---|\*\*\*|___)\s*$/.test(line.trim())) { html += '<hr>'; continue; }
    // Blockquote
    if (/^>\s?/.test(line)) {
      html += '<blockquote>' + inline(line.replace(/^>\s?/, '')) + '</blockquote>';
      continue;
    }
    // Unordered list
    if (/^\s*[-*+]\s/.test(line)) {
      if (!inList || listType !== 'ul') {
        if (inList) html += '</' + listType + '>';
        html += '<ul>'; inList = true; listType = 'ul';
      }
      html += '<li>' + inline(line.replace(/^\s*[-*+]\s/, '')) + '</li>';
      continue;
    }
    // Ordered list
    if (/^\s*\d+\.\s/.test(line)) {
      if (!inList || listType !== 'ol') {
        if (inList) html += '</' + listType + '>';
        html += '<ol>'; inList = true; listType = 'ol';
      }
      html += '<li>' + inline(line.replace(/^\s*\d+\.\s/, '')) + '</li>';
      continue;
    }
    // Table — detect header + separator pair
    if (/\|/.test(line) && i + 1 < lines.length && /^[\s|:\-]+$/.test(lines[i + 1].trim()) && /\|/.test(lines[i + 1])) {
      var tableLines = [line, lines[++i]];
      while (i + 1 < lines.length && /\|/.test(lines[i + 1]) && lines[i + 1].trim() !== '') { tableLines.push(lines[++i]); }
      html += renderTable(tableLines);
      continue;
    }
    // Empty line
    if (line.trim() === '') { html += ''; continue; }
    // Paragraph
    html += '<p>' + inline(line) + '</p>';
  }
  if (inList) html += '</' + listType + '>';
  if (inCode) html += '</code></pre>';
  return html;
}

function escLine(s) {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function inline(s) {
  s = escLine(s);
  s = s.replace(/`([^`]+)`/g, '<code>$1</code>');
  s = s.replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
  s = s.replace(/__(.+?)__/g, '<strong>$1</strong>');
  s = s.replace(/\*(.+?)\*/g, '<em>$1</em>');
  s = s.replace(/_(.+?)_/g, '<em>$1</em>');
  s = s.replace(/~~(.+?)~~/g, '<del>$1</del>');
  s = s.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" target="_blank">$1</a>');
  return s;
}

function splitTableCells(line) {
  // Handle both |col|col| and col|col formats
  var trimmed = line.trim();
  if (trimmed.startsWith('|')) trimmed = trimmed.slice(1);
  if (trimmed.endsWith('|')) trimmed = trimmed.slice(0, -1);
  return trimmed.split('|').map(function(c) { return c.trim(); });
}

function renderTable(lines) {
  if (lines.length < 2) return '';
  var headerCells = splitTableCells(lines[0]);
  // Parse alignment from separator row
  var sepCells = splitTableCells(lines[1]);
  var aligns = sepCells.map(function(c) {
    if (c.startsWith(':') && c.endsWith(':')) return 'center';
    if (c.endsWith(':')) return 'right';
    return 'left';
  });

  var html = '<table><thead><tr>';
  headerCells.forEach(function(c, j) {
    var align = aligns[j] || 'left';
    html += '<th style="text-align:' + align + '">' + inline(c) + '</th>';
  });
  html += '</tr></thead><tbody>';

  for (var r = 2; r < lines.length; r++) {
    var cells = splitTableCells(lines[r]);
    html += '<tr>';
    cells.forEach(function(c, j) {
      var align = aligns[j] || 'left';
      html += '<td style="text-align:' + align + '">' + inline(c) + '</td>';
    });
    html += '</tr>';
  }
  html += '</tbody></table>';
  return html;
}

// ── History Tab ──

function recordInput(id, text) {
  if (!_inputHistory[id]) _inputHistory[id] = [];
  _inputHistory[id].push({ text: text, ts: Date.now() });
  if (_inputHistory[id].length > 200) _inputHistory[id].shift();
}

function renderHistory(id) {
  var list = document.getElementById('sp-history-list');
  if (!list) return;
  var items = _inputHistory[id] || [];
  list.innerHTML = '';
  if (!items.length) {
    list.innerHTML = '<div style="padding:10px;color:#484f58;font-size:12px">No commands yet</div>';
    return;
  }
  // Reverse — newest first
  for (var i = items.length - 1; i >= 0; i--) {
    var item = items[i];
    var el = document.createElement('div');
    el.className = 'sp-hist-item';
    var d = new Date(item.ts);
    var time = String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
    el.innerHTML = '<span class="sp-hist-time">' + time + '</span><span class="sp-hist-text">' + escLine(item.text) + '</span>';
    (function(txt) {
      el.onclick = function() {
        var inp = document.querySelector('#inp-' + activeTab);
        if (inp) { inp.value = txt; inp.focus(); }
      };
    })(item.text);
    list.appendChild(el);
  }
}

// ── Side Panel File Upload ──

function uploadToSPDir(file) {
  if (!activeTab) return;
  var name = file.name || ('paste-' + Date.now() + '.png');
  var dir = _spBrowsePath || '/tmp';
  var dest = dir + '/' + name;

  var list = document.getElementById('sp-files-list');
  var bar = document.createElement('div');
  bar.className = 'upload-progress';
  bar.innerHTML = '<div class="upload-progress-bar" style="width:0%"></div>';
  list.insertBefore(bar, list.firstChild);

  var xhr = new XMLHttpRequest();
  xhr.open('POST', '/api/upload?id=' + encodeURIComponent(activeTab) + '&name=' + encodeURIComponent(name) + '&dir=' + encodeURIComponent(dir));
  xhr.withCredentials = true;

  xhr.upload.onprogress = function(e) {
    if (e.lengthComputable) {
      bar.querySelector('.upload-progress-bar').style.width = Math.round(e.loaded / e.total * 100) + '%';
    }
  };

  xhr.onload = function() {
    bar.remove();
    loadSPFiles(_spBrowsePath); // refresh file list
  };

  xhr.onerror = function() {
    bar.remove();
    alert('Upload failed');
  };

  xhr.send(file);
}

(function() {
  var filesContent = document.getElementById('sp-files');
  if (!filesContent) return;
  var _dc = 0;

  filesContent.addEventListener('dragenter', function(e) {
    e.preventDefault();
    _dc++;
    filesContent.classList.add('sp-drop-active');
  });

  filesContent.addEventListener('dragleave', function() {
    _dc--;
    if (_dc <= 0) { _dc = 0; filesContent.classList.remove('sp-drop-active'); }
  });

  filesContent.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.stopPropagation();
    e.dataTransfer.dropEffect = 'copy';
  });

  filesContent.addEventListener('drop', function(e) {
    e.preventDefault();
    e.stopPropagation();
    _dc = 0;
    filesContent.classList.remove('sp-drop-active');
    var files = e.dataTransfer ? e.dataTransfer.files : [];
    for (var i = 0; i < files.length; i++) {
      uploadToSPDir(files[i]);
    }
  });
})();

// ── Init ──

document.querySelectorAll('.sp-tab').forEach(function(btn) {
  btn.addEventListener('click', function() { switchSPTab(btn.dataset.sp); });
});

document.querySelector('.sp-close').addEventListener('click', toggleSidePanel);
document.getElementById('sp-files-refresh').addEventListener('click', function() { loadSPFiles(_spBrowsePath); });

document.getElementById('sp-save-btn').addEventListener('click', saveCurrentFile);
document.getElementById('sp-refresh-btn').addEventListener('click', function() {
  if (_spCurrentFile) openFileInEditor(_spCurrentFile);
});

document.getElementById('sp-preview-btn').addEventListener('click', function() {
  setPreviewMode(!_spPreviewMode);
});

document.getElementById('sp-editor-area').addEventListener('input', function() {
  _spDirty = true;
  if (_spPreviewMode) renderMarkdownPreview(this.value);
});

// ── Editor Key Handling ──
document.getElementById('sp-editor-area').addEventListener('keydown', function(e) {
  var ta = this;
  var start = ta.selectionStart;
  var end = ta.selectionEnd;
  var val = ta.value;

  // Tab → insert 2 spaces (or indent selection)
  if (e.key === 'Tab' && !e.ctrlKey && !e.metaKey) {
    e.preventDefault();
    if (start === end) {
      // No selection — insert spaces
      ta.value = val.slice(0, start) + '  ' + val.slice(end);
      ta.selectionStart = ta.selectionEnd = start + 2;
    } else {
      // Selection — indent/unindent lines
      var before = val.slice(0, start);
      var sel = val.slice(start, end);
      var after = val.slice(end);
      var lineStart = before.lastIndexOf('\n') + 1;
      var block = val.slice(lineStart, end);
      if (e.shiftKey) {
        // Unindent
        block = block.replace(/^  /gm, '');
      } else {
        block = block.replace(/^/gm, '  ');
      }
      ta.value = val.slice(0, lineStart) + block + after;
      ta.selectionStart = lineStart;
      ta.selectionEnd = lineStart + block.length;
    }
    _spDirty = true;
    return;
  }

  // Enter → auto-indent (match previous line's leading whitespace)
  if (e.key === 'Enter' && !e.shiftKey) {
    var lineStart = val.lastIndexOf('\n', start - 1) + 1;
    var currentLine = val.slice(lineStart, start);
    var indent = currentLine.match(/^(\s*)/)[1];

    // Extra indent after \begin{...}
    if (/\\begin\{[^}]*\}\s*$/.test(currentLine)) {
      indent += '  ';
    }

    e.preventDefault();
    ta.value = val.slice(0, start) + '\n' + indent + val.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 1 + indent.length;
    _spDirty = true;
    return;
  }

  // Auto-close brackets and braces
  var pairs = { '{': '}', '[': ']', '(': ')' };
  if (pairs[e.key] && start === end) {
    e.preventDefault();
    ta.value = val.slice(0, start) + e.key + pairs[e.key] + val.slice(end);
    ta.selectionStart = ta.selectionEnd = start + 1;
    _spDirty = true;
    return;
  }

  // Ctrl+S / Cmd+S → save
  if (e.key === 's' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    saveCurrentFile();
    return;
  }
});

// Right-click on empty area in file list
document.getElementById('sp-files-list').addEventListener('contextmenu', function(e) {
  if (e.target.closest('.sp-file')) return; // handled by file item
  e.preventDefault();
  showDirContextMenu(e.clientX, e.clientY, _spBrowsePath);
});

function showDirContextMenu(x, y, dir) {
  closeContextMenu();
  var menu = document.createElement('div');
  menu.id = 'sp-context-menu';
  menu.className = 'sp-context-menu';

  var items = [
    { label: 'New Folder', action: function() {
      var name = prompt('Folder name:');
      if (!name || !name.trim()) return;
      apiPost('/api/mkdir', { path: dir + '/' + name.trim() })
        .then(function(r) { return r.json(); })
        .then(function(d) { if (d.ok) loadSPFiles(dir); else alert(d.error || 'Failed'); });
    }},
    { label: 'New File', action: function() {
      var name = prompt('File name:');
      if (!name || !name.trim()) return;
      apiPost('/api/file', { path: dir + '/' + name.trim(), content: '' })
        .then(function(r) { return r.json(); })
        .then(function(d) { if (d.ok) loadSPFiles(dir); else alert(d.error || 'Failed'); });
    }},
    { label: 'Refresh', action: function() { loadSPFiles(dir); } }
  ];

  items.forEach(function(it) {
    var el = document.createElement('div');
    el.className = 'sp-ctx-item';
    el.textContent = it.label;
    el.onclick = function() { closeContextMenu(); it.action(); };
    menu.appendChild(el);
  });

  menu.style.left = x + 'px';
  menu.style.top = y + 'px';
  document.body.appendChild(menu);

  var rect = menu.getBoundingClientRect();
  if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
  if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';

  setTimeout(function() {
    document.addEventListener('click', closeContextMenu, { once: true });
  }, 0);
}
