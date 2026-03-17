// ── Notifications ──

var _notifyEnabled = localStorage.getItem('notifyEnabled') !== 'false';
var _titleBlinkTimer = null;
var _prevStatuses = {};
var _prevAIStates = {};

function playBeep(type) {
  try {
    var ctx = new (window.AudioContext || window.webkitAudioContext)();
    var osc = ctx.createOscillator();
    var gain = ctx.createGain();
    osc.connect(gain);
    gain.connect(ctx.destination);
    if (type === 'waiting') {
      osc.frequency.value = 880;
      osc.type = 'sine';
    } else {
      osc.frequency.value = 660;
      osc.type = 'square';
    }
    gain.gain.value = 0.08;
    osc.start();
    osc.stop(ctx.currentTime + 0.15);
  } catch (e) {}
}

var _blinkMessages = [];
var _blinkStopListener = null;

function startTitleBlink(msg) {
  _blinkMessages.push(msg);
  if (_titleBlinkTimer) return;
  var orig = document.title;
  var tick = 0;
  _titleBlinkTimer = setInterval(function() {
    if (_blinkMessages.length === 0) return;
    tick++;
    if (tick % 2 === 1) {
      var idx = Math.floor(tick / 2) % _blinkMessages.length;
      document.title = '\u26a1 ' + _blinkMessages[idx];
    } else {
      document.title = orig;
    }
  }, 600);

  // Only attach stop listener once
  if (!_blinkStopListener) {
    _blinkStopListener = function() {
      // When user returns to this tab, wait a moment so they can see it, then stop
      if (!document.hidden) {
        setTimeout(function() {
          if (_titleBlinkTimer) {
            clearInterval(_titleBlinkTimer);
            _titleBlinkTimer = null;
            _blinkMessages = [];
            document.title = orig;
          }
        }, 2000);
      }
    };
    document.addEventListener('visibilitychange', _blinkStopListener);
  }
}

function flashTab(id) {
  var tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (!tab) return;
  tab.classList.add('tab-flash');
  setTimeout(function() { tab.classList.remove('tab-flash'); }, 3000);
}

function notifyUser(title, body, type, id) {
  if (!_notifyEnabled) return;
  playBeep(type);
  flashTab(id);
  if (document.hidden) {
    startTitleBlink(title);
  }
  if (Notification.permission === 'granted') {
    try { new Notification(title, { body: body, tag: 'termhub-' + Date.now() }); } catch (e) {}
  }
}

function shouldNotify(id) {
  if (document.hidden) return true;
  // In tab mode, notify if the changed session is not the active tab
  if (id && activeTab && String(activeTab) !== String(id)) return true;
  return false;
}

// ── Worker Card UI ──

let customTitles = {};
try {
  customTitles = JSON.parse(localStorage.getItem('tabTitles') || '{}');
} catch (e) {
  customTitles = {};
}

function saveCustomTitles() {
  localStorage.setItem('tabTitles', JSON.stringify(customTitles));
}

function getTitleBase(id, cmd) {
  return customTitles[id] || cmd || 'claude';
}

function trimTitle(text) {
  const max = 24;
  if (text.length <= max) return text;
  return text.slice(0, max - 1) + '…';
}

function renderTitle(id, cwd, cmd) {
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  const tabCwd = cwd || (tab && tab.dataset.cwd) || '';
  const tabCmd = cmd || (tab && tab.dataset.cmd) || 'claude';
  const folder = tabCwd.replace(/\/$/, '').split('/').pop() || tabCwd;
  let text = '';
  if (customTitles[id]) {
    text = '#' + id + ' ' + customTitles[id];
  } else {
    text = '#' + id + ' ' + tabCmd + ' · ' + folder;
  }
  ['tab-label-' + id, 'card-title-' + id].forEach(function(elId) {
    document.querySelectorAll('#' + elId).forEach(function(el) {
      el.textContent = text;
    });
  });
}

function killBtnHtml(id, status) {
  if (status === 'stopped' || status === 'completed') {
    return '<button class="kill-btn" id="kill-' + id + '" style="border-color:#f85149;color:#f85149">Remove</button>';
  }
  return '<button class="kill-btn" id="kill-' + id + '">Stop</button>';
}

function ensureCard(id, cwd, status, logs, cmd) {
  // Seed prev state so future changes trigger notifications
  if (!_prevStatuses[id]) _prevStatuses[id] = status;
  if (document.getElementById('card-' + id)) return;

  const cmdLabel = cmd || 'claude';
  const card = document.createElement('div');
  card.className = 'card';
  card.id = 'card-' + id;
  card.innerHTML =
    '<div class="card-header">' +
      '<span class="card-title" id="card-title-' + id + '">#' + id + ' ' + cmdLabel + ' · ' + (cwd.replace(/\/$/, '').split('/').pop() || cwd) + '</span>' +
      '<span class="badge' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '') + '" id="badge-' + id + '">' + status + '</span>' +
      killBtnHtml(id, status) +
      '<button class="search-btn" onclick="toggleSearch(\'' + id + '\')">&#128269;</button>' +
    '</div>' +
    '<div class="card-cwd">' + displayPath(cwd) + '<span class="card-info"></span></div>' +
    '<div class="search-row" style="display:none"><input class="search-inp" placeholder="Search..." /><button class="search-close" onclick="toggleSearch(\'' + id + '\')">&times;</button></div>' +
    '<div class="logs" id="logs-' + id + '"></div>' +
    '<div class="input-row" id="input-row-' + id + '"' + (status === 'stopped' || status === 'completed' ? ' style="display:none"' : '') + '>' +
      '<textarea id="inp-' + id + '" placeholder="Enter command..." rows="1"></textarea>' +
      '<div class="quick-keys">' +
        '<button class="qk-btn" id="key-esc-' + id + '">Esc</button>' +
        '<button class="qk-btn" id="key-up-' + id + '">↑</button>' +
        '<button class="qk-btn" id="key-down-' + id + '">↓</button>' +
        '<button class="qk-btn" id="key-enter-' + id + '">↵</button>' +
        '<button class="qk-btn" id="key-tab-' + id + '">Tab</button>' +
        '<button class="qk-btn" id="key-ctrlc-' + id + '">⌃C</button>' +
      '</div>' +
      '<button class="send-btn" id="send-' + id + '">Send</button>' +
    '</div>';

  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.dataset.id = id;
  panel.appendChild(card.cloneNode(true));
  document.getElementById('tab-content').appendChild(panel);

  const splitCard = card;
  document.getElementById('split-content').appendChild(splitCard);
  bindSplitDrag(splitCard);
  updateSplitGrid();

  const tab = document.createElement('div');
  tab.className = 'tab';
  tab.dataset.id = id;
  tab.dataset.cwd = cwd;
  tab.dataset.cmd = cmdLabel;
  var folder = cwd.replace(/\/$/, '').split('/').pop() || cwd;
  tab.innerHTML = '<span class="tab-dot' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '') + '" id="tab-dot-' + id + '"></span><span class="tab-label" id="tab-label-' + id + '">#' + id + ' ' + (cmd || 'claude') + ' · ' + folder + '</span>';
  tab.addEventListener('click', () => selectTab(id));
  tab.addEventListener('dblclick', e => {
    e.stopPropagation();
    const current = customTitles[id] || cmdLabel;
    const next = prompt('Tab title', current);
    if (next === null) return;
    const trimmed = next.trim();
    if (!trimmed) {
      delete customTitles[id];
    } else {
      customTitles[id] = trimTitle(trimmed);
    }
    saveCustomTitles();
    renderTitle(id);
  });
  bindTabDrag(tab);
  document.getElementById('tab-bar').appendChild(tab);

  selectTab(id);

  bindCard(id, panel);
  bindCard(id, splitCard);

  if (status === 'stopped') {
    document.querySelectorAll('#kill-' + id).forEach(btn => {
      btn.onclick = () => removeWorker(id);
    });
    document.querySelectorAll('#input-row-' + id).forEach(el => el.style.display = 'none');
  }

  renderTitle(id, cwd, cmdLabel);
  if (logs) logs.forEach(l => appendLog(id, l.src, l.text));
  setTimeout(sendResize, 100);
  updateCardBorder(id);
  updateSummaryBar();
  if (layout === 'overview') renderOverview();
}

function bindCard(id, root) {
  const q = sel => root.querySelector ? root.querySelector(sel) : document.getElementById(sel.slice(1));

  const killBtn = q('#kill-' + id);
  const sendBtn = q('#send-' + id);
  const inp = q('#inp-' + id);

  if (killBtn) killBtn.addEventListener('click', () => killWorker(id));
  if (sendBtn) sendBtn.addEventListener('click', () => sendInput(id));
  if (inp) {
    inp.addEventListener('keydown', e => {
      if (e.key === 'Enter' && !e.shiftKey && !e.ctrlKey) {
        e.preventDefault();
        if (inp.value.trim()) { sendInput(id); } else { sendSpecialKey(id, 'Enter'); }
      }
      // Ctrl+Enter → send Enter to tmux
      if (e.key === 'Enter' && e.ctrlKey) {
        e.preventDefault();
        sendSpecialKey(id, 'Enter');
      }
      // Escape → send Escape to tmux
      if (e.key === 'Escape') {
        e.preventDefault();
        sendSpecialKey(id, 'Escape');
      }
      // Ctrl+[ → send Escape to tmux (alternative)
      if (e.key === '[' && e.ctrlKey) {
        e.preventDefault();
        sendSpecialKey(id, 'Escape');
      }
      // Ctrl+↑/↓ → send Up/Down to tmux
      if (e.key === 'ArrowUp' && e.ctrlKey) {
        e.preventDefault();
        sendSpecialKey(id, 'Up');
      }
      if (e.key === 'ArrowDown' && e.ctrlKey) {
        e.preventDefault();
        sendSpecialKey(id, 'Down');
      }
    });
    inp.addEventListener('input', () => {
      if (!inp._resizeRaf) {
        inp._resizeRaf = requestAnimationFrame(() => {
          inp.style.height = 'auto';
          inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
          inp._resizeRaf = null;
        });
      }
    });
  }

  // Search
  var searchInp = root.querySelector ? root.querySelector('.search-inp') : null;
  if (searchInp) {
    searchInp.addEventListener('input', function() { doSearch(id); });
    searchInp.addEventListener('keydown', function(e) {
      if (e.key === 'Escape') { toggleSearch(id); e.stopPropagation(); }
    });
  }

  // File paste & drop
  if (inp) {
    inp.addEventListener('paste', function(e) { handlePaste(id, e); });
  }
  var logsEl = q('#logs-' + id);
  var cardEl = root.querySelector ? root : document.getElementById('card-' + id);
  if (cardEl) {
    cardEl.addEventListener('dragover', function(e) { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    cardEl.addEventListener('drop', function(e) { handleFileDrop(id, e); });
  }

  // Quick key buttons
  const keyMap = {
    up: 'Up', down: 'Down', enter: 'Enter', esc: 'Escape',
    tab: 'Tab', ctrlc: 'C-c'
  };
  Object.entries(keyMap).forEach(([btnId, tmuxKey]) => {
    const btn = q('#key-' + btnId + '-' + id);
    if (btn) btn.addEventListener('click', () => sendSpecialKey(id, tmuxKey));
  });
}

// ── Logs ──

function isNearBottom(box) {
  return box.scrollHeight - box.scrollTop - box.clientHeight < 50;
}

function appendLog(id, src, text) {
  document.querySelectorAll('#logs-' + id).forEach(box => {
    var wasAtBottom = isNearBottom(box);
    const line = document.createElement('div');
    line.className = 'log-line ' + src;
    if (src === 'stdout') {
      line.innerHTML = ansiToHtml(text);
    } else {
      line.textContent = text;
    }
    box.appendChild(line);
    if (wasAtBottom) box.scrollTop = box.scrollHeight;
  });
}

function markPrompt(line, text) {
  const trimmed = text.trim();
  if (!/^[❯>›]/.test(trimmed)) { line.textContent = text; return; }
  const idx = text.indexOf(trimmed[0]);
  const before = text.slice(0, idx);
  const symbol = trimmed[0];
  const after = text.slice(idx + symbol.length);
  const mark = document.createElement('span');
  mark.className = 'prompt-mark';
  mark.textContent = symbol;
  line.textContent = '';
  if (before) line.appendChild(document.createTextNode(before));
  line.appendChild(mark);
  line.appendChild(document.createTextNode(after));
}

function updateStatus(id, status) {
  var prev = _prevStatuses[id];
  _prevStatuses[id] = status;
  if (shouldNotify(id) && prev && prev !== status) {
    if (status === 'completed') notifyUser('#' + id + ' 세션 완료', 'Session completed', 'done', id);
    else if (status === 'stopped') notifyUser('#' + id + ' 세션 중지', 'Session stopped', 'done', id);
  }
  var isStopped = status === 'stopped' || status === 'completed';
  document.querySelectorAll('#badge-' + id).forEach(el => {
    el.textContent = status;
    el.className = 'badge' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '');
  });
  document.querySelectorAll('#tab-dot-' + id).forEach(el => {
    el.className = 'tab-dot' + (status === 'stopped' ? ' stopped' : '') + (status === 'completed' ? ' completed' : '');
  });
  if (isStopped) {
    document.querySelectorAll('#kill-' + id).forEach(btn => {
      btn.textContent = 'Remove';
      btn.style.background = '#21262d';
      btn.style.borderColor = '#f85149';
      btn.style.color = '#f85149';
      btn.onclick = () => removeWorker(id);
      // Add Reconnect button if not already present
      if (!btn.parentElement.querySelector('.reconnect-btn')) {
        var reconBtn = document.createElement('button');
        reconBtn.className = 'reconnect-btn';
        reconBtn.textContent = 'Reconnect';
        reconBtn.style.cssText = 'background:#21262d;border:1px solid #3fb950;border-radius:5px;color:#3fb950;font-size:11px;padding:2px 8px;cursor:pointer';
        reconBtn.onclick = function() { reconnectWorker(id); };
        btn.parentElement.insertBefore(reconBtn, btn);
      }
    });
    document.querySelectorAll('#input-row-' + id).forEach(el => el.style.display = 'none');
  }
  if (status === 'running') {
    document.querySelectorAll('#kill-' + id).forEach(btn => {
      btn.textContent = 'Stop';
      btn.style.background = '';
      btn.style.borderColor = '';
      btn.style.color = '#f87171';
      btn.onclick = () => killWorker(id);
      var reconBtn = btn.parentElement.querySelector('.reconnect-btn');
      if (reconBtn) reconBtn.remove();
    });
    document.querySelectorAll('#input-row-' + id).forEach(el => el.style.display = '');
  }
  updateCardBorder(id);
  updateSummaryBar();
  if (layout === 'overview') renderOverview();
}

function updateCardBorder(id) {
  document.querySelectorAll('#card-' + id + ', .tab-panel[data-id="' + id + '"] .card').forEach(function(card) {
    card.classList.remove('status-completed', 'status-stopped', 'status-waiting', 'status-idle', 'status-running');
    var s = _prevStatuses[id];
    var ai = _prevAIStates[id];
    if (s === 'completed') card.classList.add('status-completed');
    else if (s === 'stopped') card.classList.add('status-stopped');
    else if (ai === 'waiting') card.classList.add('status-waiting');
    else if (ai === 'idle') card.classList.add('status-idle');
    else card.classList.add('status-running');
  });
}

function updateAIState(id, state) {
  var prev = _prevAIStates[id];
  _prevAIStates[id] = state;
  if (shouldNotify(id) && prev && prev !== state && state === 'waiting') {
    notifyUser('#' + id + ' 입력 대기', 'Waiting for input', 'waiting', id);
  }
  // Skip if worker is stopped/completed
  var badge = document.querySelector('#badge-' + id);
  if (badge && (badge.classList.contains('stopped') || badge.classList.contains('completed'))) return;

  document.querySelectorAll('#tab-dot-' + id).forEach(function(el) {
    el.classList.remove('ai-idle', 'ai-waiting');
    if (state === 'idle') el.classList.add('ai-idle');
    else if (state === 'waiting') el.classList.add('ai-waiting');
  });

  document.querySelectorAll('#badge-' + id).forEach(function(el) {
    el.classList.remove('ai-idle', 'ai-waiting');
    if (state === 'idle') {
      el.classList.add('ai-idle');
      el.textContent = 'idle';
    } else if (state === 'waiting') {
      el.classList.add('ai-waiting');
      el.textContent = 'waiting';
    } else {
      el.textContent = 'running';
    }
  });
  updateCardBorder(id);
  updateSummaryBar();
  if (layout === 'overview') renderOverview();
}

function removeWorker(id) {
  apiPost('/api/remove', { id });

  const panel = document.querySelector('.tab-panel[data-id="' + id + '"]');
  if (panel) panel.remove();
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (tab) {
    const wasActive = tab.classList.contains('active');
    tab.remove();
    if (wasActive) {
      const first = document.querySelector('.tab');
      if (first) selectTab(first.dataset.id);
      else activeTab = null;
    }
  }
  const card = document.getElementById('card-' + id);
  if (card) card.remove();
  updateSplitGrid();
  updateSummaryBar();
  if (layout === 'overview') renderOverview();
}

function updateCwd(id, cwd) {
  document.querySelectorAll('#card-' + id + ' .card-cwd').forEach(el => {
    el.textContent = displayPath(cwd);
  });
  // Also update card inside tab-panel
  document.querySelectorAll('.tab-panel[data-id="' + id + '"] .card-cwd').forEach(el => {
    el.textContent = displayPath(cwd);
  });
  const tab = document.querySelector('.tab[data-id="' + id + '"]');
  if (tab) tab.dataset.cwd = cwd;
  renderTitle(id, cwd);
}

function reconnectWorker(id) {
  apiPost('/api/reconnect', { id })
    .then(r => r.json())
    .then(d => {
      if (!d.ok) alert('Session is no longer alive.');
    });
}

// ── File Upload ──

function uploadFile(id, file) {
  var name = file.name || ('paste-' + Date.now() + '.png');
  return fetch('/api/upload?id=' + encodeURIComponent(id) + '&name=' + encodeURIComponent(name), {
    method: 'POST',
    body: file,
    credentials: 'include'
  }).then(function(r) { return r.json(); });
}

function handleFileDrop(id, e) {
  e.preventDefault();
  e.stopPropagation();
  var files = e.dataTransfer ? e.dataTransfer.files : [];
  for (var i = 0; i < files.length; i++) {
    uploadFile(id, files[i]).then(function(d) {
      if (d.ok) appendLog(id, 'stdin', '📎 Uploaded: ' + d.name + ' → ' + d.path);
    });
  }
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
      uploadFile(id, named).then(function(d) {
        if (d.ok) appendLog(id, 'stdin', '📎 Screenshot saved: ' + d.name + ' → ' + d.path);
      });
      return;
    }
  }
}

// ── Terminal Search ──

var _searchOpen = {};

function toggleSearch(id) {
  var rows = document.querySelectorAll('.tab-panel[data-id="' + id + '"] .search-row, #card-' + id + ' .search-row');
  if (!rows.length) return;
  var open = rows[0].style.display !== 'none';
  rows.forEach(function(row) {
    row.style.display = open ? 'none' : 'flex';
    if (!open) {
      var inp = row.querySelector('.search-inp');
      if (inp) inp.focus();
    }
  });
  if (open) clearSearch(id);
}

function doSearch(id) {
  var row = document.querySelector('.tab-panel[data-id="' + id + '"] .search-row') ||
            document.querySelector('#card-' + id + ' .search-row');
  if (!row) return;
  var term = row.querySelector('.search-inp').value.trim().toLowerCase();
  if (!term) { clearSearch(id); return; }

  document.querySelectorAll('#logs-' + id + ' .log-line').forEach(function(el) {
    var text = el.textContent.toLowerCase();
    if (text.includes(term)) {
      el.classList.add('search-hit');
      el.classList.remove('search-dim');
    } else {
      el.classList.remove('search-hit');
      el.classList.add('search-dim');
    }
  });

  // Scroll to first hit
  var hit = document.querySelector('#logs-' + id + ' .search-hit');
  if (hit) hit.scrollIntoView({ block: 'center' });
}

function clearSearch(id) {
  document.querySelectorAll('#logs-' + id + ' .log-line').forEach(function(el) {
    el.classList.remove('search-hit', 'search-dim');
  });
}

// ── Worker Actions ──

function sendSpecialKey(id, key) {
  notifyActive();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'key', id, key }));
  } else {
    apiPost('/api/key', { id, key });
  }
}

function sendInput(id) {
  let text = '';
  const inps = document.querySelectorAll('#inp-' + id);
  inps.forEach(inp => { if (!text && inp.value.trim()) text = inp.value.trim(); });
  if (!text) return;
  text = text.split('\n').filter(l => l.trim() !== '').join('\n');
  if (!text) return;
  inps.forEach(inp => { inp.value = ''; inp.style.height = 'auto'; });
  if (typeof recordInput === 'function') recordInput(id, text);
  notifyActive();
  if (ws && ws.readyState === 1) {
    ws.send(JSON.stringify({ type: 'input', id, text }));
  } else {
    apiPost('/api/input', { id, text });
  }
}

function killWorker(id) {
  if (!confirm('Stop Worker #' + id + '?')) return;
  apiPost('/api/kill', { id });
}

function spawnSession() {
  var raw = document.getElementById('cwd-input').value.trim();
  var base = window._basePath || '/tmp';
  var cwd = raw ? (raw.startsWith('/') ? raw : base + '/' + raw) : base;
  const cmd = document.getElementById('cmd-input').value.trim();
  apiPost('/api/spawn', { cwd, cmd })
    .then(r => r.json().catch(() => ({})).then(d => ({ ok: r.ok, d })))
    .then(({ ok, d }) => {
      if (!ok || d.ok === false) {
        alert(d.error || 'Invalid path. Worker not created.');
        return;
      }
      addRecent(cwd);
    })
    .catch(() => { alert('Failed to create worker.'); });
}

var _workerInfo = {}; // id → { process, createdAt, memKB }

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
  var text = parts.length ? ' · ' + parts.join(' · ') : '';
  // Update in both tab-panel and split-content cards
  document.querySelectorAll('#card-' + id + ' .card-info').forEach(function(el) {
    el.textContent = text;
  });
  document.querySelectorAll('.tab-panel[data-id="' + id + '"] .card-info').forEach(function(el) {
    el.textContent = text;
  });
}

function refreshUptimes() {
  Object.keys(_workerInfo).forEach(function(id) {
    var info = _workerInfo[id];
    if (info.createdAt) updateInfo(id, info.process, info.createdAt, info.memKB);
  });
}

setInterval(refreshUptimes, 60000);

function scanSessions() {
  const btn = document.getElementById('scan-btn');
  btn.textContent = '⏳';
  apiGet('/api/scan')
    .then(found => {
      btn.textContent = '🔍';
      if (!found.length) { alert('No new tmux sessions found.'); return; }
      const names = found.map(f => '• ' + f.sessionName + ' (' + displayPath(f.cwd) + ')').join('\n');
      if (!confirm('Add these sessions to dashboard?\n\n' + names)) return;
      found.forEach(f => apiPost('/api/attach', { sessionName: f.sessionName, cwd: f.cwd }));
    })
    .catch(() => { btn.textContent = '🔍'; });
}
