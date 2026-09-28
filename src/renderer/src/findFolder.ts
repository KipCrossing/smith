import type { FolderBuffer, FolderHit, FolderQuery } from '../../shared/types'

export type FindFolderController = {
  focus: () => void
  contains: (node: Node | null) => boolean
}

type FindHooks = {
  root: () => string | null
  buffers: () => FolderBuffer[]
  onOpen: (path: string, line: number, column: number) => void
  onReplaced: (updates: FolderBuffer[]) => void
  onMessage: (text: string) => void
}

export function mountFindFolder(host: HTMLElement, hooks: FindHooks): FindFolderController {
  host.innerHTML = `
    <div class="side-title">Search</div>
    <div class="search-field">
      <input id="find-folder-query" type="text" placeholder="Search" spellcheck="false" />
      <div class="search-toggles">
        <button id="find-folder-case" type="button" title="Match Case" aria-pressed="false">Aa</button>
        <button id="find-folder-word" type="button" title="Match Whole Word" aria-pressed="false">ab</button>
        <button id="find-folder-regex" type="button" title="Use Regular Expression" aria-pressed="false">.*</button>
      </div>
    </div>
    <div class="search-field">
      <input id="find-folder-replace" type="text" placeholder="Replace" spellcheck="false" />
      <div class="search-toggles">
        <button id="find-folder-preserve" type="button" title="Preserve Case" aria-pressed="false">AB</button>
        <button id="find-folder-replace-all" type="button" title="Replace All">Replace</button>
      </div>
    </div>
    <label class="search-label" for="find-folder-include">files to include</label>
    <input id="find-folder-include" class="search-extra" type="text" placeholder="e.g. *.ts, src/**" spellcheck="false" />
    <label class="search-label" for="find-folder-exclude">files to exclude</label>
    <input id="find-folder-exclude" class="search-extra" type="text" placeholder="e.g. dist, *.min.js" spellcheck="false" />
    <div id="find-folder-summary" class="find-summary"></div>
    <div id="find-folder-list" class="search-results"></div>
  `

  const queryInput = must<HTMLInputElement>(host, 'find-folder-query')
  const replaceInput = must<HTMLInputElement>(host, 'find-folder-replace')
  const includeInput = must<HTMLInputElement>(host, 'find-folder-include')
  const excludeInput = must<HTMLInputElement>(host, 'find-folder-exclude')
  const caseButton = must<HTMLButtonElement>(host, 'find-folder-case')
  const wordButton = must<HTMLButtonElement>(host, 'find-folder-word')
  const regexButton = must<HTMLButtonElement>(host, 'find-folder-regex')
  const preserveButton = must<HTMLButtonElement>(host, 'find-folder-preserve')
  const replaceButton = must<HTMLButtonElement>(host, 'find-folder-replace-all')
  const summary = must<HTMLElement>(host, 'find-folder-summary')
  const list = must<HTMLElement>(host, 'find-folder-list')

  let hits: FolderHit[] = []
  let total = 0
  let files = 0
  let index = 0
  let token = 0
  let timer = 0

  for (const button of [caseButton, wordButton, regexButton, preserveButton]) {
    button.addEventListener('click', () => {
      const pressed = button.getAttribute('aria-pressed') !== 'true'
      button.setAttribute('aria-pressed', pressed ? 'true' : 'false')
      button.classList.toggle('on', pressed)
      if (button !== preserveButton) schedule()
    })
  }
  for (const input of [queryInput, includeInput, excludeInput]) {
    input.addEventListener('input', schedule)
  }
  queryInput.addEventListener('keydown', onKey)
  replaceInput.addEventListener('keydown', onKey)
  includeInput.addEventListener('keydown', onKey)
  excludeInput.addEventListener('keydown', onKey)
  replaceButton.addEventListener('click', () => void replaceAll())

  return {
    focus() {
      if (!hooks.root()) {
        hooks.onMessage('Open a folder first.')
        summary.textContent = 'Open a folder first.'
        return
      }
      if (!summary.textContent) summary.textContent = 'Type to search the open folder.'
      queryInput.focus()
      queryInput.select()
    },
    contains: (node) => node !== null && host.contains(node)
  }

  function schedule(): void {
    window.clearTimeout(timer)
    timer = window.setTimeout(() => void search(), 180)
  }

  async function search(): Promise<void> {
    const folder = hooks.root()
    const find = queryInput.value
    if (!folder || find.length === 0) {
      hits = []
      total = 0
      files = 0
      render(folder ? 'Type to search the open folder.' : 'Open a folder first.')
      return
    }
    const current = ++token
    summary.textContent = 'Searching…'
    try {
      const result = await window.api.searchFolder(queryFor(folder, find))
      if (current !== token) return
      hits = result.hits
      total = result.total
      files = result.files
      index = 0
      render(describe(result.truncated, result.listTruncated))
    } catch (error) {
      if (current !== token) return
      hits = []
      total = 0
      files = 0
      render(error instanceof Error ? error.message : 'Search failed')
    }
  }

  async function replaceAll(): Promise<void> {
    const folder = hooks.root()
    const find = queryInput.value
    if (!folder || find.length === 0) return
    await search()
    if (total === 0) {
      summary.textContent = 'No matches.'
      return
    }
    const label = `${total} match${total === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}`
    if (!window.confirm(`Replace ${label}?`)) return
    summary.textContent = 'Replacing…'
    try {
      const result = await window.api.replaceFolder(queryFor(folder, find), replaceInput.value)
      hooks.onReplaced(result.updates)
      hooks.onMessage(`Replaced ${result.replacements} match${result.replacements === 1 ? '' : 'es'} in ${result.files} file${result.files === 1 ? '' : 's'}.`)
      await search()
    } catch (error) {
      summary.textContent = error instanceof Error ? error.message : 'Replace failed'
    }
  }

  function pressed(button: HTMLButtonElement): boolean {
    return button.getAttribute('aria-pressed') === 'true'
  }

  function queryFor(folder: string, find: string): FolderQuery {
    return {
      root: folder,
      find,
      regex: pressed(regexButton),
      caseSensitive: pressed(caseButton),
      wholeWord: pressed(wordButton),
      preserveCase: pressed(preserveButton),
      include: includeInput.value,
      exclude: excludeInput.value,
      buffers: hooks.buffers()
    }
  }

  function onKey(event: KeyboardEvent): void {
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      index = Math.min(index + 1, Math.max(hits.length - 1, 0))
      render(summary.textContent ?? '')
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      index = Math.max(index - 1, 0)
      render(summary.textContent ?? '')
    } else if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void replaceAll()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      const hit = hits[index]
      if (hit) hooks.onOpen(hit.path, hit.line, hit.column)
    }
  }

  function describe(truncated: boolean, listTruncated: boolean): string {
    if (total === 0) return 'No matches.'
    const shown = truncated ? `Showing ${hits.length} of ${total}` : `${total}`
    const match = `match${total === 1 ? '' : 'es'} in ${files} file${files === 1 ? '' : 's'}`
    const cap = listTruncated ? ' File list capped at 4000.' : ''
    return `${shown} ${match}.${cap}`
  }

  function render(text: string): void {
    summary.textContent = text
    if (index >= hits.length) index = Math.max(hits.length - 1, 0)
    list.replaceChildren()
    const folder = hooks.root()
    let flat = 0
    let lastPath = ''
    for (const hit of hits) {
      if (hit.path !== lastPath) {
        lastPath = hit.path
        const file = document.createElement('div')
        file.className = 'search-file'
        file.textContent = folder ? relativePath(folder, hit.path) : hit.path
        list.append(file)
      }
      const row = document.createElement('button')
      row.type = 'button'
      row.className = `search-hit${flat === index ? ' selected' : ''}`
      const where = document.createElement('span')
      where.className = 'search-hit-line'
      where.textContent = String(hit.line)
      const preview = document.createElement('span')
      preview.className = 'search-hit-preview'
      preview.textContent = hit.preview
      row.append(where, preview)
      const hitIndex = flat
      row.addEventListener('click', () => {
        index = hitIndex
        hooks.onOpen(hit.path, hit.line, hit.column)
        render(summary.textContent ?? '')
      })
      list.append(row)
      flat += 1
    }
    list.querySelector('.search-hit.selected')?.scrollIntoView({ block: 'nearest' })
  }
}

function must<T extends HTMLElement>(root: ParentNode, id: string): T {
  const el = root.querySelector(`#${id}`)
  if (!(el instanceof HTMLElement)) throw new Error(`Missing #${id}`)
  return el as T
}

function relativePath(root: string, file: string): string {
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}
