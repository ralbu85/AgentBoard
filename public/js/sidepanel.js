// ── Side Panel: Files, Editor, History ──

var _spOpen = false;
var _spCurrentFile = null;
var _spDirty = false;
var _spPreviewMode = false;
var _inputHistory = {}; // id → [{text, ts}]

// ── Panel Toggle ──

function toggleSidePanel() {
  _spOpen = !_spOpen;
  var panel = document.getElementById('side-panel');
  panel.style.display = _spOpen ? 'flex' : 'none';
  if (_spOpen && activeTab) refreshSPFiles();
  setTimeout(sendResize, 100);
}

function switchSPTab(name) {
  document.querySelectorAll('.sp-tab').forEach(function(t) {
    t.classList.toggle('active', t.dataset.sp === name);
  });
  ['files', 'editor', 'history'].forEach(function(n) {
    var el = document.getElementById('sp-' + n);
    if (el) el.style.display = n === name ? 'flex' : 'none';
  });
  if (name === 'files' && activeTab) refreshSPFiles();
  if (name === 'history' && activeTab) renderHistory(activeTab);
}

// ── Files Tab ──

var _spBrowsePath = '/';

function refreshSPFiles() {
  var tab = document.querySelector('.tab[data-id="' + activeTab + '"]');
  if (tab && tab.dataset.cwd) {
    _spBrowsePath = tab.dataset.cwd;
  }
  loadSPFiles(_spBrowsePath);
}

function loadSPFiles(dir) {
  _spBrowsePath = dir;
  renderSPPath(dir);
  apiGet('/api/files?path=' + encodeURIComponent(dir))
    .then(function(data) {
      var list = document.getElementById('sp-files-list');
      list.innerHTML = '';

      // Parent dir
      if (dir !== '/') {
        var parent = dir.replace(/\/[^/]+\/?$/, '') || '/';
        var up = document.createElement('div');
        up.className = 'sp-file';
        up.innerHTML = '<span class="sp-file-icon">..</span><span class="sp-file-name" style="color:#8b949e">parent</span>';
        up.onclick = function() { loadSPFiles(parent); };
        list.appendChild(up);
      }

      data.entries.forEach(function(e) {
        var item = document.createElement('div');
        item.className = 'sp-file';
        var icon = e.type === 'dir' ? '📁' : getFileIcon(e.name);
        var size = e.type === 'file' ? formatFileSize(e.size) : '';
        item.innerHTML = '<span class="sp-file-icon">' + icon + '</span>' +
          '<span class="sp-file-name">' + e.name + '</span>' +
          '<span class="sp-file-size">' + size + '</span>';
        if (e.type === 'dir') {
          item.onclick = function() { loadSPFiles(dir + '/' + e.name); };
        } else {
          item.onclick = function() { openFileInEditor(dir + '/' + e.name); };
        }
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

function getFileIcon(name) {
  var ext = name.split('.').pop().toLowerCase();
  var icons = { md: '📝', js: '📜', py: '🐍', json: '📋', css: '🎨', html: '🌐', ts: '📜', txt: '📄' };
  return icons[ext] || '📄';
}

function formatFileSize(bytes) {
  if (bytes < 1024) return bytes + 'B';
  if (bytes < 1048576) return (bytes / 1024).toFixed(0) + 'K';
  return (bytes / 1048576).toFixed(1) + 'M';
}

// ── Editor Tab ──

function openFileInEditor(filePath) {
  if (_spDirty && !confirm('Unsaved changes will be lost. Continue?')) return;
  apiGet('/api/file?path=' + encodeURIComponent(filePath))
    .then(function(data) {
      _spCurrentFile = data.path;
      _spDirty = false;
      document.getElementById('sp-editor-name').textContent = data.path.split('/').pop();
      document.getElementById('sp-editor-name').title = data.path;
      document.getElementById('sp-editor-area').value = data.content;
      setPreviewMode(false);
      switchSPTab('editor');
      // Auto-preview for markdown files
      if (/\.md$/i.test(filePath)) {
        renderMarkdownPreview(data.content);
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
  document.getElementById('sp-editor-area').style.display = on ? 'none' : 'block';
  document.getElementById('sp-editor-preview').style.display = on ? 'block' : 'none';
  document.getElementById('sp-preview-btn').classList.toggle('active', on);
  if (on) {
    renderMarkdownPreview(document.getElementById('sp-editor-area').value);
  }
}

function renderMarkdownPreview(text) {
  var html = markdownToHtml(text);
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
    // Table
    if (/\|/.test(line) && line.trim().startsWith('|')) {
      // Collect table lines
      var tableLines = [line];
      while (i + 1 < lines.length && /\|/.test(lines[i + 1])) { tableLines.push(lines[++i]); }
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

function renderTable(lines) {
  if (lines.length < 2) return '';
  var html = '<table>';
  lines.forEach(function(line, idx) {
    if (idx === 1 && /^[\s|:-]+$/.test(line)) return; // separator
    var cells = line.split('|').filter(function(c, i, a) { return i > 0 && i < a.length - 1; });
    var tag = idx === 0 ? 'th' : 'td';
    html += '<tr>';
    cells.forEach(function(c) { html += '<' + tag + '>' + inline(c.trim()) + '</' + tag + '>'; });
    html += '</tr>';
  });
  html += '</table>';
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

// ── Init ──

document.querySelectorAll('.sp-tab').forEach(function(btn) {
  btn.addEventListener('click', function() { switchSPTab(btn.dataset.sp); });
});

document.querySelector('.sp-close').addEventListener('click', toggleSidePanel);

document.getElementById('sp-save-btn').addEventListener('click', saveCurrentFile);

document.getElementById('sp-preview-btn').addEventListener('click', function() {
  setPreviewMode(!_spPreviewMode);
});

document.getElementById('sp-editor-area').addEventListener('input', function() {
  _spDirty = true;
  if (_spPreviewMode) renderMarkdownPreview(this.value);
});
