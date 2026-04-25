import { useState, useRef, useCallback, useEffect, Fragment } from 'react'
import { useStore, type ViewerTab } from '../../store'
import { api } from '../../api'
import { FileContent, type Memo, type SelectionInfo } from './FileContent'
import { CodeEditor } from './CodeEditor'
import { renderMarkdown } from '../../markdown'
import { api } from '../../api'

type SplitDir = 'horizontal' | 'vertical'
type DropZone = 'left' | 'right' | 'top' | 'bottom' | 'center'

interface PaneNode {
  type: 'leaf'
  id: string
  tabIds: string[]
  activeTabId: string | null
}

interface SplitNode {
  type: 'split'
  direction: SplitDir
  children: TreeNode[]
  sizes: number[]
}

type TreeNode = PaneNode | SplitNode

let _pc = 0
function newLeaf(tabIds: string[], active: string | null): PaneNode {
  return { type: 'leaf', id: `p${++_pc}`, tabIds, activeTabId: active }
}

// ── Tree helpers ──
function collectTabIds(node: TreeNode): string[] {
  if (node.type === 'leaf') return [...node.tabIds]
  return node.children.flatMap(collectTabIds)
}

function findFirstLeaf(node: TreeNode): PaneNode | null {
  if (node.type === 'leaf') return node
  for (const c of node.children) { const r = findFirstLeaf(c); if (r) return r }
  return null
}

function mapLeaves(node: TreeNode, fn: (leaf: PaneNode) => PaneNode): TreeNode {
  if (node.type === 'leaf') return fn(node)
  return { ...node, children: node.children.map(c => mapLeaves(c, fn)) }
}

function removeTabFromTree(node: TreeNode, paneId: string, tabId: string): TreeNode | null {
  if (node.type === 'leaf') {
    if (node.id !== paneId) return node
    const rest = node.tabIds.filter(id => id !== tabId)
    if (rest.length === 0) return null
    return { ...node, tabIds: rest, activeTabId: node.activeTabId === tabId ? rest[0] : node.activeTabId }
  }
  const kids = node.children.map(c => removeTabFromTree(c, paneId, tabId)).filter(Boolean) as TreeNode[]
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]
  const sizes = node.sizes.length === kids.length ? node.sizes : kids.map(() => 1)
  return { ...node, children: kids, sizes }
}

function addTabToLeaf(node: TreeNode, paneId: string, tabId: string): TreeNode {
  if (node.type === 'leaf') {
    if (node.id !== paneId) return node
    if (node.tabIds.includes(tabId)) return { ...node, activeTabId: tabId }
    return { ...node, tabIds: [...node.tabIds, tabId], activeTabId: tabId }
  }
  return { ...node, children: node.children.map(c => addTabToLeaf(c, paneId, tabId)) }
}

function splitLeaf(node: TreeNode, paneId: string, tabId: string, dir: SplitDir, first: boolean): TreeNode {
  if (node.type === 'leaf') {
    if (node.id !== paneId) return node
    const nw = newLeaf([tabId], tabId)
    return { type: 'split', direction: dir, children: first ? [nw, node] : [node, nw], sizes: [1, 1] }
  }
  return { ...node, children: node.children.map(c => splitLeaf(c, paneId, tabId, dir, first)) }
}

function setLeafActive(node: TreeNode, paneId: string, tabId: string): TreeNode {
  if (node.type === 'leaf') return node.id === paneId ? { ...node, activeTabId: tabId } : node
  return { ...node, children: node.children.map(c => setLeafActive(c, paneId, tabId)) }
}

function pruneTree(node: TreeNode, valid: Set<string>): TreeNode | null {
  if (node.type === 'leaf') {
    const v = node.tabIds.filter(id => valid.has(id))
    if (v.length === 0) return null
    return { ...node, tabIds: v, activeTabId: v.includes(node.activeTabId || '') ? node.activeTabId : v[0] }
  }
  const kids = node.children.map(c => pruneTree(c, valid)).filter(Boolean) as TreeNode[]
  if (kids.length === 0) return null
  if (kids.length === 1) return kids[0]
  return { ...node, children: kids, sizes: node.sizes.slice(0, kids.length) }
}

// ── Component ──
export function ViewerPane() {
  const tabs = useStore(s => s._viewerState[s.activeId || '']?.tabs || [])
  const activeTabId = useStore(s => s._viewerState[s.activeId || '']?.activeTabId || null)
  const setActiveTab = useStore(s => s.setActiveTab)
  const closeTab = useStore(s => s.closeTab)
  const sessionId = useStore(s => s.activeId)

  const [tree, setTree] = useState<TreeNode | null>(null)
  const dragRef = useRef<{ tabId: string; paneId: string } | null>(null)
  const prevSessionRef = useRef(sessionId)

  // Reset tree on session change
  useEffect(() => {
    if (sessionId !== prevSessionRef.current) {
      setTree(null)
      prevSessionRef.current = sessionId
    }
  }, [sessionId])

  // Sync tabs → tree
  useEffect(() => {
    const allIds = tabs.map(t => t.id)
    const validSet = new Set(allIds)

    setTree(prev => {
      if (!prev) {
        if (allIds.length === 0) return null
        return newLeaf(allIds, activeTabId)
      }
      // Prune removed tabs
      let t = pruneTree(prev, validSet)
      // Add new tabs to first leaf
      const tracked = t ? new Set(collectTabIds(t)) : new Set<string>()
      const newIds = allIds.filter(id => !tracked.has(id))
      if (newIds.length > 0) {
        if (!t) return newLeaf(allIds, activeTabId)
        const first = findFirstLeaf(t)
        if (first) {
          t = mapLeaves(t, leaf => leaf.id === first.id
            ? { ...leaf, tabIds: [...leaf.tabIds, ...newIds], activeTabId: activeTabId || leaf.activeTabId }
            : leaf)
        }
      }
      return t
    })
  }, [tabs, activeTabId])

  function onDragStart(tabId: string, paneId: string) {
    dragRef.current = { tabId, paneId }
  }

  function onDrop(targetPaneId: string, zone: DropZone) {
    const d = dragRef.current
    if (!d) return
    dragRef.current = null

    setTree(prev => {
      if (!prev) return prev
      let t = removeTabFromTree(prev, d.paneId, d.tabId)
      if (!t) t = newLeaf([], null) // shouldn't happen

      if (zone === 'center') {
        t = addTabToLeaf(t, targetPaneId, d.tabId)
      } else {
        const dir: SplitDir = (zone === 'left' || zone === 'right') ? 'horizontal' : 'vertical'
        t = splitLeaf(t, targetPaneId, d.tabId, dir, zone === 'left' || zone === 'top')
      }
      return pruneTree(t, new Set(tabs.map(tt => tt.id)))
    })
  }

  function onCloseTab(paneId: string, tabId: string) {
    closeTab(tabId)
  }

  function onSelectTab(paneId: string, tabId: string) {
    setActiveTab(tabId)
    setTree(prev => prev ? setLeafActive(prev, paneId, tabId) : prev)
  }

  if (!tree) return <div className="viewer-inner"><div className="viewer-empty">No files open</div></div>

  return (
    <div className="viewer-inner">
      <RenderNode node={tree} tabs={tabs} onDragStart={onDragStart} onDrop={onDrop} onClose={onCloseTab} onSelect={onSelectTab} />
    </div>
  )
}

// ── Render tree ──
function RenderNode({ node, tabs, onDragStart, onDrop, onClose, onSelect }: {
  node: TreeNode; tabs: ViewerTab[]
  onDragStart: (t: string, p: string) => void
  onDrop: (p: string, z: DropZone) => void
  onClose: (p: string, t: string) => void
  onSelect: (p: string, t: string) => void
}) {
  if (node.type === 'leaf') return <LeafPane node={node} tabs={tabs} onDragStart={onDragStart} onDrop={onDrop} onClose={onClose} onSelect={onSelect} />

  const isH = node.direction === 'horizontal'
  return (
    <div style={{ display: 'flex', flexDirection: isH ? 'row' : 'column', flex: 1, overflow: 'hidden' }}>
      {node.children.map((child, i) => (
        <Fragment key={i}>
          {i > 0 && <div className={`viewer-split-resizer ${isH ? 'vsr-h' : 'vsr-v'}`} />}
          <div style={{ flex: node.sizes[i] || 1, overflow: 'hidden', display: 'flex', flexDirection: 'column', minWidth: 0, minHeight: 0 }}>
            <RenderNode node={child} tabs={tabs} onDragStart={onDragStart} onDrop={onDrop} onClose={onClose} onSelect={onSelect} />
          </div>
        </Fragment>
      ))}
    </div>
  )
}

function LeafPane({ node, tabs, onDragStart, onDrop, onClose, onSelect }: {
  node: PaneNode; tabs: ViewerTab[]
  onDragStart: (t: string, p: string) => void
  onDrop: (p: string, z: DropZone) => void
  onClose: (p: string, t: string) => void
  onSelect: (p: string, t: string) => void
}) {
  const [dropZone, setDropZone] = useState<DropZone | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const updateTab = useStore(s => s.updateTab)
  const activeSessionId = useStore(s => s.activeId)
  const activeTab = tabs.find(t => t.id === node.activeTabId) || tabs.find(t => node.tabIds.includes(t.id))

  const isTextTab = activeTab && (activeTab.type === 'code' || activeTab.type === 'markdown' || activeTab.type === 'latex')
  const isMd = activeTab?.type === 'markdown'
  const isRendered = isMd
  const [dirty, setDirty] = useState(false)
  const [saving, setSaving] = useState(false)
  const [mdEditMode, setMdEditMode] = useState(false)

  // ── Memo state ──
  const [memos, setMemos] = useState<Memo[]>([])
  const [selInfo, setSelInfo] = useState<{ startLine: number; startCol: number; endLine: number; endCol: number; selectedText: string } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const pendingSelRef = useRef<{ startLine: number; startCol: number; endLine: number; endCol: number; text: string } | null>(null)

  useEffect(() => {
    if (!activeTab || activeTab.type === 'pdf' || activeTab.type === 'image') { setMemos([]); return }
    api.loadNotes(activeTab.path).then(res => setMemos(res.notes || [])).catch(() => {})
    setSelInfo(null)
    setDirty(false)
    setMdEditMode(false)
  }, [activeTab?.id])


  // ── Right-click on selected text → context menu (used by CodeEditor) ──
  const handleCtxMenu = useCallback((info: SelectionInfo) => {
    pendingSelRef.current = { startLine: info.startLine, startCol: info.startCol, endLine: info.endLine, endCol: info.endCol, text: info.text }
    setCtxMenu({ x: info.x, y: info.y })
  }, [])

  const addNoteFromCtx = () => {
    if (!pendingSelRef.current) return
    setSelInfo({ ...pendingSelRef.current, selectedText: pendingSelRef.current.text })
    setCtxMenu(null)
    pendingSelRef.current = null
  }

  const onContentChange = useCallback((value: string) => {
    if (!activeTab) return
    updateTab(activeTab.id, value)
    setDirty(true)
  }, [activeTab?.id])

  const saveFile = useCallback(async () => {
    if (!activeTab) return
    setSaving(true)
    await api.writeFile(activeTab.path, activeTab.content)
    setDirty(false)
    setSaving(false)
  }, [activeTab])

  // ── Memo CRUD ──
  const handleSaveMemo = useCallback((newMemo: Memo) => {
    if (!activeTab) return
    const updated = [...memos, newMemo]
    setMemos(updated)
    setSelInfo(null)
    api.saveNotes(activeTab.path, updated)
  }, [activeTab, memos])

  const deleteMemo = async (idx: number) => {
    if (!activeTab) return
    const updated = memos.filter((_, i) => i !== idx)
    setMemos(updated)
    await api.saveNotes(activeTab.path, updated)
  }

  const sendMemosToAgent = async () => {
    if (!activeTab || !activeSessionId || memos.length === 0) return
    const sorted = [...memos].sort((a, b) => a.startLine - b.startLine)
    const parts: string[] = []
    parts.push(`@${activeTab.path} 수정 요청:`)
    for (const m of sorted) {
      const loc = m.startCol
        ? `L${m.startLine}:${m.startCol}-${m.endLine}:${m.endCol}`
        : `L${m.startLine}${m.endLine !== m.startLine ? `-${m.endLine}` : ''}`
      parts.push(`- [${loc}] ${m.text}`)
    }
    await api.paste(activeSessionId, parts.join('\n'))
    setMemos([])
    setSelInfo(null)
    await api.saveNotes(activeTab.path, [])
  }

  const refreshTab = async () => {
    if (!activeTab) return
    if (activeTab.type === 'pdf' || activeTab.type === 'image') {
      updateTab(activeTab.id, activeTab.content.split('&_t=')[0] + '&_t=' + Date.now())
    } else {
      try {
        const res = await api.readFile(activeTab.path)
        let content = res.content || ''
        if (activeTab.path.endsWith('.json')) try { content = JSON.stringify(JSON.parse(content), null, 2) } catch {}
        updateTab(activeTab.id, content)
        setDirty(false)
      } catch {}
    }
  }

  const downloadTab = () => {
    if (!activeTab) return
    if (activeTab.type === 'pdf' || activeTab.type === 'image') {
      const a = document.createElement('a'); a.href = activeTab.content.split('&_t=')[0]; a.download = activeTab.name; a.click()
    } else {
      const blob = new Blob([activeTab.content], { type: 'text/plain;charset=utf-8' })
      const url = URL.createObjectURL(blob); const a = document.createElement('a'); a.href = url; a.download = activeTab.name; a.click(); URL.revokeObjectURL(url)
    }
  }

  const [copied, setCopied] = useState(false)
  const copyContent = async () => {
    if (!activeTab || activeTab.type === 'pdf' || activeTab.type === 'image') return
    try { await navigator.clipboard.writeText(activeTab.content); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  const onDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    const r = ref.current?.getBoundingClientRect()
    if (!r) return
    const x = (e.clientX - r.left) / r.width
    const y = (e.clientY - r.top) / r.height
    if (x < 0.2) setDropZone('left')
    else if (x > 0.8) setDropZone('right')
    else if (y < 0.25) setDropZone('top')
    else if (y > 0.75) setDropZone('bottom')
    else setDropZone('center')
  }, [])

  return (
    <div ref={ref} className="leaf-pane"
      onDragOver={onDragOver}
      onDragLeave={() => setDropZone(null)}
      onDrop={e => { e.preventDefault(); setDropZone(null); onDrop(node.id, dropZone || 'center') }}
    >
      <div className="vtab-bar">
        {node.tabIds.map(tid => {
          const t = tabs.find(tt => tt.id === tid)
          if (!t) return null
          return (
            <div key={t.id} className={`vtab ${t.id === node.activeTabId ? 'active' : ''}`}
              draggable onDragStart={e => { e.dataTransfer.setData('text/plain', t.id); onDragStart(t.id, node.id) }}
              onClick={() => onSelect(node.id, t.id)}
            >
              <span className="vtab-name">{t.name}</span>
              <span className="vtab-close vtab-x" onClick={e => { e.stopPropagation(); onClose(node.id, t.id) }}>&times;</span>
            </div>
          )
        })}
        <div className="vtab-actions">
          {isTextTab && <button className="vtab-action" onClick={copyContent} title="Copy">{copied ? '✓' : '⎘'}</button>}
          {isRendered && <button className="vtab-action" onClick={() => setMdEditMode(v => !v)} title={mdEditMode ? 'Preview' : 'Edit'}>{mdEditMode ? '👁' : '✎'}</button>}
          {dirty && <button className="vtab-action vtab-send" onClick={saveFile} title="Save (Ctrl+S)" disabled={saving}>{saving ? '...' : '💾'}</button>}
          <button className="vtab-action" onClick={downloadTab} title="Download">↓</button>
          <button className="vtab-action" onClick={refreshTab} title="Refresh">↻</button>
          {isTextTab && memos.length > 0 && (
            <button className="vtab-action vtab-send" onClick={sendMemosToAgent} title="Send notes to agent">
              ▶ {memos.length}
            </button>
          )}
        </div>
      </div>
      <div className="viewer-content" onClick={() => setCtxMenu(null)}>
        {!activeTab ? <div className="viewer-empty">Drop here</div>
          : activeTab.type === 'pdf' ? <FileContent content={activeTab.content} type="pdf" lang="" />
          : activeTab.type === 'image' ? <FileContent content={activeTab.content} type="image" lang="" />
          : (isMd && !mdEditMode) ? <MarkdownView content={activeTab.content} filePath={activeTab.path} onContextMenu={handleCtxMenu} />
          : (
            <CodeEditor
              content={activeTab.content}
              lang={activeTab.lang}
              memos={memos}
              onChange={onContentChange}
              onSave={saveFile}
              onContextMenu={handleCtxMenu}
            />
          )
        }
      </div>
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
          <button className="ctx-menu-item" onClick={addNoteFromCtx}>+ Add Note</button>
        </div>
      )}
      {selInfo && (
        <MemoInputPanel selInfo={selInfo} onSave={handleSaveMemo} onCancel={() => setSelInfo(null)} />
      )}
      {isTextTab && memos.length > 0 && !selInfo && (
        <div className="memo-list">
          {[...memos].sort((a,b) => a.startLine - b.startLine).map((m, i) => (
            <div key={i} className="memo-item">
              <span className="memo-item-range">{m.startCol ? `L${m.startLine}:${m.startCol}-${m.endLine}:${m.endCol}` : `L${m.startLine}${m.endLine !== m.startLine ? `-${m.endLine}` : ''}`}</span>
              <span className="memo-item-text">{m.text}</span>
              <button className="memo-item-del" onClick={() => deleteMemo(i)}>&times;</button>
            </div>
          ))}
        </div>
      )}
      {dropZone && <div className={`drop-indicator drop-${dropZone}`} />}
    </div>
  )
}

/** Isolated memo input — typing here does NOT re-render FileContent */
function MemoInputPanel({ selInfo, onSave, onCancel }: {
  selInfo: { startLine: number; startCol: number; endLine: number; endCol: number; selectedText: string }
  onSave: (memo: Memo) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 50) }, [])

  const save = () => {
    if (!text.trim()) return
    onSave({ startLine: selInfo.startLine, startCol: selInfo.startCol, endLine: selInfo.endLine, endCol: selInfo.endCol, text: text.trim(), selectedText: selInfo.selectedText })
    setText('')
  }

  return (
    <div className="memo-panel">
      <div className="memo-panel-header">
        <span className="memo-panel-range">
          L{selInfo.startLine}:{selInfo.startCol}-{selInfo.endLine}:{selInfo.endCol}
        </span>
        <span className="memo-panel-excerpt">{selInfo.selectedText.slice(0, 60)}{selInfo.selectedText.length > 60 ? '...' : ''}</span>
        <button className="btn btn-xs" onClick={onCancel}>&times;</button>
      </div>
      <textarea
        ref={ref}
        className="memo-textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="Add a note..."
        rows={2}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }}
      />
      <div className="memo-panel-actions">
        <button className="btn btn-xs" onClick={onCancel}>Cancel</button>
        <button className="btn btn-xs btn-primary" onClick={save} disabled={!text.trim()}>Save</button>
      </div>
    </div>
  )
}

/** Rendered markdown view (Notion-style) */
const MD_ZOOM_LEVELS = [0.5, 0.75, 0.9, 1, 1.15, 1.3, 1.5, 1.75, 2, 2.5]
function MarkdownView({ content, filePath, onContextMenu }: { content: string; filePath?: string; onContextMenu?: (info: SelectionInfo) => void }) {
  const [html, setHtml] = useState('')
  const [zoom, setZoom] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('md-zoom') || '1')
    return MD_ZOOM_LEVELS.includes(saved) ? saved : 1
  })
  useEffect(() => {
    setHtml(renderMarkdown(content, filePath))
  }, [content, filePath])
  useEffect(() => { localStorage.setItem('md-zoom', String(zoom)) }, [zoom])

  const zoomIn = () => setZoom(z => {
    const i = MD_ZOOM_LEVELS.indexOf(z)
    return MD_ZOOM_LEVELS[Math.min(i + 1, MD_ZOOM_LEVELS.length - 1)] ?? z
  })
  const zoomOut = () => setZoom(z => {
    const i = MD_ZOOM_LEVELS.indexOf(z)
    return MD_ZOOM_LEVELS[Math.max(i - 1, 0)] ?? z
  })
  const zoomReset = () => setZoom(1)

  const handleContextMenu = useCallback((e: React.MouseEvent) => {
    if (!onContextMenu) return
    const sel = window.getSelection()
    if (!sel || sel.isCollapsed || !sel.toString().trim()) return
    e.preventDefault()
    const text = sel.toString().trim()
    // Find the selected text in the source markdown to get line numbers
    const lines = content.split('\n')
    let startLine = 1, endLine = 1
    // Search for the first few words in source
    const searchKey = text.slice(0, 80).replace(/\s+/g, ' ')
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes(searchKey) || lines.slice(i, i + 3).join(' ').includes(searchKey)) {
        startLine = i + 1
        endLine = startLine
        break
      }
    }
    onContextMenu({ startLine, startCol: 0, endLine, endCol: 0, text, x: e.clientX, y: e.clientY })
  }, [onContextMenu, content])

  return (
    <div className="md-wrap">
      <div className="md-zoom-toolbar">
        <button className="md-zoom-btn" onClick={zoomOut} title="Zoom out">−</button>
        <span className="md-zoom-label" onClick={zoomReset} title="Reset">{Math.round(zoom * 100)}%</span>
        <button className="md-zoom-btn" onClick={zoomIn} title="Zoom in">+</button>
      </div>
      <div className="md-rendered" style={{ zoom }} dangerouslySetInnerHTML={{ __html: html }} onContextMenu={handleContextMenu} />
    </div>
  )
}

