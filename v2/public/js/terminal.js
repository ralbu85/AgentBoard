// ── xterm.js Terminal Wrapper ──
// Desktop: xterm.js with GPU rendering
// Mobile: lightweight HTML <pre> rendering

(function(AB) {

  var terminals = {};
  var _isMobile = window.innerWidth <= 768;

  function create(id) {
    if (terminals[id]) return terminals[id];

    var el = document.createElement('div');
    el.className = 'xterm-wrap';
    el.id = 'xterm-' + id;
    el.style.display = 'none';

    if (_isMobile) {
      // Mobile: lightweight — no xterm.js objects
      terminals[id] = {
        term: null, fitAddon: null, searchAddon: null,
        el: el, opened: false, mobile: true,
        lastData: null, pendingData: null,
        _pre: null, _lastStripped: null
      };
      return terminals[id];
    }

    // Desktop: full xterm.js
    var term = new Terminal({
      cursorBlink: true, cursorStyle: 'bar', disableStdin: false,
      scrollback: 10000, fontSize: 13, letterSpacing: 0,
      fontFamily: '"Cascadia Code", "Cascadia Mono", "Consolas", monospace',
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

    term.onData(function(data) {
      if (AB.ws) AB.ws.send({ type: 'terminal-input', id: id, data: data });
    });

    terminals[id] = {
      term: term, fitAddon: fitAddon, searchAddon: searchAddon,
      el: el, opened: false, mobile: false,
      lastData: null, pendingData: null
    };
    return terminals[id];
  }

  function open(id, container) {
    var t = terminals[id];
    if (!t) return;
    if (!t.opened) {
      container.appendChild(t.el);
      if (t.term) t.term.open(t.el);
      t.opened = true;
      if (t.pendingData) { _doWrite(t, t.pendingData); t.pendingData = null; }
    } else if (t.el.parentElement !== container) {
      container.appendChild(t.el);
    }
  }

  function _doWrite(t, data) {
    if (t.mobile) {
      // Fast path: skip everything if raw data identical
      if (data === t.lastData) return;
      if (!t._pre) {
        t._pre = document.createElement('pre');
        t._pre.className = 'mobile-terminal-pre';
        t.el.appendChild(t._pre);
      }
      // Only process last 80 lines, trim right spaces
      var i, lines = data.split('\n'), start = Math.max(0, lines.length - 80);
      var buf = '';
      for (i = start; i < lines.length; i++) {
        if (i > start) buf += '\n';
        buf += lines[i].replace(/\s+$/, '');
      }
      t._pre.innerHTML = _ansiToHtml(buf);
      t._pre.scrollTop = t._pre.scrollHeight;
    } else {
      var lines = data.split('\n');
      var out = '';
      for (var i = 0; i < lines.length; i++) {
        if (i > 0) out += '\r\n';
        out += lines[i].replace(/\s+$/, '');
      }
      t.term.write('\x1b[2J\x1b[3J\x1b[H' + out, function() {
        t.term.scrollToBottom();
      });
    }
    t.lastData = data;
  }

  function _256color(n) {
    if (n < 8) return ['#484f58','#ff7b72','#3fb950','#d29922','#58a6ff','#bc8cff','#39d353','#e6edf3'][n];
    if (n < 16) return ['#6e7681','#ffa198','#56d364','#e3b341','#79c0ff','#d2a8ff','#56d364','#f0f6fc'][n-8];
    if (n < 232) { var i=n-16,r=Math.floor(i/36)*51,g=Math.floor((i%36)/6)*51,b=(i%6)*51; return 'rgb('+r+','+g+','+b+')'; }
    var v=(n-232)*10+8; return 'rgb('+v+','+v+','+v+')';
  }

  function _ansiToHtml(text) {
    return text
      .replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      .replace(/\x1b\[([0-9;]*)m/g, function(_,codes) {
        if (!codes||codes==='0'||codes==='39'||codes==='49') return '</span>';
        var p=codes.split(';'), s=[];
        for (var i=0;i<p.length;i++) {
          var c=parseInt(p[i]);
          if (c===1) s.push('font-weight:bold');
          else if (c===2) s.push('opacity:0.6');
          else if (c===3) s.push('font-style:italic');
          else if (c===4) s.push('text-decoration:underline');
          else if (c>=30&&c<=37) s.push('color:'+['#484f58','#ff7b72','#3fb950','#d29922','#58a6ff','#bc8cff','#39d353','#e6edf3'][c-30]);
          else if (c>=90&&c<=97) s.push('color:'+['#6e7681','#ffa198','#56d364','#e3b341','#79c0ff','#d2a8ff','#56d364','#f0f6fc'][c-90]);
          else if (c===38&&p[i+1]==='5'&&p[i+2]){s.push('color:'+_256color(parseInt(p[i+2])));i+=2;}
          else if (c===48&&p[i+1]==='5'&&p[i+2]){i+=2;}
          else if (c===38&&p[i+1]==='2'&&p[i+4]){s.push('color:rgb('+p[i+2]+','+p[i+3]+','+p[i+4]+')');i+=4;}
          else if (c===48&&p[i+1]==='2'&&p[i+4]){i+=4;}
        }
        return s.length?'<span style="'+s.join(';')+'">':'<span>';
      })
      .replace(/\x1b\[[0-9;]*[a-zA-Z]/g,'');
  }

  function write(id, data) {
    var t = terminals[id];
    if (!t) t = create(id);
    if (data === t.lastData) return;
    if (!t.opened) { t.pendingData = data; t.lastData = data; return; }
    _doWrite(t, data);
  }

  function show(id) {
    Object.keys(terminals).forEach(function(k) {
      terminals[k].el.style.display = (k === id) ? '' : 'none';
    });
    var t = terminals[id];
    if (!t || !t.opened) return;
    if (t.mobile) {
      if (t._pre) t._pre.scrollTop = t._pre.scrollHeight;
    } else {
      requestAnimationFrame(function() { try { t.fitAddon.fit(); } catch(e) {} });
    }
  }

  function resize(id) {
    var t = terminals[id];
    if (!t || !t.opened || t.mobile) return null;
    try { t.fitAddon.fit(); return { cols: t.term.cols, rows: t.term.rows }; }
    catch(e) { return null; }
  }

  function resizeAll() {
    var r = {};
    Object.keys(terminals).forEach(function(id) {
      if (terminals[id].el.style.display !== 'none' && !terminals[id].mobile) r[id] = resize(id);
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

  AB.terminal = { create:create, open:open, write:write, show:show, resize:resize, resizeAll:resizeAll, search:search, searchNext:searchNext, searchPrev:searchPrev, destroy:destroy, get:get };

})(window.AB = window.AB || {});
