import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect, Fragment } from 'react'
import { useStore, viewerKey, sessionLabel, type ViewerTab } from '../../store'
import { useToasts } from '../../toasts'
import { api } from '../../api'
import { FileContent, type Memo, type SelectionInfo } from './FileContent'
import { PdfViewer } from '../PdfViewer'
import { CodeEditor } from './CodeEditor'
import { renderMarkdown, findTaskLines, toggleTaskLine } from '../../markdown'
import { TerminalPane } from '../Terminal/TerminalPane'
import { InputCard } from '../Terminal/InputCard'
import { NotebookView } from './NotebookView'

const EMPTY_TABS: ViewerTab[] = []

interface PaneNode { type: 'leaf'; id: string; tabIds: string[]; activeTabId: string | null }

export function ViewerPane() {
  const tabs = useStore(s => s._viewerState[viewerKey(s)]?.tabs || EMPTY_TABS)
  const activeTabId = useStore(s => s._viewerState[viewerKey(s)]?.activeTabId || null)
  const key = useStore(viewerKey)
  const select = (_pane: string, id: string) => {
    const state = useStore.getState()
    const tab = tabs.find(t => t.id === id)
    if (tab?.type === 'terminal' && tab.sessionId) {
      state.setActive(tab.sessionId)
      state.acknowledgeCompletion(tab.sessionId)
    } else state.setActiveTab(id)
  }
  if (!tabs.length) return <div className="viewer-empty">왼쪽에서 에이전트 세션이나 파일을 선택하세요.</div>
  return <div className="viewer-inner"><LeafPane key={key} node={{type: 'leaf', id: key, tabIds: tabs.map(t => t.id), activeTabId}}
    tabs={tabs} onSelect={select} onClose={(_pane, id) => useStore.getState().closeTab(id)} /></div>
}

function LeafPane({ node, tabs, onClose, onSelect }: {
  node: PaneNode; tabs: ViewerTab[]
  onClose: (p: string, t: string) => void
  onSelect: (p: string, t: string) => void
}) {
  const [dragTarget, setDragTarget] = useState<string | null>(null)
  const contentRef = useRef<HTMLDivElement>(null)
  const updateTab = useStore(s => s.updateTab)
  const markTabSaved = useStore(s => s.markTabSaved)
  const sessionState = useStore(s => s.sessions)
  const titles = useStore(s => s.titles)
  const activeSessionId = useStore(s => s.activeId)
  const activeTab = tabs.find(t => t.id === node.activeTabId) || tabs.find(t => node.tabIds.includes(t.id))

  const isTextTab = activeTab && (activeTab.type === 'code' || activeTab.type === 'markdown' || activeTab.type === 'latex' || activeTab.type === 'notebook')
  const isMd = activeTab?.type === 'markdown'
  const isNb = activeTab?.type === 'notebook'
  const isRendered = isMd || isNb
  const dirty = !!activeTab?.dirty
  const [saving, setSaving] = useState(false)
  const [mdEditMode, setMdEditMode] = useState(false)

  // ── Memo state ──
  const [memos, setMemos] = useState<Memo[]>([])
  const [selInfo, setSelInfo] = useState<{ startLine: number; startCol: number; endLine: number; endCol: number; selectedText: string } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const pendingSelRef = useRef<{ startLine: number; startCol: number; endLine: number; endCol: number; text: string } | null>(null)

  useEffect(() => {
    if (!activeTab || activeTab.type === 'terminal' || activeTab.type === 'pdf' || activeTab.type === 'image') { setMemos([]); return }
    api.loadNotes(activeTab.path).then(res => setMemos(res.notes || [])).catch(() => {})
    setSelInfo(null)
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
  }, [activeTab?.id])

  const ownerKey = useStore(viewerKey)
  const rememberView = useCallback((view: NonNullable<ViewerTab['viewState']>) => {
    if (activeTab) useStore.getState().updateTabView(activeTab.id, view, ownerKey)
  }, [activeTab?.id, ownerKey])
  useLayoutEffect(() => {
    const el = contentRef.current
    if (!el || !activeTab) return
    el.scrollTop = activeTab.viewState?.scrollTop || 0
    el.scrollLeft = activeTab.viewState?.scrollLeft || 0
    const save = () => rememberView({scrollTop: el.scrollTop, scrollLeft: el.scrollLeft})
    el.addEventListener('scroll', save)
    return () => { el.removeEventListener('scroll', save) }
  }, [activeTab?.id, mdEditMode])
  const saveFile = useCallback(async () => {
    if (!activeTab) return
    setSaving(true)
    const res = await api.writeFile(activeTab.path, activeTab.content, activeTab.version)
    if (res?.ok === true) markTabSaved(activeTab.id, activeTab.content, res.version, ownerKey)
    setSaving(false)
  }, [activeTab, ownerKey])

  // Checkbox toggled in the rendered markdown view → update the buffer and
  // persist immediately (the whole buffer, so any unsaved edits go with it).
  const saveMdEdit = useCallback(async (newContent: string) => {
    if (!activeTab) return
    updateTab(activeTab.id, newContent)
    const res = await api.writeFile(activeTab.path, newContent, activeTab.version)
    if (res?.ok === true) markTabSaved(activeTab.id, newContent, res.version, ownerKey)
  }, [activeTab, ownerKey])

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
    if (activeTab.dirty && !window.confirm('저장하지 않은 변경을 버리고 파일을 다시 불러올까요?')) return
    if (activeTab.type === 'pdf' || activeTab.type === 'image') {
      updateTab(activeTab.id, activeTab.content.split('&_t=')[0] + '&_t=' + Date.now())
    } else {
      try {
        const res = await api.readFile(activeTab.path)
        let content = res.content || ''
        if (activeTab.path.endsWith('.json')) try { content = JSON.stringify(JSON.parse(content), null, 2) } catch {}
        const current = useStore.getState()._viewerState[ownerKey]?.tabs.find(t => t.id === activeTab.id)
        if (!current || current.content !== activeTab.content) {
          useToasts.getState().push('다시 불러오는 동안 편집 내용이 변경되어 새로고침을 취소했습니다.')
          return
        }
        updateTab(activeTab.id, content, ownerKey)
        markTabSaved(activeTab.id, content, res.version, ownerKey)  // reloaded from disk → clean
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
    if (!activeTab || activeTab.type === 'terminal' || activeTab.type === 'pdf' || activeTab.type === 'image') return
    try { await navigator.clipboard.writeText(activeTab.content); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  return (
    <div className="leaf-pane">
      <div className="vtab-bar">
        {node.tabIds.map(tid => {
          const t = tabs.find(tt => tt.id === tid)
          if (!t) return null
          return (
            <div key={t.id} className={`vtab ${t.id === node.activeTabId ? 'active' : ''} ${dragTarget === t.id ? 'tab-drop-target' : ''}`}
              draggable
              onDragStart={e => { e.dataTransfer.setData('application/agentboard-tab', t.id); e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={e => { if (e.dataTransfer.types.includes('application/agentboard-tab')) { e.preventDefault(); setDragTarget(t.id) } }}
              onDragLeave={() => setDragTarget(null)}
              onDragEnd={() => setDragTarget(null)}
              onDrop={e => { e.preventDefault(); const id = e.dataTransfer.getData('application/agentboard-tab'); const r = e.currentTarget.getBoundingClientRect(); if (id) useStore.getState().reorderTab(id, t.id, e.clientX > r.left + r.width / 2); setDragTarget(null) }}
              onClick={() => onSelect(node.id, t.id)}
            >
              <span className={`tab-kind tab-kind-${t.type}`}>{t.type === 'terminal' ? '›_' : t.type === 'pdf' ? 'PDF' : '▤'}</span>
              <span className="vtab-name" title={t.type === 'terminal' && t.sessionId && sessionState[t.sessionId] ? sessionLabel(sessionState[t.sessionId], titles) : t.path}>{t.type === 'terminal' && t.sessionId && sessionState[t.sessionId] ? sessionLabel(sessionState[t.sessionId], titles) : t.name}</span>
              <span title={t.type === 'terminal' ? '탭 닫기 (세션 유지)' : '탭 닫기'} className="vtab-close vtab-x" onClick={e => { e.stopPropagation(); onClose(node.id, t.id) }}>&times;</span>
            </div>
          )
        })}
        <div className="vtab-actions">
          {isTextTab && <button className="vtab-action" onClick={copyContent} title="Copy">{copied ? '✓' : '⎘'}</button>}
          {isRendered && <button className="vtab-action" onClick={() => setMdEditMode(v => !v)} title={mdEditMode ? 'Preview' : 'Edit'}>{mdEditMode ? '👁' : '✎'}</button>}
          {dirty && <button className="vtab-action vtab-send" onClick={saveFile} title="Save (Ctrl+S)" disabled={saving}>{saving ? '...' : '💾'}</button>}
          {activeTab?.type !== 'terminal' && <button className="vtab-action" onClick={downloadTab} title="Download">↓</button>}
          {activeTab?.type !== 'terminal' && <button className="vtab-action" onClick={refreshTab} title="Refresh">↻</button>}
          {isTextTab && memos.length > 0 && (
            <button className="vtab-action vtab-send" onClick={sendMemosToAgent} title="Send notes to agent">
              ▶ {memos.length}
            </button>
          )}
        </div>
      </div>
      <div ref={contentRef} className={`viewer-content ${activeTab?.type === 'terminal' ? 'terminal-tab-content' : ''}`} onClick={() => setCtxMenu(null)}>
        {!activeTab ? <div className="viewer-empty">Drop here</div>
          : activeTab.type === 'terminal' ? <TerminalTab key={activeTab.sessionId} sessionId={activeTab.sessionId!} />
          : activeTab.type === 'diff' ? <DiffView diff={activeTab.content} />
          : activeTab.type === 'pdf' ? <PdfViewer key={activeTab.id} url={activeTab.content} viewState={activeTab.viewState} onViewChange={rememberView} />
          : activeTab.type === 'image' ? <FileContent content={activeTab.content} type="image" lang="" />
          : (isNb && !mdEditMode) ? <NotebookView content={activeTab.content} />
          : (isMd && !mdEditMode) ? <MarkdownView content={activeTab.content} filePath={activeTab.path} onContextMenu={handleCtxMenu} onEdit={saveMdEdit} />
          : (
            <CodeEditor key={activeTab.id}
              viewState={activeTab.viewState}
              onViewChange={rememberView}
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
    </div>
  )
}

/** Unified-diff viewer (git changes) — colored, read-only. */
function DiffView({ diff }: { diff: string }) {
  if (!diff.trim()) return <div className="viewer-empty">변경 사항이 없습니다 (git HEAD 대비)</div>
  return (
    <pre className="diff-view">
      {diff.split('\n').map((l, i) => {
        let cls = 'dl'
        if (l.startsWith('+') && !l.startsWith('+++')) cls = 'dl dl-add'
        else if (l.startsWith('-') && !l.startsWith('---')) cls = 'dl dl-del'
        else if (l.startsWith('@@')) cls = 'dl dl-hunk'
        else if (l.startsWith('diff ') || l.startsWith('index ') || l.startsWith('+++') || l.startsWith('---')) cls = 'dl dl-meta'
        return <div key={i} className={cls}>{l || ' '}</div>
      })}
    </pre>
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
function MarkdownView({ content, filePath, onContextMenu, onEdit }: { content: string; filePath?: string; onContextMenu?: (info: SelectionInfo) => void; onEdit?: (newContent: string) => void }) {
  const bodyRef = useRef<HTMLDivElement>(null)
  const [zoom, setZoom] = useState<number>(() => {
    const saved = parseFloat(localStorage.getItem('md-zoom') || '1')
    return MD_ZOOM_LEVELS.includes(saved) ? saved : 1
  })
  useEffect(() => { localStorage.setItem('md-zoom', String(zoom)) }, [zoom])

  // Make task checkboxes clickable by stripping `disabled` from the HTML
  // STRING (marked emits them disabled) — but only when the checkbox count
  // matches the source scan; on a mismatch the Nth-checkbox → Nth-task-line
  // mapping would toggle the wrong line, so they stay read-only.
  // String-level (not a post-render DOM effect): React re-applies
  // dangerouslySetInnerHTML in ways that would recreate the inputs and undo
  // an imperative `disabled = false` (observed in production).
  const html = useMemo(() => {
    let h = renderMarkdown(content, filePath)
    if (onEdit) {
      const boxes = h.match(/<input[^>]*>/g)?.filter(t => t.includes('type="checkbox"')) || []
      if (boxes.length > 0 && boxes.length === findTaskLines(content).length) {
        h = h.replace(/<input[^>]*>/g, tag =>
          tag.includes('type="checkbox"') ? tag.replace(/ disabled(="")?/, '') : tag)
      }
    }
    return h
  }, [content, filePath, onEdit])

  const handleClick = useCallback((e: React.MouseEvent) => {
    const el = e.target
    if (!onEdit || !(el instanceof HTMLInputElement) || el.type !== 'checkbox' || el.disabled) return
    const boxes = Array.from(bodyRef.current?.querySelectorAll('input[type="checkbox"]') || [])
    const taskLines = findTaskLines(content)
    const idx = boxes.indexOf(el)
    if (idx < 0 || idx >= taskLines.length) return
    onEdit(toggleTaskLine(content, taskLines[idx]))
  }, [onEdit, content])

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
      <div ref={bodyRef} className="md-rendered" style={{ zoom }} dangerouslySetInnerHTML={{ __html: html }} onContextMenu={handleContextMenu} onClick={handleClick} />
    </div>
  )
}


function TerminalTab({ sessionId }: { sessionId: string }) {
  const session = useStore(s => s.sessions[sessionId])
  useEffect(() => {
    if (session && useStore.getState().activeId !== sessionId) useStore.getState().setActive(sessionId)
  }, [sessionId, !!session])
  if (!session) return <div className="viewer-empty">종료되거나 제거된 세션입니다. 이 탭을 닫아 주세요.</div>
  return <><TerminalPane sessionId={sessionId} /><InputCard key={sessionId} sessionId={sessionId} /></>
}
