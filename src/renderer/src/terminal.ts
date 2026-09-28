import { FitAddon } from '@xterm/addon-fit'
import { Terminal } from '@xterm/xterm'
import '@xterm/xterm/css/xterm.css'
import { rememberReference, type TextReference } from './references'

const OPEN_KEY = 'smith.terminal.open'
const HEIGHT_KEY = 'smith.terminal.height'

export type TerminalPanel = {
  toggle: () => void
  restore: () => void
  sync: (directory: string | null) => void
  selection: () => TextReference | null
  contains: (node: Node | null) => boolean
}

export function mountTerminal(
  host: HTMLElement,
  resizeHandle: HTMLElement,
  title: HTMLElement,
  body: HTMLElement,
  directory: () => string | null
): TerminalPanel {
  let term: Terminal | null = null
  let fit: FitAddon | null = null
  let unsubscribe: (() => void) | null = null
  let open = false
  let requested: string | null = null
  let height = readHeight()
  let remembered: TextReference | null = null
  let shellName = 'bash'

  host.style.height = `${height}px`
  resizeHandle.addEventListener('mousedown', startResize)
  host.addEventListener('keydown', (event) => {
    if (!event.ctrlKey || !event.shiftKey || event.key.toLowerCase() !== 'c') return
    const info = currentSelection()
    if (!info) return
    rememberReference(info)
    void navigator.clipboard.writeText(info.raw)
    event.preventDefault()
    event.stopPropagation()
  })
  host.addEventListener(
    'copy',
    () => {
      const info = currentSelection()
      if (info) rememberReference(info)
    },
    true
  )

  return {
    toggle() {
      if (open) hide()
      else show()
    },
    restore() {
      if (localStorage.getItem(OPEN_KEY) === '1') show()
    },
    sync(next) {
      if (open && next !== requested) restart()
    },
    selection: () => currentSelection() ?? remembered,
    contains: (node) => node !== null && host.contains(node)
  }

  function show(): void {
    open = true
    host.hidden = false
    resizeHandle.hidden = false
    if (!term || directory() !== requested) restart()
    else {
      fitTerminal()
      term.focus()
    }
    localStorage.setItem(OPEN_KEY, '1')
  }

  function hide(): void {
    open = false
    host.hidden = true
    resizeHandle.hidden = true
    localStorage.setItem(OPEN_KEY, '0')
  }

  function restart(): void {
    const next = directory()
    requested = next
    disposeTerm()
    term = new Terminal({
      cursorBlink: true,
      fontSize: 13,
      fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
      theme: { background: '#1d1f21', foreground: '#c5c8c6' }
    })
    fit = new FitAddon()
    term.loadAddon(fit)
    term.open(body)
    term.onSelectionChange(() => {
      const info = currentSelection()
      if (info) remembered = info
    })
    term.onData((data) => window.api.terminalWrite(data))
    unsubscribe = window.api.onTerminalData((data) => term?.write(data))
    requestAnimationFrame(() => fitTerminal())
    void window.api.terminalStart(next).then((session) => {
      shellName = session.shell || 'bash'
      title.textContent = session.directory
    })
    term.focus()
  }

  function disposeTerm(): void {
    unsubscribe?.()
    unsubscribe = null
    term?.dispose()
    term = null
    fit = null
  }

  function currentSelection(): TextReference | null {
    if (!term || !term.hasSelection()) return null
    const raw = term.getSelection()
    const position = term.getSelectionPosition()
    if (!raw.trim() || !position) return null
    const shell = shellName || 'bash'
    // xterm's selection coordinates are 0-based, despite the 1-based type comment.
    let start = position.start.y + 1
    let end = position.end.y + 1
    if (end < start) {
      const swap = start
      start = end
      end = swap
    }
    return {
      text: raw.replace(/\r\n/g, '\n').replace(/\s+$/, ''),
      raw,
      file: shell,
      path: shell,
      start,
      end,
      kind: 'terminal'
    }
  }

  let fitted = ''
  function fitTerminal(): void {
    if (!fit || host.hidden) return
    const box = `${body.clientWidth}x${body.clientHeight}`
    if (body.clientWidth < 2 || body.clientHeight < 2 || box === fitted) return
    fitted = box
    fit.fit()
  }

  const observer = new ResizeObserver(() => {
    fitted = ''
    fitTerminal()
  })
  observer.observe(body)

  function startResize(event: MouseEvent): void {
    event.preventDefault()
    const bottom = host.getBoundingClientRect().bottom
    const move = (ev: MouseEvent) => {
      const next = bottom - ev.clientY
      const limit = Math.max(120, window.innerHeight - 160)
      height = Math.min(limit, Math.max(80, next))
      host.style.height = `${height}px`
      fitTerminal()
    }
    const stop = () => {
      document.removeEventListener('mousemove', move)
      document.removeEventListener('mouseup', stop)
      localStorage.setItem(HEIGHT_KEY, String(height))
    }
    document.addEventListener('mousemove', move)
    document.addEventListener('mouseup', stop)
  }
}

function readHeight(): number {
  const saved = parseInt(localStorage.getItem(HEIGHT_KEY) ?? '', 10)
  return saved >= 80 ? saved : 220
}
