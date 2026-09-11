const {app,BrowserWindow,ipcMain,Menu,dialog,shell} = require('electron')
const path=require('node:path')
const fs=require('node:fs')
const os=require('node:os')
const {randomUUID}=require('node:crypto')
const {pathToFileURL}=require('node:url')
const WebSocket=require('ws')
const {NativeBrowser,webUrl}=require('./browser.cjs')

let win,browser,server='',relay,relayTimer,quitting=false,agentEnabled=true,connecting=false
let settings={}
const connectPage=pathToFileURL(path.join(__dirname,'connect.html')).href
const configPath=()=>path.join(app.getPath('userData'),'connection.json')
function save(){fs.writeFileSync(configPath(),JSON.stringify(settings),{mode:0o600})}
function notify(data){if(win&&!win.isDestroyed())win.webContents.send('desktop-browser-event',data)}
function relayStatus(){notify({type:'relay',enabled:agentEnabled,connected:relay?.readyState===WebSocket.OPEN,desktopId:settings.id})}
function stopRelay(){clearTimeout(relayTimer);const old=relay;relay=null;old?.close();relayStatus()}
function publishTabs(){if(relay?.readyState===WebSocket.OPEN)relay.send(JSON.stringify({type:'tabs',tabs:browser?.list()||[]}))}
function event(data){
  notify(data)
  if(['state','closed'].includes(data.type))publishTabs()
}
async function connectRelay(){
  if(quitting||!agentEnabled||!server||connecting||relay?.readyState<WebSocket.CLOSING)return
  connecting=true
  try{
    const connectionServer=server
    const cookies=await win.webContents.session.cookies.get({url:connectionServer,name:'token'})
    if(!cookies.length||!agentEnabled||quitting||!server||server!==connectionServer)return
    const url=new URL('/api/desktop/ws',server);url.protocol=url.protocol==='https:'?'wss:':'ws:'
    const socket=new WebSocket(url,{headers:{Cookie:cookies.map(c=>`${c.name}=${c.value}`).join('; '),Origin:new URL(server).origin},maxPayload:1024*1024})
    relay=socket
    socket.on('open',()=>{
      if(relay!==socket)return
      socket.send(JSON.stringify({id:settings.id,name:os.hostname().slice(0,100),tabs:browser.list()}));relayStatus()
    })
    socket.on('message',async raw=>{
      if(relay!==socket||!agentEnabled)return
      let request
      try{
        request=JSON.parse(raw.toString())
        if(request.type!=='command')return
        const result=await browser.command(request.command)
        if(request.command.action==='open')notify({type:'opened',...result})
        if(socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'result',id:request.id,result}))
      }catch(error){if(request?.id&&socket.readyState===WebSocket.OPEN)socket.send(JSON.stringify({type:'result',id:request.id,error:String(error.message).slice(0,500)}))}
    })
    socket.on('error',()=>{})
    socket.on('close',()=>{if(relay!==socket)return;relay=null;relayStatus();if(!quitting&&agentEnabled)relayTimer=setTimeout(connectRelay,3000)})
  }finally{connecting=false}
}
async function connect(input){
  const url=webUrl(input)
  const parsed=new URL(url)
  if(parsed.pathname!=='/'||parsed.search||parsed.hash)throw Error('서버의 기본 주소를 입력해 주세요. 예: http://localhost:3002')
  stopRelay();browser?.destroy();server=url
  settings.server=server;save()
  browser=new NativeBrowser(win,event,server)
  try{await win.loadURL(server)}catch{await win.loadFile(path.join(__dirname,'connect.html'));throw Error('서버에 연결하지 못했습니다. 주소와 서버 실행 상태를 확인해 주세요.')}
}
function isAppSender(event){
  return event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&server&&new URL(event.senderFrame.url).origin===new URL(server).origin
}
ipcMain.handle('desktop-browser',async(event,data)=>{
  if(!data||typeof data.action!=='string')throw Error('잘못된 요청')
  const setup=event.sender===win.webContents&&event.senderFrame===win.webContents.mainFrame&&event.senderFrame.url===connectPage
  if(setup){
    if(data.action==='settings')return {server:settings.server||''}
    if(data.action==='connect')return connect(data.url)
    throw Error('허용되지 않는 요청')
  }
  if(!isAppSender(event))throw Error('앱 화면에서만 사용할 수 있습니다.')
  if(data.action==='relay'){
    if(typeof data.enabled==='boolean'){agentEnabled=data.enabled;settings.agentEnabled=agentEnabled;save();if(!agentEnabled)stopRelay()}
    await connectRelay();relayStatus();return {enabled:agentEnabled,connected:relay?.readyState===WebSocket.OPEN,desktopId:settings.id}
  }
  if(data.action==='bounds')return browser.bounds(data.id,data.bounds,data.visible)
  if(data.action==='hide')return browser.hide(data.id)
  if(data.action==='hideAll')return browser.hideAll()
  if(data.action==='external')return shell.openExternal(webUrl(data.url))
  const result=await browser.command(data)
  if(data.action==='open'){void connectRelay();publishTabs()}
  return result
})
app.whenReady().then(async()=>{
  try{settings=JSON.parse(fs.readFileSync(configPath(),'utf8'))}catch{}
  agentEnabled=settings.agentEnabled!==false
  settings.id ||= randomUUID();save()
  win=new BrowserWindow({width:1440,height:960,minWidth:900,minHeight:600,backgroundColor:'#171b22',webPreferences:{preload:path.join(__dirname,'preload.cjs'),nodeIntegration:false,contextIsolation:true,sandbox:true,partition:'persist:agentboard-app'}})
  win.webContents.on('will-navigate',(e,url)=>{if(!server||new URL(url).origin!==new URL(server).origin)e.preventDefault()})
  win.webContents.on('will-redirect',(e,url)=>{if(!server||new URL(url).origin!==new URL(server).origin)e.preventDefault()})
  win.webContents.setWindowOpenHandler(({url})=>{try{void shell.openExternal(webUrl(url))}catch{}return {action:'deny'}})
  win.webContents.session.setPermissionRequestHandler((_wc,_p,callback)=>callback(false))
  win.webContents.on('did-start-navigation',(_e,_url,inPlace,main)=>{if(main&&!inPlace)browser?.hideAll()})
  win.webContents.on('render-process-gone',()=>{browser?.hideAll();stopRelay()})
  win.webContents.on('will-prevent-unload',event=>{
    const response=dialog.showMessageBoxSync(win,{type:'question',message:'저장하지 않은 파일 변경이 있습니다.',detail:'변경을 버리고 이 화면을 닫을까요?',buttons:['취소','닫기'],defaultId:0,cancelId:0})
    if(response===1)event.preventDefault()
  })
  win.webContents.on('zoom-changed',()=>notify({type:'resize'}))
  win.on('resize',()=>notify({type:'resize'}))
  win.on('closed',()=>{quitting=true;stopRelay();browser?.destroy();app.quit()})
  Menu.setApplicationMenu(Menu.buildFromTemplate([
    ...(process.platform==='darwin'?[{role:'appMenu'}]:[]),
    {label:'AgentBoard',submenu:[
      {label:'서버 연결 변경',click:async()=>{
        const {response}=await dialog.showMessageBox(win,{type:'question',message:'서버 연결을 변경할까요?',detail:'열린 웹 페이지와 저장하지 않은 페이지 입력 내용이 닫힙니다.',buttons:['취소','변경'],defaultId:0,cancelId:0})
        if(response!==1)return
        stopRelay();browser?.destroy();server='';void win.loadFile(path.join(__dirname,'connect.html'))
      }},{type:'separator'},{role:'quit'}]},
    {role:'editMenu'},{label:'보기',submenu:[{role:'reload'},{role:'resetZoom'},{role:'zoomIn'},{role:'zoomOut'},{role:'togglefullscreen'}]},
  ]))
  const arg=process.argv.find(v=>v.startsWith('--server='))?.slice(9)
  const target=arg||process.env.AGENTBOARD_SERVER_URL||settings.server
  if(target){try{await connect(target)}catch{await win.loadFile(path.join(__dirname,'connect.html'))}}
  else await win.loadFile(path.join(__dirname,'connect.html'))
})
// Release pages only after the app window actually closes. before-quit runs
// before an unsaved-file dialog can cancel quitting and must not destroy tabs.
app.on('window-all-closed',()=>app.quit())
