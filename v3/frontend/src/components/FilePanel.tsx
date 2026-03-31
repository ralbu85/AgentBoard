import { useState, useEffect, useRef } from 'react'
import { api } from '../api'
import type { FileEntry } from '../types'

import { PdfViewer } from './PdfViewer'

// Lazy-loaded heavy modules
let _hljs: typeof import('highlight.js/lib/core').default | null = null
let _hljsLoading: Promise<void> | null = null

async function getHljs() {
  if (_hljs) return _hljs
  if (!_hljsLoading) {
    _hljsLoading = (async () => {
      const [{ default: hljs }, ...langs] = await Promise.all([
        import('highlight.js/lib/core'),
        import('highlight.js/lib/languages/python'),
        import('highlight.js/lib/languages/javascript'),
        import('highlight.js/lib/languages/typescript'),
        import('highlight.js/lib/languages/json'),
        import('highlight.js/lib/languages/bash'),
        import('highlight.js/lib/languages/css'),
        import('highlight.js/lib/languages/xml'),
        import('highlight.js/lib/languages/sql'),
        import('highlight.js/lib/languages/yaml'),
        import('highlight.js/lib/languages/go'),
        import('highlight.js/lib/languages/rust'),
        import('highlight.js/lib/languages/java'),
        import('highlight.js/lib/languages/cpp'),
      ])
      const names = ['python','javascript','typescript','json','bash','css','xml','sql','yaml','go','rust','java','cpp']
      langs.forEach((m, i) => hljs.registerLanguage(names[i], m.default))
      _hljs = hljs
    })()
  }
  await _hljsLoading
  return _hljs!
}

function lazyHighlight(code: string, lang: string): Promise<string> {
  return getHljs().then(hljs => {
    try {
      if (lang && hljs.getLanguage(lang)) return hljs.highlight(code, { language: lang }).value
      return hljs.highlightAuto(code).value
    } catch { return code.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
  })
}

// Extension → hljs language mapping
const EXT_LANG: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  json: 'json', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', html: 'xml', xml: 'xml', svg: 'xml',
  sql: 'sql', yaml: 'yaml', yml: 'yaml',
  go: 'go', rs: 'rust', java: 'java',
  c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
  rb: 'ruby', php: 'php', diff: 'diff', patch: 'diff',
  ini: 'ini', cfg: 'ini', conf: 'ini', toml: 'ini', env: 'bash',
  makefile: 'makefile', dockerfile: 'dockerfile',
  md: 'markdown', mdx: 'markdown',
}

interface Props {
  initialPath: string
  onClose: () => void
}

const TEXT_EXTS = new Set([...Object.keys(EXT_LANG), 'txt', 'log', 'csv', 'gitignore', 'dockerignore', 'editorconfig', 'prettierrc'])
const MD_EXTS = new Set(['md', 'markdown', 'mdx'])
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])
const PDF_EXTS = new Set(['pdf'])

function getExt(name: string) {
  const lower = name.toLowerCase()
  if (lower === 'makefile' || lower === 'dockerfile') return lower
  const i = lower.lastIndexOf('.')
  return i > 0 ? lower.slice(i + 1) : ''
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

// ── Markdown renderer ──
function renderMarkdown(md: string): string {
  let html = md
    // Code blocks with language
    .replace(/```(\w*)\n([\s\S]*?)```/g, (_, lang, code) => {
      const trimmed = code.trimEnd()
      let highlighted: string
      try {
        highlighted = lang && hljs.getLanguage(lang)
          ? hljs.highlight(trimmed, { language: lang }).value
          : hljs.highlightAuto(trimmed).value
      } catch { highlighted = trimmed.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;') }
      return `<pre class="md-codeblock"><code class="hljs">${highlighted}</code></pre>`
    })
  html = html
    .replace(/^#### (.+)$/gm, '<h4>$1</h4>')
    .replace(/^### (.+)$/gm, '<h3>$1</h3>')
    .replace(/^## (.+)$/gm, '<h2>$1</h2>')
    .replace(/^# (.+)$/gm, '<h1>$1</h1>')
    .replace(/^---+$/gm, '<hr/>')
    .replace(/\*\*\*(.+?)\*\*\*/g, '<strong><em>$1</em></strong>')
    .replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>')
    .replace(/(?<!\*)\*(?!\*)(.+?)(?<!\*)\*(?!\*)/g, '<em>$1</em>')
    .replace(/`([^`]+)`/g, '<code class="md-inline-code">$1</code>')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2" class="md-link" target="_blank">$1</a>')
    .replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>')
    .replace(/^- (.+)$/gm, '<li>$1</li>')
    .replace(/((?:<li>.*<\/li>\n?)+)/g, '<ul>$1</ul>')
    .replace(/\n\n/g, '</p><p>')
    .replace(/\n/g, '<br/>')
  return `<p>${html}</p>`
    .replace(/<p>\s*<(h[1-4]|pre|ul|ol|blockquote|hr)/g, '<$1')
    .replace(/<\/(h[1-4]|pre|ul|ol|blockquote)>\s*<\/p>/g, '</$1>')
}

export function FilePanel({ initialPath, onClose }: Props) {
  const [path, setPath] = useState(initialPath)
  const [pathInput, setPathInput] = useState(initialPath)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [preview, setPreview] = useState<{name: string; content: string; type: 'code'|'markdown'|'pdf'|'image'; lang: string} | null>(null)
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { loadDir(path) }, [path])

  async function loadDir(dir: string) {
    setLoading(true)
    try {
      const res = await api.files(dir)
      setEntries(res.entries || [])
      const resolved = res.path || dir
      setPath(resolved)
      setPathInput(resolved)
    } catch { /* */ }
    setLoading(false)
  }

  function goParent() {
    const parent = path.replace(/\/[^/]+\/?$/, '') || '/'
    setPath(parent)
    setPreview(null)
  }

  async function handleClick(entry: FileEntry) {
    const full = `${path}/${entry.name}`
    if (entry.type === 'dir') { setPath(full); setPreview(null); return }
    const e = getExt(entry.name)
    if (PDF_EXTS.has(e)) {
      setPreview({ name: entry.name, content: `/api/file-raw?path=${encodeURIComponent(full)}`, type: 'pdf', lang: '' })
    } else if (IMG_EXTS.has(e)) {
      setPreview({ name: entry.name, content: `/api/file-raw?path=${encodeURIComponent(full)}`, type: 'image', lang: '' })
    } else if (TEXT_EXTS.has(e) || MD_EXTS.has(e) || entry.size < 500_000) {
      try {
        const res = await api.readFile(full)
        let content = res.content || ''
        if (e === 'json') try { content = JSON.stringify(JSON.parse(content), null, 2) } catch {}
        setPreview({ name: entry.name, content, type: MD_EXTS.has(e) ? 'markdown' : 'code', lang: EXT_LANG[e] || '' })
      } catch { /* */ }
    }
  }

  async function handleUpload(ev: React.ChangeEvent<HTMLInputElement>) {
    const file = ev.target.files?.[0]
    if (!file) return
    await api.upload(path, file)
    loadDir(path)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  // Highlighted code (async lazy load)
  const [highlightedCode, setHighlightedCode] = useState('')
  useEffect(() => {
    if (!preview || preview.type !== 'code') { setHighlightedCode(''); return }
    const escaped = preview.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
    setHighlightedCode(escaped) // Show plain first
    lazyHighlight(preview.content, preview.lang).then(setHighlightedCode)
  }, [preview?.content, preview?.lang])

  const folder = path.split('/').filter(Boolean).pop() || '/'

  // ── Preview (fullscreen on mobile) ──
  if (preview) {
    return (
      <div className="file-viewer">
        <div className="file-viewer-header">
          <button className="fv-btn fv-back" onClick={() => setPreview(null)}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
          </button>
          <div className="fv-title">
            <span className="fv-name">{preview.name}</span>
            <span className="fv-lang">{preview.lang?.toUpperCase() || preview.type.toUpperCase()}</span>
          </div>
          <button className="fv-btn fv-close" onClick={onClose}>
            <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
          </button>
        </div>
        <div className="fv-body">
          {preview.type === 'code' && (
            <pre className="fv-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedCode }} /></pre>
          )}
          {preview.type === 'markdown' && (
            <div className="fv-markdown" dangerouslySetInnerHTML={{ __html: renderMarkdown(preview.content) }} />
          )}
          {preview.type === 'pdf' && (
            <PdfViewer url={preview.content} />
          )}
          {preview.type === 'image' && (
            <div className="fv-image">
              <img src={preview.content} alt={preview.name} />
            </div>
          )}
        </div>
      </div>
    )
  }

  // ── File list (panel, not fullscreen) ──
  return (
    <div className="file-panel">
      <div className="fp-header">
        <button className="fv-btn file-back-btn" onClick={goParent} title="Parent">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M12 4L6 10L12 16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <div className="fp-folder">{folder}</div>
        <button className="fv-btn file-upload-btn" onClick={() => fileInputRef.current?.click()} title="Upload">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 14V4M10 4L6 8M10 4L14 8M4 16H16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <button className="fv-btn" onClick={onClose} title="Close">
          <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        </button>
        <input ref={fileInputRef} type="file" style={{ display: 'none' }} onChange={handleUpload} />
      </div>
      <div className="fp-pathbar">
        <input className="file-path-input" value={pathInput}
          onChange={e => setPathInput(e.target.value)}
          onKeyDown={e => { if (e.key === 'Enter') { setPath(pathInput); } }}
        />
      </div>
      <div className="file-list">
        {loading && <div className="fp-loading"><div className="spinner" /></div>}
        {entries.map(entry => (
          <div key={entry.name}
            className={`fp-entry ${entry.type === 'dir' ? 'is-dir' : 'is-file'}`}
            onClick={() => handleClick(entry)}
          >
            {entry.type === 'dir'
              ? <svg className="fp-icon" width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M2 5C2 4 3 3 4 3H8L10 5H16C17 5 18 6 18 7V15C18 16 17 17 16 17H4C3 17 2 16 2 15V5Z" fill="#58a6ff" opacity="0.2" stroke="#58a6ff" strokeWidth="1.5"/></svg>
              : <svg className="fp-icon" width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 2H12L16 6V18H5C4 18 3 17 3 16V4C3 3 4 2 5 2Z" stroke="#6e7681" strokeWidth="1.5"/><path d="M12 2V6H16" stroke="#6e7681" strokeWidth="1.5"/></svg>
            }
            <div className="fp-info">
              <span className="file-name">{entry.name}</span>
              {entry.type === 'file' && <span className="file-size">{fmtSize(entry.size)}</span>}
            </div>
            {entry.type === 'dir' && <span className="fp-chevron">&rsaquo;</span>}
          </div>
        ))}
        {!loading && entries.length === 0 && <div className="fp-empty">Empty</div>}
      </div>
    </div>
  )
}
