import {afterEach,describe,expect,it,vi} from 'vitest'
import {handleCopyKey,writeClipboard} from './clipboard'

afterEach(()=>{vi.restoreAllMocks();vi.unstubAllGlobals()})
describe('terminal copy never interrupts',()=>{
  for(const modifiers of [{ctrlKey:true},{metaKey:true},{ctrlKey:true,shiftKey:true}]){
    it('consumes the copy shortcut '+JSON.stringify(modifiers),()=>{
      const copy=vi.fn(),event=new KeyboardEvent('keydown',{key:'c',code:'KeyC',cancelable:true,...modifiers})
      expect(handleCopyKey(event,copy)).toBe(false)
      expect(event.defaultPrevented).toBe(true)
      expect(copy).toHaveBeenCalledOnce()
    })
  }
  it('handles Korean keyboard layout and suppresses repeat/keyup',()=>{
    const copy=vi.fn()
    expect(handleCopyKey(new KeyboardEvent('keydown',{key:'ㅊ',code:'KeyC',ctrlKey:true}),copy)).toBe(false)
    expect(handleCopyKey(new KeyboardEvent('keydown',{key:'c',ctrlKey:true,repeat:true}),copy)).toBe(false)
    expect(handleCopyKey(new KeyboardEvent('keyup',{key:'c',ctrlKey:true}),copy)).toBe(false)
    expect(copy).toHaveBeenCalledOnce()
  })
  it('leaves normal input and other shortcuts alone',()=>{
    const copy=vi.fn()
    for(const init of [{key:'c'},{key:'v',ctrlKey:true},{key:'c',ctrlKey:true,altKey:true}])expect(handleCopyKey(new KeyboardEvent('keydown',init),copy)).toBe(true)
    expect(copy).not.toHaveBeenCalled()
  })
  it('falls back on LAN HTTP without clipboard API and restores focus',async()=>{
    vi.stubGlobal('navigator',{clipboard:undefined})
    const input=document.createElement('input');document.body.appendChild(input);input.focus()
    const exec=vi.fn(()=>true);Object.defineProperty(document,'execCommand',{value:exec,configurable:true})
    try{await writeClipboard('한글 copied text');expect(exec).toHaveBeenCalledWith('copy');expect(document.activeElement).toBe(input);expect(document.querySelector('textarea')).toBeNull()}
    finally{input.remove();delete (document as any).execCommand}
  })
})
