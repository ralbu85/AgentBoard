import { useState, useRef, useCallback, useEffect, Fragment } from 'react'
import { useStore, type ViewerTab } from '../../store'
import { api } from '../../api'
import { FileContent } from './FileContent'

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
  const activeTab = tabs.find(t => t.id === node.activeTabId) || tabs.find(t => node.tabIds.includes(t.id))

  const refreshTab = async () => {
    if (!activeTab) return
    if (activeTab.type === 'pdf' || activeTab.type === 'image') {
      // Force reload by appending cache buster
      const url = activeTab.content.split('&_t=')[0] + '&_t=' + Date.now()
      updateTab(activeTab.id, url)
    } else {
      try {
        const res = await api.readFile(activeTab.path)
        let content = res.content || ''
        if (activeTab.path.endsWith('.json')) try { content = JSON.stringify(JSON.parse(content), null, 2) } catch {}
        updateTab(activeTab.id, content)
      } catch {}
    }
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
        <button className="vtab-refresh" onClick={refreshTab} title="Refresh">↻</button>
      </div>
      <div className="viewer-content">
        {activeTab ? <FileContent content={activeTab.content} type={activeTab.type} lang={activeTab.lang} /> : <div className="viewer-empty">Drop here</div>}
      </div>
      {dropZone && <div className={`drop-indicator drop-${dropZone}`} />}
    </div>
  )
}
