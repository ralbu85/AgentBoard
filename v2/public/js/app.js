// ── App Entry Point: Login, Init, Keyboard Shortcuts, Input Handling ──

(function(AB) {

  AB._customTitles = {};
  AB._basePath = '';

  AB.displayPath = function(p) {
    var base = AB._basePath || '';
    return (base && p.startsWith(base)) ? p.slice(base.length) : p;
  };

  AB.getTitle = function(id, cwd, cmd) {
    var custom = AB._customTitles[id];
    if (custom) return '#' + id + ' ' + custom;
    var c = cmd || 'claude';
    var folder = (cwd || '').replace(/\/$/, '').split('/').pop() || cwd || '';
    return '#' + id + ' ' + c + ' \u00b7 ' + folder;
  };

  // ── Input Row Management ──

  var _inputCards = {}; // id → card element

  function createInputCard(id) {
    var s = AB.store.get(id);
    var isStopped = s && (s.status === 'stopped' || s.status === 'completed');

    var card = document.createElement('div');
    card.className = 'input-card';
    card.id = 'input-card-' + id;
    card.style.display = 'none';

    // Card header
    var header = document.createElement('div');
    header.className = 'card-header';
    header.innerHTML =
      '<span class="card-title" id="card-title-' + id + '">' + AB.getTitle(id, s ? s.cwd : '', s ? s.cmd : '') + '</span>' +
      '<span class="badge" id="badge-' + id + '">' + (s ? s.status : 'running') + '</span>' +
      '<button class="kill-btn" id="kill-' + id + '">' + (isStopped ? 'Remove' : 'Stop') + '</button>';

    // Search row
    var searchRow = document.createElement('div');
    searchRow.className = 'search-row';
    searchRow.style.display = 'none';
    searchRow.innerHTML = '<input class="search-inp" placeholder="Search..." /><button class="search-close">&times;</button>';

    // Card CWD
    var cwdDiv = document.createElement('div');
    cwdDiv.className = 'card-cwd';
    cwdDiv.innerHTML = AB.displayPath(s ? s.cwd : '') + '<span class="card-info"></span>';

    // Input row
    var inputRow = document.createElement('div');
    inputRow.className = 'input-row';
    inputRow.id = 'input-row-' + id;
    if (isStopped) inputRow.style.display = 'none';
    inputRow.innerHTML =
      '<textarea id="inp-' + id + '" placeholder="Enter command..." rows="1"></textarea>' +
      '<div class="quick-keys">' +
        '<button class="qk-btn" data-key="Escape">Esc</button>' +
        '<button class="qk-btn" data-key="Up">\u2191</button>' +
        '<button class="qk-btn" data-key="Down">\u2193</button>' +
        '<button class="qk-btn" data-key="Enter">\u21b5</button>' +
        '<button class="qk-btn" data-key="Tab">Tab</button>' +
        '<button class="qk-btn" data-key="C-c">\u2303C</button>' +
      '</div>' +
      '<button class="send-btn" id="send-' + id + '">Send</button>';

    card.appendChild(header);
    card.appendChild(cwdDiv);
    card.appendChild(searchRow);
    card.appendChild(inputRow);

    // Bind events
    bindInputCard(id, card);

    _inputCards[id] = card;
    return card;
  }

  function bindInputCard(id, card) {
    var killBtn = card.querySelector('#kill-' + id);
    var sendBtn = card.querySelector('#send-' + id);
    var inp = card.querySelector('#inp-' + id);

    if (killBtn) {
      killBtn.addEventListener('click', function() {
        var s = AB.store.get(id);
        if (s && (s.status === 'stopped' || s.status === 'completed')) {
          AB.api.post('/api/remove', { id: id });
          AB.store.remove(id);
          AB.terminal.destroy(id);
          if (_inputCards[id]) { _inputCards[id].remove(); delete _inputCards[id]; }
        } else {
          if (!confirm('Stop Session #' + id + '?')) return;
          AB.api.post('/api/kill', { id: id });
        }
      });
    }

    if (sendBtn) sendBtn.addEventListener('click', function() { doSendInput(id); });

    if (inp) {
      inp.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
          e.preventDefault();
          if (inp.value.trim()) doSendInput(id); else sendKey(id, 'Enter');
        }
        if (e.key === 'Enter' && e.ctrlKey) { e.preventDefault(); sendKey(id, 'Enter'); }
        if (e.key === 'Escape') { e.preventDefault(); sendKey(id, 'Escape'); }
        if (e.key === '[' && e.ctrlKey) { e.preventDefault(); sendKey(id, 'Escape'); }
        if (e.key === 'ArrowUp' && e.ctrlKey) { e.preventDefault(); sendKey(id, 'Up'); }
        if (e.key === 'ArrowDown' && e.ctrlKey) { e.preventDefault(); sendKey(id, 'Down'); }
      });
      inp.addEventListener('input', function() {
        if (!inp._raf) {
          inp._raf = requestAnimationFrame(function() {
            inp.style.height = 'auto';
            inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
            inp._raf = null;
          });
        }
      });
    }

    // Quick key buttons
    card.querySelectorAll('.qk-btn').forEach(function(btn) {
      btn.addEventListener('click', function() { sendKey(id, btn.dataset.key); });
    });

    // Search
    var searchInp = card.querySelector('.search-inp');
    var searchClose = card.querySelector('.search-close');
    if (searchInp) {
      searchInp.addEventListener('input', function() {
        AB.terminal.search(id, searchInp.value.trim());
      });
      searchInp.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') { toggleSearch(id); e.stopPropagation(); }
        if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); AB.terminal.searchNext(id, searchInp.value.trim()); }
        if (e.key === 'Enter' && e.shiftKey) { e.preventDefault(); AB.terminal.searchPrev(id, searchInp.value.trim()); }
      });
    }
    if (searchClose) searchClose.addEventListener('click', function() { toggleSearch(id); });

    // File paste on textarea
    if (inp) {
      inp.addEventListener('paste', function(e) { handlePaste(id, e); });
    }

    // File drag & drop on card
    var _dragCount = 0;
    card.addEventListener('dragenter', function(e) {
      e.preventDefault(); _dragCount++;
      card.classList.add('file-drop-active');
    });
    card.addEventListener('dragleave', function() {
      _dragCount--;
      if (_dragCount <= 0) { _dragCount = 0; card.classList.remove('file-drop-active'); }
    });
    card.addEventListener('dragover', function(e) {
      e.preventDefault(); e.stopPropagation();
      e.dataTransfer.dropEffect = 'copy';
    });
    card.addEventListener('drop', function(e) {
      e.preventDefault(); e.stopPropagation();
      _dragCount = 0;
      card.classList.remove('file-drop-active');
      var files = e.dataTransfer ? e.dataTransfer.files : [];
      for (var i = 0; i < files.length; i++) uploadFile(id, files[i]);
    });
  }

  // ── File Upload ──

  function uploadFile(id, file) {
    var name = file.name || ('paste-' + Date.now() + '.png');
    var card = _inputCards[id];

    return new Promise(function(resolve) {
      var xhr = new XMLHttpRequest();
      xhr.open('POST', '/api/upload?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name));
      xhr.withCredentials = true;

      // Progress bar
      var progressEl = null;
      if (card) {
        var bar = document.createElement('div');
        bar.className = 'upload-progress';
        bar.innerHTML = '<div class="upload-progress-bar" style="width:0%"></div><span class="upload-label">' + name + '</span>';
        var inputRow = card.querySelector('.input-row');
        if (inputRow) card.insertBefore(bar, inputRow);
        else card.appendChild(bar);
        progressEl = bar;
      }

      xhr.upload.onprogress = function(e) {
        if (e.lengthComputable && progressEl) {
          var pct = Math.round(e.loaded / e.total * 100);
          progressEl.querySelector('.upload-progress-bar').style.width = pct + '%';
        }
      };

      xhr.onload = function() {
        if (progressEl) {
          progressEl.querySelector('.upload-progress-bar').style.width = '100%';
          progressEl.querySelector('.upload-progress-bar').style.background = '#3fb950';
          setTimeout(function() { if (progressEl.parentElement) progressEl.remove(); }, 1500);
        }
        try { resolve(JSON.parse(xhr.responseText)); }
        catch (e) { resolve({ ok: false }); }
      };

      xhr.onerror = function() {
        if (progressEl) {
          progressEl.querySelector('.upload-progress-bar').style.background = '#f87171';
          setTimeout(function() { if (progressEl.parentElement) progressEl.remove(); }, 2000);
        }
        resolve({ ok: false });
      };

      xhr.send(file);
    });
  }

  function handlePaste(id, e) {
    var items = e.clipboardData && e.clipboardData.items;
    if (!items) return;
    for (var i = 0; i < items.length; i++) {
      if (items[i].type.indexOf('image/') === 0) {
        e.preventDefault();
        var file = items[i].getAsFile();
        if (!file) continue;
        var ext = file.type.split('/')[1] || 'png';
        var named = new File([file], 'screenshot-' + Date.now() + '.' + ext, { type: file.type });
        uploadFile(id, named);
        return;
      }
    }
  }

  function sendKey(id, key) {
    AB.ws.send({ type: 'key', id: id, key: key });
  }

  function doSendInput(id) {
    var inp = document.getElementById('inp-' + id);
    if (!inp) return;
    var text = inp.value.trim();
    if (!text) return;
    text = text.split('\n').filter(function(l) { return l.trim() !== ''; }).join('\n');
    if (!text) return;
    inp.value = '';
    inp.style.height = 'auto';
    AB.ws.send({ type: 'input', id: id, text: text });
  }

  function toggleSearch(id) {
    var card = _inputCards[id];
    if (!card) return;
    var row = card.querySelector('.search-row');
    if (!row) return;
    var open = row.style.display !== 'none';
    row.style.display = open ? 'none' : 'flex';
    if (!open) {
      var inp = row.querySelector('.search-inp');
      if (inp) inp.focus();
    }
    if (open) AB.terminal.search(id, ''); // clear search
  }

  // ── Session state UI updates ──

  function updateInputCardState(id) {
    var card = _inputCards[id];
    if (!card) return;
    var s = AB.store.get(id);
    if (!s) return;

    var state = AB.store.effectiveState(id);
    var isStopped = s.status === 'stopped' || s.status === 'completed';

    // Apply status border class to card (animations)
    card.classList.remove('status-running', 'status-idle', 'status-waiting', 'status-stopped', 'status-completed');
    if (isStopped) {
      card.classList.add(s.status === 'completed' ? 'status-completed' : 'status-stopped');
    } else if (s.aiState === 'waiting') {
      card.classList.add('status-waiting');
    } else if (s.aiState === 'idle') {
      card.classList.add('status-idle');
    } else {
      card.classList.add('status-running');
    }

    // Update badge
    var badge = card.querySelector('#badge-' + id);
    if (badge) {
      badge.textContent = state;
      badge.className = 'badge' + (state === 'stopped' ? ' stopped' : '') + (state === 'idle' ? ' ai-idle' : '') + (state === 'waiting' ? ' ai-waiting' : '');
    }

    // Update kill button + reconnect
    var killBtn = card.querySelector('#kill-' + id);
    if (killBtn) {
      killBtn.textContent = isStopped ? 'Remove' : 'Stop';
      if (isStopped) {
        killBtn.style.borderColor = '#f85149';
        killBtn.style.color = '#f85149';
        // Add reconnect button if not present
        if (!killBtn.parentElement.querySelector('.reconnect-btn')) {
          var reconBtn = document.createElement('button');
          reconBtn.className = 'reconnect-btn';
          reconBtn.textContent = 'Reconnect';
          reconBtn.onclick = function() {
            AB.api.post('/api/reconnect', { id: id })
              .then(function(r) { return r.json(); })
              .then(function(d) { if (!d.ok) alert('Session is no longer alive.'); });
          };
          killBtn.parentElement.insertBefore(reconBtn, killBtn);
        }
      } else {
        killBtn.style.borderColor = '';
        killBtn.style.color = '#f87171';
        // Remove reconnect button if session is running
        var reconBtn = killBtn.parentElement.querySelector('.reconnect-btn');
        if (reconBtn) reconBtn.remove();
      }
    }

    // Show/hide input row
    var inputRow = card.querySelector('#input-row-' + id);
    if (inputRow) inputRow.style.display = isStopped ? 'none' : '';

    // Update CWD
    var cwdEl = card.querySelector('.card-cwd');
    if (cwdEl) {
      var infoEl = cwdEl.querySelector('.card-info');
      var infoText = infoEl ? infoEl.outerHTML : '';
      cwdEl.innerHTML = AB.displayPath(s.cwd) + infoText;
    }

    // Update title
    var titleEl = card.querySelector('#card-title-' + id);
    if (titleEl) titleEl.textContent = AB.getTitle(id, s.cwd, s.cmd);
  }

  // ── Info updates (uptime, memory) ──

  var _workerInfo = {};

  function formatUptime(seconds) {
    if (seconds < 60) return '<1m';
    var m = Math.floor(seconds / 60) % 60;
    var h = Math.floor(seconds / 3600) % 24;
    var d = Math.floor(seconds / 86400);
    if (d > 0) return d + 'd ' + h + 'h';
    if (h > 0) return h + 'h ' + m + 'm';
    return m + 'm';
  }

  function formatMem(kb) {
    if (!kb || kb <= 0) return '';
    if (kb < 1024) return kb + ' KB';
    if (kb < 1048576) return (kb / 1024).toFixed(0) + ' MB';
    return (kb / 1048576).toFixed(1) + ' GB';
  }

  function updateInfo(id, process, createdAt, memKB) {
    var prev = _workerInfo[id] || {};
    _workerInfo[id] = { process: process, createdAt: createdAt, memKB: memKB != null ? memKB : prev.memKB || 0 };
    var info = _workerInfo[id];
    var now = Math.floor(Date.now() / 1000);
    var uptime = info.createdAt ? formatUptime(now - info.createdAt) : '';
    var mem = formatMem(info.memKB);
    var parts = [process || '', uptime, mem].filter(Boolean);
    var text = parts.length ? ' \u00b7 ' + parts.join(' \u00b7 ') : '';
    var card = _inputCards[id];
    if (card) {
      var infoEl = card.querySelector('.card-info');
      if (infoEl) infoEl.textContent = text;
    }
  }

  setInterval(function() {
    Object.keys(_workerInfo).forEach(function(id) {
      var info = _workerInfo[id];
      if (info.createdAt) updateInfo(id, info.process, info.createdAt, info.memKB);
    });
  }, 60000);

  // ── App Init ──

  function enterApp(workerList) {
    document.getElementById('login').style.display = 'none';
    document.getElementById('app').style.display = 'flex';
    document.getElementById('workspace').style.display = 'flex';

    // Load config
    AB.api.get('/api/config')
      .then(function(cfg) {
        if (cfg.basePath) AB._basePath = cfg.basePath;
      })
      .catch(function() {});

    // Init modules
    AB.sidebar.init();
    AB.panels.init();
    AB.notify.init();
    AB.files.init();
    AB.ws.init();

    // Listen to store events for UI updates
    AB.store.addEventListener('session-added', function(e) {
      var id = e.detail.id;
      var card = createInputCard(id);
      var target = document.getElementById('terminal-pane-input');
      if (target) target.appendChild(card);
      AB.terminal.create(id);
      updateInputCardState(id);
      // Show card if this is the active session (may have been set before card existed)
      if (AB.store.activeId === id) {
        card.style.display = '';
      }
    });

    AB.store.addEventListener('active-changed', function(e) {
      var id = e.detail.id;
      var prev = e.detail.prev;
      // Hide all input cards, show active
      Object.keys(_inputCards).forEach(function(k) {
        _inputCards[k].style.display = (k === id) ? '' : 'none';
      });
      // Update mobile session label
      var label = document.getElementById('mobile-session-label');
      if (label && id) {
        var s = AB.store.get(id);
        var state = AB.store.effectiveState(id);
        var dot = state === 'running' ? '\u25cf ' : state === 'idle' ? '\u25cb ' : state === 'waiting' ? '\u25d4 ' : '\u25cb ';
        label.textContent = dot + '#' + id + ' ' + ((s && s.cwd) ? s.cwd.split('/').pop() : '');
      }
      if (id) AB.panels.selectSession(id, prev);
    });

    AB.store.addEventListener('status-changed', function(e) {
      updateInputCardState(e.detail.id);
    });

    AB.store.addEventListener('state-changed', function(e) {
      updateInputCardState(e.detail.id);
      // Update mobile label if this is the active session
      if (e.detail.id === AB.store.activeId) {
        var label = document.getElementById('mobile-session-label');
        if (label) {
          var s = AB.store.get(e.detail.id);
          var state = AB.store.effectiveState(e.detail.id);
          var dot = state === 'running' ? '\u25cf ' : state === 'idle' ? '\u25cb ' : state === 'waiting' ? '\u25d4 ' : '\u25cb ';
          label.textContent = dot + '#' + e.detail.id + ' ' + ((s && s.cwd) ? s.cwd.split('/').pop() : '');
        }
      }
    });

    AB.store.addEventListener('cwd-changed', function(e) {
      updateInputCardState(e.detail.id);
      // Refresh file explorer if viewing this session
      if (AB.store.activeId === e.detail.id && AB.files) {
        AB.files.refresh(e.detail.id);
      }
    });

    AB.store.addEventListener('info-changed', function(e) {
      updateInfo(e.detail.id, e.detail.process, e.detail.createdAt, e.detail.memKB);
    });

    AB.store.addEventListener('title-changed', function(e) {
      updateInputCardState(e.detail.id);
    });

    AB.store.addEventListener('session-removed', function(e) {
      var card = _inputCards[e.detail.id];
      if (card) { card.remove(); delete _inputCards[e.detail.id]; }
    });

    // Load initial sessions
    if (workerList) {
      workerList.forEach(function(w) {
        AB.store.add(w.id, w);
        if (w.aiState) AB.store.updateAiState(w.id, w.aiState);
        if (w.process || w.createdAt) updateInfo(w.id, w.process, w.createdAt, w.memKB);
      });
    }

    setTimeout(function() { AB.sidebar.updateSummaryBar(); }, 500);
  }

  function doLogin() {
    var pw = document.getElementById('pw').value;
    AB.api.post('/api/login', { pw: pw })
      .then(function(r) { return r.json(); })
      .then(function(d) {
        if (d.ok) enterApp();
        else document.getElementById('login-err').style.display = 'block';
      });
  }

  // ── Scan Sessions ──

  function scanSessions() {
    var btn = document.getElementById('scan-btn');
    btn.textContent = '\u23f3';
    AB.api.get('/api/scan')
      .then(function(found) {
        btn.textContent = '\ud83d\udd0d';
        if (!found.length) { alert('No new tmux sessions found.'); return; }
        var names = found.map(function(f) { return '\u2022 ' + f.sessionName + ' (' + AB.displayPath(f.cwd) + ')'; }).join('\n');
        if (!confirm('Add these sessions to dashboard?\n\n' + names)) return;
        found.forEach(function(f) { AB.api.post('/api/attach', { sessionName: f.sessionName, cwd: f.cwd }); });
      })
      .catch(function() { btn.textContent = '\ud83d\udd0d'; });
  }

  // ── Mobile Sidebar ──

  function toggleMobileSidebar(open) {
    var sb = document.getElementById('sidebar');
    var bd = document.getElementById('mobile-backdrop');
    if (!sb) return;
    var isOpen = sb.classList.contains('mobile-open');
    var shouldOpen = (open !== undefined) ? open : !isOpen;
    sb.classList.toggle('mobile-open', shouldOpen);
    if (bd) bd.classList.toggle('active', shouldOpen);
  }

  // ── Boot ──

  // Try auto-login first
  fetch('/api/workers', { credentials: 'include' })
    .then(function(r) { if (r.ok) return r.json(); throw new Error(); })
    .then(function(list) { enterApp(list); })
    .catch(function() { document.getElementById('login').style.display = ''; });

  // Event bindings
  document.getElementById('login-btn').addEventListener('click', doLogin);
  document.getElementById('pw').addEventListener('keydown', function(e) { if (e.key === 'Enter') doLogin(); });
  document.getElementById('toggle-toolbar-btn').addEventListener('click', function() { AB.favorites.toggleSpawnPanel(); });
  document.getElementById('scan-btn').addEventListener('click', scanSessions);
  document.getElementById('notify-btn').addEventListener('click', function() { AB.notify.toggle(); });

  var mobileMenuBtn = document.getElementById('mobile-menu-btn');
  if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', function() { toggleMobileSidebar(); });
  var mobileBackdrop = document.getElementById('mobile-backdrop');
  if (mobileBackdrop) mobileBackdrop.addEventListener('click', function() { toggleMobileSidebar(false); });

  window.addEventListener('resize', function() { AB.ws.sendResize(); });

  // ── Mobile view toggle (header button) ──
  AB._setMobileView = function(view) {
    var mainArea = document.getElementById('main-area');
    var filesBtn = document.getElementById('mobile-files-btn');
    if (view === 'viewer') {
      mainArea.classList.add('mobile-viewer-mode');
      if (filesBtn) filesBtn.classList.add('active');
    } else {
      mainArea.classList.remove('mobile-viewer-mode');
      if (filesBtn) filesBtn.classList.remove('active');
      setTimeout(function() { AB.ws.sendResize(); }, 100);
    }
  };

  var mobileFilesBtn = document.getElementById('mobile-files-btn');
  if (mobileFilesBtn) {
    mobileFilesBtn.addEventListener('click', function() {
      var mainArea = document.getElementById('main-area');
      var isViewer = mainArea.classList.contains('mobile-viewer-mode');
      AB._setMobileView(isViewer ? 'terminal' : 'viewer');
    });
  }

  // ── Terminal ↔ Viewer drag resize ──
  (function() {
    var handle = document.getElementById('terminal-viewer-drag');
    var termPane = document.getElementById('terminal-pane');
    if (!handle || !termPane) return;
    handle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      handle.classList.add('dragging');
      var startX = e.clientX;
      var startW = termPane.getBoundingClientRect().width;
      function onMove(e) {
        var w = startW + (e.clientX - startX);
        w = Math.max(250, Math.min(w, window.innerWidth * 0.6));
        termPane.style.flexBasis = w + 'px';
      }
      function onUp() {
        handle.classList.remove('dragging');
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        // Resize tmux once after drag ends
        AB.ws.sendResize();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  })();

  // ── Keyboard Shortcuts ──

  document.addEventListener('keydown', function(e) {
    var activeId = AB.store.activeId;
    if (!activeId) return;
    var inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

    if (!inInput && e.metaKey && e.shiftKey && e.key === 'ArrowLeft') {
      e.preventDefault(); AB.panels.switchSession(-1); return;
    }
    if (!inInput && e.metaKey && e.shiftKey && e.key === 'ArrowRight') {
      e.preventDefault(); AB.panels.switchSession(1); return;
    }
    if (e.key === 'b' && (e.ctrlKey || e.metaKey) && !inInput) {
      e.preventDefault();
      var sb = document.getElementById('sidebar');
      var drag = document.getElementById('sidebar-drag');
      if (sb) {
        var hidden = sb.style.display === 'none';
        sb.style.display = hidden ? '' : 'none';
        if (drag) drag.style.display = hidden ? '' : 'none';
        setTimeout(function() { AB.ws.sendResize(); }, 100);
      }
      return;
    }
    if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault(); toggleSearch(activeId); return;
    }
    if (inInput) return;
    if (e.key === 'Escape') { e.preventDefault(); sendKey(activeId, 'Escape'); }
    else if (e.key === 'Tab' && e.shiftKey) { e.preventDefault(); sendKey(activeId, 'BTab'); }
    else if (e.key === 'Tab' && !e.shiftKey) { e.preventDefault(); sendKey(activeId, 'Tab'); }
    else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) { e.preventDefault(); sendKey(activeId, 'C-c'); }
    else if (e.key === 'Enter') { e.preventDefault(); sendKey(activeId, 'Enter'); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); sendKey(activeId, 'Up'); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); sendKey(activeId, 'Down'); }
  });

})(window.AB = window.AB || {});
