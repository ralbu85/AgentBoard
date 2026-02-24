// ── Init & Event Binding ──

function doLogin() {
  const pw = document.getElementById('pw').value;
  apiPost('/api/login', { pw })
    .then(r => r.json())
    .then(d => {
      if (d.ok) {
        document.getElementById('login').style.display = 'none';
        document.getElementById('app').style.display = 'flex';
        loadConfig();
        initWS();
        loadAll();
        setLayout(layout);
      } else {
        document.getElementById('login-err').style.display = 'block';
      }
    });
}

// ── Toolbar Toggle ──

function toggleToolbar() {
  const toolbar = document.getElementById('spawn-toolbar');
  const isOpen = toolbar.style.display !== 'none';
  toolbar.style.display = isOpen ? 'none' : 'flex';
  if (!isOpen) document.getElementById('cwd-input').focus();
}

// ── Event Binding ──

document.getElementById('login-btn').addEventListener('click', doLogin);
document.getElementById('pw').addEventListener('keydown', e => { if (e.key === 'Enter') doLogin(); });
document.getElementById('toggle-toolbar-btn').addEventListener('click', toggleToolbar);
document.getElementById('dir-btn').addEventListener('click', toggleDropdown);
document.getElementById('spawn-btn').addEventListener('click', () => {
  spawnSession();
  document.getElementById('spawn-toolbar').style.display = 'none';
});
document.getElementById('scan-btn').addEventListener('click', scanSessions);
document.getElementById('add-fav-btn').addEventListener('click', addFavorite);
document.getElementById('layout-tab-btn').addEventListener('click', () => setLayout('tab'));
document.getElementById('layout-split-btn').addEventListener('click', () => setLayout('split'));

document.addEventListener('click', e => {
  closeDropdown();
  if (!e.target.closest('.toolkit-wrap')) {
    document.querySelectorAll('.toolkit-popup.open').forEach(p => {
      p.classList.remove('open');
      p.previousElementSibling.classList.remove('open');
    });
  }
});

window.addEventListener('resize', sendResize);

// ── Keyboard Shortcuts ──

document.addEventListener('keydown', e => {
  if (!activeTab) return;

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
  } else if (e.key === 'Enter' && !e.target.closest('.input-row') && !e.target.closest('.toolbar') && !e.target.closest('#login')) {
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
