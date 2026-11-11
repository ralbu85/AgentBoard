import { create } from 'zustand'
import { api } from '../../api'
import { useToasts } from '../../toasts'
import { useDrafts } from './drafts'

// Voice input for the desktop input card (phones have their keyboard's own).
// The browser records; this server's Whisper writes it out, so speech never
// leaves the server. One recording at a time. Its text goes to the draft of the
// session it was started for: at the caret when that card is open (`inserters`),
// else at the end of the draft.

type Phase = 'idle' | 'recording' | 'transcribing'
export const useVoice = create<{ phase: Phase; draftKey: string | null; started: number }>(() => ({ phase: 'idle', draftKey: null, started: 0 }))
export const inserters = new Map<string, (text: string) => boolean>()

const MAX_MS = 5 * 60_000   // well under the server's upload limit
let recorder: MediaRecorder | null = null
let stream: MediaStream | null = null
let chunks: Blob[] = []
let limit = 0, starting = false, cancelled = false

let available: Promise<boolean> | null = null
/** Whether this server can transcribe (asked once). */
export const voiceAvailable = () => available ||= api.transcribeAvailable()

const toast = (text: string) => useToasts.getState().push(text)
const refusal = (e: unknown) => {
  const name = e instanceof DOMException ? e.name : ''
  if (name === 'NotAllowedError' || name === 'SecurityError') return '마이크 권한이 꺼져 있습니다. 주소창 왼쪽의 사이트 설정에서 마이크를 허용해 주세요.'
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return '마이크를 찾지 못했습니다.'
  if (name === 'NotReadableError') return '다른 프로그램이 마이크를 쓰고 있습니다.'
  return '마이크를 켜지 못했습니다.'
}

export async function startVoice(draftKey: string) {
  if (starting || useVoice.getState().phase !== 'idle') return
  // getUserMedia exists only on HTTPS (or localhost) pages.
  if (!navigator.mediaDevices?.getUserMedia || typeof MediaRecorder === 'undefined') {
    toast('이 주소에서는 마이크를 쓸 수 없습니다. HTTPS 주소로 접속해 주세요.')
    return
  }
  starting = true
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, channelCount: 1 } })
  } catch (e) {
    toast(refusal(e))
    return
  } finally { starting = false }
  const type = ['audio/webm;codecs=opus', 'audio/ogg;codecs=opus', 'audio/mp4'].find(t => MediaRecorder.isTypeSupported(t))
  const rec = recorder = new MediaRecorder(stream, type ? { mimeType: type } : undefined)
  chunks = []; cancelled = false
  rec.ondataavailable = e => { if (e.data.size) chunks.push(e.data) }
  rec.onstop = () => void finish(draftKey, rec.mimeType)
  rec.start(1000)
  api.transcribeWarm()   // the model loads while the user speaks
  limit = window.setTimeout(() => stopVoice(), MAX_MS)
  useVoice.setState({ phase: 'recording', draftKey, started: Date.now() })
}

/** Ends the recording and writes it out; `cancel` drops it instead. */
export function stopVoice(cancel = false) {
  if (!recorder || recorder.state === 'inactive') return
  cancelled = cancel
  recorder.stop()
}

async function finish(draftKey: string, type: string) {
  window.clearTimeout(limit)
  stream?.getTracks().forEach(track => track.stop())   // the browser's mic indicator goes off
  stream = null; recorder = null
  const audio = new Blob(chunks, { type })
  chunks = []
  if (cancelled || !audio.size) { useVoice.setState({ phase: 'idle', draftKey: null }); return }
  useVoice.setState({ phase: 'transcribing' })
  const result = await api.transcribe(audio)
  useVoice.setState({ phase: 'idle', draftKey: null })
  if (!result.ok) { toast(result.error); return }
  if (!result.text) { toast('알아들은 말이 없습니다. 다시 녹음해 주세요.'); return }
  if (inserters.get(draftKey)?.(result.text)) return
  useDrafts.getState().write(draftKey, previous => previous + (previous && !/\s$/.test(previous) ? ' ' : '') + result.text)
}
