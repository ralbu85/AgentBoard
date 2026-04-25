import DOMPurify from 'dompurify'

// Allow KaTeX-emitted attributes that DOMPurify strips by default.
const config: DOMPurify.Config = {
  ADD_ATTR: ['target', 'aria-hidden'],
  ADD_TAGS: ['math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'annotation', 'semantics'],
}

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, config) as string
}
