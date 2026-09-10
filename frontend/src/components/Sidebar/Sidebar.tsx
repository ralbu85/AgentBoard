import { useState, useEffect, useRef } from 'react'
import { FolderList } from './FolderList'
import { FilePanel } from '../FilePanel'
import { useStore } from '../../store'

interface Props { visible: boolean; onClose?: () => void; width?: number }

export function Sidebar({ visible, onClose, width }: Props) {
  const isMobile = window.innerWidth <= 768
  const cwd = useStore(s => s.workspaceCwd)
  const host = useStore(s => s.workspaceHost)
  const openWorkspaceModal = useStore(s => s.openWorkspaceModal)
  const modalOpen = useStore(s => s.workspaceModalOpen)
  const [pickerOpen, setPickerOpen] = useState(false)
  const [filesOpen, setFilesOpen] = useState(true)
  const selectorRef = useRef<HTMLDivElement>(null)
  const triggerRef = useRef<HTMLButtonElement>(null)
  useEffect(() => {
    if (!pickerOpen) return
    const outside = (e: PointerEvent) => { if (!selectorRef.current?.contains(e.target as Node)) setPickerOpen(false) }
    const escape = (e: KeyboardEvent) => { if (e.key === 'Escape') { setPickerOpen(false); triggerRef.current?.focus() } }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('keydown', escape)
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape) }
  }, [pickerOpen])
  useEffect(() => { if (modalOpen) setPickerOpen(false) }, [modalOpen])
  useEffect(() => { setFilesOpen(true) }, [cwd, host])
  if (!visible) return null
  const name = cwd?.split('/').filter(Boolean).pop() || cwd || '워크스페이스 선택'
  return <>
    <div className="sidebar-backdrop" onClick={onClose} />
    <aside className="sidebar workspace-sidebar" style={width && !isMobile ? { width } : undefined}>
      {isMobile ? <FolderList onSelect={onClose} /> : <>
        <div className="workspace-selector" ref={selectorRef}>
          <button ref={triggerRef} className="workspace-switcher" aria-expanded={pickerOpen} aria-controls="workspace-picker" onClick={() => setPickerOpen(v => !v)} title="워크스페이스 전환 및 관리">
            <span className="workspace-switcher-copy"><span className="workspace-switcher-label">WORKSPACE</span><strong>{name}</strong><small title={cwd || ''}>{host} {cwd && `· ${cwd}`}</small></span>
            <span className="workspace-switcher-caret">⌄</span>
          </button>
          {pickerOpen && <div id="workspace-picker" className="workspace-picker-popover" aria-label="워크스페이스 전환 및 관리">
            <FolderList onSelect={() => { setPickerOpen(false); setFilesOpen(true); triggerRef.current?.focus() }} />
          </div>}
        </div>
        {cwd ? filesOpen ? <div className="sidebar-explorer">
          {host === 'local' ? <FilePanel key={`${host}:${cwd}`} initialPath={cwd} onClose={() => setFilesOpen(false)} />
            : <p className="folder-empty">원격 파일 탐색은 아직 지원하지 않습니다.<br />선택한 머신: {host}</p>}
        </div> : <button className="sidebar-files-reopen" onClick={() => setFilesOpen(true)}>파일 탐색기 열기</button>
          : <div className="workspace-sidebar-empty"><p>폴더를 열어 파일과 세션을 관리하세요.</p><button className="btn btn-primary" onClick={openWorkspaceModal}>워크스페이스 열기</button></div>}
      </>}
    </aside>
  </>
}
