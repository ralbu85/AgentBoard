// ── xterm.js Terminal Wrapper ──
// Creates, manages, and resizes xterm.js Terminal instances per session.

(function(AB) {

  var terminals = {};  // id → { term, fitAddon, searchAddon, el, opened, lastData, pendingData }

  function create(id) {
    if (terminals[id]) return terminals[id];

    var term = new Terminal({
      cursorBlink: false,
      cursorStyle: 'bar',
      disableStdin: true,
      scrollback: 10000,
      fontSize: 13,
      fontFamily: '"Cascadia Code", "Cascadia Mono", "Consolas", monospace',
      theme: {
        background: '#0d1117',
        foreground: '#e6edf3',
        cursor: '#e6edf3',
        selectionBackground: '#264f78',
        black: '#484f58',
        red: '#ff7b72',
        green: '#3fb950',
        yellow: '#d29922',
        blue: '#58a6ff',
        magenta: '#bc8cff',
        cyan: '#39d353',
        white: '#e6edf3',
        brightBlack: '#6e7681',
        brightRed: '#ffa198',
        brightGreen: '#56d364',
        brightYellow: '#e3b341',
        brightBlue: '#79c0ff',
        brightMagenta: '#d2a8ff',
        brightCyan: '#56d364',
        brightWhite: '#f0f6fc'
      },
      allowProposedApi: true
    });

    // CDN UMD exports: addon could be the class itself or a namespace
    var FitAddonClass = (typeof FitAddon === 'function') ? FitAddon : FitAddon.FitAddon;
    var fitAddon = new FitAddonClass();
    term.loadAddon(fitAddon);

    var SearchAddonClass = (typeof SearchAddon === 'function') ? SearchAddon : SearchAddon.SearchAddon;
    var searchAddon = new SearchAddonClass();
    term.loadAddon(searchAddon);

    var WebLinksAddonClass = (typeof WebLinksAddon === 'function') ? WebLinksAddon : WebLinksAddon.WebLinksAddon;
    var webLinksAddon = new WebLinksAddonClass();
    term.loadAddon(webLinksAddon);

    var el = document.createElement('div');
    el.className = 'xterm-wrap';
    el.id = 'xterm-' + id;
    el.style.display = 'none';

    terminals[id] = {
      term: term, fitAddon: fitAddon, searchAddon: searchAddon,
      el: el, opened: false,
      lastData: null,    // last written data (for dedup)
      pendingData: null  // buffered data before open()
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
      // Flush pending data that arrived before open
      if (t.pendingData) {
        _doWrite(t, t.pendingData);
        t.pendingData = null;
      }
    } else if (t.el.parentElement !== container) {
      container.appendChild(t.el);
    }
  }

  function _doWrite(t, data) {
    // Convert \n to \r\n for xterm.js line breaks
    var converted = data.replace(/\r?\n/g, '\r\n');
    // \x1b[2J = clear screen, \x1b[3J = clear scrollback, \x1b[H = cursor home
    // Without \x1b[3J, each rewrite of 1000+ lines accumulates in scrollback
    t.term.write('\x1b[2J\x1b[3J\x1b[H' + converted);
    t.lastData = data;
  }

  function write(id, data) {
    var t = terminals[id];
    if (!t) {
      // Terminal not created yet — create and buffer
      t = create(id);
    }
    // Skip if data unchanged
    if (data === t.lastData) return;

    if (!t.opened) {
      // Buffer for later — will flush on open()
      t.pendingData = data;
      t.lastData = data;
      return;
    }
    _doWrite(t, data);
  }

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
    try {
      t.fitAddon.fit();
      return { cols: t.term.cols, rows: t.term.rows };
    } catch(e) {
      return null;
    }
  }

  function resizeAll() {
    var results = {};
    Object.keys(terminals).forEach(function(id) {
      if (terminals[id].el.style.display !== 'none') {
        results[id] = resize(id);
      }
    });
    return results;
  }

  function search(id, query) {
    var t = terminals[id];
    if (!t) return;
    if (query) {
      t.searchAddon.findNext(query, { decorations: { matchBackground: '#fbbf2444', activeMatchBackground: '#fbbf2488' } });
    } else {
      t.searchAddon.clearDecorations();
    }
  }

  function searchNext(id, query) {
    var t = terminals[id];
    if (t) t.searchAddon.findNext(query);
  }

  function searchPrev(id, query) {
    var t = terminals[id];
    if (t) t.searchAddon.findPrevious(query);
  }

  function destroy(id) {
    var t = terminals[id];
    if (!t) return;
    t.term.dispose();
    if (t.el.parentElement) t.el.parentElement.removeChild(t.el);
    delete terminals[id];
  }

  function get(id) {
    return terminals[id] || null;
  }

  AB.terminal = { create: create, open: open, write: write, show: show, resize: resize, resizeAll: resizeAll, search: search, searchNext: searchNext, searchPrev: searchPrev, destroy: destroy, get: get };

})(window.AB = window.AB || {});
