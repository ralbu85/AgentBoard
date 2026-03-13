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
}

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
  const box = document.querySelector('.logs');
  if (!box || !box.clientWidth) return;
  const ch = measureChar(box);
  if (!ch.w || !ch.h) return;
  const cols = Math.floor((box.clientWidth - 16) / ch.w);
  const rows = Math.floor(box.clientHeight / ch.h);
  document.querySelectorAll('.tab').forEach(t => {
    ws.send(JSON.stringify({ type: 'resize', id: t.dataset.id, cols, rows }));
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
