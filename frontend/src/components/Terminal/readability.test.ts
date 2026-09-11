import {beforeEach, expect, it} from 'vitest'
import {loadTerminalPreferences, terminalGeometry} from './readability'
beforeEach(() => localStorage.clear())
it('preserves legible default font and limits unsafe persisted values', () => {
  expect(loadTerminalPreferences()).toEqual({fontSize:15,lineHeight:1,adaptiveColumns:true})
  localStorage.setItem('agentboard.terminalPreferences', JSON.stringify({fontSize:2,lineHeight:8}))
  expect(loadTerminalPreferences()).toMatchObject({fontSize:12,lineHeight:1})
})
it('adapts columns within the server protocol limits without shrinking the font', () => {
  expect(terminalGeometry(450,800,9,19,true)).toEqual({cols:50,rows:42})
  expect(terminalGeometry(100,100,9,19,true)).toEqual({cols:30,rows:40})
  expect(terminalGeometry(2000,9000,9,19,true)).toEqual({cols:80,rows:200})
  expect(terminalGeometry(450,800,9,19,false).cols).toBe(80)
})
it('uses a compact phone font without inheriting desktop zoom preferences', () => {
  localStorage.setItem('agentboard.terminalPreferences', JSON.stringify({fontSize:22}))
  expect(loadTerminalPreferences(true).fontSize).toBe(12)
  expect(loadTerminalPreferences(false).fontSize).toBe(22)
  localStorage.setItem('agentboard.terminalPreferences.mobile', JSON.stringify({fontSize:14}))
  expect(loadTerminalPreferences(true).fontSize).toBe(14)
})
