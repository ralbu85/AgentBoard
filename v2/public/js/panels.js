// ── Two-Pane Layout: Fixed terminal + Splittable viewer ──
// Drag to edges = split, center = tab. Simple flat grid.

(function(AB) {

  var _cells = [];
  var _cellCounter = 0;
  var _tabCounter = 0;
  var _splitDir = null;    // 'h' or 'v'
  var _sessionViewers = {};

  // ── Terminal ──

  function selectSession(id, prevId) {
    if (prevId && prevId !== id) {
      _saveSessionViewers(prevId);
      _clearAll();
    }

    // Close mobile sidebar if open
    var sb = document.getElementById('sidebar');
    if (sb) sb.classList.remove('mobile-open');
    var bd = document.getElementById('mobile-backdrop');
    if (bd) bd.classList.remove('active');
    if (AB._setMobileView) AB._setMobileView('terminal');

    // Terminal
    AB.terminal.create(id);
    AB.terminal.open(id, document.getElementById('terminal-pane-body'));
    AB.terminal.show(id);

    var s = AB.store.get(id);
    var termTitle = document.getElementById('terminal-pane-title');
    if (s && termTitle) termTitle.textContent = AB.getTitle(id, s.cwd, s.cmd);

    if (AB.files) AB.files.refresh(id);
    _restoreSessionViewers(id);

    // Fit + resize + notify server
    requestAnimationFrame(function() {
      var size = AB.terminal.resize(id);
      if (size && size.cols > 0 && size.rows > 0)
        AB.ws.send({ type: 'resize', id: id, cols: size.cols, rows: size.rows });
      AB.ws.notifyActive(id);
    });
  }

  function switchSession(delta) {
    var items = Array.from(document.querySelectorAll('.session-item'));
    if (!items.length) return;
    var activeId = AB.store.activeId;
    if (!activeId) { AB.store.setActive(items[0].dataset.id); return; }
    var idx = items.findIndex(function(el) { return el.dataset.id === String(activeId); });
    var next = idx === -1 ? 0 : (idx + delta + items.length) % items.length;
    AB.store.setActive(items[next].dataset.id);
  }

  // ── Render ──

  function _render() {
    var pane = document.getElementById('viewer-pane');
    // Detach all children without destroying them
    while (pane.firstChild) pane.removeChild(pane.firstChild);

    var dir = _splitDir || 'h';
    pane.style.flexDirection = (dir === 'h') ? 'row' : 'column';

    _cells.forEach(function(cell, i) {
      if (i > 0) {
        var handle = document.createElement('div');
        handle.className = 'viewer-split-handle ' + (dir === 'h' ? 'horizontal' : 'vertical');
        pane.appendChild(handle);
      }
      pane.appendChild(cell.el);
    });
  }

  // ── Cell ──

  function _createCell() {
    _cellCounter++;
    var cellId = 'cell-' + _cellCounter;

    var el = document.createElement('div');
    el.className = 'viewer-cell';
    el.dataset.cellId = cellId;

    var tabBar = document.createElement('div');
    tabBar.className = 'cell-tabs';
    el.appendChild(tabBar);

    var body = document.createElement('div');
    body.className = 'cell-body';
    el.appendChild(body);

    // Shield blocks CodeMirror/PDF from stealing drag events
    var shield = document.createElement('div');
    shield.className = 'cell-drag-shield';
    el.appendChild(shield);

    var highlight = document.createElement('div');
    highlight.className = 'drop-highlight';
    el.appendChild(highlight);

    var cell = { id: cellId, tabs: [], activeTabId: null, el: el, tabBar: tabBar, body: body, highlight: highlight, shield: shield };

    // Empty placeholder
    var empty = document.createElement('div');
    empty.className = 'viewer-empty-cell';
    empty.innerHTML = '<span class="viewer-empty-text">Drop a file here</span>';
    body.appendChild(empty);

    // ── Drop events directly on the cell element ──
    var dc = 0;

    el.addEventListener('dragenter', function(e) {
      e.preventDefault();
      dc++;
      shield.classList.add('active');
      highlight.classList.add('visible');
    });

    el.addEventListener('dragleave', function(e) {
      dc--;
      if (dc <= 0) { dc = 0; shield.classList.remove('active'); highlight.classList.remove('visible'); }
    });

    el.addEventListener('dragover', function(e) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'move';
      var zone = _getZone(el, e);
      _positionHighlight(highlight, zone);
    });

    el.addEventListener('drop', function(e) {
      e.preventDefault();
      e.stopPropagation();
      dc = 0;
      shield.classList.remove('active');
      highlight.classList.remove('visible');

      var zone = _getZone(el, e);
      var data = _parseDragData(e);
      if (!data) return;

      if (zone === 'center' || _cells.length >= 4) {
        _handleDrop(cell, data);
      } else {
        var dir = (zone === 'left' || zone === 'right') ? 'h' : 'v';
        // If already split in other direction, add as tab instead
        if (_splitDir && _splitDir !== dir && _cells.length > 1) {
          _handleDrop(cell, data);
          return;
        }
        _splitDir = dir;
        var newCell = _createCell();
        var idx = _cells.indexOf(cell);
        var insertAt = (zone === 'right' || zone === 'bottom') ? idx + 1 : idx;
        _cells.splice(insertAt, 0, newCell);
        _render();
        _handleDrop(newCell, data);
      }
    });

    return cell;
  }

  function _getZone(el, e) {
    var rect = el.getBoundingClientRect();
    var x = (e.clientX - rect.left) / rect.width;
    var y = (e.clientY - rect.top) / rect.height;
    if (x < 0.25) return 'left';
    if (x > 0.75) return 'right';
    if (y < 0.25) return 'top';
    if (y > 0.75) return 'bottom';
    return 'center';
  }

  function _positionHighlight(hl, zone) {
    var s = hl.style;
    if (zone === 'center') { s.top='2px'; s.left='2px'; s.right='2px'; s.bottom='2px'; }
    else if (zone === 'left') { s.top='2px'; s.left='2px'; s.right='52%'; s.bottom='2px'; }
    else if (zone === 'right') { s.top='2px'; s.left='52%'; s.right='2px'; s.bottom='2px'; }
    else if (zone === 'top') { s.top='2px'; s.left='2px'; s.right='2px'; s.bottom='52%'; }
    else if (zone === 'bottom') { s.top='52%'; s.left='2px'; s.right='2px'; s.bottom='2px'; }
  }

  function _parseDragData(e) {
    var raw = e.dataTransfer.getData('text/plain') || '';
    if (raw.indexOf('file:') === 0) {
      var p = raw.substring(5).split('|');
      return { type: 'file', filePath: p[0], fileName: p[1], fileType: p[2] };
    }
    if (raw.indexOf('tab:') === 0) {
      var p = raw.substring(4).split('|');
      return { type: 'tab', tabId: p[0], fromCellId: p[1] };
    }
    return null;
  }

  function _handleDrop(cell, data) {
    if (data.type === 'file') {
      _addTab(cell, data.filePath, data.fileName, data.fileType);
    } else if (data.type === 'tab') {
      _moveTab(data.fromCellId, cell.id, data.tabId);
    }
  }

  // ── Tabs ──

  function _addTab(cell, filePath, fileName, fileType) {
    // Dedup across all cells
    for (var i = 0; i < _cells.length; i++) {
      var found = _cells[i].tabs.find(function(t) { return t.filePath === filePath; });
      if (found) { _activateTab(_cells[i], found.id); return; }
    }

    _tabCounter++;
    var tabId = 'tab-' + _tabCounter;

    var tabEl = document.createElement('div');
    tabEl.className = 'viewer-tab';
    tabEl.draggable = true;
    tabEl.innerHTML =
      '<span class="viewer-tab-name">' + fileName + '</span>' +
      '<button class="viewer-tab-close">&times;</button>';

    // Use closure to always get current cell
    (function(tid) {
      tabEl.querySelector('.viewer-tab-name').addEventListener('click', function() {
        var cid = tabEl.closest('.viewer-cell').dataset.cellId;
        var c = _findCell(cid);
        if (c) _activateTab(c, tid);
      });
      tabEl.querySelector('.viewer-tab-close').addEventListener('click', function(e) {
        e.stopPropagation();
        var cid = tabEl.closest('.viewer-cell').dataset.cellId;
        var c = _findCell(cid);
        if (c) _closeTab(c, tid);
      });
      tabEl.addEventListener('dragstart', function(e) {
        var cid = tabEl.closest('.viewer-cell').dataset.cellId;
        e.dataTransfer.setData('text/plain', 'tab:' + tid + '|' + cid);
        e.dataTransfer.effectAllowed = 'move';
        tabEl.classList.add('tab-dragging');
      });
      tabEl.addEventListener('dragend', function() {
        tabEl.classList.remove('tab-dragging');
      });
    })(tabId);

    cell.tabBar.appendChild(tabEl);

    var contentEl = document.createElement('div');
    contentEl.className = 'viewer-content-area';
    contentEl.style.display = 'none';
    cell.body.appendChild(contentEl);

    var tab = { id: tabId, filePath: filePath, fileName: fileName, fileType: fileType, el: contentEl, tabEl: tabEl };
    cell.tabs.push(tab);

    // Hide empty
    var empty = cell.body.querySelector('.viewer-empty-cell');
    if (empty) empty.style.display = 'none';

    _updateViewerVisibility();

    // Mobile: switch to viewer + close sidebar
    if (window.innerWidth <= 768) {
      if (AB._setMobileView) AB._setMobileView('viewer');
      var sb = document.getElementById('sidebar');
      if (sb) sb.classList.remove('mobile-open');
      var bd = document.getElementById('mobile-backdrop');
      if (bd) bd.classList.remove('active');
    }

    // Load content
    if (fileType === 'pdf') AB.editor.loadPDF(contentEl, filePath, tabId);
    else if (fileType === 'image') AB.editor.loadImage(contentEl, filePath, tabId);
    else {
      var ext = fileName.split('.').pop().toLowerCase();
      AB.editor.loadCode(contentEl, filePath, fileName, ext, fileType === 'markdown', tabId);
    }

    _activateTab(cell, tabId);
  }

  function _activateTab(cell, tabId) {
    cell.activeTabId = tabId;
    cell.tabs.forEach(function(t) {
      t.el.style.display = (t.id === tabId) ? '' : 'none';
      t.tabEl.classList.toggle('active', t.id === tabId);
    });
  }

  function _closeTab(cell, tabId) {
    var idx = cell.tabs.findIndex(function(t) { return t.id === tabId; });
    if (idx === -1) return;
    cell.tabs[idx].el.remove();
    cell.tabs[idx].tabEl.remove();
    cell.tabs.splice(idx, 1);

    if (cell.tabs.length === 0) {
      cell.activeTabId = null;
      var empty = cell.body.querySelector('.viewer-empty-cell');
      if (empty) empty.style.display = '';
      _updateViewerVisibility();
      if (_cells.length > 1) _removeCell(cell);
    } else if (cell.activeTabId === tabId) {
      _activateTab(cell, cell.tabs[Math.min(idx, cell.tabs.length - 1)].id);
    }
  }

  function _moveTab(fromCellId, toCellId, tabId) {
    if (fromCellId === toCellId) return;
    var from = _findCell(fromCellId);
    var to = _findCell(toCellId);
    if (!from || !to) return;

    var idx = from.tabs.findIndex(function(t) { return t.id === tabId; });
    if (idx === -1) return;
    var tab = from.tabs.splice(idx, 1)[0];

    to.tabBar.appendChild(tab.tabEl);
    to.body.appendChild(tab.el);
    to.tabs.push(tab);

    var emptyTo = to.body.querySelector('.viewer-empty-cell');
    if (emptyTo) emptyTo.style.display = 'none';
    _activateTab(to, tabId);

    if (from.tabs.length === 0) {
      from.activeTabId = null;
      var emptyFrom = from.body.querySelector('.viewer-empty-cell');
      if (emptyFrom) emptyFrom.style.display = '';
      _updateViewerVisibility();
      if (_cells.length > 1) _removeCell(from);
    } else if (from.activeTabId === tabId) {
      _activateTab(from, from.tabs[0].id);
    }
  }

  function _removeCell(cell) {
    var idx = _cells.indexOf(cell);
    if (idx === -1) return;
    _cells.splice(idx, 1);
    // Don't remove el from DOM — _render will handle it
    if (_cells.length <= 1) _splitDir = null;
    _render();
  }

  function _findCell(cellId) {
    return _cells.find(function(c) { return c.id === cellId; }) || null;
  }

  function _updateViewerVisibility() {
    var pane = document.getElementById('viewer-pane');
    var hasTabs = _cells.some(function(c) { return c.tabs.length > 0; });
    pane.classList.toggle('has-tabs', hasTabs);
    // Mobile: auto-switch back to terminal when all tabs closed
    if (!hasTabs && window.innerWidth <= 768 && AB._setMobileView) {
      AB._setMobileView('terminal');
    }
  }

  // ── Open (from click) ──

  function openViewer(filePath, fileName, fileType) {
    for (var i = 0; i < _cells.length; i++) {
      var found = _cells[i].tabs.find(function(t) { return t.filePath === filePath; });
      if (found) { _activateTab(_cells[i], found.id); return; }
    }
    var sorted = _cells.slice().sort(function(a, b) { return a.tabs.length - b.tabs.length; });
    _addTab(sorted[0], filePath, fileName, fileType);
  }

  // ── Clear ──

  function _clearAll() {
    _cells = [];
    _splitDir = null;
    var c = _createCell();
    _cells.push(c);
    _render();
    _updateViewerVisibility();
  }

  function closeAllViewers() { _clearAll(); }

  // ── Session persistence ──

  function _saveSessionViewers(forId) {
    var id = forId || AB.store.activeId;
    if (!id) return;
    _sessionViewers[id] = {
      dir: _splitDir,
      cells: _cells.map(function(c) {
        return c.tabs.map(function(t) {
          return { filePath: t.filePath, fileName: t.fileName, fileType: t.fileType };
        });
      })
    };
  }

  function _restoreSessionViewers(sessionId) {
    var saved = _sessionViewers[sessionId];
    if (!saved || !saved.cells) return;
    var nonEmpty = saved.cells.filter(function(c) { return c.length > 0; });
    if (nonEmpty.length === 0) return;

    nonEmpty.forEach(function(tabs, i) {
      var cell;
      if (i === 0) {
        cell = _cells[0];
      } else {
        _splitDir = saved.dir || 'h';
        cell = _createCell();
        _cells.push(cell);
      }
      tabs.forEach(function(t) { _addTab(cell, t.filePath, t.fileName, t.fileType); });
    });
    if (nonEmpty.length > 1) _render();
  }

  // ── Init ──

  function init() {
    var c = _createCell();
    _cells.push(c);
    _render();

    // Global dragend: clean up all shields if drag is cancelled
    document.addEventListener('dragend', function() {
      document.querySelectorAll('.cell-drag-shield').forEach(function(s) { s.classList.remove('active'); });
      document.querySelectorAll('.drop-highlight').forEach(function(h) { h.classList.remove('visible'); });
    });
  }

  AB.panels = {
    init: init,
    selectSession: selectSession,
    switchSession: switchSession,
    openViewer: openViewer,
    closeAllViewers: closeAllViewers
  };

})(window.AB = window.AB || {});
