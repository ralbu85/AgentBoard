import {createRoot} from 'react-dom/client'
import {InputCard} from '../src/components/Terminal/InputCard'
import * as terminal from '../src/components/Terminal/TerminalManager'
import {useStore} from '../src/store'
import {textWidth} from '../src/components/Terminal/terminalText'
import '../src/index.css'
import '@xterm/xterm/css/xterm.css'

// Synthetic fixture only: no login cookie, backend connection, user process or
// user transcript. Requests are intercepted by the tests.
const id='fixture'
useStore.setState({sessions:{[id]:{id,cwd:'/fixture',host:'local',sessionName:'fixture',cmd:'bash',status:'running',process:'bash',createdAt:1,memKB:0,aiState:'idle'}}})
document.body.style.cssText='margin:0;width:100%;height:100dvh;overflow:hidden'
const root=document.getElementById('root')!
root.style.cssText='display:flex;flex-direction:column;height:100dvh;min-width:0'
const output=document.createElement('div');output.className='terminal-container';output.style.minHeight='0';root.append(output)
const input=document.createElement('div');root.append(input);createRoot(input).render(<InputCard sessionId={id}/> )
terminal.open(id,output);terminal.refit(id)
const history=Array.from({length:160},(_,i)=>`History ${i}: 한글과 English words remain stable while reading.`)
const source=[...history,'curl --header    "한글 test" https://example.org/very/long/resource','',...Array(38).fill('')].join('\r\n')+'\r\x1b[?25l'
terminal.writeSnapshot(id,source,100,40,true,1,false)
window.addEventListener('resize',()=>terminal.refit(id))
;(window as any).fixture={
  update(){terminal.writeSnapshot(id,source.replace('History 159:','History 159 (updated):'),100,40,true,1,false)},
  text:()=>terminal.getBufferText(id),
  columns:()=>output.querySelector<HTMLElement>('.xterm-wrap')?.dataset.sourceCols,
  table(wide:boolean,fontSize:number){
    terminal.setReadability({fontSize})
    const widths=wide?[14,52]:[10,16]
    const values=[['이름','결과'],['\x1b[1;32m한글\x1b[0m','완료🙂'],['e\u0301','👩🏽‍💻'],['가','✓ → ·']]
    const rule=(left:string,middle:string,right:string)=>left+widths.map(w=>'─'.repeat(w+2)).join(middle)+right
    const table=[rule('┌','┬','┐'),...values.map(row=>'│'+row.map((value,c)=>' '+value+' '.repeat(widths[c]-textWidth(value))+' │').join('')),rule('└','┴','┘')]
    terminal.writeSnapshot(id,table.join('\r\n')+'\r\x1b[?25l',100,40,true,1,false)
  },
}
