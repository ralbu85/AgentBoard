// No-op stand-ins for renderer/DOM-dependent xterm addons under vitest.
class NoopAddon {
  activate() {}
  dispose() {}
  clearDecorations() {}
  findNext() { return false }
}
export class SearchAddon extends NoopAddon {}
export class WebLinksAddon extends NoopAddon {}
