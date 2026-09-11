import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect, Fragment } from 'react'
import { useStore, viewerKey, sessionLabel, type ViewerTab } from '../../store'
import { useToasts } from '../../toasts'
import { notifyActive } from '../../ws'
import { api } from '../../api'
import { FileContent, type Memo, type SelectionInfo } from './FileContent'
import { PdfViewer } from '../PdfViewer'
import { BrowserPane } from './BrowserPane'
import { ScrollSlider } from './ScrollSlider'
import { CodeEditor } from './CodeEditor'
import { renderMarkdown, findTaskLines, toggleTaskLine } from '../../markdown'
import { TerminalPane } from '../Terminal/TerminalPane'
import { InputCard } from '../Terminal/InputCard'
import { leaves, mapTree, moveTab, newLeaf, readLayout, saveLayout, syncTree, type PaneNode, type TreeNode, type DropZone } from './layout'
import { NotebookView } from './NotebookView'

const EMPTY_TABS: ViewerTab[] = []

export function ViewerPane() {
  const tabs = useStore(s => s._viewerState[viewerKey(s)]?.tabs || EMPTY_TABS)
  const activeTabId = useStore(s => s._viewerState[viewerKey(s)]?.activeTabId || null)
  const key = useStore(viewerKey)
  const ready = useStore(s => s._restoredWorkspaces[viewerKey(s)])
  if (!ready) return <div className="viewer-empty">작업 화면 복원 중…</div>
  return <WorkspaceViewer key={key} workspaceKey={key} tabs={tabs} activeTabId={activeTabId} />
}

function WorkspaceViewer({workspaceKey, tabs, activeTabId}: {workspaceKey:string; tabs:ViewerTab[]; activeTabId:string|null}) {
  const [tree, setTree] = useState(() => readLayout(workspaceKey, tabs.map(t=>t.id), activeTabId))
  const hiddenSessionKeys = useStore(s=>s.hiddenSessions.join('\0'))
  const workspaceSessionIds = useStore(s=>Object.values(s.sessions).filter(session=>JSON.stringify([session.host||'local',session.cwd||'~'])===workspaceKey).map(session=>session.id).join('\0'))
  useEffect(()=>{ useStore.getState().ensureSessionTabs(workspaceKey) },[workspaceKey,workspaceSessionIds,hiddenSessionKeys])
  const focused = useRef(leaves(tree).find(p=>p.tabIds.includes(activeTabId||''))?.id || leaves(tree)[0].id)
  const ids = tabs.map(t=>t.id).join('\0')
  const displayedTree = useMemo(()=>syncTree(tree,tabs.map(t=>t.id),activeTabId,focused.current),[tree,ids,activeTabId])
  useLayoutEffect(() => {
    setTree(prev => {
      const next = syncTree(prev, tabs.map(t=>t.id), activeTabId, focused.current)
      focused.current = leaves(next).find(p=>p.tabIds.includes(activeTabId||''))?.id || leaves(next)[0].id
      return next
    })
  }, [ids, activeTabId])
  useEffect(() => { saveLayout(workspaceKey, tree) }, [workspaceKey, tree])

  const select = (pane:string, id:string) => {
    focused.current = pane
    const state = useStore.getState(), tab = tabs.find(t=>t.id===id)
    if (tab?.type==='terminal' && tab.sessionId) {
      state.acknowledgeCompletion(tab.sessionId)
      if (state.activeId!==tab.sessionId || state._viewerState[workspaceKey]?.activeTabId!==id) { state.setActive(tab.sessionId); notifyActive(tab.sessionId) }
    } else if (state._viewerState[workspaceKey]?.activeTabId!==id) state.setActiveTab(id)
    setTree(prev => leaves(prev).find(p=>p.id===pane)?.activeTabId===id ? prev : mapTree(prev, n=>n.type==='leaf'&&n.id===pane ? {...n,activeTabId:id} : n))
  }
  const move = (id:string, pane:string, zone:DropZone) => {
    setTree(prev => {
      const next=moveTab(prev,id,pane,zone)
      focused.current=leaves(next).find(p=>p.tabIds.includes(id))?.id || pane
      return next
    })
    const state=useStore.getState(), tab=tabs.find(t=>t.id===id)
    if(tab?.type==='terminal'&&tab.sessionId){ state.setActive(tab.sessionId); notifyActive(tab.sessionId) } else state.setActiveTab(id)
  }
  const resize = (id:string, ratio:number) => setTree(prev=>mapTree(prev,n=>n.type==='split'&&n.id===id ? {...n,ratio:Math.max(.15,Math.min(.85,ratio))}:n))
  const merge = () => setTree(newLeaf(tabs.map(t=>t.id),activeTabId))
  if (!tabs.length) return <div className="viewer-empty">왼쪽에서 에이전트 세션이나 파일을 선택하세요.</div>
  return <div className="viewer-inner"><RenderNode node={displayedTree} tabs={tabs} activeTabId={activeTabId} onSelect={select} onClose={(_pane,id)=>useStore.getState().closeTab(id)} onMove={move} onResize={resize} onMerge={merge} split={displayedTree.type==='split'} /></div>
}

interface PaneActions {
  tabs:ViewerTab[]; activeTabId:string|null; split:boolean
  onSelect:(pane:string,id:string)=>void; onClose:(pane:string,id:string)=>void
  onMove:(id:string,pane:string,zone:DropZone)=>void
  onResize:(id:string,ratio:number)=>void; onMerge:()=>void
}
function RenderNode({node,...actions}: {node:TreeNode}&PaneActions) {
  const ref=useRef<HTMLDivElement>(null)
  if(node.type==='leaf')return <LeafPane node={node} {...actions} />
  const horizontal=node.direction==='horizontal'
  return <div ref={ref} className={`workbench-split split-${node.direction}`}>
    <div className="workbench-split-child" style={{flex:node.ratio}}><RenderNode node={node.children[0]} {...actions}/></div>
    <div className="workbench-split-resizer" role="separator" tabIndex={0} aria-label="분할 크기 조절" aria-orientation={horizontal?'vertical':'horizontal'} aria-valuenow={Math.round(node.ratio*100)} aria-valuemin={15} aria-valuemax={85}
      onKeyDown={e=>{if(['ArrowLeft','ArrowUp','ArrowRight','ArrowDown'].includes(e.key)){e.preventDefault();actions.onResize(node.id,node.ratio+(['ArrowLeft','ArrowUp'].includes(e.key)?-.05:.05))}}}
      onPointerDown={e=>{e.preventDefault();e.currentTarget.setPointerCapture(e.pointerId)}}
      onPointerMove={e=>{if(!e.currentTarget.hasPointerCapture(e.pointerId))return;const r=ref.current?.getBoundingClientRect();if(r)actions.onResize(node.id,horizontal?(e.clientX-r.left)/r.width:(e.clientY-r.top)/r.height)}}
      onPointerUp={e=>{if(e.currentTarget.hasPointerCapture(e.pointerId))e.currentTarget.releasePointerCapture(e.pointerId)}} />
    <div className="workbench-split-child" style={{flex:1-node.ratio}}><RenderNode node={node.children[1]} {...actions}/></div>
  </div>
}

function LeafPane({ node, tabs, activeTabId, split, onClose, onSelect, onMove, onMerge }: {node:PaneNode}&PaneActions) {
  const [dropZone, setDropZone] = useState<DropZone|null>(null)
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
    if (!activeTab || activeTab.type === 'terminal' || activeTab.type === 'browser' || activeTab.type === 'pdf' || activeTab.type === 'image') { setMemos([]); return }
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
    if (!activeTab || activeTab.type === 'terminal' || activeTab.type === 'browser' || activeTab.type === 'pdf' || activeTab.type === 'image') return
    try { await navigator.clipboard.writeText(activeTab.content); setCopied(true); setTimeout(() => setCopied(false), 1500) } catch {}
  }

  return (
    <div className={`leaf-pane ${node.activeTabId===activeTabId?'focused-pane':''}`} data-pane-id={node.id}
      onPointerDownCapture={e=>{if(!(e.target as HTMLElement).closest('.vtab-bar, a')&&activeTab)onSelect(node.id,activeTab.id)}}
      onFocusCapture={e=>{if(!(e.target as HTMLElement).closest('.vtab-bar, a')&&activeTab&&node.activeTabId!==activeTabId)onSelect(node.id,activeTab.id)}}
      onDragOver={e=>{
        if(!e.dataTransfer.types.includes('application/agentboard-tab')||(e.target as HTMLElement).closest('.vtab-bar'))return
        e.preventDefault();const r=e.currentTarget.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height
        setDropZone(x<.22?'left':x>.78?'right':y<.25?'top':y>.75?'bottom':'center')
      }}
      onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDropZone(null)}}
      onDrop={e=>{document.body.classList.remove('dragging-viewer-tab');const id=e.dataTransfer.getData('application/agentboard-tab');if(!id)return;e.preventDefault();onMove(id,node.id,dropZone||'center');setDropZone(null)}}
    >
      <div className="vtab-bar">
        {node.tabIds.map(tid => {
          const t = tabs.find(tt => tt.id === tid)
          if (!t) return null
          return (
            <div key={t.id} className={`vtab ${t.id === node.activeTabId ? 'active' : ''} ${dragTarget === t.id ? 'tab-drop-target' : ''}`}
              draggable
              onDragStart={e => { document.body.classList.add('dragging-viewer-tab'); e.dataTransfer.setData('application/agentboard-tab', t.id); e.dataTransfer.effectAllowed = 'move' }}
              onDragOver={e => { if (e.dataTransfer.types.includes('application/agentboard-tab')) { e.preventDefault(); setDragTarget(t.id) } }}
              onDragLeave={() => setDragTarget(null)}
              onDragEnd={() => { document.body.classList.remove('dragging-viewer-tab'); setDragTarget(null); setDropZone(null) }}
              onDrop={e => { document.body.classList.remove('dragging-viewer-tab'); e.preventDefault(); e.stopPropagation(); const id = e.dataTransfer.getData('application/agentboard-tab'); const r = e.currentTarget.getBoundingClientRect(); if (id) { onMove(id,node.id,'center'); useStore.getState().reorderTab(id, t.id, e.clientX > r.left + r.width / 2) }; setDragTarget(null) }}
              onClick={() => onSelect(node.id, t.id)}
            >
              <span className={`tab-kind tab-kind-${t.type}`}>{t.type === 'browser' ? '◎' : t.type === 'terminal' ? '›_' : t.type === 'pdf' ? 'PDF' : '▤'}</span>
              <span className="vtab-name" title={t.type === 'terminal' && t.sessionId && sessionState[t.sessionId] ? sessionLabel(sessionState[t.sessionId], titles) : t.path}>{t.type === 'terminal' && t.sessionId && sessionState[t.sessionId] ? sessionLabel(sessionState[t.sessionId], titles) : t.name}</span>
              <span title={t.type === 'terminal' ? '탭 닫기 (세션 유지)' : '탭 닫기'} className="vtab-close vtab-x" onClick={e => { e.stopPropagation(); onClose(node.id, t.id) }}>&times;</span>
            </div>
          )
        })}
        <div className="vtab-actions">
          <button className="vtab-action" title="좌우 분할 (선택한 탭을 오른쪽으로)" disabled={node.tabIds.length<2} onClick={()=>activeTab&&onMove(activeTab.id,node.id,'right')}>◫</button>
          <button className="vtab-action" title="상하 분할 (선택한 탭을 아래로)" disabled={node.tabIds.length<2} onClick={()=>activeTab&&onMove(activeTab.id,node.id,'bottom')}>⬒</button>
          {split&&<button className="vtab-action" title="분할 합치기" onClick={onMerge}>▣</button>}
          {isTextTab && <button className="vtab-action" onClick={copyContent} title="Copy">{copied ? '✓' : '⎘'}</button>}
          {isRendered && <button className="vtab-action" onClick={() => setMdEditMode(v => !v)} title={mdEditMode ? 'Preview' : 'Edit'}>{mdEditMode ? '👁' : '✎'}</button>}
          {dirty && <button className="vtab-action vtab-send" onClick={saveFile} title="Save (Ctrl+S)" disabled={saving}>{saving ? '...' : '💾'}</button>}
          {activeTab?.type !== 'terminal' && activeTab?.type !== 'browser' && <button className="vtab-action" onClick={downloadTab} title="Download">↓</button>}
          {activeTab?.type !== 'terminal' && activeTab?.type !== 'browser' && <button className="vtab-action" onClick={refreshTab} title="Refresh">↻</button>}
          {isTextTab && memos.length > 0 && (
            <button className="vtab-action vtab-send" onClick={sendMemosToAgent} title="Send notes to agent">
              ▶ {memos.length}
            </button>
          )}
        </div>
      </div>
      <div className="viewer-body">
      <div ref={contentRef} className={`viewer-content ${activeTab?.type === 'terminal' ? 'terminal-tab-content' : activeTab?.type === 'browser' ? 'browser-tab-content' : ''}`} onClick={e => {
        setCtxMenu(null)
        const link=(e.target as HTMLElement).closest('a')
        const href=link?.getAttribute('href')
        if(activeTab?.type!=='browser'&&href&&/^https?:\/\//i.test(href)&&!e.ctrlKey&&!e.metaKey&&!e.shiftKey&&!e.altKey){e.preventDefault();if(activeTab)onSelect(node.id,activeTab.id);useStore.getState().openBrowser(href,ownerKey)}
      }}>
        {!activeTab ? <div className="viewer-empty">Drop here</div>
          : activeTab.type === 'terminal' ? <TerminalTab key={activeTab.sessionId} sessionId={activeTab.sessionId!} />
          : activeTab.type === 'browser' ? <BrowserPane key={activeTab.id} tab={activeTab} ownerKey={ownerKey} />
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
      {activeTab && activeTab.type!=='pdf' && activeTab.type!=='terminal' && activeTab.type!=='browser' && <ScrollSlider container={contentRef} identity={`${activeTab.id}:${mdEditMode}`} />}
      </div>
      {dropZone&&<div className={`pane-drop-overlay pane-drop-${dropZone}`}>{dropZone==='center'?'이 화면으로 탭 이동':'여기에 화면 분할'}</div>}
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
  if (!session) return <div className="viewer-empty">종료되거나 제거된 세션입니다. 이 탭을 닫아 주세요.</div>
  return <><TerminalPane sessionId={sessionId} /><InputCard key={sessionId} sessionId={sessionId} /></>
}
