type AgentSession = {cmd?: string; process?: string}

export function AgentIcon({session}: {session?: AgentSession}) {
  const kind = [session?.process, session?.cmd].map(value => {
    const command = value || ''
    if (/(?:^|[/\\\s"'])codex(?:\.exe)?(?=$|[\s"'])/i.test(command)) return 'codex'
    if (/(?:^|[/\\\s"'])claude(?:\.exe)?(?=$|[\s"'])/i.test(command)) return 'claude'
    return null
  }).find(Boolean)
  if (!kind) return null
  const label = kind === 'codex' ? 'Codex' : 'Claude'
  return <span className={`agent-icon agent-icon-${kind}`} role="img" aria-label={label} title={label}>
    <svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
      {kind === 'codex' ? <><path d="m5 7 5 5-5 5"/><path d="M13 17h6"/></> : <><path d="M12 3v18M3 12h18M5.6 5.6l12.8 12.8M5.6 18.4 18.4 5.6"/></>}
    </svg>
  </span>
}
