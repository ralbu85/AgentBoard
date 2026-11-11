import { useRef, useState, useEffect, type KeyboardEvent, type DragEvent } from 'react'
import { useToasts } from '../../toasts'
import { api } from '../../api'
import { useDrafts } from './drafts'
import { useStore } from '../../store'
import { FilePanel } from '../FilePanel'
import * as TM from './TerminalManager'
import { isMobileInputDevice } from './inputDevice'
import { inserters, startVoice, stopVoice, useVoice, voiceAvailable } from './voiceInput'

interface Props {
  sessionId: string
}

const QUICK_KEYS = [
  { label: 'Esc', key: 'Escape' },
  { label: '\u2191', key: 'Up' },
  { label: '\u2193', key: 'Down' },
  { label: '\u232b', key: 'BSpace' },
  { label: 'PgUp', key: 'PageUp' },
  { label: 'PgDn', key: 'PageDown' },
  { label: '\u23CE', key: 'Enter' },
  { label: 'Tab', key: 'Tab' },
  { label: '■ 실행 중단', key: 'C-c' },
]

const isMobile = isMobileInputDevice

export function InputCard({ sessionId }: Props) {
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const draftKey = useStore(s => JSON.stringify([s.sessions[sessionId]?.host || 'local', sessionId, s.sessions[sessionId]?.cwd || '~']))
  const text = useDrafts(s => s.drafts[draftKey] || '')
  const setText = (value: string | ((previous: string) => string)) => useDrafts.getState().write(draftKey, value)
  const [sending, setSending] = useState(false)
  const sendingRef = useRef(false)
  const [showFiles, setShowFiles] = useState(false)
  const [dragOver, setDragOver] = useState(false)
  const [uploading, setUploading] = useState(0)
  const host = useStore(s => s.sessions[sessionId]?.host || 'local')
  const cwd = useStore((s) => s.sessions[sessionId]?.cwd || '~')

  // Close file panel on session switch
  useEffect(() => { setShowFiles(false) }, [sessionId])

  // Voice input (desktop): spoken text goes in at the caret, else at the end.
  const voice = useVoice()
  const [voiceReady, setVoiceReady] = useState(false)
  const [, setTick] = useState(0)
  useEffect(() => { if (!isMobile()) void voiceAvailable().then(setVoiceReady) }, [])
  useEffect(() => {
    if (voice.phase !== 'recording') return
    const timer = window.setInterval(() => setTick(n => n + 1), 1000)
    return () => window.clearInterval(timer)
  }, [voice.phase])
  useEffect(() => {
    const insert = (spoken: string) => {
      const el = textareaRef.current
      if (!el) return false
      const focused = document.activeElement === el
      const start = focused ? el.selectionStart : el.value.length, end = focused ? el.selectionEnd : el.value.length
      const before = el.value.slice(0, start), after = el.value.slice(end)
      const head = before + (before && !/\s$/.test(before) ? ' ' : '') + spoken
      const value = head + (after && !/^\s/.test(after) ? ' ' : '') + after
      useDrafts.getState().write(draftKey, value)
      el.value = value
      el.focus()
      el.setSelectionRange(head.length, head.length)
      return true
    }
    inserters.set(draftKey, insert)
    return () => {
      if (inserters.get(draftKey) === insert) inserters.delete(draftKey)
      // A card closed mid-recording still gets its words, in its draft.
      const now = useVoice.getState()
      if (now.phase === 'recording' && now.draftKey === draftKey) stopVoice()
    }
  }, [draftKey])
  const myVoice = voice.draftKey === draftKey
  const recording = voice.phase === 'recording' && myVoice
  const elapsed = recording ? Math.floor((Date.now() - voice.started) / 1000) : 0

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
    if (host !== 'local') { useToasts.getState().push('원격 파일 업로드는 아직 지원하지 않습니다.'); return }
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

  // Grow the textarea to show what's typed (up to the CSS max-height, then it
  // scrolls) — a 1-row box hid most of a long/multi-line command. Runs on any
  // text change (typing, dropped paths, clear-on-send).
  useEffect(() => {
    const el = textareaRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = `${el.scrollHeight}px`
  }, [text])

  const doSend = async () => {
    if (sendingRef.current) return
    const sent = textareaRef.current?.value ?? text
    sendingRef.current = true
    setSending(true)
    try {
      const result = await api.input(sessionId, sent)
      if (result?.ok !== false) {
        if (result?.sessionState) useStore.getState().applySessionState(result.sessionState)
        setText(current => current === sent ? '' : current)
      }
    } finally { sendingRef.current = false; setSending(false) }
  }

  const onKeyDown = (e: KeyboardEvent) => {
    if (recording && e.key === 'Escape') { e.preventDefault(); stopVoice(true); return }
    if (isMobile() || e.key !== 'Enter' || !e.ctrlKey || e.altKey || e.shiftKey || e.nativeEvent.isComposing || e.nativeEvent.keyCode === 229) return
    e.preventDefault()
    if (!e.repeat) doSend()
  }

  const onQuickKey = (key: string) => {
    if(key==='C-c'&&!window.confirm('현재 터미널에 중단 신호(Ctrl+C)를 보낼까요? 실행 중인 프로그램이나 에이전트가 종료될 수 있습니다.'))return
    // PgUp/PgDn: normal sessions scroll the local xterm scrollback (the app
    // never sees page keys there); alt-screen apps get the key forwarded.
    if (key === 'PageUp' || key === 'PageDown') {
      if (TM.pageView(sessionId, key === 'PageUp')) return
    }
    api.key(sessionId, key)
  }

  const insertDoubleHyphen = () => {
    const el = textareaRef.current
    if (!el) return
    const start = el.selectionStart, end = el.selectionEnd
    const value = el.value.slice(0, start) + '--' + el.value.slice(end)
    setText(value)
    // Update before focusing so the software keyboard sees the new caret.
    el.value = value
    el.focus()
    el.setSelectionRange(start + 2, start + 2)
  }

  // Mobile: full tab switch to file panel
  if (isMobile() && showFiles && host === 'local') {
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
          <button className="btn file-browse-btn" data-action="browse" disabled={host !== 'local'} onClick={() => setShowFiles(true)} title={host === 'local' ? 'Files' : '원격 파일 탐색은 아직 지원하지 않습니다.'}>
            <svg width="18" height="18" viewBox="0 0 20 20" fill="none"><path d="M2 5C2 4 3 3 4 3H8L10 5H16C17 5 18 6 18 7V15C18 16 17 17 16 17H4C3 17 2 16 2 15V5Z" stroke="currentColor" strokeWidth="1.5"/></svg>
          </button>
        )}
        <textarea
          ref={textareaRef}
          className="input-textarea"
          value={text}
          onChange={(e) => setText(e.target.value)}
          onKeyDown={onKeyDown}
          placeholder={isMobile()?'메시지 입력 · Enter 줄바꿈':'메시지 입력 · Ctrl+Enter 전송'}
          enterKeyHint="enter"
          rows={1}
          autoCorrect="off"
          autoCapitalize="none"
          autoComplete="off"
          spellCheck={false}
        />
        {voiceReady && !isMobile() && <>
          {/* pointerdown keeps the caret in the text box, where the words will go */}
          <button className={`btn voice-btn${recording ? ' recording' : ''}`} onPointerDown={e => e.preventDefault()}
            disabled={voice.phase === 'transcribing' || (voice.phase !== 'idle' && !myVoice)}
            onClick={() => recording ? stopVoice() : void startVoice(draftKey)}
            title={recording ? '녹음을 끝내고 입력창에 넣기 (Esc: 취소)' : voice.phase === 'transcribing' && myVoice ? '받아쓰는 중…' : '말로 입력 — 이 서버에서 받아씁니다'}
            aria-label={recording ? '녹음 끝내기' : '말로 입력'}>
            {recording ? `■ ${Math.floor(elapsed / 60)}:${String(elapsed % 60).padStart(2, '0')}` : voice.phase === 'transcribing' && myVoice ? '받아쓰는 중…' : '🎤'}
          </button>
          {recording && <button className="btn voice-cancel" onPointerDown={e => e.preventDefault()} onClick={() => stopVoice(true)} title="녹음 취소" aria-label="녹음 취소">✕</button>}
        </>}
        <button className="btn send-btn" disabled={sending} onClick={doSend} title={isMobile()?'작성한 내용 전송':'작성한 내용 전송 (Ctrl+Enter)'} aria-keyshortcuts={isMobile()?undefined:'Control+Enter'}>Send</button>
      </div>
      <div className="quick-keys">
        <button className="btn quick-key" title="입력창에 하이픈 두 개 삽입" onPointerDown={e => e.preventDefault()} onClick={insertDoubleHyphen}>--</button>
        {QUICK_KEYS.filter(k=>!isMobile()||k.key!=='Enter').map((k) => (
          <button key={k.key} className="btn quick-key" title={k.key==='C-c'?'복사가 아니라 실행 중단 신호를 보냅니다':undefined} onClick={() => onQuickKey(k.key)}>
            {k.label}
          </button>
        ))}
      </div>
    </div>
  )
}
