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
}
