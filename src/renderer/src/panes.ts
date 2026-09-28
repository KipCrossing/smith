const SIDEBAR_KEY = 'smith.sidebar.width'
const AGENT_KEY = 'smith.agent.width'

export function mountPanes(app: HTMLElement, sidebarHandle: HTMLElement, agentHandle: HTMLElement): void {
  let sidebar = readWidth(SIDEBAR_KEY, 240)
  let agent = readWidth(AGENT_KEY, 380)
  apply()

  drag(sidebarHandle, (clientX) => {
    const left = app.getBoundingClientRect().left
    sidebar = clamp(clientX - left, 160, Math.min(560, window.innerWidth - 420))
    apply()
  }, () => localStorage.setItem(SIDEBAR_KEY, String(Math.round(sidebar))))

  drag(agentHandle, (clientX) => {
    const right = app.getBoundingClientRect().right
    agent = clamp(right - clientX, 280, Math.min(720, window.innerWidth - 480))
    apply()
  }, () => localStorage.setItem(AGENT_KEY, String(Math.round(agent))))

  function apply(): void {
    app.style.setProperty('--sidebar-width', `${Math.round(sidebar)}px`)
    app.style.setProperty('--agent-width', `${Math.round(agent)}px`)
  }
}

function drag(handle: HTMLElement, onMove: (clientX: number) => void, onEnd: () => void): void {
  handle.addEventListener('mousedown', (event) => {
    if (event.button !== 0) return
    event.preventDefault()
    handle.classList.add('dragging')
    const move = (ev: MouseEvent) => onMove(ev.clientX)
    const stop = () => {
      handle.classList.remove('dragging')
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', stop)
      onEnd()
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', stop)
  })
}

function readWidth(key: string, fallback: number): number {
  const saved = parseInt(localStorage.getItem(key) ?? '', 10)
  return Number.isFinite(saved) && saved >= 80 ? saved : fallback
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), Math.max(min, max))
}
