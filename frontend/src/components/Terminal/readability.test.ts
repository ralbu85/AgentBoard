import {beforeEach, expect, it} from 'vitest'
import {loadTerminalPreferences, viewportScale, viewportRows, desktopColumns} from './readability'
beforeEach(() => localStorage.clear())
it('preserves legible default font and limits unsafe persisted values', () => {
  expect(loadTerminalPreferences()).toEqual({fontSize:15,lineHeight:1,adaptiveColumns:true})
  localStorage.setItem('agentboard.terminalPreferences', JSON.stringify({fontSize:2,lineHeight:8}))
  expect(loadTerminalPreferences()).toMatchObject({fontSize:12,lineHeight:1})
})
it('fits each viewport without changing the source grid or magnifying it', () => {
  expect(viewportScale(360,720,true)).toBe(.5)
  expect(viewportScale(1200,720,true)).toBe(1)
  expect(viewportScale(360,720,false)).toBe(1)
})
it('uses a compact phone font without inheriting desktop zoom preferences', () => {
  localStorage.setItem('agentboard.terminalPreferences', JSON.stringify({fontSize:22}))
  expect(loadTerminalPreferences(true).fontSize).toBe(12)
  expect(loadTerminalPreferences(false).fontSize).toBe(22)
  localStorage.setItem('agentboard.terminalPreferences.mobile', JSON.stringify({fontSize:14}))
  expect(loadTerminalPreferences(true).fontSize).toBe(14)
})
it('remembers independent fit preferences on phone and desktop', () => {
  localStorage.setItem('agentboard.terminalPreferences.mobile', JSON.stringify({fontSize:14,adaptiveColumns:false}))
  localStorage.setItem('agentboard.terminalPreferences', JSON.stringify({fontSize:15,adaptiveColumns:false}))
  expect(loadTerminalPreferences(true)).toMatchObject({fontSize:14,adaptiveColumns:false})
  expect(loadTerminalPreferences(false).adaptiveColumns).toBe(false)
})

it('adds desktop history rows using scaled cell height and keeps legacy/mobile source rows',()=>{
  expect(viewportRows(900,15,1,40,true)).toBe(60)
  expect(viewportRows(630,15,.75,40,true)).toBe(56)
  expect(viewportRows(300,15,1,40,true)).toBe(40)
  expect(viewportRows(900,15,1,40,false)).toBe(40)
})

it('calculates desktop columns from available space within the protocol bounds',()=>{
  expect(desktopColumns(1200,8)).toBe(150)
  expect(desktopColumns(641,8)).toBe(80)
  expect(desktopColumns(360,8)).toBe(80)
  expect(desktopColumns(4000,8)).toBe(240)
})
