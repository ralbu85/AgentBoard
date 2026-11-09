import {api} from '../../api'
import {useStore} from '../../store'

const MARKDOWN = /\.(md|markdown|mdx|qmd)$/i

/** Open a page or document (HTML, Markdown, Quarto) in a tab, as the file panel does. */
export async function openFileTab(path: string, ownerKey: string) {
  const name = path.slice(path.lastIndexOf('/') + 1)
  const res = await api.readFile(path).catch(() => null)
  if (typeof res?.content !== 'string') return
  const markdown = MARKDOWN.test(name)
  useStore.getState().openTab({id: path, name, path, content: res.content, type: markdown ? 'markdown' : 'code', lang: markdown ? 'markdown' : 'xml', version: res.version}, ownerKey)
}
