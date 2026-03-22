// ── Layout & Sidebar Management ──

let activeTab = null;
let sidebarWidth = parseInt(localStorage.getItem('sidebarWidth')) || 220;

// ── Sidebar Collapsible Sections ──

function initSidebarSections() {
  document.querySelectorAll('.sidebar-section-header').forEach(function(header) {
    header.addEventListener('click', function() {
      var section = header.parentElement;
      section.classList.toggle('collapsed');
      var name = header.dataset.section;
      var collapsed = section.classList.contains('collapsed');
      localStorage.setItem('sidebar-' + name, collapsed ? 'collapsed' : 'expanded');
    });
    // Restore saved state
    var name = header.dataset.section;
    var saved = localStorage.getItem('sidebar-' + name);
    if (saved === 'collapsed') {
      header.parentElement.classList.add('collapsed');
    }
  });
}

// ── Panel System ──

var _panels = [];       // [{id, type, sessionId, filePath, fileName, fileType, el}]
var _panelCounter = 0;
var _terminalPanelId = null; // the panel that holds the terminal card
var MAX_PANELS = 4;
var _sessionPanels = {};  // sessionId -> [{filePath, fileName, fileType}] saved viewer panels per session

function getTerminalPanel() {
  return _panels.find(function(p) { return p.id === _terminalPanelId; });
}

function ensureTerminalPanel() {
  // Create or return the terminal panel
  if (_terminalPanelId) {
    var existing = _panels.find(function(p) { return p.id === _terminalPanelId; });
    if (existing) return existing;
  }
  var panel = createPanel('terminal', {});
  _terminalPanelId = panel.id;
  return panel;
}

function createPanel(type, data) {
  if (_panels.length >= MAX_PANELS) return null;

  _panelCounter++;
  var panelId = 'panel-' + _panelCounter;
  var container = document.getElementById('panel-container');

  // Add resize handle if not first panel
  if (_panels.length > 0) {
    var handle = document.createElement('div');
    handle.className = 'panel-resize';
    handle.id = 'resize-' + panelId;
    container.appendChild(handle);
  }

  // Create panel element
  var el = document.createElement('div');
  el.className = 'panel';
  el.id = panelId;
  el.dataset.panelType = type;

  // Header
  var header = document.createElement('div');
  header.className = 'panel-header';

  var title = document.createElement('span');
  title.className = 'panel-title';

  if (type === 'terminal') {
    title.textContent = 'Terminal';
  } else {
    title.textContent = (data && data.fileName) || 'Viewer';
  }

  header.appendChild(title);

  // Close button (not for terminal panel if it's the only one)
  if (type !== 'terminal') {
    var closeBtn = document.createElement('button');
    closeBtn.className = 'panel-close';
    closeBtn.innerHTML = '&times;';
    closeBtn.title = 'Close panel';
    (function(pid) {
      closeBtn.onclick = function() { closePanel(pid); };
    })(panelId);
    header.appendChild(closeBtn);
  }

  el.appendChild(header);

  // Body
  var body = document.createElement('div');
  body.className = 'panel-body';
  el.appendChild(body);

  container.appendChild(el);

  var panelObj = {
    id: panelId,
    type: type,
    sessionId: data ? data.sessionId : null,
    filePath: data ? data.filePath : null,
    fileName: data ? data.fileName : null,
    fileType: data ? data.fileType : null,
    el: el,
    body: body,
    titleEl: title
  };

  _panels.push(panelObj);

  // Bind resize handles
  if (_panels.length > 1) {
    var handle = document.getElementById('resize-' + panelId);
    var leftPanel = _panels[_panels.length - 2];
    bindPanelResize(handle, leftPanel.el, el);
  }

  return panelObj;
}

function closePanel(panelId) {
  // Don't close the terminal panel
  if (panelId === _terminalPanelId) return;

  var idx = _panels.findIndex(function(p) { return p.id === panelId; });
  if (idx === -1) return;

  var panel = _panels[idx];
  var filePath = panel.filePath;

  // Remove from array first
  _panels.splice(idx, 1);

  // Rebuild DOM: nuke container, re-add remaining panels with fresh handles
  var container = document.getElementById('panel-container');
  while (container.firstChild) container.removeChild(container.firstChild);

  _panels.forEach(function(p, i) {
    if (i > 0) {
      var handle = document.createElement('div');
      handle.className = 'panel-resize';
      handle.id = 'resize-' + p.id;
      container.appendChild(handle);
    }
    p.el.style.flex = '1';
    p.el.style.flexBasis = '';
    container.appendChild(p.el);
  });

  // Rebind resize handles
  for (var i = 1; i < _panels.length; i++) {
    var h = document.getElementById('resize-' + _panels[i].id);
    if (h) bindPanelResize(h, _panels[i - 1].el, _panels[i].el);
  }

  // Update session panel state
  if (activeTab && _sessionPanels[activeTab] && filePath) {
    _sessionPanels[activeTab] = _sessionPanels[activeTab].filter(function(s) {
      return s.filePath !== filePath;
    });
  }

  if (typeof sendResize === 'function') sendResize();
}

function openFileInPanel(filePath, fileName) {
  if (!filePath || !fileName) return;

  // Determine file type
  var ext = fileName.split('.').pop().toLowerCase();
  var fileType = 'code';
  if (ext === 'pdf') fileType = 'pdf';
  else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].indexOf(ext) !== -1) fileType = 'image';
  else if (ext === 'md') fileType = 'markdown';

  // Check if this file is already open in a panel
  var existing = _panels.find(function(p) {
    return p.type === 'viewer' && p.filePath === filePath;
  });
  if (existing) {
    // Already open — just focus it visually
    existing.el.classList.add('panel-focus');
    setTimeout(function() { existing.el.classList.remove('panel-focus'); }, 500);
    return;
  }

  // Check max panels
  if (_panels.length >= MAX_PANELS) {
    alert('Maximum ' + MAX_PANELS + ' panels. Close one first.');
    return;
  }

  var panel = createPanel('viewer', {
    filePath: filePath,
    fileName: fileName,
    fileType: fileType
  });

  if (!panel) return;

  var body = panel.body;

  if (fileType === 'pdf') {
    loadPDFInPanel(body, filePath);
  } else if (fileType === 'image') {
    loadImageInPanel(body, filePath);
  } else if (fileType === 'markdown') {
    loadCodeInPanel(body, filePath, fileName, ext, true);
  } else {
    loadCodeInPanel(body, filePath, fileName, ext, false);
  }
}

function loadPDFInPanel(body, filePath) {
  var url = '/api/file-raw?path=' + encodeURIComponent(filePath);
  body.classList.add('viewer-content');

  var viewer = document.createElement('div');
  viewer.className = 'panel-pdf-viewer';
  viewer.innerHTML =
    '<div class="panel-pdf-nav">' +
      '<button class="sp-btn panel-pdf-prev">Prev</button>' +
      '<span class="panel-pdf-info">Loading...</span>' +
      '<button class="sp-btn panel-pdf-next">Next</button>' +
    '</div>' +
    '<div class="panel-pdf-canvas-wrap"></div>';
  body.appendChild(viewer);

  pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  pdfjsLib.getDocument(url).promise.then(function(pdf) {
    var currentPage = 1;
    var info = viewer.querySelector('.panel-pdf-info');
    info.textContent = pdf.numPages + ' pages';

    var wrap = viewer.querySelector('.panel-pdf-canvas-wrap');

    // Render all pages
    var containerWidth = wrap.clientWidth || 500;
    var dpr = window.devicePixelRatio || 1;

    for (var p = 1; p <= pdf.numPages; p++) {
      (function(pageNum) {
        var canvas = document.createElement('canvas');
        canvas.className = 'sp-pdf-page';
        canvas.id = 'panel-pdf-page-' + pageNum + '-' + Date.now();
        wrap.appendChild(canvas);

        pdf.getPage(pageNum).then(function(page) {
          var ctx = canvas.getContext('2d');
          var baseViewport = page.getViewport({ scale: 1 });
          var scale = containerWidth / baseViewport.width;
          var viewport = page.getViewport({ scale: scale * dpr });
          canvas.width = viewport.width;
          canvas.height = viewport.height;
          canvas.style.width = (viewport.width / dpr) + 'px';
          canvas.style.height = (viewport.height / dpr) + 'px';
          page.render({ canvasContext: ctx, viewport: viewport });
        });
      })(p);
    }

    // Navigation
    viewer.querySelector('.panel-pdf-prev').onclick = function() {
      if (currentPage > 1) {
        currentPage--;
        var el = wrap.querySelectorAll('.sp-pdf-page')[currentPage - 1];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        info.textContent = currentPage + ' / ' + pdf.numPages;
      }
    };
    viewer.querySelector('.panel-pdf-next').onclick = function() {
      if (currentPage < pdf.numPages) {
        currentPage++;
        var el = wrap.querySelectorAll('.sp-pdf-page')[currentPage - 1];
        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
        info.textContent = currentPage + ' / ' + pdf.numPages;
      }
    };

    // Track current page on scroll
    wrap.onscroll = function() {
      var pages = wrap.querySelectorAll('.sp-pdf-page');
      var wrapTop = wrap.scrollTop + wrap.clientHeight / 3;
      for (var i = pages.length - 1; i >= 0; i--) {
        if (pages[i].offsetTop <= wrapTop) {
          currentPage = i + 1;
          info.textContent = currentPage + ' / ' + pdf.numPages;
          break;
        }
      }
    };
  }).catch(function() {
    viewer.querySelector('.panel-pdf-info').textContent = 'Failed to load PDF';
  });
}

function loadImageInPanel(body, filePath) {
  body.classList.add('viewer-content');
  var img = document.createElement('img');
  img.src = '/api/file-raw?path=' + encodeURIComponent(filePath);
  img.style.maxWidth = '100%';
  img.style.height = 'auto';
  img.style.display = 'block';
  img.style.margin = '10px auto';
  body.appendChild(img);
}

function loadCodeInPanel(body, filePath, fileName, ext, isMarkdown) {
  body.classList.add('viewer-content');
  body.style.position = 'relative';

  // Toolbar
  var toolbar = document.createElement('div');
  toolbar.className = 'panel-editor-bar';

  var nameSpan = document.createElement('span');
  nameSpan.className = 'panel-editor-name';
  nameSpan.textContent = fileName;
  nameSpan.title = filePath;
  toolbar.appendChild(nameSpan);

  if (isMarkdown) {
    var previewBtn = document.createElement('button');
    previewBtn.className = 'sp-btn';
    previewBtn.textContent = 'Preview';
    toolbar.appendChild(previewBtn);
  }

  var saveBtn = document.createElement('button');
  saveBtn.className = 'sp-btn';
  saveBtn.textContent = 'Save';
  toolbar.appendChild(saveBtn);

  body.appendChild(toolbar);

  // Editor area
  var editorWrap = document.createElement('div');
  editorWrap.className = 'panel-editor-wrap';
  body.appendChild(editorWrap);

  // Preview area (for markdown)
  var previewDiv = null;
  if (isMarkdown) {
    previewDiv = document.createElement('div');
    previewDiv.className = 'panel-editor-preview';
    previewDiv.style.display = 'none';
    body.appendChild(previewDiv);
  }

  // Load file content
  apiGet('/api/file?path=' + encodeURIComponent(filePath))
    .then(function(data) {
      var cmModes = {
        tex: 'stex', sty: 'stex', cls: 'stex', bib: 'stex',
        js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
        py: 'python', css: 'css', html: 'htmlmixed', xml: 'xml',
        md: 'markdown', yml: 'yaml', yaml: 'yaml',
        sh: 'shell', bash: 'shell', zsh: 'shell',
        sql: 'sql', json: { name: 'javascript', json: true }
      };
      var mode = cmModes[ext] || 'text';
      var dirty = false;

      if (typeof CodeMirror !== 'undefined') {
        var cm = CodeMirror(editorWrap, {
          value: data.content || '',
          mode: mode,
          theme: 'material-darker',
          lineNumbers: true,
          matchBrackets: true,
          autoCloseBrackets: true,
          indentUnit: 2,
          tabSize: 2,
          indentWithTabs: false,
          lineWrapping: true,
          extraKeys: {
            'Ctrl-S': function() { doSave(); },
            'Cmd-S': function() { doSave(); }
          }
        });
        cm.on('change', function() { dirty = true; });
        cm.getWrapperElement().style.flex = '1';
        cm.getWrapperElement().style.overflow = 'hidden';
        setTimeout(function() { cm.refresh(); }, 100);

        // Save function
        function doSave() {
          var content = cm.getValue();
          apiPost('/api/file', { path: filePath, content: content })
            .then(function(r) { return r.json(); })
            .then(function(d) {
              if (d.ok) {
                dirty = false;
                nameSpan.style.color = '#3fb950';
                setTimeout(function() { nameSpan.style.color = ''; }, 1500);
              } else {
                alert('Save failed: ' + (d.error || 'unknown'));
              }
            });
        }

        saveBtn.onclick = doSave;

        // Markdown preview toggle
        if (isMarkdown && previewBtn && previewDiv) {
          var showingPreview = false;
          previewBtn.onclick = function() {
            showingPreview = !showingPreview;
            previewBtn.classList.toggle('active', showingPreview);
            if (showingPreview) {
              cm.getWrapperElement().style.display = 'none';
              previewDiv.style.display = 'block';
              previewDiv.style.flex = '1';
              previewDiv.style.overflow = 'auto';
              if (typeof renderMarkdownPreview === 'function') {
                var html;
                if (typeof marked !== 'undefined') {
                  html = marked.parse(cm.getValue());
                } else {
                  html = '<pre>' + cm.getValue() + '</pre>';
                }
                previewDiv.innerHTML = html;
              }
            } else {
              cm.getWrapperElement().style.display = '';
              previewDiv.style.display = 'none';
              cm.refresh();
            }
          };
        }
      } else {
        // Fallback textarea
        var ta = document.createElement('textarea');
        ta.className = 'panel-editor-textarea';
        ta.value = data.content || '';
        ta.addEventListener('input', function() { dirty = true; });
        editorWrap.appendChild(ta);

        saveBtn.onclick = function() {
          apiPost('/api/file', { path: filePath, content: ta.value })
            .then(function(r) { return r.json(); })
            .then(function(d) {
              if (d.ok) {
                dirty = false;
                nameSpan.style.color = '#3fb950';
                setTimeout(function() { nameSpan.style.color = ''; }, 1500);
              }
            });
        };
      }
    })
    .catch(function() {
      editorWrap.innerHTML = '<div style="padding:10px;color:#f87171">Cannot open file</div>';
    });
}

// ── Panel Resize ──

function bindPanelResize(handle, leftPanel, rightPanel) {
  handle.addEventListener('mousedown', function(e) {
    e.preventDefault();
    handle.classList.add('dragging');

    var container = document.getElementById('panel-container');
    var containerRect = container.getBoundingClientRect();
    var startX = e.clientX;
    var leftStart = leftPanel.getBoundingClientRect().width;
    var rightStart = rightPanel.getBoundingClientRect().width;
    var totalWidth = leftStart + rightStart;

    function onMove(e) {
      var dx = e.clientX - startX;
      var newLeft = leftStart + dx;
      var newRight = rightStart - dx;

      // Enforce minimums
      if (newLeft < 200) { newLeft = 200; newRight = totalWidth - 200; }
      if (newRight < 200) { newRight = 200; newLeft = totalWidth - 200; }

      // Set as flex-basis percentages relative to container
      var containerW = containerRect.width;
      leftPanel.style.flex = '0 0 ' + newLeft + 'px';
      rightPanel.style.flex = '0 0 ' + newRight + 'px';
    }

    function onUp() {
      handle.classList.remove('dragging');
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseup', onUp);

      // Refresh CodeMirror instances in both panels
      [leftPanel, rightPanel].forEach(function(p) {
        var cms = p.querySelectorAll('.CodeMirror');
        cms.forEach(function(w) {
          if (w.CodeMirror) w.CodeMirror.refresh();
        });
      });

      if (typeof sendResize === 'function') sendResize();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}

// ── Session Sidebar ──

function renderSidebar() {
  var list = document.getElementById('session-list');
  if (!list) return;

  var items = list.querySelectorAll('.session-item');
  var existingIds = {};
  items.forEach(function(el) { existingIds[el.dataset.id] = el; });

  // Get all session IDs from _prevStatuses (or _cardElements)
  var ids = Object.keys(_cardElements || {});
  if (ids.length === 0) {
    // No sessions — leave list empty
    return;
  }

  ids.forEach(function(id) {
    var item = existingIds[id];
    if (!item) return; // session-item created in ensureCard

    var state = getEffectiveState(id);
    var info = _workerInfo[id] || {};
    var cwd = item.dataset.cwd || '';
    var folder = cwd.replace(/\/$/, '').split('/').pop() || cwd;

    // Update status dot
    var dot = item.querySelector('.session-dot');
    if (dot) {
      dot.className = 'session-dot ' + state;
    }

    // Update state badge
    var badge = item.querySelector('.session-badge');
    if (badge) {
      badge.className = 'session-badge ' + state;
      badge.textContent = state;
    }

    // Update cwd
    var cwdEl = item.querySelector('.session-cwd');
    if (cwdEl) cwdEl.textContent = displayPath(cwd);

    // Active class
    item.classList.toggle('active', String(activeTab) === String(id));
  });
}

function _saveSessionPanels() {
  if (!activeTab) return;
  var viewers = [];
  _panels.forEach(function(p) {
    if (p.type === 'viewer' && p.filePath) {
      viewers.push({ filePath: p.filePath, fileName: p.fileName, fileType: p.fileType });
    }
  });
  _sessionPanels[activeTab] = viewers;
}

function _clearViewerPanels() {
  var container = document.getElementById('panel-container');
  if (!container) return;

  var termPanel = _panels.find(function(p) { return p.id === _terminalPanelId; });

  // Nuke everything from container
  while (container.firstChild) container.removeChild(container.firstChild);

  // Re-add only the terminal panel
  if (termPanel) {
    container.appendChild(termPanel.el);
    termPanel.el.style.flex = '1';
    termPanel.el.style.flexBasis = '';
    _panels = [termPanel];
  } else {
    _panels = [];
  }
}

function _restoreSessionPanels(sessionId) {
  var saved = _sessionPanels[sessionId];
  if (!saved || saved.length === 0) return;
  saved.forEach(function(s) {
    openFileInPanel(s.filePath, s.fileName);
  });
}

function selectSession(id) {
  // Save current session's viewer panels
  if (activeTab && activeTab !== id) {
    _saveSessionPanels();
    _clearViewerPanels();
  }

  activeTab = id;

  // Update sidebar active state
  document.querySelectorAll('.session-item').forEach(function(el) {
    el.classList.toggle('active', el.dataset.id === String(id));
  });

  // Ensure terminal panel exists
  var termPanel = ensureTerminalPanel();
  var body = termPanel.body;

  // Hide all cards in the terminal panel body
  var cards = body.querySelectorAll('.card');
  cards.forEach(function(c) { c.style.display = 'none'; });

  // Show the selected card
  var card = _cardElements[id];
  if (card) {
    if (card.parentElement !== body) {
      body.appendChild(card);
    }
    card.style.display = 'flex';
    card.classList.add('status-seen');
  }

  // Update terminal panel title
  var sessionItem = document.querySelector('.session-item[data-id="' + id + '"]');
  if (sessionItem && termPanel.titleEl) {
    var titleText = sessionItem.querySelector('.session-title');
    termPanel.titleEl.textContent = titleText ? titleText.textContent : 'Terminal #' + id;
  }

  // Notify server to poll this session immediately
  if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'active', id: id }));

  // Refresh explorer file browser for new tab
  if (typeof refreshSPFiles === 'function') {
    _spBrowseInitialized[id] = false;
    refreshSPFiles();
  }

  // Restore viewer panels for this session
  _restoreSessionPanels(id);

  // Scroll logs to bottom after card becomes visible
  requestAnimationFrame(function() {
    var card = _cardElements[id];
    if (card) {
      var box = card.querySelector('.logs');
      if (box) box.scrollTop = box.scrollHeight;
    }
  });
}

// Backward compat alias
function selectTab(id) { selectSession(id); }

function switchTab(delta) {
  var items = Array.from(document.querySelectorAll('.session-item'));
  if (!items.length) return;
  if (!activeTab) {
    selectSession(items[0].dataset.id);
    return;
  }
  var idx = items.findIndex(function(el) { return el.dataset.id === String(activeTab); });
  var next = idx === -1 ? 0 : (idx + delta + items.length) % items.length;
  selectSession(items[next].dataset.id);
}

// ── State helpers ──

function getEffectiveState(id) {
  var status = _prevStatuses[id] || 'running';
  if (status === 'stopped' || status === 'completed') return status;
  var aiState = _prevAIStates[id];
  if (aiState === 'waiting') return 'waiting';
  if (aiState === 'idle') return 'idle';
  return 'running';
}

// ── Summary Bar ──

function updateSummaryBar() {
  var bar = document.getElementById('summary-bar');
  if (!bar) return;

  var ids = Object.keys(_cardElements || {});
  if (ids.length === 0) { bar.innerHTML = ''; return; }

  var counts = { running: 0, waiting: 0, idle: 0, completed: 0, stopped: 0 };
  ids.forEach(function(id) {
    var state = getEffectiveState(id);
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

// ── Sidebar Resize ──

function initSidebarDrag() {
  var handle = document.getElementById('sidebar-drag');
  var sidebar = document.getElementById('sidebar');
  if (!handle || !sidebar) return;

  // Apply saved width
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
      sendResize();
    }

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseup', onUp);
  });
}
