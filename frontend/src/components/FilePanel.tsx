import { useState, useEffect, useRef, useCallback } from 'react'
import { api } from '../api'
import { useStore } from '../store'
import type { FileEntry } from '../types'
import { renderMarkdown } from '../markdown'
import { sanitize } from '../sanitize'
import { PdfViewer } from './PdfViewer'

// ── Tree Node component (VS Code style) ──
function TreeDir({ dirPath, name, depth, onFileClick }: {
  dirPath: string; name: string; depth: number
  onFileClick: (path: string, entry: FileEntry) => void
}) {
  const [open, setOpen] = useState(depth === 0)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [loaded, setLoaded] = useState(false)

  const load = useCallback(async () => {
    if (loaded) return
    try {
      const res = await api.files(dirPath)
      setEntries(res.entries || [])
      setLoaded(true)
    } catch { /* */ }
  }, [dirPath, loaded])

  useEffect(() => { if (open && !loaded) load() }, [open, loaded, load])
  // Auto-open root
  useEffect(() => { if (depth === 0) { setOpen(true); load() } }, [depth, load])

  const toggle = () => { setOpen(v => !v); if (!loaded) load() }

  return (
    <>
      {depth > 0 && (
        <div className="tree-row tree-dir" style={{ paddingLeft: depth * 12 + 4 }} onClick={toggle}>
          <span className={`tree-arrow ${open ? 'open' : ''}`}>{'\u25B6'}</span>
          <svg className="tree-icon" width="14" height="14" viewBox="0 0 20 20" fill="none">
            <path d="M2 5C2 4 3 3 4 3H8L10 5H16C17 5 18 6 18 7V15C18 16 17 17 16 17H4C3 17 2 16 2 15V5Z"
              fill={open ? 'var(--accent)' : 'none'} opacity={open ? '0.2' : '1'}
              stroke="var(--accent)" strokeWidth="1.5"/>
          </svg>
          <span className="tree-name tree-dirname">{name}</span>
        </div>
      )}
      {open && entries.map(entry => {
        const full = `${dirPath}/${entry.name}`
        if (entry.type === 'dir') {
          return <TreeDir key={entry.name} dirPath={full} name={entry.name} depth={depth + 1} onFileClick={onFileClick} />
        }
        return (
          <div key={entry.name} className="tree-row tree-file" style={{ paddingLeft: (depth + 1) * 12 + 4 }}
            onClick={() => onFileClick(full, entry)}>
            <span className="tree-arrow-space" />
            <svg className="tree-icon" width="14" height="14" viewBox="0 0 20 20" fill="none">
              <path d="M5 2H12L16 6V18H5C4 18 3 17 3 16V4C3 3 4 2 5 2Z" stroke="var(--text-muted)" strokeWidth="1.5"/>
              <path d="M12 2V6H16" stroke="var(--text-muted)" strokeWidth="1.5"/>
            </svg>
            <span className="tree-name">{entry.name}</span>
            <span className="tree-size">{fmtSize(entry.size)}</span>
          </div>
        )
      })}
    </>
  )
}

function fmtSize(bytes: number) {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

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
        import('highlight.js/lib/languages/latex'),
        import('highlight.js/lib/languages/r'),
      ])
      const names = ['python','javascript','typescript','json','bash','css','xml','sql','yaml','go','rust','java','cpp','latex','r']
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
      const html = (lang && hljs.getLanguage(lang))
        ? hljs.highlight(code, { language: lang }).value
        : hljs.highlightAuto(code).value
      return sanitize(html)
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
  md: 'markdown', mdx: 'markdown', qmd: 'markdown',
  tex: 'latex', sty: 'latex', cls: 'latex', bib: 'latex',
  r: 'r', rmd: 'markdown',
}

interface Props {
  initialPath: string
  onClose: () => void
}

const TEXT_EXTS = new Set([...Object.keys(EXT_LANG), 'txt', 'log', 'csv', 'gitignore', 'dockerignore', 'editorconfig', 'prettierrc'])
const MD_EXTS = new Set(['md', 'markdown', 'mdx', 'qmd'])
const TEX_EXTS = new Set(['tex'])
const IMG_EXTS = new Set(['png', 'jpg', 'jpeg', 'gif', 'svg', 'webp', 'bmp', 'ico'])
const PDF_EXTS = new Set(['pdf'])

function getExt(name: string) {
  const lower = name.toLowerCase()
  if (lower === 'makefile' || lower === 'dockerfile') return lower
  const i = lower.lastIndexOf('.')
  return i > 0 ? lower.slice(i + 1) : ''
}

// ── Markdown renderer (shared, with KaTeX math support) ──

export function FilePanel({ initialPath, onClose }: Props) {
  const [path, setPath] = useState(initialPath)
  const [pathInput, setPathInput] = useState(initialPath)
  const [entries, setEntries] = useState<FileEntry[]>([])
  const [preview, setPreview] = useState<{name: string; content: string; type: 'code'|'markdown'|'latex'|'pdf'|'image'; lang: string; path?: string} | null>(null)
  const [loading, setLoading] = useState(false)
  const fileInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => { setPath(initialPath); setPathInput(initialPath); setPreview(null) }, [initialPath])
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

  const atRoot = path === initialPath || path === initialPath + '/'

  function goParent() {
    if (atRoot) return
    const parent = path.replace(/\/[^/]+\/?$/, '') || '/'
    setPath(parent.length >= initialPath.length ? parent : initialPath)
    setPreview(null)
  }

  const openTab = useStore(s => s.openTab)
  const isDesktop = window.innerWidth > 768

  async function handleClick(entry: FileEntry) {
    const full = `${path}/${entry.name}`
    if (entry.type === 'dir') { setPath(full); setPreview(null); return }
    const e = getExt(entry.name)

    const makeTab = (name: string, content: string, type: 'code'|'markdown'|'latex'|'pdf'|'image', lang: string) => ({
      id: full, name, path: full, content, type, lang,
    })

    if (PDF_EXTS.has(e)) {
      const url = `/api/file-raw?path=${encodeURIComponent(full)}`
      if (isDesktop) { openTab(makeTab(entry.name, url, 'pdf', '')); return }
      setPreview({ name: entry.name, content: url, type: 'pdf', lang: '' })
    } else if (IMG_EXTS.has(e)) {
      const url = `/api/file-raw?path=${encodeURIComponent(full)}`
      if (isDesktop) { openTab(makeTab(entry.name, url, 'image', '')); return }
      setPreview({ name: entry.name, content: url, type: 'image', lang: '' })
    } else if (TEXT_EXTS.has(e) || MD_EXTS.has(e) || TEX_EXTS.has(e) || entry.size < 500_000) {
      try {
        const res = await api.readFile(full)
        let content = res.content || ''
        if (e === 'json') try { content = JSON.stringify(JSON.parse(content), null, 2) } catch {}
        const type = TEX_EXTS.has(e) ? 'latex' as const : MD_EXTS.has(e) ? 'markdown' as const : 'code' as const
        if (isDesktop) { openTab(makeTab(entry.name, content, type, EXT_LANG[e] || '')); return }
        setPreview({ name: entry.name, content, type, lang: EXT_LANG[e] || '', path: full })
      } catch { /* */ }
    }
  }

  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(0)

  async function uploadFiles(files: FileList | File[]) {
    const arr = Array.from(files)
    if (arr.length === 0) return
    setUploading(arr.length)
    try {
      await api.uploadMany(path, arr)
      loadDir(path)
    } finally {
      setUploading(0)
    }
  }

  async function handleUpload(ev: React.ChangeEvent<HTMLInputElement>) {
    if (!ev.target.files || ev.target.files.length === 0) return
    await uploadFiles(ev.target.files)
    if (fileInputRef.current) fileInputRef.current.value = ''
  }

  const onDragOver = (e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.stopPropagation()
      setDragOver(true)
    }
  }
  const onDragLeave = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget === e.target) setDragOver(false)
  }
  const onDrop = (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    if (e.dataTransfer.files && e.dataTransfer.files.length > 0) {
      uploadFiles(e.dataTransfer.files)
    }
  }

  // Highlighted code (async lazy load)
  const [highlightedCode, setHighlightedCode] = useState('')
  const [mdHtml, setMdHtml] = useState('')
  useEffect(() => {
    if (!preview) { setHighlightedCode(''); setMdHtml(''); return }
    if (preview.type === 'code') {
      const escaped = preview.content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      setHighlightedCode(escaped)
      lazyHighlight(preview.content, preview.lang).then(setHighlightedCode)
    } else if (preview.type === 'markdown') {
      setMdHtml('')
      setMdHtml(renderMarkdown(preview.content, preview.path))
    }
  }, [preview?.content, preview?.lang, preview?.type])

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
          <div className="fv-header-actions">
            {preview.type !== 'pdf' && preview.type !== 'image' && (
              <button className="fv-btn" title="Copy" onClick={() => {
                navigator.clipboard.writeText(preview.content).catch(() => {})
              }}>
                <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><rect x="6" y="6" width="10" height="10" rx="1.5" stroke="currentColor" strokeWidth="1.5"/><path d="M4 14V4h10" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/></svg>
              </button>
            )}
            <button className="fv-btn" title="Download" onClick={() => {
              if (preview.type === 'pdf' || preview.type === 'image') {
                const a = document.createElement('a'); a.href = preview.content.split('&_t=')[0]; a.download = preview.name; a.click()
              } else {
                const blob = new Blob([preview.content], { type: 'text/plain;charset=utf-8' })
                const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = preview.name; a.click(); URL.revokeObjectURL(url)
              }
            }}>
              <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M10 3v10m0 0l-3-3m3 3l3-3M4 15v1a1 1 0 001 1h10a1 1 0 001-1v-1" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round"/></svg>
            </button>
            <button className="fv-btn fv-close" onClick={onClose}>
              <svg width="20" height="20" viewBox="0 0 20 20" fill="none"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
            </button>
          </div>
        </div>
        <div className="fv-body">
          {preview.type === 'code' && (
            <pre className="fv-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlightedCode }} /></pre>
          )}
          {preview.type === 'markdown' && (
            <div className="fv-markdown" dangerouslySetInnerHTML={{ __html: mdHtml }} />
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

  // ── Tree view (panel, not fullscreen) ──
  return (
    <div
      className={`file-panel ${dragOver ? 'drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      <div className="fp-header">
        <div className="fp-folder">{folder}{uploading > 0 ? ` · 업로드 중 ${uploading}` : ''}</div>
        <button className="fv-btn file-upload-btn" onClick={() => fileInputRef.current?.click()} title="Upload">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M10 14V4M10 4L6 8M10 4L14 8M4 16H16" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/></svg>
        </button>
        <button className="fv-btn" onClick={onClose} title="Close">
          <svg width="14" height="14" viewBox="0 0 20 20" fill="none"><path d="M5 5L15 15M15 5L5 15" stroke="currentColor" strokeWidth="2" strokeLinecap="round"/></svg>
        </button>
        <input ref={fileInputRef} type="file" multiple style={{ display: 'none' }} onChange={handleUpload} />
      </div>
      {dragOver && <div className="fp-drop-overlay">파일을 놓아 업로드</div>}
      <div className="file-list">
        <TreeDir dirPath={initialPath} name={folder} depth={0} onFileClick={(fullPath, entry) => {
          // Reuse existing handleClick logic but with full path
          const e = getExt(entry.name)
          const makeTab = (name: string, content: string, type: 'code'|'markdown'|'latex'|'pdf'|'image', lang: string) => ({
            id: fullPath, name, path: fullPath, content, type, lang,
          })
          if (PDF_EXTS.has(e)) {
            const url = `/api/file-raw?path=${encodeURIComponent(fullPath)}`
            if (isDesktop) { openTab(makeTab(entry.name, url, 'pdf', '')); return }
            setPreview({ name: entry.name, content: url, type: 'pdf', lang: '' })
          } else if (IMG_EXTS.has(e)) {
            const url = `/api/file-raw?path=${encodeURIComponent(fullPath)}`
            if (isDesktop) { openTab(makeTab(entry.name, url, 'image', '')); return }
            setPreview({ name: entry.name, content: url, type: 'image', lang: '' })
          } else if (TEXT_EXTS.has(e) || MD_EXTS.has(e) || TEX_EXTS.has(e) || entry.size < 500_000) {
            api.readFile(fullPath).then(res => {
              let content = res.content || ''
              if (e === 'json') try { content = JSON.stringify(JSON.parse(content), null, 2) } catch {}
              const type = TEX_EXTS.has(e) ? 'latex' as const : MD_EXTS.has(e) ? 'markdown' as const : 'code' as const
              if (isDesktop) { openTab(makeTab(entry.name, content, type, EXT_LANG[e] || '')); return }
              setPreview({ name: entry.name, content, type, lang: EXT_LANG[e] || '', path: fullPath })
            }).catch(() => {})
          }
        }} />
      </div>
    </div>
  )
}
