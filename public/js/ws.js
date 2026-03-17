// ── WebSocket & API Communication ──

// Snapshot throttle & diff — prevents main-thread stalls on long sessions
var _snapshotPending = {};   // id → lines (latest pending)
var _snapshotTimer = {};     // id → requestAnimationFrame id
var _snapshotCache = {};     // id → last rendered lines array

function scheduleSnapshot(id, lines) {
  _snapshotPending[id] = lines;
  if (_snapshotTimer[id]) return; // already scheduled
  _snapshotTimer[id] = requestAnimationFrame(function() {
    _snapshotTimer[id] = null;
    var pending = _snapshotPending[id];
    if (!pending) return;
    _snapshotPending[id] = null;
    applySnapshot(id, pending);
  });
}

function applySnapshot(id, lines) {
  // Trim trailing empty lines
  while (lines.length > 0 && lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '').trim() === '') lines.pop();
  var prev = _snapshotCache[id];
  document.querySelectorAll('#logs-' + id).forEach(function(box) {
    var wasAtBottom = isNearBottom(box);
    var children = box.children;

    if (!prev || Math.abs(lines.length - prev.length) > 50) {
      // Full rebuild only on first load or big jump — atomic swap to avoid flicker
      var frag = document.createDocumentFragment();
      for (var i = 0; i < lines.length; i++) {
        var el = document.createElement('div');
        el.className = 'log-line stdout';
        el.innerHTML = ansiToHtml(lines[i]);
        frag.appendChild(el);
      }
      box.replaceChildren(frag);
    } else {
      // Diff: update only changed lines
      // Adjust length
      while (children.length > lines.length) {
        box.removeChild(box.lastChild);
      }
      // Update existing lines that changed
      for (var i = 0; i < children.length; i++) {
        if (!prev || i >= prev.length || lines[i] !== prev[i]) {
          children[i].innerHTML = ansiToHtml(lines[i]);
        }
      }
      // Append new lines
      if (lines.length > children.length) {
        var frag = document.createDocumentFragment();
        for (var i = children.length; i < lines.length; i++) {
          var el = document.createElement('div');
          el.className = 'log-line stdout';
          el.innerHTML = ansiToHtml(lines[i]);
          frag.appendChild(el);
        }
        box.appendChild(frag);
      }
    }
    if (wasAtBottom) box.scrollTop = box.scrollHeight;
  });
  _snapshotCache[id] = lines;
  // Throttled overview refresh on snapshot
  if (layout === 'overview') {
    if (!_ovRefreshTimer) {
      _ovRefreshTimer = setTimeout(function() {
        _ovRefreshTimer = null;
        renderOverview();
      }, 2000);
    }
  }
}

var _ovRefreshTimer = null;

let ws;

function initWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);
  ws.onopen = () => {
    document.getElementById('status-dot').classList.remove('off');
    sendResize();
  };
  ws.onclose = () => {
    document.getElementById('status-dot').classList.add('off');
    setTimeout(initWS, 2000);
  };
  ws.onmessage = e => handleMsg(JSON.parse(e.data));
}

function handleMsg(d) {
  if (d.type === 'spawned') ensureCard(d.id, d.cwd, d.status, [], d.cmd);
  if (d.type === 'log') appendLog(d.id, d.src, d.text);
  if (d.type === 'status') updateStatus(d.id, d.status);
  if (d.type === 'cwd') updateCwd(d.id, d.cwd);
  if (d.type === 'aiState') updateAIState(d.id, d.state);
  if (d.type === 'info') updateInfo(d.id, d.process, d.createdAt, d.memKB);
  if (d.type === 'snapshot') {
    scheduleSnapshot(d.id, d.lines);
  }
}

function notifyActive() {
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'active' }));
}

// ── Terminal Resize ──

function measureChar(box) {
  const span = document.createElement('span');
  span.className = 'log-line';
  span.style.visibility = 'hidden';
  span.style.position = 'absolute';
  span.textContent = 'X';
  box.appendChild(span);
  const rect = span.getBoundingClientRect();
  box.removeChild(span);
  return { w: rect.width, h: rect.height };
}

var _resizeTimer = null;
function _doResize() {
  if (!ws || ws.readyState !== 1) return;

  // Measure from a visible .logs box for char size
  var refBox = document.querySelector('.logs');
  if (!refBox || !refBox.clientWidth) return;
  var ch = measureChar(refBox);
  if (!ch.w || !ch.h) return;

  // Send per-session resize based on each visible .logs width
  document.querySelectorAll('.tab').forEach(function(t) {
    var id = t.dataset.id;
    var box = null;

    // In split mode, use the split-content card's .logs
    if (layout === 'split') {
      var card = document.querySelector('#split-content #card-' + id);
      if (card) box = card.querySelector('.logs');
    }
    // In tab mode, use the active panel's .logs
    if (!box) {
      var panel = document.querySelector('.tab-panel[data-id="' + id + '"]');
      if (panel) box = panel.querySelector('.logs');
    }

    var w = box && box.clientWidth > 0 ? box.clientWidth : refBox.clientWidth;
    var h = box && box.clientHeight > 0 ? box.clientHeight : refBox.clientHeight;
    var cols = Math.floor((w - 16) / ch.w);
    var rows = Math.floor(h / ch.h);
    if (cols > 0 && rows > 0) {
      ws.send(JSON.stringify({ type: 'resize', id: id, cols: cols, rows: rows }));
    }
  });
}
function sendResize() {
  clearTimeout(_resizeTimer);
  _resizeTimer = setTimeout(_doResize, 200);
}

// ── API Calls ──

function apiPost(url, body) {
  return fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
    credentials: 'include'
  });
}

function apiGet(url) {
  return fetch(url, { credentials: 'include' }).then(r => r.json());
}

function loadAll() {
  apiGet('/api/workers')
    .then(list => list.forEach(w => {
      ensureCard(w.id, w.cwd, w.status, w.logs, w.cmd);
      if (w.aiState) updateAIState(w.id, w.aiState);
      if (w.process || w.createdAt) updateInfo(w.id, w.process, w.createdAt, w.memKB);
    }));
}

function loadConfig() {
  apiGet('/api/config')
    .then(cfg => {
      if (cfg.basePath) window._basePath = cfg.basePath;
      if (cfg.favorites && !localStorage.getItem('fav')) {
        favorites = cfg.favorites;
        saveFavs();
      }
      renderDropdown();
    })
    .catch(() => {});
}
