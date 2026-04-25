import DOMPurify, { type Config } from 'dompurify'

// Allow KaTeX-emitted attributes/tags that DOMPurify strips by default.
const config: Config = {
  ADD_ATTR: ['target', 'aria-hidden'],
  ADD_TAGS: ['math', 'mrow', 'mi', 'mn', 'mo', 'ms', 'mtext', 'msup', 'msub', 'mfrac', 'msqrt', 'mroot', 'mtable', 'mtr', 'mtd', 'munder', 'mover', 'munderover', 'annotation', 'semantics'],
  RETURN_TRUSTED_TYPE: false,
}

export function sanitize(html: string): string {
  return DOMPurify.sanitize(html, config) as unknown as string
}
