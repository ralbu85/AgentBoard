import {WorkspaceTabs} from './WorkspaceTabs'
import {useDrafts} from '../Terminal/drafts'
import { useState, useRef, useCallback, useEffect, useMemo, useLayoutEffect, Fragment } from 'react'
import { isEditableFile, useStore, viewerKey, sessionLabel, type ViewerTab } from '../../store'
import { useToasts } from '../../toasts'
import { notifyActive } from '../../ws'
import { api } from '../../api'
import { FileContent, type Memo, type SelectionInfo } from './FileContent'
import { PdfViewer } from '../PdfViewer'
import { BrowserPane } from './BrowserPane'
import { ScrollSlider } from './ScrollSlider'
import { DocSurface } from './DocSurface'
import { useFileChanges } from './docSync'
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
  const [compact, setCompact] = useState(() => window.matchMedia('(max-width: 768px)').matches)
  useEffect(() => {
    const media = window.matchMedia('(max-width: 768px)')
    const update = () => setCompact(media.matches)
    media.addEventListener('change', update)
    return () => media.removeEventListener('change', update)
  }, [])
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
    pane = leaves(displayedTree).find(p => p.tabIds.includes(id))?.id || pane
    focused.current = pane
    const state = useStore.getState(), tab = tabs.find(t=>t.id===id)
    if (tab?.type==='terminal' && tab.sessionId) {
      state.acknowledgeCompletion(tab.sessionId)
      if (state.activeId!==tab.sessionId || state._viewerState[workspaceKey]?.activeTabId!==id) { state.setActive(tab.sessionId); notifyActive(tab.sessionId) }
    } else if (state._viewerState[workspaceKey]?.activeTabId!==id) state.setActiveTab(id)
    setTree(prev => leaves(prev).find(p=>p.id===pane)?.activeTabId===id ? prev : mapTree(prev, n=>n.type==='leaf'&&n.id===pane ? {...n,activeTabId:id} : n))
  }
  const move = (id:string, pane:string, zone:DropZone) => {
    if (compact) return // Mobile tab reordering must not rewrite desktop pane membership.
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
  // Present all tabs in one full-width pane on phones. Only the original tree
  // is persisted, so rotating/resizing back restores the desktop split layout.
  const visibleTree:TreeNode = compact ? {type:'leaf',id:'mobile-view',tabIds:tabs.map(t=>t.id),activeTabId:activeTabId||tabs[0].id} : displayedTree
  return <div className={`viewer-inner${compact?' compact-viewer':''}`}><RenderNode node={visibleTree} tabs={tabs} activeTabId={activeTabId} onSelect={select} onClose={(_pane,id)=>useStore.getState().closeTab(id,workspaceKey)} onMove={move} onResize={resize} onMerge={merge} split={!compact&&displayedTree.type==='split'} /></div>
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
  const contentRef = useRef<HTMLDivElement>(null)
  const updateTab = useStore(s => s.updateTab)
  const markTabSaved = useStore(s => s.markTabSaved)
  const sessionState = useStore(s => s.sessions)
  const titles = useStore(s => s.titles)
  const ownerKey = useStore(viewerKey)
  const activeSessionId = useStore(s => s.activeId)
  const activeTab = tabs.find(t => t.id === node.activeTabId) || tabs.find(t => node.tabIds.includes(t.id))

  const isTextTab = activeTab && (activeTab.type === 'code' || activeTab.type === 'markdown' || activeTab.type === 'latex' || activeTab.type === 'notebook')
  const isNb = activeTab?.type === 'notebook'
  // PDFs and images aren't edited here; they reload when the file changes.
  const fileChanges = useFileChanges(activeTab && (activeTab.type === 'pdf' || activeTab.type === 'image') && activeTab.path.startsWith('/') ? activeTab.path : undefined)

  // ── Memo state ──
  const [memos, setMemos] = useState<Memo[]>([])
  const [notesBusy,setNotesBusy]=useState(false)
  const [noteTarget,setNoteTarget]=useState('')
  const notePath=useRef(activeTab?.path);notePath.current=activeTab?.path
  const noteSessions=Object.values(sessionState).filter(s=>JSON.stringify([s.host||'local',s.cwd||'~'])===ownerKey && s.status==='running' && s.online!==false)
  const targetId=noteSessions.some(s=>s.id===noteTarget)?noteTarget:noteSessions.some(s=>s.id===activeSessionId)?activeSessionId||'':noteSessions.length===1?noteSessions[0].id:''
  const [selInfo, setSelInfo] = useState<{ startLine: number; startCol: number; endLine: number; endCol: number; selectedText: string } | null>(null)
  const [ctxMenu, setCtxMenu] = useState<{ x: number; y: number } | null>(null)
  const pendingSelRef = useRef<{ startLine: number; startCol: number; endLine: number; endCol: number; text: string } | null>(null)

  useEffect(() => {
    let alive=true
    setMemos([]);setSelInfo(null);setCtxMenu(null);pendingSelRef.current=null
    if (!isTextTab || !activeTab) {setNotesBusy(false);return}
    setNotesBusy(true)
    api.loadNotes(activeTab.path).then(res=>{if(alive)setMemos(res.notes||[])}).catch(()=>{}).finally(()=>{if(alive)setNotesBusy(false)})
    return()=>{alive=false}
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
  }, [activeTab?.id])

  // ── Memo CRUD ──
  const saveMemoList=async(updated:Memo[])=>{
    if(!activeTab||notesBusy)return false
    const path=activeTab.path
    setNotesBusy(true)
    try{
      const result=await api.saveNotes(path,updated)
      if(result.ok===false)return false
      if(notePath.current===path)setMemos(updated)
      return true
    }finally{if(notePath.current===path)setNotesBusy(false)}
  }
  const handleSaveMemo=async(newMemo:Memo)=>{
    const path=activeTab?.path
    if(await saveMemoList([...memos,newMemo])&&notePath.current===path)setSelInfo(null)
  }
  const deleteMemo=(idx:number)=>saveMemoList(memos.filter((_,i)=>i!==idx))

  const sendMemosToAgent=()=>{
    if(!activeTab||!targetId||notesBusy||!memos.length)return
    const session=sessionState[targetId]
    const parts=[`파일: ${activeTab.path}`, '다음 메모에 따라 수정해 주세요. 선택 문장을 기준으로 위치를 확인해 주세요.']
    for(const m of [...memos].sort((a,b)=>a.startLine-b.startLine)){
      parts.push(`\n${m.startLine>0?`[L${m.startLine}${m.endLine!==m.startLine?'-'+m.endLine:''}] `:''}요청: ${m.text}`)
      if(m.selectedText)parts.push('선택 문장:\n'+m.selectedText.split('\n').map(line=>'> '+line).join('\n'))
    }
    const key=JSON.stringify([session.host||'local',session.id,session.cwd||'~'])
    useDrafts.getState().write(key,previous=>[previous,parts.join('\n')].filter(Boolean).join('\n\n'))
    useStore.getState().setActive(targetId)
  }

  // Open files follow the disk by themselves; ↻ is for anything that doesn't.
  const followsDisk = isEditableFile(activeTab) || isNb || ((activeTab?.type === 'pdf' || activeTab?.type === 'image') && !!activeTab?.path.startsWith('/'))
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
      onPointerDownCapture={e=>{if(!(e.target as HTMLElement).closest('.vtab-bar, .workspace-tabs-popup, a')&&activeTab)onSelect(node.id,activeTab.id)}}
      onFocusCapture={e=>{if(!(e.target as HTMLElement).closest('.vtab-bar, .workspace-tabs-popup, a')&&activeTab&&node.activeTabId!==activeTabId)onSelect(node.id,activeTab.id)}}
      onDragEnd={()=>setDropZone(null)}
      onDragOver={e=>{
        if(!e.dataTransfer.types.includes('application/agentboard-tab')||(e.target as HTMLElement).closest('.vtab-bar'))return
        e.preventDefault();const r=e.currentTarget.getBoundingClientRect(),x=(e.clientX-r.left)/r.width,y=(e.clientY-r.top)/r.height
        setDropZone(x<.22?'left':x>.78?'right':y<.25?'top':y>.75?'bottom':'center')
      }}
      onDragLeave={e=>{if(!e.currentTarget.contains(e.relatedTarget as Node))setDropZone(null)}}
      onDrop={e=>{document.body.classList.remove('dragging-viewer-tab');const id=e.dataTransfer.getData('application/agentboard-tab');if(!id)return;e.preventDefault();onMove(id,node.id,dropZone||'center');setDropZone(null)}}
    >
      <WorkspaceTabs tabs={tabs} paneIds={node.tabIds} activeId={activeTab?.id||null}
        onSelect={id=>onSelect(node.id,id)} onClose={id=>onClose(node.id,id)}
        onDrop={(id,target,after)=>{onMove(id,node.id,'center');useStore.getState().reorderTab(id,target,after);setDropZone(null)}}
        actions={
        <div className="vtab-actions">
          <button className="vtab-action vtab-action-split" title="좌우 분할 (선택한 탭을 오른쪽으로)" disabled={node.tabIds.length<2} onClick={()=>activeTab&&onMove(activeTab.id,node.id,'right')}>◫</button>
          <button className="vtab-action vtab-action-split" title="상하 분할 (선택한 탭을 아래로)" disabled={node.tabIds.length<2} onClick={()=>activeTab&&onMove(activeTab.id,node.id,'bottom')}>⬒</button>
          {split&&<button className="vtab-action vtab-action-split" title="분할 합치기" onClick={onMerge}>▣</button>}
          {isTextTab && <button className="vtab-action" onClick={copyContent} title="Copy">{copied ? '✓' : '⎘'}</button>}
          {activeTab?.type !== 'terminal' && activeTab?.type !== 'browser' && <button className="vtab-action" onClick={downloadTab} title="Download">↓</button>}
          {activeTab?.type !== 'terminal' && activeTab?.type !== 'browser' && !followsDisk && <button className="vtab-action" onClick={refreshTab} title="Refresh">↻</button>}
          {isTextTab && memos.length > 0 && (
            <><select className="memo-target-select" aria-label="메모를 받을 세션" value={targetId} onChange={e=>setNoteTarget(e.target.value)}><option value="">대상 세션 선택</option>{noteSessions.map(s=><option key={s.id} value={s.id}>{sessionLabel(s,titles)}</option>)}</select><button className="vtab-action vtab-send" disabled={notesBusy||!targetId} onClick={sendMemosToAgent} title="기존 입력에 메모를 추가합니다. 전송 전 내용을 확인하세요.">채팅에 넣기 · {memos.length}</button></>
          )}
        </div>
      } />
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
          : activeTab.type === 'pdf' ? <PdfViewer key={activeTab.id} url={activeTab.content} viewState={activeTab.viewState} onViewChange={rememberView} reloadSignal={fileChanges} />
          : activeTab.type === 'image' ? <FileContent content={fileChanges ? `${activeTab.content}&_v=${fileChanges}` : activeTab.content} type="image" lang="" />
          : isNb ? <NotebookView key={activeTab.path} tab={activeTab} ownerKey={ownerKey} />
          : <DocSurface key={activeTab.id} tab={activeTab} ownerKey={ownerKey} memos={memos} onContextMenu={handleCtxMenu} onViewChange={rememberView} />
        }
      </div>
      {activeTab && activeTab.type!=='pdf' && activeTab.type!=='terminal' && activeTab.type!=='browser' && <ScrollSlider container={contentRef} identity={activeTab.id} />}
      </div>
      {dropZone&&<div className={`pane-drop-overlay pane-drop-${dropZone}`}>{dropZone==='center'?'이 화면으로 탭 이동':'여기에 화면 분할'}</div>}
      {ctxMenu && (
        <div className="ctx-menu" style={{ left: ctxMenu.x, top: ctxMenu.y }} onClick={e => e.stopPropagation()}>
          <button className="ctx-menu-item" disabled={notesBusy} onClick={addNoteFromCtx}>＋ 메모 추가</button>
        </div>
      )}
      {selInfo && (
        <MemoInputPanel busy={notesBusy} selInfo={selInfo} onSave={handleSaveMemo} onCancel={() => setSelInfo(null)} />
      )}
      {isTextTab && memos.length > 0 && !selInfo && (
        <div className="memo-list">
          {memos.map((m,i)=>({m,i})).sort((a,b)=>a.m.startLine-b.m.startLine).map(({m,i}) => (
            <div key={i} className="memo-item">
              <span className="memo-item-range">{m.startLine===0?'선택 문장':m.startCol ? `L${m.startLine}:${m.startCol}-${m.endLine}:${m.endCol}` : `L${m.startLine}${m.endLine !== m.startLine ? `-${m.endLine}` : ''}`}</span>
              <span className="memo-item-text">{m.text}</span>
              <button className="memo-item-del" disabled={notesBusy} onClick={() => deleteMemo(i)}>&times;</button>
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
function MemoInputPanel({ selInfo, onSave, onCancel, busy }: {
  selInfo: { startLine: number; startCol: number; endLine: number; endCol: number; selectedText: string }
  busy:boolean
  onSave: (memo: Memo) => void
  onCancel: () => void
}) {
  const [text, setText] = useState('')
  const ref = useRef<HTMLTextAreaElement>(null)
  useEffect(() => { setTimeout(() => ref.current?.focus(), 50) }, [])

  const save = () => {
    if (busy||!text.trim()) return
    onSave({ startLine: selInfo.startLine, startCol: selInfo.startCol, endLine: selInfo.endLine, endCol: selInfo.endCol, text: text.trim(), selectedText: selInfo.selectedText })
  }

  return (
    <div className="memo-panel">
      <div className="memo-panel-header">
        <span className="memo-panel-range">
          {selInfo.startLine>0?`L${selInfo.startLine}–${selInfo.endLine}`:'선택 문장'}
        </span>
        <span className="memo-panel-excerpt">{selInfo.selectedText.slice(0, 60)}{selInfo.selectedText.length > 60 ? '...' : ''}</span>
        <button className="btn btn-xs" onClick={onCancel}>&times;</button>
      </div>
      <textarea
        ref={ref}
        className="memo-textarea"
        value={text}
        onChange={e => setText(e.target.value)}
        placeholder="수정 요청을 입력하세요…"
        rows={2}
        onKeyDown={e => { if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) save() }}
      />
      <div className="memo-panel-actions">
        <button className="btn btn-xs" onClick={onCancel}>취소</button>
        <button className="btn btn-xs btn-primary" onClick={save} disabled={busy||!text.trim()}>{busy?'저장 중…':'메모 저장'}</button>
      </div>
    </div>
  )
}

function TerminalTab({ sessionId }: { sessionId: string }) {
  const session = useStore(s => s.sessions[sessionId])
  if (!session) return <div className="viewer-empty">종료되거나 제거된 세션입니다. 이 탭을 닫아 주세요.</div>
  return <><TerminalPane sessionId={sessionId} /><InputCard key={sessionId} sessionId={sessionId} /></>
}
