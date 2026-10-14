type IconName = 'folder' | 'search' | 'plus' | 'close' | 'grip' | 'terminal' | 'tabs'

// Decorative navigation icons. The containing controls supply accessible names.
export function WorkbenchIcon({name}: {name: IconName}) {
  return <svg className="workbench-icon" viewBox="0 0 20 20" fill="none" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true" focusable="false">
    {name==='folder'&&<path d="M2.5 5.5a1 1 0 0 1 1-1h4l2 2h7a1 1 0 0 1 1 1v8a1 1 0 0 1-1 1h-13a1 1 0 0 1-1-1z"/>}
    {name==='search'&&<><circle cx="8.5" cy="8.5" r="5"/><path d="m12.5 12.5 4 4"/></>}
    {name==='plus'&&<path d="M10 4v12M4 10h12"/>}
    {name==='close'&&<path d="m5.5 5.5 9 9m0-9-9 9"/>}
    {name==='grip'&&<path d="M7 5h.01M13 5h.01M7 10h.01M13 10h.01M7 15h.01M13 15h.01" strokeWidth="2.5"/>}
    {name==='terminal'&&<><rect x="2.5" y="3.5" width="15" height="13" rx="2"/><path d="m6 7 3 3-3 3m5 0h3"/></>}
    {name==='tabs'&&<><rect x="3" y="6" width="11" height="11" rx="2"/><path d="M7 3h8a2 2 0 0 1 2 2v8"/></>}
  </svg>
}
