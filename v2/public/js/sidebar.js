// ── Sidebar: Session List + Explorer ──

(function(AB) {

  var store = null; // set on init
  var sidebarWidth = parseInt(localStorage.getItem('sidebarWidth')) || 220;

  // ── Session List ──

  function createSessionItem(id, data) {
    var item = document.createElement('div');
    item.className = 'session-item';
    item.draggable = (window.innerWidth > 768);
    item.dataset.id = String(id);
    item.dataset.cwd = data.cwd;
    item.dataset.cmd = data.cmd || 'claude';
    var folder = data.cwd.replace(/\/$/, '').split('/').pop() || data.cwd;
    var state = store.effectiveState(id);
    var title = AB.getTitle(id, data.cwd, data.cmd);
    item.innerHTML =
      '<span class="session-dot ' + state + '"></span>' +
      '<div class="session-info">' +
        '<span class="session-title">' + title + '</span>' +
        '<span class="session-cwd">' + AB.displayPath(data.cwd) + '</span>' +
      '</div>' +
      '<span class="session-badge ' + state + '">' + state + '</span>' +
      '<button class="session-close" title="Remove session">&times;</button>';
    // Instant tap on mobile (touchend), normal click on desktop
    function doSelect() { store.setActive(id); }
    item.addEventListener('touchend', function(e) {
      if (e.target.closest('.session-close')) return;
      e.preventDefault();
      doSelect();
    });
    item.addEventListener('click', function(e) {
      e.stopPropagation();
      if (e.target.closest('.session-close')) return;
      doSelect();
    });
    item.querySelector('.session-close').addEventListener('click', function(e) {
      e.stopPropagation();
      var s = store.get(id);
      var isRunning = s && s.status === 'running';
      if (!confirm((isRunning ? 'Stop and remove' : 'Remove') + ' #' + id + '?')) return;
      if (isRunning) AB.api.post('/api/kill', { id: id });
      AB.api.post('/api/remove', { id: id });
      store.remove(id);
      AB.terminal.destroy(id);
    });
    return item;
  }

  function updateSessionItem(id) {
    var item = document.querySelector('.session-item[data-id="' + id + '"]');
    if (!item) return;
    var s = store.get(id);
    if (!s) return;
    var state = store.effectiveState(id);
    var dot = item.querySelector('.session-dot');
    if (dot) dot.className = 'session-dot ' + state;
    var badge = item.querySelector('.session-badge');
    if (badge) { badge.className = 'session-badge ' + state; badge.textContent = state; }
    var cwdEl = item.querySelector('.session-cwd');
    if (cwdEl) cwdEl.textContent = AB.displayPath(s.cwd);
    var titleEl = item.querySelector('.session-title');
    if (titleEl) titleEl.textContent = AB.getTitle(id, s.cwd, s.cmd);
    item.classList.toggle('active', String(store.activeId) === String(id));
  }

  function updateAllSessionItems() {
    store.ids().forEach(updateSessionItem);
  }

  // ── Summary Bar ──

  function updateSummaryBar() {
    var bar = document.getElementById('summary-bar');
    if (!bar) return;
    var ids = store.ids();
    if (ids.length === 0) { bar.innerHTML = ''; return; }
    var counts = { running: 0, waiting: 0, idle: 0, stopped: 0 };
    ids.forEach(function(id) {
      var state = store.effectiveState(id);
      counts[state] = (counts[state] || 0) + 1;
    });
    var html = '';
    var order = ['running', 'waiting', 'idle', 'completed', 'stopped'];
    var labels = { running: 'Running', waiting: 'Waiting', idle: 'Idle', completed: 'Completed', stopped: 'Stopped' };
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

  // ── Sidebar Sections ──

  function initSections() {
    document.querySelectorAll('.sidebar-section-header').forEach(function(header) {
      header.addEventListener('click', function() {
        var section = header.parentElement;
        section.classList.toggle('collapsed');
        var name = header.dataset.section;
        var collapsed = section.classList.contains('collapsed');
        localStorage.setItem('sidebar-' + name, collapsed ? 'collapsed' : 'expanded');
      });
      var name = header.dataset.section;
      var saved = localStorage.getItem('sidebar-' + name);
      if (saved === 'collapsed') header.parentElement.classList.add('collapsed');
    });
  }

  // ── Sidebar Resize ──

  function initSidebarDrag() {
    var handle = document.getElementById('sidebar-drag');
    var sidebar = document.getElementById('sidebar');
    if (!handle || !sidebar) return;
    sidebar.style.width = sidebarWidth + 'px';
    handle.addEventListener('mousedown', function(e) {
      e.preventDefault();
      handle.classList.add('dragging');
      var startX = e.clientX;
      var startW = sidebar.offsetWidth;
      function onMove(e) {
        var newW = startW + (e.clientX - startX);
        newW = Math.max(140, Math.min(newW, 500));
        sidebar.style.width = newW + 'px';
        sidebarWidth = newW;
      }
      function onUp() {
        handle.classList.remove('dragging');
        localStorage.setItem('sidebarWidth', sidebarWidth);
        document.removeEventListener('mousemove', onMove);
        document.removeEventListener('mouseup', onUp);
        AB.ws.sendResize();
      }
      document.addEventListener('mousemove', onMove);
      document.addEventListener('mouseup', onUp);
    });
  }

  // ── Session Drag Reorder ──

  function initSessionDrag() {
    var list = document.getElementById('session-list');
    if (!list) return;
    var dragItem = null;
    list.addEventListener('dragstart', function(e) {
      var item = e.target.closest('.session-item');
      if (!item) return;
      dragItem = item;
      item.classList.add('session-dragging');
      e.dataTransfer.effectAllowed = 'move';
      e.dataTransfer.setData('text/plain', item.dataset.id);
    });
    list.addEventListener('dragend', function() {
      if (dragItem) dragItem.classList.remove('session-dragging');
      list.querySelectorAll('.session-item').forEach(function(el) {
        el.classList.remove('session-drop-above', 'session-drop-below');
      });
      dragItem = null;
    });
    list.addEventListener('dragover', function(e) {
      e.preventDefault();
      if (!dragItem) return;
      var target = e.target.closest('.session-item');
      if (!target || target === dragItem) return;
      list.querySelectorAll('.session-item').forEach(function(el) {
        el.classList.remove('session-drop-above', 'session-drop-below');
      });
      var rect = target.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        target.classList.add('session-drop-above');
      } else {
        target.classList.add('session-drop-below');
      }
    });
    list.addEventListener('drop', function(e) {
      e.preventDefault();
      if (!dragItem) return;
      var target = e.target.closest('.session-item');
      if (!target || target === dragItem) return;
      var rect = target.getBoundingClientRect();
      if (e.clientY < rect.top + rect.height / 2) {
        list.insertBefore(dragItem, target);
      } else {
        list.insertBefore(dragItem, target.nextSibling);
      }
      list.querySelectorAll('.session-item').forEach(function(el) {
        el.classList.remove('session-drop-above', 'session-drop-below');
      });
    });
  }

  var _mobileHighlightId = null;

  function _highlightMobileTab(id) {
    _mobileHighlightId = id;
    var tabs = document.getElementById('mobile-session-tabs');
    if (!tabs) return;
    tabs.querySelectorAll('.mobile-tab').forEach(function(t) {
      t.classList.toggle('highlighted', t.dataset.id === String(id));
    });
    // Preview: update file browser to this session's cwd
    if (AB.files) AB.files.refresh(id);
  }

  // ── Mobile Session Tabs ──

  function _addMobileTab(id, data) {
    var tabs = document.getElementById('mobile-session-tabs');
    if (!tabs) return;
    var tab = document.createElement('div');
    tab.className = 'mobile-tab';
    tab.dataset.id = String(id);
    var state = store.effectiveState(id);
    var folder = (data.cwd || '').replace(/\/$/, '').split('/').pop() || id;
    tab.innerHTML =
      '<span class="mobile-tab-dot ' + state + '"></span>' +
      '<span class="mobile-tab-name">' + folder + '</span>' +
      '<button class="mobile-tab-go">Open</button>';
    // Tap row = highlight (preview)
    tab.addEventListener('touchend', function(e) {
      if (e.target.classList.contains('mobile-tab-go')) return;
      e.preventDefault();
      _highlightMobileTab(id);
    });
    tab.addEventListener('click', function(e) {
      if (e.target.classList.contains('mobile-tab-go')) return;
      e.stopPropagation();
      _highlightMobileTab(id);
    });
    // Open button = switch session + close sidebar
    tab.querySelector('.mobile-tab-go').addEventListener('touchend', function(e) {
      e.preventDefault(); e.stopPropagation();
      store.setActive(id);
    });
    tab.querySelector('.mobile-tab-go').addEventListener('click', function(e) {
      e.stopPropagation();
      store.setActive(id);
    });
    tabs.appendChild(tab);
  }

  function _updateMobileTabs() {
    var tabs = document.getElementById('mobile-session-tabs');
    if (!tabs) return;
    tabs.querySelectorAll('.mobile-tab').forEach(function(tab) {
      var id = tab.dataset.id;
      var s = store.get(id);
      if (!s) return;
      var state = store.effectiveState(id);
      var dot = tab.querySelector('.mobile-tab-dot');
      if (dot) dot.className = 'mobile-tab-dot ' + state;
      tab.classList.toggle('active', String(store.activeId) === String(id));
    });
    // Scroll active tab into view
    var active = tabs.querySelector('.mobile-tab.active');
    if (active) active.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });
  }

  // ── Init ──

  function init() {
    store = AB.store;

    initSections();
    initSidebarDrag();
    initSessionDrag();

    store.addEventListener('session-added', function(e) {
      var id = e.detail.id;
      var data = e.detail.data;
      var list = document.getElementById('session-list');
      if (list) list.appendChild(createSessionItem(id, data));
      _addMobileTab(id, data);
      if (store.size === 1 || !store.activeId) {
        store.setActive(id);
      }
      updateSummaryBar();
    });

    store.addEventListener('session-removed', function(e) {
      var item = document.querySelector('.session-item[data-id="' + e.detail.id + '"]');
      if (item) item.remove();
      var tab = document.querySelector('.mobile-tab[data-id="' + e.detail.id + '"]');
      if (tab) tab.remove();
      updateSummaryBar();
    });

    store.addEventListener('active-changed', function(e) {
      updateAllSessionItems();
      _updateMobileTabs();
    });

    store.addEventListener('status-changed', function(e) {
      updateSessionItem(e.detail.id);
      _updateMobileTabs();
      updateSummaryBar();
    });

    store.addEventListener('state-changed', function(e) {
      updateSessionItem(e.detail.id);
      _updateMobileTabs();
      updateSummaryBar();
    });

    store.addEventListener('cwd-changed', function(e) {
      var item = document.querySelector('.session-item[data-id="' + e.detail.id + '"]');
      if (item) item.dataset.cwd = e.detail.cwd;
      updateSessionItem(e.detail.id);
    });

    store.addEventListener('title-changed', function(e) {
      updateSessionItem(e.detail.id);
    });
  }

  AB.sidebar = { init: init, updateSummaryBar: updateSummaryBar, updateSessionItem: updateSessionItem };

})(window.AB = window.AB || {});
