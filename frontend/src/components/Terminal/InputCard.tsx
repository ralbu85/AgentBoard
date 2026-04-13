import { useRef, useState, useEffect, type KeyboardEvent, type DragEvent } from 'react'
import { api } from '../../api'
import { useStore } from '../../store'
import { FilePanel } from '../FilePanel'

interface Props {
  sessionId: string
}

const QUICK_KEYS = [
  { label: 'Esc', key: 'Escape' },
  { label: '\u2191', key: 'Up' },
  { label: '\u2193', key: 'Down' },
  { label: '\u23CE', key: 'Enter' },
  { label: 'Tab', key: 'Tab' },
  { label: 'C-c', key: 'C-c' },
]

const isMobile = () => window.innerWidth <= 768

export function InputCard({ sessionId }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const [text, setText] = useState('')
  const [showFiles, setShowFiles] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(0)
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd || '~')

  // Close file panel on session switch
  useEffect(() => { setShowFiles(false) }, [sessionId])

  const onDragOver = (e: DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault()
      e.stopPropagation()
      setDragOver(true)
    }
  }
  const onDragLeave = (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    if (e.currentTarget === e.target) setDragOver(false)
  }
  const onDrop = async (e: DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const files = e.dataTransfer.files
    if (!files || files.length === 0) return
    setUploading(files.length)
    try {
      const paths = await api.uploadMany(cwd, files)
      if (paths.length > 0) {
        // Insert paths into textarea (space-separated, with trailing space)
        const insert = paths.join(' ') + ' '
        setText(prev => prev + (prev && !prev.endsWith(' ') ? ' ' : '') + insert)
        textareaRef.current?.focus()
      }
    } finally {
      setUploading(0)
    }
  }

  const doSend = () => {
    if (text.includes('\n')) {
      api.paste(sessionId, text)  // Multi-line: paste as single block
    } else {
      api.input(sessionId, text)  // Single line: send + Enter
    }
    setText('')
    if (textareaRef.current) textareaRef.current.style.height = 'auto'
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      doSend()
    }
  }

  const onQuickKey = (key: string) => {
    api.key(sessionId, key)
  }

  // Mobile: full tab switch to file panel
  if (isMobile() && showFiles) {
    return <FilePanel initialPath={cwd} onClose={() => setShowFiles(false)} />
  }

  return (
    <div
      className={`input-card ${dragOver ? 'drag-over' : ''}`}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
    >
      {dragOver && <div className="input-drop-overlay">파일을 놓아 업로드 → 경로가 입력창에 추가됩니다</div>}
      {uploading > 0 && <div className="input-upload-status">업로드 중 {uploading}…</div>}
      <div className="input-row">
        {isMobile() && (
          <button className="btn file-browse-btn" data-action="browse" onClick={() => setShowFiles(true)} title="Files">
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M2 5C2 4 3 3 4 3H8L10 5H16C17 5 18 6 18 7V15C18 16 17 17 16 17H4C3 17 2 16 2 15V5Z" stroke="currentColor" strokeWidth="1.5"/></svg>
          </button>
        )}
        <textarea
          ref={textareaRef}
          className="input-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder="Type command..."
          rows={1}
        />
        <button className="btn send-btn" onClick={doSend}>Send</button>
      </div>
      <div className="quick-keys">
        {QUICK_KEYS.map((k) => (
          <button key={k.key} className="btn quick-key" onClick={() => onQuickKey(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  )
}
