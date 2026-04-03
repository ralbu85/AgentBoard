import { useRef, useState, useEffect, type KeyboardEvent } from 'react'
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
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd || '~')

  // Close file panel on session switch
  useEffect(() => { setShowFiles(false) }, [sessionId])

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
    <div className="input-card">
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
