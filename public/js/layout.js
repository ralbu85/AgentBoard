// ── Layout & Tab Management ──

let layout = localStorage.getItem('layout') || 'tab';
let activeTab = null;

function setLayout(mode) {
  layout = mode;
  localStorage.setItem('layout', mode);
  document.getElementById('tab-mode').style.display = mode === 'tab' ? 'flex' : 'none';
  document.getElementById('split-mode').style.display = mode === 'split' ? 'block' : 'none';
  document.getElementById('split-content').style.display = mode === 'split' ? 'grid' : 'none';
  document.getElementById('layout-tab-btn').classList.toggle('layout-active', mode === 'tab');
  document.getElementById('layout-split-btn').classList.toggle('layout-active', mode === 'split');
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
