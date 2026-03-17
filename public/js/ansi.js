// ── ANSI Escape → HTML Converter ──

var ANSI_COLORS = [
  '#0d1117','#f85149','#3fb950','#d29922','#58a6ff','#bc8cff','#39d2c0','#e6edf3',  // 0-7
  '#484f58','#ff7b72','#56d364','#e3b341','#79c0ff','#d2a8ff','#56d4dd','#ffffff'   // 8-15 (bright)
];

function isBoxLine(text) {
  var stripped = text.replace(/\x1b\[[0-9;]*m/g, '').trim();
  if (stripped.length < 10) return false;
  var boxes = stripped.replace(/[─━═╌╍┄┅┈┉╶╴╸╺─]/g, '');
  return boxes.length === 0;
}

function ansiToHtml(text) {
  if (isBoxLine(text)) return '<hr class="term-hr">';
  var result = '';
  var fg = null, bg = null, bold = false, dim = false, italic = false, underline = false, strikethrough = false;
  var i = 0;
  var spanOpen = false;

  function buildSpan() {
    var styles = [];
    if (fg !== null) styles.push('color:' + fg);
    if (bg !== null) styles.push('background:' + bg);
    if (bold) styles.push('font-weight:bold');
    if (dim) styles.push('opacity:0.6');
    if (italic) styles.push('font-style:italic');
    if (underline) styles.push('text-decoration:underline');
    if (strikethrough) styles.push('text-decoration:line-through');
    if (styles.length === 0) return '';
    return '<span style="' + styles.join(';') + '">';
  }

  function closeSpan() {
    if (spanOpen) { result += '</span>'; spanOpen = false; }
  }

  function openSpan() {
    var tag = buildSpan();
    if (tag) { result += tag; spanOpen = true; }
  }

  function color256(n) {
    if (n < 16) return ANSI_COLORS[n];
    if (n < 232) {
      n -= 16;
      var r = Math.floor(n / 36) * 51;
      var g = Math.floor((n % 36) / 6) * 51;
      var b = (n % 6) * 51;
      return 'rgb(' + r + ',' + g + ',' + b + ')';
    }
    var v = (n - 232) * 10 + 8;
    return 'rgb(' + v + ',' + v + ',' + v + ')';
  }

  function escapeHtml(ch) {
    if (ch === '<') return '&lt;';
    if (ch === '>') return '&gt;';
    if (ch === '&') return '&amp;';
    if (ch === '"') return '&quot;';
    return ch;
  }

  while (i < text.length) {
    if (text[i] === '\x1b' && text[i + 1] === '[') {
      // Parse CSI sequence
      var j = i + 2;
      while (j < text.length && text[j] !== 'm' && j - i < 20) j++;
      if (j < text.length && text[j] === 'm') {
        var codes = text.slice(i + 2, j).split(';').map(Number);
        closeSpan();
        var k = 0;
        while (k < codes.length) {
          var c = codes[k];
          if (isNaN(c) || c === 0) { fg = null; bg = null; bold = false; dim = false; italic = false; underline = false; strikethrough = false; }
          else if (c === 1) bold = true;
          else if (c === 2) dim = true;
          else if (c === 3) italic = true;
          else if (c === 4) underline = true;
          else if (c === 9) strikethrough = true;
          else if (c === 22) { bold = false; dim = false; }
          else if (c === 23) italic = false;
          else if (c === 24) underline = false;
          else if (c === 29) strikethrough = false;
          else if (c >= 30 && c <= 37) fg = ANSI_COLORS[c - 30 + (bold ? 8 : 0)];
          else if (c === 38 && codes[k + 1] === 5) { fg = color256(codes[k + 2]); k += 2; }
          else if (c === 38 && codes[k + 1] === 2) { fg = 'rgb(' + codes[k + 2] + ',' + codes[k + 3] + ',' + codes[k + 4] + ')'; k += 4; }
          else if (c === 39) fg = null;
          else if (c >= 40 && c <= 47) bg = ANSI_COLORS[c - 40];
          else if (c === 48 && codes[k + 1] === 5) { bg = color256(codes[k + 2]); k += 2; }
          else if (c === 48 && codes[k + 1] === 2) { bg = 'rgb(' + codes[k + 2] + ',' + codes[k + 3] + ',' + codes[k + 4] + ')'; k += 4; }
          else if (c === 49) bg = null;
          else if (c >= 90 && c <= 97) fg = ANSI_COLORS[c - 90 + 8];
          else if (c >= 100 && c <= 107) bg = ANSI_COLORS[c - 100 + 8];
          k++;
        }
        openSpan();
        i = j + 1;
        continue;
      }
    }
    // Skip other escape sequences (cursor movement, etc.)
    if (text[i] === '\x1b' && i + 1 < text.length && text[i + 1] === '[') {
      var j = i + 2;
      while (j < text.length && !((text.charCodeAt(j) >= 0x40 && text.charCodeAt(j) <= 0x7e))) j++;
      i = j + 1;
      continue;
    }
    result += escapeHtml(text[i]);
    i++;
  }
  closeSpan();
  return result;
}
