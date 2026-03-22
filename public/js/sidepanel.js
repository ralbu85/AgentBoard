// ── Sidebar Explorer: File Browser ──

var _inputHistory = {}; // id -> [{text, ts}]

// ── Files Browser ──

var _spBrowsePath = '/';
var _spBrowseInitialized = {}; // per-tab: true if already browsing
var _spBrowsePaths = {};       // per-tab: remember last browsed path
var _spRootPath = {};          // per-tab: session CWD (locked root)

function refreshSPFiles() {
  var tab = document.querySelector('.session-item[data-id="' + activeTab + '"]');
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
        var icon = e.type === 'dir' ? '\ud83d\udcc1' : getFileIcon(e.name);
        var size = e.type === 'file' ? formatFileSize(e.size) : '';
        item.innerHTML = '<span class="sp-file-icon">' + icon + '</span>' +
          '<span class="sp-file-name">' + e.name + '</span>' +
          '<span class="sp-file-size">' + size + '</span>';
        if (e.type === 'dir') {
          item.onclick = function() { loadSPFiles(fullPath); };
        } else if (isPDF(e.name) || isEditableFile(e.name) || isImageFile(e.name)) {
          item.onclick = function() {
            if (typeof openFileInPanel === 'function') {
              openFileInPanel(fullPath, e.name);
            }
          };
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

function isEditableFile(name) {
  var lower = name.toLowerCase();
  if (lower === 'makefile' || lower === 'dockerfile') return true;
  var ext = lower.split('.').pop();
  return _editableExts.indexOf(ext) !== -1;
}

function isImageFile(name) {
  var ext = name.split('.').pop().toLowerCase();
  return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].indexOf(ext) !== -1;
}

function getFileIcon(name) {
  var ext = name.split('.').pop().toLowerCase();
  var icons = { md: '\ud83d\udcdd', js: '\ud83d\udcdc', py: '\ud83d\udc0d', json: '\ud83d\udccb', css: '\ud83c\udfa8', html: '\ud83c\udf10', ts: '\ud83d\udcdc', txt: '\ud83d\udcc4', pdf: '\ud83d\udcd5', tex: '\ud83d\udcd0', bib: '\ud83d\udcda', sty: '\u2699\ufe0f', png: '\ud83d\uddbc\ufe0f', jpg: '\ud83d\uddbc\ufe0f', jpeg: '\ud83d\uddbc\ufe0f', gif: '\ud83d\uddbc\ufe0f', svg: '\ud83d\uddbc\ufe0f', webp: '\ud83d\uddbc\ufe0f' };
  return icons[ext] || '\ud83d\udcc4';
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
    if (isPDF(name) || isEditableFile(name) || isImageFile(name)) {
      items.push({ label: 'Open in Panel', action: function() {
        if (typeof openFileInPanel === 'function') openFileInPanel(filePath, name);
      }});
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

// ── History (kept for input recording) ──

function recordInput(id, text) {
  if (!_inputHistory[id]) _inputHistory[id] = [];
  _inputHistory[id].push({ text: text, ts: Date.now() });
  if (_inputHistory[id].length > 200) _inputHistory[id].shift();
}

// ── File Upload (drag & drop into explorer) ──

function uploadToSPDir(file) {
  if (!activeTab) return;
  var name = file.name || ('paste-' + Date.now() + '.png');
  var dir = _spBrowsePath || '/tmp';

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
    loadSPFiles(_spBrowsePath);
  };

  xhr.onerror = function() {
    bar.remove();
    alert('Upload failed');
  };

  xhr.send(file);
}

// Drag & drop on sidebar file list
(function() {
  var filesContent = document.getElementById('sidebar-files');
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

document.getElementById('sp-files-refresh').addEventListener('click', function() { loadSPFiles(_spBrowsePath); });

// Right-click on empty area in file list
document.getElementById('sp-files-list').addEventListener('contextmenu', function(e) {
  if (e.target.closest('.sp-file')) return;
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
