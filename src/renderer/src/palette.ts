export type PaletteCommand = {
  label: string
  hint?: string
  run: () => void
}

export type PaletteController = {
  toggle: () => void
  open: () => void
  hide: (focusEditor?: boolean) => void
  isOpen: () => boolean
  contains: (node: Node | null) => boolean
}

export function mountPalette(
  commands: () => Promise<PaletteCommand[]>,
  onFocusReturn: () => void
): PaletteController {
  const root = document.createElement('div')
  root.id = 'palette'
  root.className = 'quick-open hidden'
  const input = document.createElement('input')
  input.type = 'text'
  input.placeholder = 'Type a command'
  input.spellcheck = false
  const list = document.createElement('ul')
  root.append(input, list)
  document.body.append(root)

  let items: PaletteCommand[] = []
  let shown: PaletteCommand[] = []
  let index = 0

  input.addEventListener('input', () => {
    index = 0
    render()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      index = Math.min(index + 1, Math.max(shown.length - 1, 0))
      render()
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      index = Math.max(index - 1, 0)
      render()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const chosen = shown[index]
      if (!chosen) return
      hide()
      chosen.run()
    } else if (event.key === 'Escape') {
      event.preventDefault()
      hide()
    }
  })

  return {
    toggle() {
      if (isOpen()) hide()
      else void open()
    },
    open() {
      void open()
    },
    hide,
    isOpen,
    contains: (node) => node !== null && root.contains(node)
  }

  async function open(): Promise<void> {
    items = await commands()
    index = 0
    input.value = ''
    root.classList.remove('hidden')
    render()
    input.focus()
  }

  function hide(focusEditor = true): void {
    root.classList.add('hidden')
    if (focusEditor) onFocusReturn()
  }

  function isOpen(): boolean {
    return !root.classList.contains('hidden')
  }

  function render(): void {
    shown = filter(items, input.value.trim())
    if (index >= shown.length) index = Math.max(shown.length - 1, 0)
    list.replaceChildren()
    for (const [itemIndex, item] of shown.entries()) {
      const row = document.createElement('li')
      if (itemIndex === index) row.className = 'selected'
      const label = document.createElement('span')
      label.textContent = item.label
      row.append(label)
      if (item.hint) {
        const hint = document.createElement('span')
        hint.className = 'hint'
        hint.textContent = item.hint
        row.append(hint)
      }
      row.addEventListener('mousedown', (event) => {
        event.preventDefault()
        hide()
        item.run()
      })
      list.append(row)
    }
    list.children[index]?.scrollIntoView({ block: 'nearest' })
  }
}

function filter(items: PaletteCommand[], query: string): PaletteCommand[] {
  const ranked = items.flatMap((item) => {
    const score = fuzzy(query, `${item.label} ${item.hint ?? ''}`)
    return score === null ? [] : [{ item, score }]
  })
  ranked.sort((a, b) => a.score - b.score || a.item.label.localeCompare(b.item.label))
  return ranked.slice(0, 40).map((row) => row.item)
}

function fuzzy(query: string, label: string): number | null {
  if (!query) return 0
  const hay = label.toLowerCase()
  let score = 0
  let at = 0
  for (const char of query.toLowerCase()) {
    const found = hay.indexOf(char, at)
    if (found < 0) return null
    score += found
    at = found + 1
  }
  return score
}
