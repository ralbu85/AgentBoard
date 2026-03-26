// ── File Browser + Context Menu ──

(function(AB) {

  var _spBrowsePath = '/';
  var _spBrowsePaths = {};  // per-session last browsed path
  var _spRootPath = {};     // per-session session CWD

  var _editableExts = ['md', 'txt', 'js', 'ts', 'jsx', 'tsx', 'py', 'json', 'css', 'html', 'yml', 'yaml', 'toml', 'sh', 'bash', 'zsh', 'env', 'cfg', 'ini', 'xml', 'svg', 'sql', 'rs', 'go', 'java', 'c', 'cpp', 'h', 'hpp', 'rb', 'php', 'lua', 'r', 'csv', 'log', 'conf', 'dockerfile', 'makefile', 'tex', 'bib', 'sty', 'cls', 'bbl', 'aux'];

  function isPDF(name) { return name.toLowerCase().endsWith('.pdf'); }
  function isEditable(name) {
    var lower = name.toLowerCase();
    if (lower === 'makefile' || lower === 'dockerfile') return true;
    return _editableExts.indexOf(lower.split('.').pop()) !== -1;
  }
  function isImage(name) {
    return ['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].indexOf(name.split('.').pop().toLowerCase()) !== -1;
  }

  function getFileIcon(name) {
    var ext = name.split('.').pop().toLowerCase();
    var icons = { md: '\ud83d\udcdd', js: '\ud83d\udcdc', py: '\ud83d\udc0d', json: '\ud83d\udccb', css: '\ud83c\udfa8', html: '\ud83c\udf10', ts: '\ud83d\udcdc', txt: '\ud83d\udcc4', pdf: '\ud83d\udcd5', tex: '\ud83d\udcd0', bib: '\ud83d\udcda', png: '\ud83d\uddbc\ufe0f', jpg: '\ud83d\uddbc\ufe0f', jpeg: '\ud83d\uddbc\ufe0f', gif: '\ud83d\uddbc\ufe0f', svg: '\ud83d\uddbc\ufe0f' };
    return icons[ext] || '\ud83d\udcc4';
  }

  function formatSize(bytes) {
    if (bytes < 1024) return bytes + 'B';
    if (bytes < 1048576) return (bytes / 1024).toFixed(0) + 'K';
    return (bytes / 1048576).toFixed(1) + 'M';
  }

  var _currentBrowseSession = null;

  function refresh(sessionId) {
    _currentBrowseSession = sessionId;
    var s = AB.store.get(sessionId);
    if (!s) return;
    _spRootPath[sessionId] = s.cwd;
    _spBrowsePath = _spBrowsePaths[sessionId] || s.cwd;
    loadFiles(_spBrowsePath);
  }

  function loadFiles(dir) {
    var browseId = _currentBrowseSession || AB.store.activeId;
    var root = _spRootPath[browseId];
    if (root && !dir.startsWith(root) && dir !== '/') dir = root;
    _spBrowsePath = dir;
    if (browseId) _spBrowsePaths[browseId] = dir;
    renderPath(dir);

    AB.api.get('/api/files?path=' + encodeURIComponent(dir))
      .then(function(data) {
        var list = document.getElementById('sp-files-list');
        list.innerHTML = '';
        var root = _spRootPath[browseId] || '/';
        if (dir !== '/' && dir !== root) {
          var parent = dir.replace(/\/[^/]+\/?$/, '') || '/';
          if (parent.length < root.length) parent = root;
          var up = document.createElement('div');
          up.className = 'sp-file';
          up.innerHTML = '<span class="sp-file-icon">..</span><span class="sp-file-name" style="color:#8b949e">parent</span>';
          up.onclick = function() { loadFiles(parent); };
          list.appendChild(up);
        }
        data.entries.forEach(function(e) {
          var fullPath = dir + '/' + e.name;
          var item = document.createElement('div');
          item.className = 'sp-file';
          var icon = e.type === 'dir' ? '\ud83d\udcc1' : getFileIcon(e.name);
          var size = e.type === 'file' ? formatSize(e.size) : '';
          item.innerHTML = '<span class="sp-file-icon">' + icon + '</span><span class="sp-file-name">' + e.name + '</span><span class="sp-file-size">' + size + '</span>';
          if (e.type === 'dir') {
            item.onclick = function(ev) { ev.stopPropagation(); loadFiles(fullPath); };
          } else if (isPDF(e.name) || isEditable(e.name) || isImage(e.name)) {
            item.onclick = function() { AB.editor.openFileInPanel(fullPath, e.name); };
            // Draggable to viewer pane for split
            item.draggable = true;
            (function(fp, fn) {
              var ext = fn.split('.').pop().toLowerCase();
              var ft = 'code';
              if (ext === 'pdf') ft = 'pdf';
              else if (['png','jpg','jpeg','gif','svg','webp','bmp','ico'].indexOf(ext) !== -1) ft = 'image';
              else if (ext === 'md') ft = 'markdown';
              item.addEventListener('dragstart', function(ev) {
                ev.dataTransfer.setData('text/plain', 'file:' + fp + '|' + fn + '|' + ft);
                ev.dataTransfer.effectAllowed = 'move';
              });
            })(fullPath, e.name);
          } else {
            item.style.opacity = '0.4';
            item.style.cursor = 'default';
          }
          item.addEventListener('contextmenu', function(ev) {
            ev.preventDefault();
            showContextMenu(ev.clientX, ev.clientY, fullPath, e.type, e.name, dir);
          });
          list.appendChild(item);
        });
      })
      .catch(function() {
        document.getElementById('sp-files-list').innerHTML = '<div style="padding:10px;color:#f87171;font-size:12px">Cannot read directory</div>';
      });
  }

  function renderPath(dir) {
    var el = document.getElementById('sp-files-path');
    el.innerHTML = '';
    var parts = dir.split('/').filter(Boolean);
    var crumb = document.createElement('span');
    crumb.className = 'crumb';
    crumb.textContent = '/';
    crumb.onclick = function() { loadFiles('/'); };
    el.appendChild(crumb);
    var acc = '';
    parts.forEach(function(part) {
      acc += '/' + part;
      el.appendChild(document.createTextNode(' / '));
      var c = document.createElement('span');
      c.className = 'crumb';
      c.textContent = part;
      var target = acc;
      c.onclick = function() { loadFiles(target); };
      el.appendChild(c);
    });
  }

  // ── Context Menu ──

  function showContextMenu(x, y, filePath, type, name, parentDir) {
    closeContextMenu();
    var menu = document.createElement('div');
    menu.id = 'sp-context-menu';
    menu.className = 'sp-context-menu';
    var items = [];
    if (type === 'file') {
      if (isPDF(name) || isEditable(name) || isImage(name)) {
        items.push({ label: 'Open in Panel', action: function() { AB.editor.openFileInPanel(filePath, name); } });
      }
      items.push({ label: 'Download', action: function() {
        var a = document.createElement('a');
        a.href = '/api/file-raw?path=' + encodeURIComponent(filePath);
        a.download = name;
        a.click();
      }});
    } else {
      items.push({ label: 'Open', action: function() { loadFiles(filePath); } });
    }
    items.push({ label: 'Rename', action: function() {
      var newName = prompt('Rename to:', name);
      if (!newName || newName === name) return;
      AB.api.post('/api/rename', { from: filePath, to: parentDir + '/' + newName })
        .then(function(r) { return r.json(); })
        .then(function(d) { if (d.ok) loadFiles(parentDir); else alert(d.error || 'Failed'); });
    }});
    items.push({ label: 'Delete', cls: 'danger', action: function() {
      if (!confirm('Delete "' + name + '"?')) return;
      AB.api.post('/api/delete', { path: filePath })
        .then(function(r) { return r.json(); })
        .then(function(d) { if (d.ok) loadFiles(parentDir); else alert(d.error || 'Failed'); });
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
    var rect = menu.getBoundingClientRect();
    if (rect.right > window.innerWidth) menu.style.left = (x - rect.width) + 'px';
    if (rect.bottom > window.innerHeight) menu.style.top = (y - rect.height) + 'px';
    setTimeout(function() { document.addEventListener('click', closeContextMenu, { once: true }); }, 0);
  }

  function showDirContextMenu(x, y, dir) {
    closeContextMenu();
    var menu = document.createElement('div');
    menu.id = 'sp-context-menu';
    menu.className = 'sp-context-menu';
    var items = [
      { label: 'New Folder', action: function() {
        var name = prompt('Folder name:');
        if (!name || !name.trim()) return;
        AB.api.post('/api/mkdir', { path: dir + '/' + name.trim() })
          .then(function(r) { return r.json(); })
          .then(function(d) { if (d.ok) loadFiles(dir); else alert(d.error || 'Failed'); });
      }},
      { label: 'New File', action: function() {
        var name = prompt('File name:');
        if (!name || !name.trim()) return;
        AB.api.post('/api/file', { path: dir + '/' + name.trim(), content: '' })
          .then(function(r) { return r.json(); })
          .then(function(d) { if (d.ok) loadFiles(dir); else alert(d.error || 'Failed'); });
      }},
      { label: 'Refresh', action: function() { loadFiles(dir); } }
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
    setTimeout(function() { document.addEventListener('click', closeContextMenu, { once: true }); }, 0);
  }

  function closeContextMenu() {
    var old = document.getElementById('sp-context-menu');
    if (old) old.remove();
  }

  // ── File Upload (drag & drop) ──

  function uploadToDir(file) {
    var activeId = AB.store.activeId;
    if (!activeId) return;
    var name = file.name || ('paste-' + Date.now() + '.png');
    var dir = _spBrowsePath || '/tmp';
    var list = document.getElementById('sp-files-list');
    var bar = document.createElement('div');
    bar.className = 'upload-progress';
    bar.innerHTML = '<div class="upload-progress-bar" style="width:0%"></div>';
    list.insertBefore(bar, list.firstChild);
    var xhr = new XMLHttpRequest();
    xhr.open('POST', '/api/upload?id=' + encodeURIComponent(activeId) + '&name=' + encodeURIComponent(name) + '&dir=' + encodeURIComponent(dir));
    xhr.withCredentials = true;
    xhr.upload.onprogress = function(e) {
      if (e.lengthComputable) bar.querySelector('.upload-progress-bar').style.width = Math.round(e.loaded / e.total * 100) + '%';
    };
    xhr.onload = function() { bar.remove(); loadFiles(_spBrowsePath); };
    xhr.onerror = function() { bar.remove(); alert('Upload failed'); };
    xhr.send(file);
  }

  function init() {
    var filesContent = document.getElementById('sidebar-files');
    if (!filesContent) return;
    var _dc = 0;
    filesContent.addEventListener('dragenter', function(e) { e.preventDefault(); _dc++; filesContent.classList.add('sp-drop-active'); });
    filesContent.addEventListener('dragleave', function() { _dc--; if (_dc <= 0) { _dc = 0; filesContent.classList.remove('sp-drop-active'); } });
    filesContent.addEventListener('dragover', function(e) { e.preventDefault(); e.stopPropagation(); e.dataTransfer.dropEffect = 'copy'; });
    filesContent.addEventListener('drop', function(e) {
      e.preventDefault(); e.stopPropagation(); _dc = 0; filesContent.classList.remove('sp-drop-active');
      var files = e.dataTransfer ? e.dataTransfer.files : [];
      for (var i = 0; i < files.length; i++) uploadToDir(files[i]);
    });

    document.getElementById('sp-files-refresh').addEventListener('click', function() { loadFiles(_spBrowsePath); });
    document.getElementById('sp-files-list').addEventListener('contextmenu', function(e) {
      if (e.target.closest('.sp-file')) return;
      e.preventDefault();
      showDirContextMenu(e.clientX, e.clientY, _spBrowsePath);
    });
  }

  AB.files = { init: init, refresh: refresh, loadFiles: loadFiles, getCurrentPath: function() { return _spBrowsePath; } };

})(window.AB = window.AB || {});
