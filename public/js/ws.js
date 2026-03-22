// ── WebSocket & API Communication ──

var _snapshotPending = {};
var _snapshotTimer = {};
var _snapshotCache = {};

var DOM_LIMIT = 300;  // max lines in DOM — full data stays in _snapshotCache
var LOAD_BATCH = 200; // lines to prepend when scrolling up
var _domOffset = {};  // id -> index into _snapshotCache where DOM starts

function scheduleSnapshot(id, msg) {
  _snapshotPending[id] = msg;
  if (_snapshotTimer[id]) return;
  _snapshotTimer[id] = requestAnimationFrame(function() {
    _snapshotTimer[id] = null;
    var pending = _snapshotPending[id];
    if (!pending) return;
    _snapshotPending[id] = null;
    if (pending.lines) {
      applyFullSnapshot(id, pending.lines);
    } else {
      applyTailSnapshot(id, pending.tail, pending.offset, pending.total);
    }
  });
}

function _trimEmpty(lines) {
  while (lines.length > 0 && lines[lines.length - 1].replace(/\x1b\[[0-9;]*m/g, '').trim() === '') lines.pop();
  return lines;
}

function _bindScroll(id, box) {
  if (!box._scrollBound) {
    box._scrollBound = true;
    box.addEventListener('scroll', function() { _onLogsScroll(id, box); });
  }
}

function _refreshOV() {
  // No-op: overview mode removed in sidebar layout redesign
}

// Full rebuild — used for first load, tab switch, capture size change
function _renderFull(id, allLines) {
  var start = Math.max(0, allLines.length - DOM_LIMIT);
  _domOffset[id] = start;
  var renderLines = allLines.slice(start);

  document.querySelectorAll('#logs-' + id).forEach(function(box) {
    _bindScroll(id, box);
    var wasAtBottom = isNearBottom(box);
    var distFromBottom = box.scrollHeight - box.scrollTop;

    var frag = document.createDocumentFragment();
    for (var i = 0; i < renderLines.length; i++) {
      var el = document.createElement('div');
      el.className = 'log-line stdout';
      el.innerHTML = ansiToHtml(renderLines[i]);
      frag.appendChild(el);
    }
    box.replaceChildren(frag);

    if (wasAtBottom || !box.scrollTop) {
      box.scrollTop = box.scrollHeight;
    } else {
      // Preserve scroll position relative to bottom
      box.scrollTop = box.scrollHeight - distFromBottom;
    }
  });
  _refreshOV();
}

// Incremental update — used for tail diffs (only changed region touched)
function _renderTail(id, allLines, changeOffset) {
  var start = Math.max(0, allLines.length - DOM_LIMIT);
  _domOffset[id] = start;
  var renderLines = allLines.slice(start);

  document.querySelectorAll('#logs-' + id).forEach(function(box) {
    _bindScroll(id, box);
    var wasAtBottom = isNearBottom(box);
    var children = box.children;
    var existingCount = children.length;
    var diff = renderLines.length - existingCount;

    if (existingCount > 0 && diff >= 0 && diff <= 50) {
      // Append new lines at the end
      for (var i = 0; i < diff; i++) {
        var el = document.createElement('div');
        el.className = 'log-line stdout';
        el.innerHTML = ansiToHtml(renderLines[existingCount + i]);
        box.appendChild(el);
      }
      // Update existing lines in the changed region only
      var domChangeStart = Math.max(0, changeOffset - start);
      for (var i = domChangeStart; i < existingCount; i++) {
        var newHtml = ansiToHtml(renderLines[i]);
        if (children[i].innerHTML !== newHtml) {
          children[i].innerHTML = newHtml;
        }
      }
      // Trim from top if over limit
      while (children.length > DOM_LIMIT) {
        box.removeChild(box.firstChild);
        _domOffset[id]++;
      }
      if (wasAtBottom) box.scrollTop = box.scrollHeight;
    } else {
      // Fallback to full rebuild
      var distFromBottom = box.scrollHeight - box.scrollTop;
      var frag = document.createDocumentFragment();
      for (var i = 0; i < renderLines.length; i++) {
        var el = document.createElement('div');
        el.className = 'log-line stdout';
        el.innerHTML = ansiToHtml(renderLines[i]);
        frag.appendChild(el);
      }
      box.replaceChildren(frag);
      if (wasAtBottom) {
        box.scrollTop = box.scrollHeight;
      } else {
        box.scrollTop = box.scrollHeight - distFromBottom;
      }
    }
  });
  _refreshOV();
}

function _onLogsScroll(id, box) {
  // When scrolled near top, prepend older lines from cache
  if (box.scrollTop > 50) return;
  var offset = _domOffset[id] || 0;
  if (offset <= 0) return;

  var cache = _snapshotCache[id];
  if (!cache) return;

  var loadFrom = Math.max(0, offset - LOAD_BATCH);
  var batch = cache.slice(loadFrom, offset);
  if (batch.length === 0) return;

  _domOffset[id] = loadFrom;

  // Remember scroll position to maintain it after prepend
  var oldHeight = box.scrollHeight;

  var frag = document.createDocumentFragment();
  for (var i = 0; i < batch.length; i++) {
    var el = document.createElement('div');
    el.className = 'log-line stdout';
    el.innerHTML = ansiToHtml(batch[i]);
    frag.appendChild(el);
  }
  box.insertBefore(frag, box.firstChild);

  // Restore scroll position
  box.scrollTop = box.scrollHeight - oldHeight + box.scrollTop;
}

function applyFullSnapshot(id, lines) {
  _trimEmpty(lines);
  var existing = _snapshotCache[id];
  // If we already have more lines and the tail matches, skip — just a capture window reduction
  if (existing && existing.length > lines.length && lines.length > 0) {
    var lastNew = lines[lines.length - 1];
    var lastOld = existing[existing.length - 1];
    if (lastNew === lastOld) return;  // Same content, smaller window — keep existing cache
  }
  _snapshotCache[id] = lines;
  _renderFull(id, lines);
}

function applyTailSnapshot(id, tail, offset, total) {
  var cache = _snapshotCache[id] || [];
  // If offset doesn't match cache, request full resync from server
  if (offset > cache.length) {
    if (ws && ws.readyState === 1) {
      ws.send(JSON.stringify({ type: 'resync', id: id }));
    }
    return;  // Skip render, wait for full snapshot
  }
  var updated = cache.slice(0, offset).concat(tail);
  _trimEmpty(updated);
  if (updated.length > total) updated = updated.slice(updated.length - total);
  _snapshotCache[id] = updated;
  _renderTail(id, updated, offset);  // Incremental, knows exactly what changed
}

var _ovRefreshTimer = null;

let ws;

function initWS() {
  const proto = location.protocol === 'https:' ? 'wss' : 'ws';
  ws = new WebSocket(proto + '://' + location.host);
  ws.onopen = () => {
    document.getElementById('status-dot').classList.remove('off');
    sendResize();
    // Inform server which tab is active on (re)connect
    if (activeTab) {
      ws.send(JSON.stringify({ type: 'active', id: activeTab }));
    }
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
    scheduleSnapshot(d.id, d);
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
  document.querySelectorAll('.session-item').forEach(function(t) {
    var id = t.dataset.id;
    var card = _cardElements ? _cardElements[id] : null;
    var box = card ? card.querySelector('.logs') : null;

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
