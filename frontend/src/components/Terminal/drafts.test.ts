import {beforeEach, expect, it} from 'vitest'
import {useDrafts} from './drafts'
beforeEach(() => { localStorage.clear(); useDrafts.setState({drafts:{}}) })
it('isolates session drafts and persists them across component unmounts', () => {
  const s = useDrafts.getState()
  s.write('local:a', '한글 작성 중'); s.write('local:b', 'second draft')
  expect(useDrafts.getState().drafts['local:a']).toBe('한글 작성 중')
  expect(JSON.parse(localStorage.getItem('agentboard.inputDrafts')!)).toEqual({'local:a':'한글 작성 중','local:b':'second draft'})
})
it('does not erase newer typing when an earlier send finishes', () => {
  const s = useDrafts.getState(); s.write('a', 'sent')
  const sent = useDrafts.getState().drafts.a
  s.write('a','new text')
  s.write('a', current => current === sent ? '' : current)
  expect(useDrafts.getState().drafts.a).toBe('new text')
  s.write('a','')
  expect(JSON.parse(localStorage.getItem('agentboard.inputDrafts')!)).toEqual({})
})
