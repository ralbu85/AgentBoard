import { afterEach, beforeEach, expect, it, vi } from 'vitest'

const notes = vi.hoisted(() => ({ load: vi.fn(), save: vi.fn() }))
vi.mock('../api', () => ({ api: { loadNotes: notes.load, saveNotes: notes.save } }))

import { chatMessage, findQuote, inOrder, locateQuote, memoStore, type PdfMemo } from './pdfMemos'

const memo = (over: Partial<PdfMemo>): PdfMemo => ({ id: 'm', kind: 'text', page: 1, rects: [[0.1, 0.2, 0.3, 0.02]], text: '', created: 1, ...over })

beforeEach(() => { notes.load.mockReset(); notes.save.mockReset() })
afterEach(() => { vi.useRealTimers() })

it('finds a passage again whatever its spaces and line breaks became', () => {
  // A page's text has nothing where a line ends; the memo's words were read with a space there.
  const page = 'We train the modelon two GPUs.Results follow.'
  const hit = findQuote(page, { quote: 'the model on two', start: 9 })!
  expect(page.slice(hit.start, hit.end)).toBe('the modelon two')
  expect(findQuote(page, { quote: 'three GPUs' })).toBeNull()
})

it('tells repeated words apart by the words around them, then by where they were', () => {
  const page = 'loss is low. The loss is high. Again the loss is low.'
  const second = findQuote(page, { quote: 'loss', prefix: 'The ', suffix: ' is high' })!
  expect(second.start).toBe(page.indexOf('loss is high'))
  const nearest = findQuote(page, { quote: 'loss', start: 40 })!
  expect(nearest.start).toBe(page.lastIndexOf('loss'))
})

it('follows a passage a recompile moved to another page, but not a common word', () => {
  const moved = memo({ page: 1, quote: 'a careful ablation of the encoder', prefix: 'We then run ', suffix: ' in Table 2', start: 30 })
  const texts = ['Introduction. Our method is new.', 'We then run a careful ablation of the encoder in Table 2.']
  expect(locateQuote(moved, texts)).toEqual({ page: 2, start: 12, end: 45 })
  const word = memo({ page: 1, quote: 'model', start: 3 })
  expect(locateQuote(word, ['Nothing here.', 'The model is big.'])).toBeNull()      // could be any "model"
  expect(locateQuote(memo({ page: 2, quote: 'removed sentence' }), texts)).toBeNull()
})

it('reports a passage deleted or rewritten in place as not found, though its words recur elsewhere', () => {
  const m = memo({ page: 1, quote: 'by a wide margin', prefix: 'Our agent beats every baseline ', suffix: ' on all four benchmarks.', start: 31 })
  const elsewhere = 'Related work also wins by a wide margin on all four benchmarks of theirs.'
  expect(locateQuote(m, ['Our agent beats every baseline on all four benchmarks.', elsewhere])).toBeNull()
  expect(locateQuote(m, ['Our agent beats every baseline clearly on all four benchmarks.', elsewhere])).toBeNull()
  // the same words, the same surroundings, two pages on: moved, not rewritten
  expect(locateQuote(m, ['Introduction.', elsewhere, 'Our agent beats every baseline by a wide margin on all four benchmarks.'])).toMatchObject({ page: 3, start: 31 })
})

it('writes the memos as a request, in page order, leaving out bare highlights', () => {
  const memos = inOrder([
    memo({ id: 'b', page: 3, kind: 'area', rects: [[0.7, 0.05, 0.2, 0.1]], text: '그림 범례를 키워 주세요' }),
    memo({ id: 'a', page: 2, quote: 'the modelon two', text: '모델 이름을 명시' }),
    memo({ id: 'c', page: 2, quote: 'just marked', rects: [[0, 0.5, 0.1, 0.02]] }),
    memo({ id: 'd', page: 4, quote: 'old wording', text: '다듬기' }),
  ])
  expect(memos.map(m => m.id)).toEqual(['a', 'c', 'b', 'd'])
  expect(chatMessage('/p/paper.pdf', memos, new Set(['d']))).toBe([
    '파일: /p/paper.pdf',
    'PDF에 단 메모입니다. 메모대로 이 PDF의 원본을 고쳐 주세요. 선택 문장으로 위치를 찾아 주세요.',
    '\n[p.2] 요청: 모델 이름을 명시', '선택 문장:\n> the modelon two',
    '\n[p.3 영역, 페이지 위쪽 오른편] 요청: 그림 범례를 키워 주세요',
    '\n[p.4, 지금 PDF에서는 이 문장을 찾지 못함] 요청: 다듬기', '선택 문장:\n> old wording',
  ].join('\n'))
})

it('shows each change at once, saves after typing pauses, and never sends two saves at a time', async () => {
  vi.useFakeTimers()
  const kept = { startLine: 3, endLine: 3, text: 'a line memo' }
  notes.load.mockResolvedValue({ notes: [kept, memo({ id: 'x' })] })
  let finish = () => {}
  notes.save.mockImplementation(() => new Promise<void>(resolve => { finish = resolve }))
  const shown: PdfMemo[][] = []
  const store = memoStore('/p/a.pdf', memos => shown.push(memos))
  store.change(() => [])                     // nothing to change before it has loaded
  await store.load()
  expect(shown[shown.length - 1].map(m => m.id)).toEqual(['x'])

  store.change(list => list.map(m => ({ ...m, text: '첫' })))
  store.change(list => list.map(m => ({ ...m, text: '첫 메모' })))
  expect(shown[shown.length - 1][0].text).toBe('첫 메모')
  expect(notes.save).not.toHaveBeenCalled()
  await vi.advanceTimersByTimeAsync(500)
  expect(notes.save).toHaveBeenCalledTimes(1)
  expect(notes.save.mock.calls[0][1]).toEqual([kept, { ...memo({ id: 'x' }), text: '첫 메모' }])   // the line memo stays

  store.change(list => [...list, memo({ id: 'y' })], true)   // while the first save is out
  expect(notes.save).toHaveBeenCalledTimes(1)
  finish(); await vi.advanceTimersByTimeAsync(0)
  expect(notes.save).toHaveBeenCalledTimes(2)
  expect(notes.save.mock.calls[1][1].map((m: { id?: string }) => m.id)).toEqual([undefined, 'x', 'y'])

  store.change(list => list.filter(m => m.id !== 'y'))
  finish(); store.close()                   // closing saves what is still waiting
  await vi.advanceTimersByTimeAsync(0)
  expect(notes.save).toHaveBeenCalledTimes(3)
})
