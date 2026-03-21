// ── Layout & Tab Management ──

let layout = localStorage.getItem('layout') || 'overview';
let activeTab = null;

function setLayout(mode) {
  layout = mode;
  localStorage.setItem('layout', mode);
  document.getElementById('overview-mode').style.display = mode === 'overview' ? '' : 'none';
  document.getElementById('tab-mode').style.display = mode === 'tab' ? 'flex' : 'none';
  document.getElementById('split-mode').style.display = mode === 'split' ? 'block' : 'none';
  document.getElementById('split-content').style.display = mode === 'split' ? 'grid' : 'none';
  document.getElementById('layout-overview-btn').classList.toggle('layout-active', mode === 'overview');
  document.getElementById('layout-tab-btn').classList.toggle('layout-active', mode === 'tab');
  document.getElementById('layout-split-btn').classList.toggle('layout-active', mode === 'split');
  if (mode === 'overview') {
    renderOverview();
    // No active tab in overview — all sessions use 100-line capture
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'active', id: null }));
  }
  updateSplitGrid();
}

function updateSplitGrid() {
  const sc = document.getElementById('split-content');
  const cards = sc.querySelectorAll('.card');
  const n = cards.length;
  if (n === 0) return;

  let cols, rows;
  if (n <= 3) {
    cols = n; rows = 1;
  } else {
    cols = Math.ceil(n / 2); rows = 2;
  }

  sc.style.gridTemplateColumns = `repeat(${cols}, 1fr)`;
  sc.style.gridTemplateRows = `repeat(${rows}, 1fr)`;
}

function selectTab(id) {
  activeTab = id;
  document.querySelectorAll('.tab').forEach(t => t.classList.toggle('active', t.dataset.id === id));
  document.querySelectorAll('.tab-panel').forEach(p => p.classList.toggle('active', p.dataset.id === id));
  // Notify server to poll this session immediately
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'active', id: id }));
  // Mark completed card as seen — stop pulsing
  var card = document.querySelector('#card-' + id);
  if (card) card.classList.add('status-seen');
  var panelCard = document.querySelector('.tab-panel[data-id="' + id + '"] .card');
  if (panelCard) panelCard.classList.add('status-seen');

  // Refresh side panel for new tab
  if (_spOpen && typeof refreshSPFiles === 'function') {
    _spBrowseInitialized[id] = false;
    refreshSPFiles();
    // Reset editor
    if (typeof resetEditor === 'function') resetEditor();
    switchSPTab('files');
  }

  // Scroll logs to bottom after tab becomes visible
  requestAnimationFrame(function() {
    var panel = document.querySelector('.tab-panel[data-id="' + id + '"]');
    if (panel) {
      var box = panel.querySelector('.logs');
      if (box) box.scrollTop = box.scrollHeight;
    }
  });
}

function switchTab(delta) {
  const tabs = Array.from(document.querySelectorAll('.tab'));
  if (!tabs.length) return;
  if (!activeTab) {
    selectTab(tabs[0].dataset.id);
    return;
  }
  const idx = tabs.findIndex(t => t.dataset.id === activeTab);
  const next = idx === -1 ? 0 : (idx + delta + tabs.length) % tabs.length;
  selectTab(tabs[next].dataset.id);
}

// ── Overview Mode ──

function getEffectiveState(id) {
  var status = _prevStatuses[id] || 'running';
  if (status === 'stopped' || status === 'completed') return status;
  var aiState = _prevAIStates[id];
  if (aiState === 'waiting') return 'waiting';
  if (aiState === 'idle') return 'idle';
  return 'running';
}

function renderOverview() {
  var container = document.getElementById('overview-content');
  if (!container) return;

  var tabs = Array.from(document.querySelectorAll('.tab'));
  if (tabs.length === 0) {
    container.innerHTML = '<div style="color:#484f58;text-align:center;padding:48px 0;font-size:14px">No sessions yet. Click <span style="color:#a78bfa;font-weight:600">+</span> to create one.</div>';
    return;
  }

  container.innerHTML = '';
  tabs.forEach(function(tab) {
    var id = tab.dataset.id;
    var state = getEffectiveState(id);
    var title = tab.querySelector('.tab-label');
    var titleText = title ? title.textContent : '#' + id;
    var info = _workerInfo[id] || {};

    var card = document.createElement('div');
    card.className = 'ov-card' + (state === 'waiting' ? ' ov-waiting' : '') + (state === 'stopped' ? ' ov-stopped' : '');
    card.onclick = function() { setLayout('tab'); selectTab(id); };

    // Header
    var header = document.createElement('div');
    header.className = 'ov-header';
    header.innerHTML =
      '<span class="ov-dot ' + state + '"></span>' +
      '<span class="ov-title">' + titleText + '</span>' +
      '<span class="ov-badge ' + state + '">' + state + '</span>';
    card.appendChild(header);

    // CWD
    var cwd = document.createElement('div');
    cwd.className = 'ov-cwd';
    cwd.textContent = displayPath(tab.dataset.cwd || '');
    card.appendChild(cwd);

    // Preview — last 3 lines from snapshot cache
    var preview = document.createElement('div');
    preview.className = 'ov-preview';
    var cached = _snapshotCache[id];
    if (cached && cached.length > 0) {
      // Get last 3 non-empty lines
      var lines = cached.filter(function(l) { return l.trim() !== ''; });
      var last3 = lines.slice(-3);
      last3.forEach(function(line) {
        var el = document.createElement('div');
        el.className = 'log-line';
        el.innerHTML = ansiToHtml(line);
        preview.appendChild(el);
      });
    } else {
      preview.innerHTML = '<span style="color:#484f58">No output yet</span>';
    }
    card.appendChild(preview);

    // Info bar
    if (info.createdAt || info.process) {
      var infoEl = document.createElement('div');
      infoEl.className = 'ov-info';
      var parts = [];
      if (info.process) parts.push(info.process);
      if (info.createdAt) parts.push(formatUptime(Math.floor(Date.now() / 1000) - info.createdAt));
      if (info.memKB) parts.push(formatMem(info.memKB));
      infoEl.textContent = parts.join(' · ');
      card.appendChild(infoEl);
    }

    container.appendChild(card);
  });
}

// ── Summary Bar ──

function updateSummaryBar() {
  var bar = document.getElementById('summary-bar');
  if (!bar) return;

  var tabs = Array.from(document.querySelectorAll('.tab'));
  if (tabs.length === 0) { bar.innerHTML = ''; return; }

  var counts = { running: 0, waiting: 0, idle: 0, completed: 0, stopped: 0 };
  tabs.forEach(function(tab) {
    var state = getEffectiveState(tab.dataset.id);
    counts[state] = (counts[state] || 0) + 1;
  });

  var html = '';
  var order = ['running', 'waiting', 'idle', 'completed', 'stopped'];
  var labels = { running: 'Running', waiting: 'Waiting', idle: 'Idle', completed: 'Done', stopped: 'Stopped' };
  order.forEach(function(key) {
    if (counts[key] > 0) {
      html += '<span class="summary-item">' +
        '<span class="summary-dot ' + key + '"></span>' +
        '<span class="summary-count">' + counts[key] + '</span> ' + labels[key] +
        '</span>';
    }
  });
  bar.innerHTML = html;
}

// ── Split Card Drag ──

function bindSplitDrag(card) {
  var header = card.querySelector('.card-header');
  if (!header) return;
  header.draggable = true;
  header.style.cursor = 'grab';

  header.addEventListener('dragstart', function(e) {
    card.classList.add('split-dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', card.id);
  });

  header.addEventListener('dragend', function() {
    card.classList.remove('split-dragging');
    document.querySelectorAll('#split-content .card').forEach(function(c) {
      c.classList.remove('split-drop-before', 'split-drop-after');
    });
  });

  card.addEventListener('dragover', function(e) {
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    var rect = card.getBoundingClientRect();
    var mid = rect.left + rect.width / 2;
    var before = e.clientX < mid;
    card.classList.toggle('split-drop-before', before);
    card.classList.toggle('split-drop-after', !before);
  });

  card.addEventListener('dragleave', function() {
    card.classList.remove('split-drop-before', 'split-drop-after');
  });

  card.addEventListener('drop', function(e) {
    e.preventDefault();
    card.classList.remove('split-drop-before', 'split-drop-after');
    var draggedId = e.dataTransfer.getData('text/plain');
    var dragged = document.getElementById(draggedId);
    if (!dragged || dragged === card) return;

    var container = document.getElementById('split-content');
    var rect = card.getBoundingClientRect();
    var before = e.clientX < rect.left + rect.width / 2;
    if (before) {
      container.insertBefore(dragged, card);
    } else {
      container.insertBefore(dragged, card.nextSibling);
    }
    updateSplitGrid();
  });
}

// ── Tab Drag ──

function bindTabDrag(tab) {
  tab.draggable = true;
  tab.addEventListener('dragstart', e => {
    tab.classList.add('dragging');
    e.dataTransfer.effectAllowed = 'move';
    e.dataTransfer.setData('text/plain', tab.dataset.id);
  });
  tab.addEventListener('dragend', () => {
    tab.classList.remove('dragging');
  });
}

function getDragAfterElement(container, x) {
  const els = [...container.querySelectorAll('.tab:not(.dragging)')];
  let closest = { offset: Number.NEGATIVE_INFINITY, element: null };
  els.forEach(el => {
    const box = el.getBoundingClientRect();
    const offset = x - box.left - box.width / 2;
    if (offset < 0 && offset > closest.offset) {
      closest = { offset, element: el };
    }
  });
  return closest.element;
}

const tabBar = document.getElementById('tab-bar');
if (tabBar) {
  const indicator = document.createElement('div');
  indicator.id = 'tab-drop-indicator';
  tabBar.appendChild(indicator);

  tabBar.addEventListener('dragover', e => {
    e.preventDefault();
    const dragging = document.querySelector('.tab.dragging');
    if (!dragging) return;
    const after = getDragAfterElement(tabBar, e.clientX);
    if (!after) tabBar.appendChild(dragging);
    else tabBar.insertBefore(dragging, after);

    const target = after || tabBar.lastElementChild;
    if (!target) return;
    const rect = target.getBoundingClientRect();
    const barRect = tabBar.getBoundingClientRect();
    const x = after ? rect.left - barRect.left : rect.right - barRect.left;
    indicator.style.transform = `translateX(${x}px)`;
    indicator.classList.add('show');
  });

  tabBar.addEventListener('dragleave', e => {
    if (e.relatedTarget && tabBar.contains(e.relatedTarget)) return;
    indicator.classList.remove('show');
  });

  tabBar.addEventListener('drop', () => {
    indicator.classList.remove('show');
  });
}
