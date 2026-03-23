// ── Init & Event Binding ──

function enterApp(workerList) {
  document.getElementById('login').style.display = 'none';
  document.getElementById('app').style.display = 'flex';
  document.getElementById('workspace').style.display = 'flex';
  loadConfig();
  initWS();
  initSidebarDrag();
  initSidebarSections();
  initSessionDrag();
  // Request notification permission
  if ('Notification' in window && Notification.permission === 'default') {
    Notification.requestPermission();
  }
  updateNotifyBtn();
  if (workerList) {
    workerList.forEach(w => {
      // Pre-set AI state before creating card so initial display is correct
      if (w.aiState) _prevAIStates[w.id] = w.aiState;
      ensureCard(w.id, w.cwd, w.status, w.logs, w.cmd);
      if (w.aiState) updateAIState(w.id, w.aiState);
    });
  } else {
    loadAll();
  }
  setTimeout(updateSummaryBar, 500);
}

fetch('/api/workers', { credentials: 'include' })
  .then(r => { if (r.ok) return r.json(); throw new Error(); })
  .then(list => enterApp(list))
  .catch(() => {
    document.getElementById('login').style.display = '';
  });

function doLogin() {
  const pw = document.getElementById('pw').value;
  apiPost('/api/login', { pw })
    .then(r => r.json())
    .then(d => {
      if (d.ok) enterApp();
      else document.getElementById('login-err').style.display = 'block';
    });
}

// ── Event Binding ──

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('toggle-toolbar-btn').addEventListener('click', toggleSpawnPanel);
document.getElementById('scan-btn').addEventListener('click', scanSessions);
document.getElementById('notify-btn').addEventListener('click', toggleNotify);

// ── Mobile Sidebar Toggle ──

function toggleMobileSidebar(open) {
  var sb = document.getElementById('sidebar');
  var bd = document.getElementById('mobile-backdrop');
  if (!sb) return;
  var isOpen = sb.classList.contains('mobile-open');
  var shouldOpen = (open !== undefined) ? open : !isOpen;
  sb.classList.toggle('mobile-open', shouldOpen);
  if (bd) bd.classList.toggle('active', shouldOpen);
}

var mobileMenuBtn = document.getElementById('mobile-menu-btn');
if (mobileMenuBtn) mobileMenuBtn.addEventListener('click', function() { toggleMobileSidebar(); });

var mobileBackdrop = document.getElementById('mobile-backdrop');
if (mobileBackdrop) mobileBackdrop.addEventListener('click', function() { toggleMobileSidebar(false); });

function toggleNotify() {
  _notifyEnabled = !_notifyEnabled;
  localStorage.setItem('notifyEnabled', _notifyEnabled);
  updateNotifyBtn();
}

function updateNotifyBtn() {
  var btn = document.getElementById('notify-btn');
  if (btn) btn.textContent = _notifyEnabled ? '\ud83d\udd14' : '\ud83d\udd15';
}

window.addEventListener('resize', sendResize);

// ── Keyboard Shortcuts ──

document.addEventListener('keydown', e => {
  if (!activeTab) return;

  const inInput = e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA';

  if (!inInput && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowLeft') {
    e.preventDefault();
    switchTab(-1);
    return;
  } else if (!inInput && e.metaKey && e.shiftKey && !e.ctrlKey && !e.altKey && e.key === 'ArrowRight') {
    e.preventDefault();
    switchTab(1);
    return;
  }

  // Ctrl+B / Cmd+B -> toggle sidebar
  if (e.key === 'b' && (e.ctrlKey || e.metaKey) && !inInput) {
    e.preventDefault();
    var sb = document.getElementById('sidebar');
    var drag = document.getElementById('sidebar-drag');
    if (sb) {
      var hidden = sb.style.display === 'none';
      sb.style.display = hidden ? '' : 'none';
      if (drag) drag.style.display = hidden ? '' : 'none';
      setTimeout(sendResize, 100);
    }
    return;
  }

  // Ctrl+F / Cmd+F -> terminal search
  if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    toggleSearch(activeTab);
    return;
  }

  if (inInput) return;

  if (e.key === 'Escape') {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Escape');
  } else if (e.key === 'Tab' && e.shiftKey) {
    e.preventDefault();
    sendSpecialKey(activeTab, 'BTab');
  } else if (e.key === 'Tab' && !e.shiftKey) {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Tab');
  } else if (e.key === 'c' && (e.ctrlKey || e.metaKey)) {
    e.preventDefault();
    sendSpecialKey(activeTab, 'C-c');
  } else if (e.key === 'Enter') {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Enter');
  } else if (e.key === 'ArrowUp') {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Up');
  } else if (e.key === 'ArrowDown') {
    e.preventDefault();
    sendSpecialKey(activeTab, 'Down');
  }
});
