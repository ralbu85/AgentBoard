// ── Folder Browser & Bookmarks ──

var bookmarks = JSON.parse(localStorage.getItem('bookmarks') || '[]');
var recents = JSON.parse(localStorage.getItem('recent') || '[]');
var _browsePath = '/';

function displayPath(p) {
  var base = window._basePath || '';
  return (base && p.startsWith(base)) ? p.slice(base.length) : p;
}

function _fetch(url, opts) {
  return fetch(url, Object.assign({ credentials: 'include' }, opts || {}));
}

function _get(url) {
  return _fetch(url).then(function(r) { return r.json(); });
}

function _post(url, body) {
  return _fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function(r) { return r.json(); });
}

// ── Panel ──

function toggleSpawnPanel() {
  var panel = document.getElementById('spawn-panel');
  if (panel.style.display === 'none') {
    panel.style.display = '';
    browseTo('/');
    renderBookmarks();
  } else {
    panel.style.display = 'none';
  }
}

function browseTo(dir) {
  _browsePath = dir;
  var pathEl = document.getElementById('browse-path');
  pathEl.textContent = '';

  // Build clickable breadcrumbs: / > root > TermHub
  var parts = dir.split('/').filter(Boolean);
  var crumb = document.createElement('span');
  crumb.textContent = '/';
  crumb.className = 'crumb';
  crumb.onclick = function() { browseTo('/'); };
  pathEl.appendChild(crumb);

  var acc = '';
  parts.forEach(function(part) {
    acc += '/' + part;
    var sep = document.createTextNode(' / ');
    pathEl.appendChild(sep);
    var c = document.createElement('span');
    c.textContent = part;
    c.className = 'crumb';
    var target = acc;
    c.onclick = function() { browseTo(target); };
    pathEl.appendChild(c);
  });

  _get('/api/browse?path=' + encodeURIComponent(dir))
    .then(function(data) {
      var list = document.getElementById('browse-list');
      list.innerHTML = '';

      if (dir !== '/') {
        var parent = dir.replace(/\/[^/]+\/?$/, '') || '/';
        var up = document.createElement('div');
        up.className = 'browse-item parent';
        up.innerHTML = '<span class="browse-item-icon">..</span><span>parent</span>';
        up.onclick = function() { browseTo(parent); };
        list.appendChild(up);
      }

      if (data.dirs && data.dirs.length > 0) {
        data.dirs.forEach(function(name) {
          var full = (dir === '/' ? '' : dir) + '/' + name;
          var item = document.createElement('div');
          item.className = 'browse-item';
          item.innerHTML = '<span class="browse-item-icon">&#128193;</span><span>' + name + '</span>';
          item.onclick = function() { browseTo(full); };
          list.appendChild(item);
        });
      } else {
        list.innerHTML = '<div style="padding:10px;color:#8b949e;font-size:12px">Empty</div>';
      }
    })
    .catch(function() {
      document.getElementById('browse-list').innerHTML =
        '<div style="padding:10px;color:#f85149;font-size:12px">Cannot read directory</div>';
    });
}

// ── Bookmarks ──

function renderBookmarks() {
  var list = document.getElementById('bookmark-list');
  if (!list) return;
  list.innerHTML = '';

  bookmarks.forEach(function(p) {
    var chip = document.createElement('span');
    chip.className = 'bookmark-chip';
    var label = p.replace(/\/$/, '').split('/').pop() || p;
    chip.textContent = label;
    chip.title = p;
    chip.onclick = function() { browseTo(p); };

    var del = document.createElement('span');
    del.className = 'del';
    del.textContent = '\u00d7';
    del.onclick = function(e) {
      e.stopPropagation();
      bookmarks = bookmarks.filter(function(b) { return b !== p; });
      localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
      renderBookmarks();
    };
    chip.appendChild(del);
    list.appendChild(chip);
  });

  // Recent paths as subtle chips
  recents.forEach(function(p) {
    if (bookmarks.includes(p)) return;
    var chip = document.createElement('span');
    chip.className = 'bookmark-chip recent';
    var label = p.replace(/\/$/, '').split('/').pop() || p;
    chip.textContent = label;
    chip.title = p;
    chip.onclick = function() { browseTo(p); };
    list.appendChild(chip);
  });
}

function addBookmark() {
  if (!_browsePath || bookmarks.includes(_browsePath)) return;
  bookmarks.push(_browsePath);
  localStorage.setItem('bookmarks', JSON.stringify(bookmarks));
  renderBookmarks();
}

function addRecent(p) {
  recents = [p].concat(recents.filter(function(r) { return r !== p; })).slice(0, 10);
  localStorage.setItem('recent', JSON.stringify(recents));
}

// ── Spawn ──

function spawnFromBrowser() {
  var cwd = _browsePath || '/root';
  var btn = document.querySelector('.spawn-create-btn');
  if (btn) { btn.textContent = 'Creating...'; btn.disabled = true; }

  _post('/api/spawn', { cwd: cwd })
    .then(function(d) {
      if (btn) { btn.textContent = 'Open here'; btn.disabled = false; }
      if (d.ok === false) { alert(d.error || 'Failed'); return; }
      addRecent(cwd);
      document.getElementById('spawn-panel').style.display = 'none';
    })
    .catch(function() {
      if (btn) { btn.textContent = 'Open here'; btn.disabled = false; }
      alert('Failed to create session.');
    });
}
