import { useState, useEffect } from 'react'
import { PdfViewer } from '../PdfViewer'

// Lazy highlight.js
let _hljs: any = null
let _hljsLoading: Promise<void> | null = null

const LANG_MAP: Record<string, string> = {
  py: 'python', js: 'javascript', mjs: 'javascript', cjs: 'javascript',
  ts: 'typescript', tsx: 'typescript', jsx: 'javascript',
  json: 'json', sh: 'bash', bash: 'bash', zsh: 'bash',
  css: 'css', html: 'xml', xml: 'xml', svg: 'xml',
  sql: 'sql', yaml: 'yaml', yml: 'yaml',
  go: 'go', rs: 'rust', java: 'java',
  c: 'cpp', cpp: 'cpp', h: 'cpp', hpp: 'cpp',
}

async function getHljs() {
  if (_hljs) return _hljs
  if (!_hljsLoading) {
    _hljsLoading = (async () => {
      const [{ default: hljs }, ...langs] = await Promise.all([
        import('highlight.js/lib/core'),
        import('highlight.js/lib/languages/python'),
        import('highlight.js/lib/languages/javascript'),
        import('highlight.js/lib/languages/typescript'),
        import('highlight.js/lib/languages/json'),
        import('highlight.js/lib/languages/bash'),
        import('highlight.js/lib/languages/css'),
        import('highlight.js/lib/languages/xml'),
        import('highlight.js/lib/languages/sql'),
        import('highlight.js/lib/languages/yaml'),
        import('highlight.js/lib/languages/go'),
        import('highlight.js/lib/languages/rust'),
        import('highlight.js/lib/languages/java'),
        import('highlight.js/lib/languages/cpp'),
      ])
      const names = ['python','javascript','typescript','json','bash','css','xml','sql','yaml','go','rust','java','cpp']
      langs.forEach((m, i) => hljs.registerLanguage(names[i], m.default))
      _hljs = hljs
    })()
  }
  await _hljsLoading
  return _hljs!
}

// Lazy marked for markdown rendering
let _renderMd: ((md: string) => string) | null = null

async function getMarkdownRenderer() {
  if (_renderMd) return _renderMd
  const { marked } = await import('marked')
  marked.setOptions({ breaks: true, gfm: true })
  _renderMd = (md: string) => marked.parse(md) as string
  return _renderMd
}

interface Props {
  content: string
  type: 'code' | 'markdown' | 'pdf' | 'image'
  lang: string
}

export function FileContent({ content, type, lang }: Props) {
  const [highlighted, setHighlighted] = useState('')
  const [mdHtml, setMdHtml] = useState('')

  useEffect(() => {
    if (type === 'code') {
      const escaped = content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;')
      setHighlighted(escaped)
      const mappedLang = LANG_MAP[lang] || lang
      getHljs().then(hljs => {
        try {
          if (mappedLang && hljs.getLanguage(mappedLang)) {
            setHighlighted(hljs.highlight(content, { language: mappedLang }).value)
          } else {
            setHighlighted(hljs.highlightAuto(content).value)
          }
        } catch {}
      })
    } else if (type === 'markdown') {
      // Show raw first, then rendered
      setMdHtml(content.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br/>'))
      getMarkdownRenderer().then(render => {
        setMdHtml(render(content))
      })
    }
  }, [content, lang, type])

  if (type === 'pdf') return <PdfViewer url={content} />
  if (type === 'image') return <div className="fv-image"><img src={content} alt="" /></div>
  if (type === 'markdown') return <div className="fv-markdown" dangerouslySetInnerHTML={{ __html: mdHtml }} />
  return (
    <pre className="fv-code"><code className="hljs" dangerouslySetInnerHTML={{ __html: highlighted }} /></pre>
  )
}
