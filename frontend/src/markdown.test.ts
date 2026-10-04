import {describe,expect,it} from 'vitest'
import {renderMarkdown} from './markdown'

function images(source:string,path?:string,attachments?:Parameters<typeof renderMarkdown>[2]){
  const root=document.createElement('div')
  root.innerHTML=renderMarkdown(source,path,attachments)
  return [...root.querySelectorAll('img')]
}
const filePath=(img:HTMLImageElement)=>new URL(img.getAttribute('src')!,'http://localhost').searchParams.get('path')

describe('markdown images',()=>{
  it('resolves notebook-relative, parent and absolute paths through the authenticated file API',()=>{
    const result=images('![local](images/plot.png)\n![parent](../shared/figure.jpg)\n![absolute](/project/figures/a.svg)','/project/notebooks/demo.ipynb')
    expect(result.map(filePath)).toEqual(['/project/notebooks/images/plot.png','/project/shared/figure.jpg','/project/figures/a.svg'])
  })
  it('handles HTML attribute order, quoted paths, entities and percent-encoded Korean filenames',()=>{
    const result=images(`<img width="320" alt="HTML" src='images/한글 &amp; 공백.png'>\n\n![encoded](images/%ED%95%9C%EA%B8%80%20%26%20%EA%B3%B5%EB%B0%B1.png)`,'/project/demo.ipynb')
    expect(result.map(filePath)).toEqual(['/project/images/한글 & 공백.png','/project/images/한글 & 공백.png'])
    expect(result[0].getAttribute('width')).toBe('320')
  })
  it('preserves external, protocol-relative, data and already-resolved file URLs',()=>{
    const sources=['https://example.test/plot.png?a=1&b=2','//example.test/plot.png','data:image/png;base64,AAA=','/api/file-raw?path=%2Fproject%2Fa.png']
    const result=images(sources.map(src=>`<img src="${src.replace(/&/g,'&amp;')}">`).join('\n'),'/project/demo.ipynb')
    expect(result.map(img=>img.getAttribute('src'))).toEqual(sources)
  })
  it('renders per-cell embedded attachments including split base64 and encoded filenames',()=>{
    const source='![attached](attachment:그림%20하나.png)'
    const a=images(source,'/project/demo.ipynb',{'그림 하나.png':{'image/png':['AA\n','BB==']}})
    const b=images(source,undefined,{'그림 하나.png':{'image/jpeg':'CCCC'}})
    expect(a[0].getAttribute('src')).toBe('data:image/png;base64,AABB==')
    expect(b[0].getAttribute('src')).toBe('data:image/jpeg;base64,CCCC')
  })
  it('loads SVG attachments as image documents and keeps unsafe HTML sanitized',()=>{
    const svg='<svg xmlns="http://www.w3.org/2000/svg"><text>한글</text></svg>'
    const html=renderMarkdown('<img width="200" src="attachment:plot.svg" onerror="alert(1)"><script>alert(2)</script>\n\n<img src="javascript:alert(3)">','/project/demo.ipynb',{'plot.svg':{'image/svg+xml':[svg]}})
    const root=document.createElement('div');root.innerHTML=html
    expect(root.querySelector('img')?.getAttribute('src')).toBe('data:image/svg+xml;charset=utf-8,'+encodeURIComponent(svg))
    expect(root.querySelector('svg,script,[onerror],[src^="javascript:"]')).toBeNull()
  })
  it('does not treat missing or unsupported attachments as local files',()=>{
    const result=images('![](attachment:missing.png)\n![bad](attachment:bad.png)\n![prototype](attachment:toString)','/project/demo.ipynb',{'bad.png':{'text/html':'<script>alert(1)</script>'}})
    expect(result).toHaveLength(3)
    expect(result.every(img=>!img.hasAttribute('src'))).toBe(true)
    expect(result[0].alt).toContain('첨부 이미지')
  })
})
