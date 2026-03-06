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
    '</div>' +
    '<div class="card-cwd">' + displayPath(cwd) + '</div>' +
    '<div class="logs" id="logs-' + id + '"></div>' +
    '<div class="input-row" id="input-row-' + id + '"' + (status === 'stopped' || status === 'completed' ? ' style="display:none"' : '') + '>' +
      '<textarea id="inp-' + id + '" placeholder="Enter command..." rows="1"></textarea>' +
      '<button id="send-' + id + '">Send</button>' +
      '<div class="toolkit-wrap">' +
        '<button class="toolkit-toggle" id="tk-btn-' + id + '">⌨</button>' +
        '<div class="toolkit-popup" id="tk-popup-' + id + '">' +
          '<div class="tk-label">Keys</div>' +
          '<div class="key-grid">' +
            '<button class="key-btn" id="key-esc-' + id + '">esc</button>' +
            '<button class="key-btn" id="key-up-' + id + '">↑</button>' +
            '<button class="key-btn" id="key-down-' + id + '">↓</button>' +
            '<button class="key-btn key-enter" id="key-enter-' + id + '">↵</button>' +
            '<button class="key-btn" id="key-tab-' + id + '">tab</button>' +
            '<button class="key-btn" id="key-stab-' + id + '">⇧tab</button>' +
            '<button class="key-btn" id="key-ctrlc-' + id + '">⌃c</button>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</div>';

  const panel = document.createElement('div');
  panel.className = 'tab-panel';
  panel.dataset.id = id;
  panel.appendChild(card.cloneNode(true));
  document.getElementById('tab-content').appendChild(panel);

  const splitCard = card;
  document.getElementById('split-content').appendChild(splitCard);
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
      if (e.key === 'Enter' && !e.shiftKey) {
        e.preventDefault();
        if (inp.value.trim()) { sendInput(id); } else { sendSpecialKey(id, 'Enter'); }
      }
    });
    inp.addEventListener('input', () => {
      inp.style.height = 'auto';
      inp.style.height = Math.min(inp.scrollHeight, 120) + 'px';
    });
  }

  // Toolkit toggle
  const tkBtn = q('#tk-btn-' + id);
  const tkPopup = q('#tk-popup-' + id);
  if (tkBtn && tkPopup) {
    tkBtn.addEventListener('click', e => {
      e.stopPropagation();
      const isOpen = tkPopup.classList.toggle('open');
      tkBtn.classList.toggle('open', isOpen);
      document.querySelectorAll('.toolkit-popup.open').forEach(p => {
        if (p !== tkPopup) {
          p.classList.remove('open');
          p.previousElementSibling.classList.remove('open');
        }
      });
    });
  }

  // Key buttons
  const keyMap = {
    up: 'Up', down: 'Down', enter: 'Enter', esc: 'Escape',
    tab: 'Tab', stab: 'BTab', ctrlc: 'C-c'
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
    line.textContent = text;
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
      btn.style.color = '#f85149';
      btn.onclick = () => killWorker(id);
      var reconBtn = btn.parentElement.querySelector('.reconnect-btn');
      if (reconBtn) reconBtn.remove();
    });
    document.querySelectorAll('#input-row-' + id).forEach(el => el.style.display = '');
  }
}

function updateAIState(id, state) {
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

// ── Worker Actions ──

function sendSpecialKey(id, key) {
  notifyActive();
  apiPost('/api/key', { id, key });
}

function sendInput(id) {
  let text = '';
  const inps = document.querySelectorAll('#inp-' + id);
  inps.forEach(inp => { if (!text && inp.value.trim()) text = inp.value.trim(); });
  if (!text) return;
  text = text.split('\n').filter(l => l.trim() !== '').join('\n');
  if (!text) return;
  inps.forEach(inp => { inp.value = ''; inp.style.height = 'auto'; });
  notifyActive();
  apiPost('/api/input', { id, text });
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
