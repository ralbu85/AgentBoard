document.querySelector('#connect').addEventListener('submit', async (event) => {
  event.preventDefault()
  try { await window.agentboardDesktop.invoke({action:'connect',url:document.querySelector('#server').value}) }
  catch (error) { document.querySelector('#error').textContent = error.message }
})
window.agentboardDesktop.invoke({action:'settings'}).then(s => { document.querySelector('#server').value=s.server||'http://localhost:3002' })
