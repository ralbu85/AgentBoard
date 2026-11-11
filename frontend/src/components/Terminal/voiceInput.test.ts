import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const transcribe = vi.hoisted(() => vi.fn())
vi.mock('../../api', () => ({ api: { transcribe, transcribeAvailable: async () => true, transcribeWarm: () => {} } }))

import { inserters, startVoice, stopVoice, useVoice } from './voiceInput'
import { useDrafts } from './drafts'
import { useToasts } from '../../toasts'

// A microphone that "records" one chunk and a recorder that hands it over on stop.
const tracks: { stop: () => void; stopped: boolean }[] = []
class FakeRecorder {
  static isTypeSupported = (type: string) => type.startsWith('audio/webm')
  state = 'inactive'; mimeType: string
  ondataavailable: ((e: { data: Blob }) => void) | null = null
  onstop: (() => void) | null = null
  constructor(_stream: unknown, options?: { mimeType: string }) { this.mimeType = options?.mimeType || '' }
  start() { this.state = 'recording' }
  stop() { this.state = 'inactive'; this.ondataavailable?.({ data: new Blob(['voice'], { type: this.mimeType }) }); this.onstop?.() }
}
const settle = () => new Promise(resolve => setTimeout(resolve, 0))
const toasts = () => useToasts.getState().toasts.map(t => t.message)

beforeEach(() => {
  vi.stubGlobal('MediaRecorder', FakeRecorder)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => {
    const track = { stopped: false, stop() { this.stopped = true } }; tracks.push(track)
    return { getTracks: () => [track] }
  } } })
  useDrafts.setState({ drafts: { k: '작성 중' } })
  useToasts.setState({ toasts: [] })
  transcribe.mockReset()
})
afterEach(() => { vi.unstubAllGlobals(); inserters.clear() })

it('records, writes it out on this server and adds the words to the draft', async () => {
  transcribe.mockResolvedValue({ ok: true, text: '테스트를 돌려 줘' })
  await startVoice('k')
  expect(useVoice.getState()).toMatchObject({ phase: 'recording', draftKey: 'k' })
  stopVoice()
  expect(useVoice.getState().phase).toBe('transcribing')
  await settle()
  expect(transcribe.mock.calls[0][0].type).toBe('audio/webm;codecs=opus')
  expect(useDrafts.getState().drafts.k).toBe('작성 중 테스트를 돌려 줘')
  expect(useVoice.getState().phase).toBe('idle')
  expect(tracks[tracks.length - 1].stopped).toBe(true)   // the mic is released
})

it('goes in at the caret when the card is open, and a cancelled recording is dropped', async () => {
  transcribe.mockResolvedValue({ ok: true, text: '여기' })
  const insert = vi.fn(() => true)
  inserters.set('k', insert)
  await startVoice('k'); stopVoice(); await settle()
  expect(insert).toHaveBeenCalledWith('여기')
  expect(useDrafts.getState().drafts.k).toBe('작성 중')
  await startVoice('k'); stopVoice(true); await settle()
  expect(transcribe).toHaveBeenCalledTimes(1)
  expect(useVoice.getState().phase).toBe('idle')
})

it('says why when there is no microphone or the server could not write it out', async () => {
  transcribe.mockResolvedValue({ ok: false, error: '음성 인식 프로그램이 종료되었습니다.' })
  await startVoice('k'); stopVoice(); await settle()
  expect(toasts()).toContain('음성 인식 프로그램이 종료되었습니다.')
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: async () => { throw new DOMException('denied', 'NotAllowedError') } } })
  await startVoice('k')
  expect(toasts().some(t => t.startsWith('마이크 권한이 꺼져 있습니다'))).toBe(true)
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined })   // a plain-HTTP page
  await startVoice('k')
  expect(toasts().some(t => t.includes('HTTPS'))).toBe(true)
  expect(useVoice.getState().phase).toBe('idle')
})
