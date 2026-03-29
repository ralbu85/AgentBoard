// ── xterm.js Terminal — single renderer for all platforms ──
// No mobile/desktop split. xterm.js everywhere.

(function(AB) {

  var terminals = {};
  var _isMobile = window.innerWidth <= 768;

  function _autoScroll(t) {
    if (!t.term) return;
    var buf = t.term.buffer.active;
    if (buf.viewportY >= buf.baseY) t.term.scrollToBottom();
  }

  function create(id) {
    if (terminals[id]) return terminals[id];

    var term = new Terminal({
      cursorBlink: true,
      cursorStyle: 'bar',
      disableStdin: false,
      scrollback: 10000,
      fontSize: _isMobile ? 11 : 13,
      letterSpacing: 0,
      fontFamily: '"D2Coding", "Cascadia Code", "Cascadia Mono", "Consolas", monospace',
      theme: {
        background: '#0d1117', foreground: '#e6edf3', cursor: '#e6edf3',
        selectionBackground: '#264f78',
        black: '#484f58', red: '#ff7b72', green: '#3fb950', yellow: '#d29922',
        blue: '#58a6ff', magenta: '#bc8cff', cyan: '#39d353', white: '#e6edf3',
        brightBlack: '#6e7681', brightRed: '#ffa198', brightGreen: '#56d364',
        brightYellow: '#e3b341', brightBlue: '#79c0ff', brightMagenta: '#d2a8ff',
        brightCyan: '#56d364', brightWhite: '#f0f6fc'
      },
      allowProposedApi: true
    });

    var FitAddonClass = (typeof FitAddon === 'function') ? FitAddon : FitAddon.FitAddon;
    var fitAddon = new FitAddonClass();
    term.loadAddon(fitAddon);

    var SearchAddonClass = (typeof SearchAddon === 'function') ? SearchAddon : SearchAddon.SearchAddon;
    var searchAddon = new SearchAddonClass();
    term.loadAddon(searchAddon);

    var WebLinksAddonClass = (typeof WebLinksAddon === 'function') ? WebLinksAddon : WebLinksAddon.WebLinksAddon;
    term.loadAddon(new WebLinksAddonClass());

    if (typeof Unicode11Addon !== 'undefined') {
      var Uni11 = (typeof Unicode11Addon === 'function') ? Unicode11Addon : Unicode11Addon.Unicode11Addon;
      term.loadAddon(new Uni11());
      term.unicode.activeVersion = '11';
    }

    // Desktop: direct keyboard input to tmux
    if (!_isMobile) {
      term.onData(function(data) {
        if (AB.ws) AB.ws.send({ type: 'terminal-input', id: id, data: data });
      });
    }

    var el = document.createElement('div');
    el.className = 'xterm-wrap';
    el.id = 'xterm-' + id;
    el.style.display = 'none';

    terminals[id] = {
      term: term, fitAddon: fitAddon, searchAddon: searchAddon,
      el: el, opened: false,
      _pendingSnapshot: null,
      _pendingStream: ''
    };
    return terminals[id];
  }

  function open(id, container) {
    var t = terminals[id];
    if (!t) return;
    if (!t.opened) {
      container.appendChild(t.el);
      t.term.open(t.el);
      t.opened = true;
      // Mobile: xterm sets touch-action:none AND adds touchmove→preventDefault()
      // Override both: set pan-y + block xterm's touch handlers entirely
      if (_isMobile) {
        var vp = t.el.querySelector('.xterm-viewport');
        if (vp) {
          vp.style.touchAction = 'pan-y';
          ['touchstart', 'touchmove', 'touchend'].forEach(function(evt) {
            vp.addEventListener(evt, function(e) { e.stopImmediatePropagation(); }, { capture: true, passive: true });
          });
        }
      }
      // Flush pending data
      if (t._pendingSnapshot) {
        writeSnapshot(id, t._pendingSnapshot);
        t._pendingSnapshot = null;
      }
      if (t._pendingStream) {
        writeStream(id, t._pendingStream);
        t._pendingStream = '';
      }
    } else if (t.el.parentElement !== container) {
      container.appendChild(t.el);
    }
  }

  // ── Snapshot: initial terminal state (capture-pane, one time) ──

  function writeSnapshot(id, data) {
    var t = terminals[id];
    if (!t) t = create(id);
    if (!t.opened) { t._pendingSnapshot = data; return; }

    var t0 = Date.now();
    // Server already converts \n → \r\n
    t.term.write('\x1b[2J\x1b[H' + data, function() {
      // After write completes, always scroll to bottom (session switch = latest content)
      t.term.scrollToBottom();
    });
    if (AB._perfMarkRender) AB._perfMarkRender('snapshot', data.length, Date.now() - t0);
  }

  // ── Screen: active session polling update ──
  // Overwrite visible area in-place (no \x1b[2J — that pushes content into scrollback)
  // Skip if user is scrolled up reading history

  function writeScreen(id, data) {
    var t = terminals[id];
    if (!t || !t.opened) return;
    if (t.el.style.display === 'none') return;

    // Don't clobber view while user is reading scrollback
    var buf = t.term.buffer.active;
    if (buf.viewportY < buf.baseY) return;

    // Cursor home → overwrite each line → clear leftover lines below
    var lines = data.split('\r\n');
    var out = '\x1b[H';
    for (var i = 0; i < lines.length; i++) {
      out += lines[i] + '\x1b[K';
      if (i < lines.length - 1) out += '\r\n';
    }
    out += '\x1b[J';
    t.term.write(out);
  }

  // ── Stream: real-time output (legacy, kept for compat) ──

  function writeStream(id, data) {
    var t = terminals[id];
    if (!t) t = create(id);
    if (!t.opened) { t._pendingStream += data; return; }

    t.term.write(data);
    _autoScroll(t);
  }

  // Legacy compat
  function write(id, data) { writeSnapshot(id, data); }

  function show(id) {
    Object.keys(terminals).forEach(function(k) {
      terminals[k].el.style.display = (k === id) ? '' : 'none';
    });
    var t = terminals[id];
    if (t && t.opened) {
      requestAnimationFrame(function() {
        try { t.fitAddon.fit(); } catch(e) {}
      });
    }
  }

  function resize(id) {
    var t = terminals[id];
    if (!t || !t.opened) return null;
    try { t.fitAddon.fit(); return { cols: t.term.cols, rows: t.term.rows }; }
    catch(e) { return null; }
  }

  function resizeAll() {
    var r = {};
    Object.keys(terminals).forEach(function(id) {
      if (terminals[id].el.style.display !== 'none') r[id] = resize(id);
    });
    return r;
  }

  function search(id, q) { var t=terminals[id]; if(t&&t.searchAddon){if(q)t.searchAddon.findNext(q);else t.searchAddon.clearDecorations();} }
  function searchNext(id, q) { var t=terminals[id]; if(t&&t.searchAddon) t.searchAddon.findNext(q); }
  function searchPrev(id, q) { var t=terminals[id]; if(t&&t.searchAddon) t.searchAddon.findPrevious(q); }

  function destroy(id) {
    var t = terminals[id];
    if (!t) return;
    if (t.term) t.term.dispose();
    if (t.el.parentElement) t.el.parentElement.removeChild(t.el);
    delete terminals[id];
  }

  function get(id) { return terminals[id] || null; }

  AB.terminal = { create:create, open:open, write:write, writeSnapshot:writeSnapshot, writeScreen:writeScreen, writeStream:writeStream, show:show, resize:resize, resizeAll:resizeAll, search:search, searchNext:searchNext, searchPrev:searchPrev, destroy:destroy, get:get };

})(window.AB = window.AB || {});
