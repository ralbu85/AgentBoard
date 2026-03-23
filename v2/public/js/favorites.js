// ── Folder Browser & Bookmarks (Spawn Panel) ──

(function(AB) {

  var bookmarks = JSON.parse(localStorage.getItem('bookmarks') || '[]');
  var recents = JSON.parse(localStorage.getItem('recent') || '[]');
  var _browsePath = '/';

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
    var parts = dir.split('/').filter(Boolean);
    var crumb = document.createElement('span');
    crumb.textContent = '/';
    crumb.className = 'crumb';
    crumb.onclick = function() { browseTo('/'); };
    pathEl.appendChild(crumb);
    var acc = '';
    parts.forEach(function(part) {
      acc += '/' + part;
      pathEl.appendChild(document.createTextNode(' / '));
      var c = document.createElement('span');
      c.textContent = part;
      c.className = 'crumb';
      var target = acc;
      c.onclick = function() { browseTo(target); };
      pathEl.appendChild(c);
    });
    AB.api.get('/api/browse?path=' + encodeURIComponent(dir))
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
        var newDir = document.createElement('div');
        newDir.className = 'browse-item';
        newDir.style.color = '#a78bfa';
        newDir.innerHTML = '<span class="browse-item-icon">+</span><span>New Folder</span>';
        newDir.onclick = function() {
          var name = prompt('Folder name:');
          if (!name || !name.trim()) return;
          var full = (dir === '/' ? '' : dir) + '/' + name.trim();
          AB.api.post('/api/mkdir', { path: full }).then(function(r) { return r.json(); }).then(function(d) {
            if (d.ok) browseTo(dir); else alert(d.error || 'Failed');
          });
        };
        list.appendChild(newDir);
        if (data.dirs && data.dirs.length > 0) {
          data.dirs.forEach(function(name) {
            var full = (dir === '/' ? '' : dir) + '/' + name;
            var item = document.createElement('div');
            item.className = 'browse-item';
            item.innerHTML = '<span class="browse-item-icon">&#128193;</span><span>' + name + '</span>';
            item.onclick = function() { browseTo(full); };
            list.appendChild(item);
          });
        }
      })
      .catch(function() {
        document.getElementById('browse-list').innerHTML = '<div style="padding:10px;color:#f85149;font-size:12px">Cannot read directory</div>';
      });
  }

  function renderBookmarks() {
    var list = document.getElementById('bookmark-list');
    if (!list) return;
    list.innerHTML = '';
    bookmarks.forEach(function(p) {
      var chip = document.createElement('span');
      chip.className = 'bookmark-chip';
      chip.textContent = p.replace(/\/$/, '').split('/').pop() || p;
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
    recents.forEach(function(p) {
      if (bookmarks.includes(p)) return;
      var chip = document.createElement('span');
      chip.className = 'bookmark-chip recent';
      chip.textContent = p.replace(/\/$/, '').split('/').pop() || p;
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

  function spawnFromBrowser() {
    var cwd = _browsePath || '/root';
    var btn = document.querySelector('.spawn-create-btn');
    if (btn) { btn.textContent = 'Creating...'; btn.disabled = true; }
    AB.api.post('/api/spawn', { cwd: cwd })
      .then(function(r) { return r.json(); })
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

  AB.favorites = { toggleSpawnPanel: toggleSpawnPanel, addBookmark: addBookmark, spawnFromBrowser: spawnFromBrowser };

})(window.AB = window.AB || {});
