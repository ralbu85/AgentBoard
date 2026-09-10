export function browserUrl(input: string): string | null {
  let text = input.trim()
  if (!text || /[\u0000-\u0020]/.test(text)) return null
  if (!/^https?:\/\//i.test(text)) {
    if (/^[a-z][a-z\d+.-]*:/i.test(text) && !/^[\w.-]+:\d+(?:[/?#]|$)/.test(text)) return null
    text = (/^(localhost|127\.\d+\.\d+\.\d+|0\.0\.0\.0)(:\d+)?([/?#]|$)/i.test(text) ? 'http://' : 'https://') + text
  }
  try {
    const url = new URL(text)
    return ['https:','http:'].includes(url.protocol) && !url.username && !url.password ? url.href : null
  } catch { return null }
}
