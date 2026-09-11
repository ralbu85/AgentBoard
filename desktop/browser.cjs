const {WebContentsView, session, Menu} = require('electron')
const {createHash} = require('node:crypto')

function webUrl(value) {
  if (typeof value !== 'string' || value.length > 8192 || /[\x00-\x20]/.test(value)) throw Error('HTTP(S) 주소가 필요합니다.')
  const url = new URL(value)
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw Error('HTTP(S) 주소가 필요합니다.')
  return url.href
}
function identity(id, workspace) {
  if (typeof id !== 'string' || !/^browser:[a-zA-Z0-9-]{1,100}$/.test(id)) throw Error('잘못된 탭 ID')
  const owner = JSON.parse(workspace)
  if (!Array.isArray(owner) || owner.length !== 2 || owner.some(v => typeof v !== 'string' || !v || v.length > 4096)) throw Error('잘못된 워크스페이스')
}

class NativeBrowser {
  constructor(win, notify, server) { this.win=win; this.notify=notify; this.server=server; this.tabs=new Map(); this.partitions=new Set() }
  state(tab) {
    const wc=tab.view.webContents
    return {id:tab.id,workspace:tab.workspace,url:wc.getURL(),title:wc.getTitle(),back:wc.navigationHistory.canGoBack(),forward:wc.navigationHistory.canGoForward(),loading:wc.isLoading(),visible:tab.visible,error:tab.error||''}
  }
  list() { return [...this.tabs.values()].map(t => this.state(t)) }
  publish(tab) { if (!tab.view.webContents.isDestroyed()) this.notify({type:'state',...this.state(tab)}) }
  open(id, workspace, url) {
    identity(id,workspace)
    if (url) webUrl(url)
    const existing=this.tabs.get(id)
    if (existing) { if (existing.workspace!==workspace) throw Error('다른 워크스페이스의 탭입니다.'); return this.state(existing) }
    if (this.tabs.size>=12) throw Error('웹 탭은 최대 12개입니다. 사용하지 않는 탭을 닫아 주세요.')
    const partition='persist:web-'+createHash('sha256').update(this.server+'\0'+workspace).digest('hex')
    const profile=session.fromPartition(partition)
    if (!this.partitions.has(partition)) {
      this.partitions.add(partition)
      profile.setPermissionRequestHandler((_wc,_permission,callback)=>callback(false))
      profile.setPermissionCheckHandler(()=>false)
      // Chromium's native Save As dialog chooses the destination on this PC.
      profile.on('will-download',(_event,item)=>{
        item.once('done',(_e,state)=>this.notify({type:'download',name:item.getFilename(),state}))
      })
    }
    const view=new WebContentsView({webPreferences:{session:profile,nodeIntegration:false,contextIsolation:true,sandbox:true,webSecurity:true}})
    const tab={id,workspace,view,visible:false,error:''}
    this.tabs.set(id,tab)
    this.win.contentView.addChildView(view); view.setVisible(false)
    const wc=view.webContents
    const guard=(event,target)=>{ try { webUrl(target) } catch { event.preventDefault() } }
    wc.on('will-navigate',guard);wc.on('will-redirect',guard)
    wc.setWindowOpenHandler(({url:target})=>{
      try { webUrl(target);this.notify({type:'popup',workspace,url:target}) } catch {}
      return {action:'deny'}
    })
    wc.on('context-menu',(_e,params)=>Menu.buildFromTemplate([
      {role:'cut',enabled:params.isEditable},{role:'copy',enabled:!!params.selectionText},
      {role:'paste',enabled:params.isEditable},{role:'selectAll'},
    ]).popup({window:this.win}))
    for (const event of ['did-navigate','did-navigate-in-page','page-title-updated','did-start-loading','did-stop-loading']) wc.on(event,()=>this.publish(tab))
    wc.on('did-fail-load',(_e,code,description,_url,main)=>{if(main&&code!==-3){tab.error=description;this.publish(tab)}})
    wc.on('render-process-gone',()=>{tab.error='페이지 실행이 중단됐습니다. 새로고침해 주세요.';this.publish(tab)})
    wc.on('focus',()=>this.notify({type:'focus',id,workspace}))
    if(url) this.navigate(tab,url)
    return this.state(tab)
  }
  navigate(tab,url) {
    tab.error=''
    // Do not wait for load completion: alerts and slow pages must not lock controls.
    void tab.view.webContents.loadURL(webUrl(url)).catch(error=>{if(!tab.view.webContents.isDestroyed()&&error.code!=='ERR_ABORTED'){tab.error=error.message;this.publish(tab)}})
  }
  bounds(id, bounds, visible) {
    const tab=this.tabs.get(id);if(!tab)return
    const [width,height]=this.win.getContentSize()
    const numbers=['x','y','width','height'].map(key=>Number(bounds?.[key]))
    if(!numbers.every(Number.isFinite))throw Error('잘못된 화면 위치')
    const zoom=this.win.webContents.getZoomFactor()
    const x=Math.max(0,Math.min(width,Math.round(numbers[0]*zoom)))
    const y=Math.max(0,Math.min(height,Math.round(numbers[1]*zoom)))
    const w=Math.max(0,Math.min(width-x,Math.round(numbers[2]*zoom)))
    const h=Math.max(0,Math.min(height-y,Math.round(numbers[3]*zoom)))
    tab.visible=!!visible&&w>0&&h>0
    tab.view.setBounds({x,y,width:w,height:h});tab.view.setVisible(tab.visible)
  }
  hide(id) { const t=this.tabs.get(id);if(t){t.visible=false;t.view.setVisible(false)} }
  hideAll() { for(const id of this.tabs.keys())this.hide(id) }
  close(id, announce=true) {
    const t=this.tabs.get(id);if(!t)return
    this.tabs.delete(id);if(!this.win.isDestroyed())this.win.contentView.removeChildView(t.view);t.view.webContents.close({waitForBeforeUnload:false})
    if(announce)this.notify({type:'closed',id,workspace:t.workspace})
  }
  destroy() { for(const id of [...this.tabs.keys()])this.close(id,false) }
  async command(data) {
    const {action,id}=data
    if(action==='list')return this.list()
    if(action==='open')return this.open(id,data.workspace,data.url||'')
    if(action==='close'){this.close(id);return {ok:true}}
    const tab=this.tabs.get(id);if(!tab)throw Error('열려 있지 않은 데스크톱 탭입니다.')
    const wc=tab.view.webContents
    if(action==='navigate')this.navigate(tab,data.url)
    else if(action==='back'){if(wc.navigationHistory.canGoBack())wc.navigationHistory.goBack()}
    else if(action==='forward'){if(wc.navigationHistory.canGoForward())wc.navigationHistory.goForward()}
    else if(action==='reload'){tab.error='';wc.reload()}
    else if(action==='stop')wc.stop()
    else if(action==='devtools')wc.openDevTools({mode:'detach'})
    else if(action==='snapshot')return wc.executeJavaScript(`(${snapshot.toString()})()`)
    else if(action==='screenshot')return {mimeType:'image/png',base64:(await wc.capturePage()).toPNG().toString('base64')}
    else if(action==='click'||action==='fill'){
      if(typeof data.selector!=='string'||data.selector.length>2048)throw Error('CSS selector가 필요합니다.')
      if(action==='fill'&&(typeof data.text!=='string'||data.text.length>100000))throw Error('입력 길이를 확인해 주세요.')
      return wc.executeJavaScript(`(${elementAction.toString()})(${JSON.stringify({action,selector:data.selector,text:data.text})})`,true)
    } else if(action==='key'){
      if(!['Enter','Tab','Escape','Backspace','Delete','ArrowUp','ArrowDown','ArrowLeft','ArrowRight'].includes(data.key))throw Error('지원하지 않는 키입니다.')
      const keyCode=data.key.replace('Arrow','')
      wc.sendInputEvent({type:'keyDown',keyCode});wc.sendInputEvent({type:'keyUp',keyCode})
    } else if(action==='scroll'){
      const dy=Number(data.dy);if(!Number.isFinite(dy)||Math.abs(dy)>10000)throw Error('잘못된 스크롤 값')
      await wc.executeJavaScript(`window.scrollBy(0,${dy})`)
    } else throw Error('지원하지 않는 브라우저 작업입니다.')
    return this.state(tab)
  }
}
// Fixed page operations, not an arbitrary JavaScript or shell execution API.
function snapshot() {
  const selector=el=>{
    if(el.id&&document.querySelectorAll('#'+CSS.escape(el.id)).length===1)return '#'+CSS.escape(el.id)
    const parts=[];let node=el
    while(node&&node!==document.documentElement){const parent=node.parentElement;if(!parent)break;parts.unshift(node.localName+':nth-child('+([...parent.children].indexOf(node)+1)+')');node=parent}
    return 'html > '+parts.join(' > ')
  }
  return {url:location.href,title:document.title,text:document.body.innerText.slice(0,40000),elements:[...document.querySelectorAll('a,button,input,textarea,select,[role="button"],[contenteditable="true"]')].filter(el=>el.getClientRects().length).slice(0,200).map(el=>({selector:selector(el),tag:el.localName,type:el.getAttribute('type'),label:el.getAttribute('aria-label')||el.getAttribute('placeholder')||el.innerText?.slice(0,150)||'',href:el.getAttribute('href')}))}
}
function elementAction({action,selector,text}) {
  const matches=document.querySelectorAll(selector)
  if(matches.length!==1)throw Error('정확히 하나의 요소를 선택해 주세요. 현재 '+matches.length+'개')
  const el=matches[0]
  if(!el.getClientRects().length||el.disabled)throw Error('현재 조작할 수 없는 요소입니다.')
  el.scrollIntoView({block:'center'});el.focus()
  if(action==='click')el.click()
  else {
    if(el instanceof HTMLInputElement&&['file','hidden','checkbox','radio','submit','button'].includes(el.type))throw Error('텍스트 입력칸이 아닙니다.')
    if(el instanceof HTMLInputElement||el instanceof HTMLTextAreaElement){
      if(el.readOnly)throw Error('읽기 전용 입력칸입니다.')
      const proto=el instanceof HTMLInputElement?HTMLInputElement.prototype:HTMLTextAreaElement.prototype
      Object.getOwnPropertyDescriptor(proto,'value').set.call(el,text)
    }else if(el.isContentEditable)el.textContent=text
    else throw Error('텍스트 입력칸이 아닙니다.')
    el.dispatchEvent(new Event('input',{bubbles:true}));el.dispatchEvent(new Event('change',{bubbles:true}))
  }
  return {ok:true}
}
module.exports={NativeBrowser,webUrl,identity}
