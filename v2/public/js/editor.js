// ── Editor: CodeMirror / PDF / Image Viewer in Panels ──

(function(AB) {

  // Track open panels for refresh
  var _openEditors = {}; // panelId → { filePath, fileName, ext, type, cm, reload }

  function openFileInPanel(filePath, fileName) {
    if (!filePath || !fileName) return;
    var ext = fileName.split('.').pop().toLowerCase();
    var fileType = 'code';
    if (ext === 'pdf') fileType = 'pdf';
    else if (['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'].indexOf(ext) !== -1) fileType = 'image';
    else if (ext === 'md') fileType = 'markdown';

    // Delegate to panels.openViewer — it handles tabs and dedup
    AB.panels.openViewer(filePath, fileName, fileType);
  }

  // ── PDF Viewer with zoom ──

  function loadPDF(body, filePath, panelId) {
    var url = '/api/file-raw?path=' + encodeURIComponent(filePath);
    body.classList.add('viewer-content');
    var viewer = document.createElement('div');
    viewer.className = 'panel-pdf-viewer';
    viewer.innerHTML =
      '<div class="panel-pdf-nav">' +
        '<button class="sp-btn panel-pdf-prev">Prev</button>' +
        '<button class="sp-btn panel-pdf-zoom-out">&minus;</button>' +
        '<span class="panel-pdf-info">Loading...</span>' +
        '<button class="sp-btn panel-pdf-zoom-in">&plus;</button>' +
        '<button class="sp-btn panel-pdf-next">Next</button>' +
        '<button class="sp-btn panel-pdf-refresh" title="Refresh">&#8635;</button>' +
      '</div>' +
      '<div class="panel-pdf-canvas-wrap"></div>';
    body.appendChild(viewer);

    var zoomLevel = 1.0;
    var pdfDoc = null;
    var currentPage = 1;

    function renderAllPages() {
      var wrap = viewer.querySelector('.panel-pdf-canvas-wrap');
      var info = viewer.querySelector('.panel-pdf-info');
      wrap.innerHTML = '';
      if (!pdfDoc) return;
      info.textContent = currentPage + ' / ' + pdfDoc.numPages + ' (' + Math.round(zoomLevel * 100) + '%)';
      var containerWidth = wrap.clientWidth || 500;
      var dpr = window.devicePixelRatio || 1;

      for (var p = 1; p <= pdfDoc.numPages; p++) {
        (function(pageNum) {
          var canvas = document.createElement('canvas');
          canvas.className = 'sp-pdf-page';
          wrap.appendChild(canvas);
          pdfDoc.getPage(pageNum).then(function(page) {
            var baseViewport = page.getViewport({ scale: 1 });
            var scale = (containerWidth / baseViewport.width) * zoomLevel;
            var viewport = page.getViewport({ scale: scale * dpr });
            canvas.width = viewport.width;
            canvas.height = viewport.height;
            canvas.style.width = (viewport.width / dpr) + 'px';
            canvas.style.height = (viewport.height / dpr) + 'px';
            page.render({ canvasContext: canvas.getContext('2d'), viewport: viewport });
          });
        })(p);
      }
    }

    function loadDoc() {
      pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      // Add cache buster for refresh
      pdfjsLib.getDocument(url + '&t=' + Date.now()).promise.then(function(pdf) {
        pdfDoc = pdf;
        currentPage = 1;
        renderAllPages();

        var wrap = viewer.querySelector('.panel-pdf-canvas-wrap');
        wrap.onscroll = function() {
          var pages = wrap.querySelectorAll('.sp-pdf-page');
          var wrapTop = wrap.scrollTop + wrap.clientHeight / 3;
          for (var i = pages.length - 1; i >= 0; i--) {
            if (pages[i].offsetTop <= wrapTop) {
              currentPage = i + 1;
              viewer.querySelector('.panel-pdf-info').textContent = currentPage + ' / ' + pdfDoc.numPages + ' (' + Math.round(zoomLevel * 100) + '%)';
              break;
            }
          }
        };
      }).catch(function() {
        viewer.querySelector('.panel-pdf-info').textContent = 'Failed to load PDF';
      });
    }

    loadDoc();

    viewer.querySelector('.panel-pdf-prev').onclick = function() {
      if (!pdfDoc || currentPage <= 1) return;
      currentPage--;
      var pages = viewer.querySelectorAll('.sp-pdf-page');
      if (pages[currentPage - 1]) pages[currentPage - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
      viewer.querySelector('.panel-pdf-info').textContent = currentPage + ' / ' + pdfDoc.numPages + ' (' + Math.round(zoomLevel * 100) + '%)';
    };
    viewer.querySelector('.panel-pdf-next').onclick = function() {
      if (!pdfDoc || currentPage >= pdfDoc.numPages) return;
      currentPage++;
      var pages = viewer.querySelectorAll('.sp-pdf-page');
      if (pages[currentPage - 1]) pages[currentPage - 1].scrollIntoView({ behavior: 'smooth', block: 'start' });
      viewer.querySelector('.panel-pdf-info').textContent = currentPage + ' / ' + pdfDoc.numPages + ' (' + Math.round(zoomLevel * 100) + '%)';
    };
    viewer.querySelector('.panel-pdf-zoom-in').onclick = function() {
      zoomLevel = Math.min(zoomLevel + 0.25, 3.0);
      renderAllPages();
    };
    viewer.querySelector('.panel-pdf-zoom-out').onclick = function() {
      zoomLevel = Math.max(zoomLevel - 0.25, 0.5);
      renderAllPages();
    };
    viewer.querySelector('.panel-pdf-refresh').onclick = function() {
      loadDoc();
    };

    _openEditors[panelId] = { filePath: filePath, type: 'pdf', reload: loadDoc };
  }

  // ── Image Viewer ──

  function loadImage(body, filePath, panelId) {
    body.classList.add('viewer-content');
    var img = document.createElement('img');
    img.src = '/api/file-raw?path=' + encodeURIComponent(filePath) + '&t=' + Date.now();
    img.style.cssText = 'max-width:100%;height:auto;display:block;margin:10px auto';
    body.appendChild(img);

    _openEditors[panelId] = {
      filePath: filePath, type: 'image',
      reload: function() { img.src = '/api/file-raw?path=' + encodeURIComponent(filePath) + '&t=' + Date.now(); }
    };
  }

  // ── Code Editor ──

  function loadCode(body, filePath, fileName, ext, isMarkdown, panelId) {
    body.classList.add('viewer-content');
    body.style.position = 'relative';

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

    var refreshBtn = document.createElement('button');
    refreshBtn.className = 'sp-btn';
    refreshBtn.textContent = '\u21bb';
    refreshBtn.title = 'Reload from disk';
    toolbar.appendChild(refreshBtn);

    var saveBtn = document.createElement('button');
    saveBtn.className = 'sp-btn save-btn-highlight';
    saveBtn.textContent = '\u2b07 Save';
    toolbar.appendChild(saveBtn);

    body.appendChild(toolbar);

    var editorWrap = document.createElement('div');
    editorWrap.className = 'panel-editor-wrap';
    body.appendChild(editorWrap);

    var previewDiv = null;
    if (isMarkdown) {
      previewDiv = document.createElement('div');
      previewDiv.className = 'panel-editor-preview';
      previewDiv.style.display = 'none';
      body.appendChild(previewDiv);
    }

    var _cm = null;
    var _ta = null;
    var _dirty = false;

    function loadContent() {
      AB.api.get('/api/file?path=' + encodeURIComponent(filePath))
        .then(function(data) {
          var content = data.content || '';
          if (_cm) {
            var cursor = _cm.getCursor();
            _cm.setValue(content);
            _cm.setCursor(cursor);
            _dirty = false;
          } else if (_ta) {
            _ta.value = content;
            _dirty = false;
          } else {
            initEditor(content);
          }
          // Flash name green to indicate refresh
          nameSpan.style.color = '#58a6ff';
          setTimeout(function() { nameSpan.style.color = ''; }, 1000);
        })
        .catch(function() {
          if (!_cm && !_ta) {
            editorWrap.innerHTML = '<div style="padding:10px;color:#f87171">Cannot open file</div>';
          }
        });
    }

    function initEditor(content) {
      var cmModes = {
        tex: 'stex', sty: 'stex', cls: 'stex', bib: 'stex',
        js: 'javascript', jsx: 'javascript', ts: 'javascript', tsx: 'javascript',
        py: 'python', css: 'css', html: 'htmlmixed', xml: 'xml',
        md: 'markdown', yml: 'yaml', yaml: 'yaml',
        sh: 'shell', bash: 'shell', zsh: 'shell',
        sql: 'sql', json: { name: 'javascript', json: true }
      };
      var mode = cmModes[ext] || 'text';

      if (typeof CodeMirror !== 'undefined') {
        _cm = CodeMirror(editorWrap, {
          value: content,
          mode: mode,
          theme: 'material-darker',
          lineNumbers: true,
          matchBrackets: true,
          autoCloseBrackets: true,
          indentUnit: 2, tabSize: 2, indentWithTabs: false,
          lineWrapping: true,
          extraKeys: { 'Ctrl-S': doSave, 'Cmd-S': doSave }
        });
        _cm.getWrapperElement().style.flex = '1';
        _cm.getWrapperElement().style.overflow = 'hidden';
        _cm.on('change', function() { _dirty = true; updateSaveBtn(); });
        setTimeout(function() { _cm.refresh(); }, 100);

        if (isMarkdown && previewBtn && previewDiv) {
          var showingPreview = false;
          previewBtn.onclick = function() {
            showingPreview = !showingPreview;
            previewBtn.classList.toggle('active', showingPreview);
            if (showingPreview) {
              _cm.getWrapperElement().style.display = 'none';
              previewDiv.style.display = 'block';
              previewDiv.style.flex = '1';
              previewDiv.style.overflow = 'auto';
              previewDiv.innerHTML = typeof marked !== 'undefined' ? marked.parse(_cm.getValue()) : '<pre>' + _cm.getValue() + '</pre>';
            } else {
              _cm.getWrapperElement().style.display = '';
              previewDiv.style.display = 'none';
              _cm.refresh();
            }
          };
        }
      } else {
        _ta = document.createElement('textarea');
        _ta.className = 'panel-editor-textarea';
        _ta.value = content;
        _ta.addEventListener('input', function() { _dirty = true; updateSaveBtn(); });
        editorWrap.appendChild(_ta);
      }
    }

    function doSave() {
      var content = _cm ? _cm.getValue() : (_ta ? _ta.value : '');
      AB.api.post('/api/file', { path: filePath, content: content })
        .then(function(r) { return r.json(); })
        .then(function(d) {
          if (d.ok) {
            _dirty = false;
            updateSaveBtn();
            nameSpan.style.color = '#3fb950';
            setTimeout(function() { nameSpan.style.color = ''; }, 1500);
          } else {
            alert('Save failed: ' + (d.error || 'unknown'));
          }
        });
    }

    function updateSaveBtn() {
      if (_dirty) {
        saveBtn.textContent = '\u25cf Save';
        saveBtn.classList.add('save-dirty');
      } else {
        saveBtn.textContent = '\u2b07 Save';
        saveBtn.classList.remove('save-dirty');
      }
    }

    saveBtn.onclick = doSave;
    refreshBtn.onclick = loadContent;

    loadContent();

    _openEditors[panelId] = { filePath: filePath, type: 'code', cm: function() { return _cm; }, reload: loadContent };
  }

  // Clean up when panel closes
  function onPanelClose(panelId) {
    delete _openEditors[panelId];
  }

  AB.editor = { openFileInPanel: openFileInPanel, loadPDF: loadPDF, loadImage: loadImage, loadCode: loadCode, onPanelClose: onPanelClose };

})(window.AB = window.AB || {});
