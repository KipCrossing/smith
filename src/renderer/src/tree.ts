import type { DirEntry } from '../../shared/types'

export type TreeController = {
  load: (root: string) => Promise<void>
  refresh: () => Promise<void>
  newFile: () => void
  newFolder: () => void
  copy: () => void
  paste: () => void
  rename: () => void
  remove: () => void
  focus: () => void
  markOpen: (path: string | null) => Promise<void>
  setGit: (entries: { path: string; code: string }[]) => void
  contains: (node: Node | null) => boolean
}

type TreeHooks = {
  openFile: (path: string) => Promise<void>
  onChanged: () => void
  onMessage: (text: string) => void
  onRetarget: (from: string, to: string, isDir: boolean) => void
  onRemove: (target: string, isDir: boolean) => void
}

type Clip = { path: string; cut: boolean }

export function mountTree(tree: HTMLElement, hooks: TreeHooks): TreeController {
  const menu = document.createElement('div')
  menu.className = 'tree-menu hidden'
  menu.setAttribute('role', 'menu')
  document.body.append(menu)

  let root: string | null = null
  let selected: string | null = null
  let openPath: string | null = null
  let clipboard: Clip | null = null
  const expanded = new Set<string>()
  const git = new Map<string, string>()
  let deletedKey = ''
  let renderToken = 0

  tree.tabIndex = 0
  tree.setAttribute('role', 'tree')
  tree.addEventListener('keydown', onKey)
  tree.addEventListener('click', (event) => {
    if (!(event.target instanceof Element)) return
    if (event.target.closest('.tree-row') || event.target.closest('input')) return
    if (root) select(root)
    tree.focus()
  })
  tree.addEventListener('contextmenu', (event) => {
    if (!(event.target instanceof Element) || event.target.closest('.tree-row')) return
    event.preventDefault()
    if (root) select(root)
    openMenu(event.clientX, event.clientY)
  })
  menu.addEventListener('mousedown', (event) => event.stopPropagation())
  window.addEventListener('mousedown', (event) => {
    if (event.target instanceof Node && menu.contains(event.target)) return
    hideMenu()
  })
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || menu.classList.contains('hidden')) return
    event.preventDefault()
    event.stopPropagation()
    hideMenu()
  }, true)
  tree.addEventListener('scroll', () => hideMenu())

  return {
    load: async (next) => {
      root = next
      selected = null
      clipboard = null
      expanded.clear()
      git.clear()
      deletedKey = ''
      await refresh()
    },
    refresh,
    newFile: () => beginCreate('file'),
    newFolder: () => beginCreate('directory'),
    copy,
    paste: () => void paste(),
    rename,
    remove: () => void remove(),
    focus() {
      const row = selected ? rowFor(selected) : rows()[0]
      if (row) row.focus()
      else tree.focus()
    },
    markOpen,
    setGit(entries) {
      git.clear()
      for (const entry of entries) git.set(entry.path, entry.code)
      const deleted = entries
        .filter((entry) => entry.code === 'D')
        .map((entry) => entry.path)
        .sort()
        .join('\n')
      if (deleted !== deletedKey) {
        deletedKey = deleted
        void refresh()
        return
      }
      paint()
    },
    contains: (node) => node !== null && (tree.contains(node) || menu.contains(node))
  }

  async function refresh(): Promise<void> {
    if (!root) return
    const token = ++renderToken
    const scroll = tree.scrollTop
    await renderInto(tree, root, 0, token)
    if (token !== renderToken) return
    tree.scrollTop = scroll
    paint()
  }

  async function renderInto(container: HTMLElement, dir: string, depth: number, token: number): Promise<void> {
    let entries: DirEntry[]
    try {
      entries = await window.api.listDir(dir)
    } catch (error) {
      if (token !== renderToken) return
      container.replaceChildren(note(errorText(error)))
      return
    }
    if (token !== renderToken) return
    container.replaceChildren()
    const ghosts = deletedIn(dir)
    if (entries.length === 0 && ghosts.length === 0) {
      container.append(note(depth === 0 ? 'This folder is empty.' : 'Empty'))
      return
    }
    for (const entry of entries) {
      const row = document.createElement('div')
      row.className = `tree-row${entry.kind === 'directory' ? ' directory' : ''}`
      row.dataset.path = entry.path
      row.dataset.kind = entry.kind
      row.dataset.depth = String(depth)
      row.tabIndex = -1
      row.setAttribute('role', 'treeitem')
      row.style.paddingLeft = `${depth * 14 + 8}px`
      const twist = document.createElement('span')
      twist.className = 'twist'
      twist.textContent = entry.kind === 'directory' && expanded.has(entry.path) ? '▾' : entry.kind === 'directory' ? '▸' : ''
      const label = document.createElement('span')
      label.className = 'tree-label'
      label.textContent = entry.name
      row.append(twist, label)
      wire(row, entry)
      container.append(row)
      if (entry.kind === 'directory') {
        const children = document.createElement('div')
        children.className = 'tree-children'
        if (!expanded.has(entry.path)) children.hidden = true
        container.append(children)
        if (expanded.has(entry.path)) await renderInto(children, entry.path, depth + 1, token)
      }
    }
    for (const ghost of ghosts) {
      if (entries.some((entry) => entry.path === ghost.path)) continue
      const row = document.createElement('div')
      row.className = 'tree-row git-missing'
      row.dataset.path = ghost.path
      row.dataset.kind = 'deleted'
      row.dataset.depth = String(depth)
      row.tabIndex = -1
      row.setAttribute('role', 'treeitem')
      row.style.paddingLeft = `${depth * 14 + 8}px`
      const twist = document.createElement('span')
      twist.className = 'twist'
      const label = document.createElement('span')
      label.className = 'tree-label'
      label.textContent = ghost.name
      row.append(twist, label)
      row.addEventListener('mousedown', (event) => {
        if (event.button !== 0 && event.button !== 2) return
        select(ghost.path)
      })
      row.addEventListener('click', () => {
        select(ghost.path)
        hooks.onMessage('This file was deleted from the folder.')
      })
      container.append(row)
    }
  }

  function deletedIn(dir: string): { name: string; path: string }[] {
    const found: { name: string; path: string }[] = []
    for (const [file, code] of git) {
      if (code !== 'D' || parentDir(file) !== dir) continue
      found.push({ name: baseName(file), path: file })
    }
    found.sort((a, b) => a.name.localeCompare(b.name))
    return found
  }

  function wire(row: HTMLElement, entry: DirEntry): void {
    row.addEventListener('mousedown', (event) => {
      if (event.button !== 0 && event.button !== 2) return
      select(entry.path)
    })
    row.addEventListener('click', () => {
      select(entry.path)
      if (entry.kind === 'file') void hooks.openFile(entry.path)
      else void toggle(entry.path)
    })
    row.addEventListener('contextmenu', (event) => {
      event.preventDefault()
      event.stopPropagation()
      select(entry.path)
      openMenu(event.clientX, event.clientY)
    })
  }

  async function toggle(path: string): Promise<void> {
    const open = !expanded.has(path)
    if (open) expanded.add(path)
    else expanded.delete(path)
    const row = rowFor(path)
    const children = childrenEl(path)
    if (!row || !children) return
    children.hidden = !open
    const twist = row.querySelector('.twist')
    if (twist) twist.textContent = open ? '▾' : '▸'
    if (open && children.childElementCount === 0) {
      await renderInto(children, path, Number(row.dataset.depth ?? '0') + 1, renderToken)
    }
    paint()
  }

  function beginCreate(kind: 'file' | 'directory'): void {
    const parent = destinationDir()
    if (!root || !parent) {
      hooks.onMessage('Open a folder first.')
      return
    }
    void insertCreator(kind, parent)
  }

  async function insertCreator(kind: 'file' | 'directory', parent: string): Promise<void> {
    if (parent !== root) {
      expanded.add(parent)
      await refresh()
    }
    const container = parent === root ? tree : childrenEl(parent)
    if (!container) return
    tree.querySelector('.tree-create')?.remove()
    const row = document.createElement('div')
    row.className = 'tree-row tree-create'
    const depth = parent === root ? 0 : Number(rowFor(parent)?.dataset.depth ?? '0') + 1
    row.style.paddingLeft = `${depth * 14 + 8}px`
    const input = document.createElement('input')
    input.className = 'tree-name'
    input.placeholder = kind === 'file' ? 'filename.txt' : 'folder name'
    input.spellcheck = false
    row.append(input)
    container.querySelector(':scope > .tree-empty')?.remove()
    container.prepend(row)
    input.focus()
    let settled = false
    const finish = (commit: boolean) => {
      if (settled) return
      settled = true
      const name = input.value
      row.remove()
      if (!commit || !name.trim()) {
        if (container.childElementCount === 0) container.append(note(parent === root ? 'This folder is empty.' : 'Empty'))
        return
      }
      void commitCreate(kind, parent, name)
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
  }

  async function commitCreate(kind: 'file' | 'directory', parent: string, name: string): Promise<void> {
    if (!root) return
    try {
      const created = kind === 'file'
        ? await window.api.createFile(root, parent, name)
        : await window.api.createDirectory(root, parent, name)
      if (kind === 'directory') expanded.add(created)
      await refresh()
      select(created)
      hooks.onChanged()
      if (kind === 'file') await hooks.openFile(created)
      hooks.onMessage(kind === 'file' ? 'File created' : 'Folder created')
    } catch (error) {
      hooks.onMessage(errorText(error))
      await refresh()
    }
  }

  function copy(): void {
    if (!insideSelection()) return
    clipboard = { path: selected as string, cut: false }
    paint()
    hooks.onMessage('Copied')
  }

  function cut(): void {
    if (!insideSelection()) return
    clipboard = { path: selected as string, cut: true }
    paint()
    hooks.onMessage('Cut')
  }

  async function paste(): Promise<void> {
    if (!root || !clipboard) return
    const dest = destinationDir()
    if (!dest) return
    const clip = clipboard
    const isDir = kindOf(clip.path) === 'directory'
    try {
      const next = clip.cut
        ? await window.api.movePath(root, clip.path, dest)
        : await window.api.copyPath(root, clip.path, dest)
      if (clip.cut) {
        hooks.onRetarget(clip.path, next, isDir)
        rewrite(clip.path, next, isDir)
        clipboard = null
      }
      if (!clip.cut && isDir) expanded.add(next)
      await refresh()
      select(next)
      hooks.onChanged()
      if (rowFor(next)?.dataset.kind === 'file') await hooks.openFile(next)
      hooks.onMessage(clip.cut ? 'Moved' : 'Pasted')
    } catch (error) {
      hooks.onMessage(errorText(error))
    }
  }

  async function duplicate(): Promise<void> {
    if (!root || !insideSelection() || !selected) return
    try {
      const next = await window.api.duplicatePath(root, selected)
      await refresh()
      select(next)
      hooks.onChanged()
      if (rowFor(next)?.dataset.kind === 'file') await hooks.openFile(next)
      hooks.onMessage('Duplicated')
    } catch (error) {
      hooks.onMessage(errorText(error))
    }
  }

  function rename(): void {
    if (!root || !insideSelection() || !selected) return
    const row = rowFor(selected)
    const label = row?.querySelector('.tree-label')
    if (!row || !label) return
    const from = selected
    const isDir = row.dataset.kind === 'directory'
    const input = document.createElement('input')
    input.className = 'tree-name'
    input.value = label.textContent ?? ''
    input.spellcheck = false
    label.replaceWith(input)
    input.focus()
    const dot = input.value.lastIndexOf('.')
    input.setSelectionRange(0, !isDir && dot > 0 ? dot : input.value.length)
    let settled = false
    const finish = (commit: boolean) => {
      if (settled) return
      settled = true
      const name = input.value.trim()
      if (!commit || !name || name === label.textContent) {
        input.replaceWith(label)
        return
      }
      void commitRename(from, name, isDir === true)
    }
    input.addEventListener('keydown', (event) => {
      event.stopPropagation()
      if (event.key === 'Enter') {
        event.preventDefault()
        finish(true)
      } else if (event.key === 'Escape') {
        event.preventDefault()
        finish(false)
      }
    })
    input.addEventListener('blur', () => finish(true))
  }

  async function commitRename(from: string, name: string, isDir: boolean): Promise<void> {
    if (!root) return
    try {
      const next = await window.api.renamePath(root, from, name)
      hooks.onRetarget(from, next, isDir)
      rewrite(from, next, isDir)
      await refresh()
      select(next)
      hooks.onChanged()
      hooks.onMessage('Renamed')
    } catch (error) {
      hooks.onMessage(errorText(error))
      await refresh()
    }
  }

  async function remove(): Promise<void> {
    if (!root || !insideSelection() || !selected) return
    const target = selected
    const isDir = kindOf(target) === 'directory'
    const name = baseName(target)
    const warning = isDir ? `Delete folder "${name}" and everything inside it?` : `Delete "${name}"?`
    if (!window.confirm(warning)) return
    try {
      await window.api.removePath(root, target)
      if (clipboard && (clipboard.path === target || (isDir && clipboard.path.startsWith(`${target}/`)))) clipboard = null
      const prefix = `${target}/`
      for (const item of [...expanded]) {
        if (item === target || item.startsWith(prefix)) expanded.delete(item)
      }
      if (selected === target) selected = parentDir(target) === root ? null : parentDir(target)
      hooks.onRemove(target, isDir)
      await refresh()
      hooks.onChanged()
      hooks.onMessage('Deleted')
    } catch (error) {
      hooks.onMessage(errorText(error))
    }
  }

  async function copyText(text: string): Promise<void> {
    try {
      await navigator.clipboard.writeText(text)
      hooks.onMessage('Copied')
    } catch (error) {
      hooks.onMessage(errorText(error))
    }
  }

  function openMenu(x: number, y: number): void {
    menu.replaceChildren()
    for (const item of menuItems()) {
      if (item.gap && menu.childElementCount > 0) {
        const sep = document.createElement('div')
        sep.className = 'tree-menu-sep'
        menu.append(sep)
      }
      const button = document.createElement('button')
      button.type = 'button'
      button.textContent = item.label
      button.disabled = !item.enabled
      button.addEventListener('click', () => {
        hideMenu()
        item.run()
      })
      menu.append(button)
    }
    menu.classList.remove('hidden')
    menu.style.left = '0px'
    menu.style.top = '0px'
    const rect = menu.getBoundingClientRect()
    menu.style.left = `${Math.max(4, Math.min(x, window.innerWidth - rect.width - 8))}px`
    menu.style.top = `${Math.max(4, Math.min(y, window.innerHeight - rect.height - 8))}px`
  }

  function hideMenu(): void {
    menu.classList.add('hidden')
  }

  function menuItems(): Array<{ label: string; enabled: boolean; run: () => void; gap?: boolean }> {
    const target = selected
    const kind = target ? (target === root ? 'directory' : kindOf(target)) : null
    const inside = insideSelection()
    const canCreate = destinationDir() !== null
    return [
      { label: 'Open', enabled: kind === 'file' && !!target, run: () => { if (target) void hooks.openFile(target) } },
      { label: 'New File', enabled: canCreate, gap: true, run: () => beginCreate('file') },
      { label: 'New Folder', enabled: canCreate, run: () => beginCreate('directory') },
      { label: 'Copy', enabled: inside, gap: true, run: copy },
      { label: 'Cut', enabled: inside, run: cut },
      { label: 'Paste', enabled: canCreate && clipboard !== null, run: () => void paste() },
      { label: 'Duplicate', enabled: inside, run: () => void duplicate() },
      { label: 'Rename', enabled: inside, gap: true, run: rename },
      { label: 'Delete', enabled: inside, run: () => void remove() },
      { label: 'Copy Path', enabled: !!target, gap: true, run: () => { if (target) void copyText(target) } },
      {
        label: 'Copy Relative Path',
        enabled: !!target && !!root && target !== root,
        run: () => { if (target && root) void copyText(relative(root, target)) }
      },
      { label: 'Reveal in File Manager', enabled: !!target, run: () => { if (target) void window.api.showItem(target) } },
      { label: 'Refresh', enabled: !!root, gap: true, run: () => void refresh().then(() => hooks.onChanged()) }
    ]
  }

  function onKey(event: KeyboardEvent): void {
    if (event.target instanceof HTMLInputElement) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      move(1)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      move(-1)
    } else if (event.key === 'ArrowRight') {
      event.preventDefault()
      void goRight()
    } else if (event.key === 'ArrowLeft') {
      event.preventDefault()
      goLeft()
    } else if (event.key === 'Enter') {
      event.preventDefault()
      activate()
    } else if (event.key === 'F2') {
      event.preventDefault()
      rename()
    } else if (event.key === 'Delete') {
      event.preventDefault()
      void remove()
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'c' && !event.shiftKey) {
      event.preventDefault()
      copy()
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'x') {
      event.preventDefault()
      cut()
    } else if ((event.ctrlKey || event.metaKey) && !event.altKey && event.key.toLowerCase() === 'v') {
      event.preventDefault()
      void paste()
    }
  }

  function move(delta: number): void {
    const list = rows()
    if (list.length === 0) return
    const index = list.findIndex((row) => row.dataset.path === selected)
    const start = index === -1 ? (delta > 0 ? 0 : list.length - 1) : index + delta
    const next = list[Math.min(list.length - 1, Math.max(0, start))]
    if (!next?.dataset.path) return
    select(next.dataset.path)
    next.focus()
    next.scrollIntoView({ block: 'nearest' })
  }

  async function goRight(): Promise<void> {
    if (!selected || kindOf(selected) !== 'directory') return
    if (!expanded.has(selected)) {
      await toggle(selected)
      return
    }
    move(1)
  }

  function goLeft(): void {
    if (selected && kindOf(selected) === 'directory' && expanded.has(selected)) {
      void toggle(selected)
      return
    }
    if (!selected || !root || selected === root) return
    const parent = parentDir(selected)
    if (parent === root || parent === selected) return
    select(parent)
    const row = rowFor(parent)
    row?.focus()
    row?.scrollIntoView({ block: 'nearest' })
  }

  function activate(): void {
    if (!selected || selected === root) return
    if (kindOf(selected) === 'file') void hooks.openFile(selected)
    else if (kindOf(selected) === 'directory') void toggle(selected)
    else if (kindOf(selected) === 'deleted') hooks.onMessage('This file was deleted from the folder.')
  }

  async function markOpen(path: string | null): Promise<void> {
    openPath = path
    if (path && root && isInside(path)) {
      let grew = false
      for (const dir of ancestors(path)) {
        if (!expanded.has(dir)) {
          expanded.add(dir)
          grew = true
        }
      }
      if (grew || !rowFor(path)) await refresh()
    }
    paint()
    if (path) rowFor(path)?.scrollIntoView({ block: 'nearest' })
  }

  function select(path: string | null): void {
    selected = path
    paint()
  }

  function paint(): void {
    for (const row of tree.querySelectorAll<HTMLElement>('.tree-row')) {
      const path = row.dataset.path ?? ''
      row.classList.toggle('selected', path !== '' && path === selected)
      row.classList.toggle('open', path !== '' && path === openPath)
      row.classList.toggle('cut', !!clipboard?.cut && clipboard.path === path)
      row.tabIndex = path === selected ? 0 : -1
      paintBadge(row)
    }
  }

  function paintBadge(row: HTMLElement): void {
    const code = badgeFor(row)
    const existing = row.querySelector('.git-badge')
    if (!code) {
      existing?.remove()
      return
    }
    const badge = existing instanceof HTMLElement ? existing : document.createElement('span')
    if (!badge.isConnected) {
      badge.className = 'git-badge'
      row.append(badge)
    }
    badge.textContent = code
    badge.dataset.git = code
  }

  function badgeFor(row: HTMLElement): string | undefined {
    const file = row.dataset.path
    if (!file) return undefined
    const direct = git.get(file)
    if (direct) return direct
    if (row.dataset.kind !== 'directory') return undefined
    const prefix = `${file}/`
    const rank: Record<string, number> = { U: 5, M: 4, A: 3, R: 3, '?': 3, D: 1 }
    let best = ''
    let bestRank = 0
    for (const [candidate, code] of git) {
      if (!candidate.startsWith(prefix)) continue
      const score = rank[code] ?? 2
      if (score > bestRank) {
        best = code
        bestRank = score
      }
    }
    return best || undefined
  }

  function rewrite(from: string, to: string, isDir: boolean): void {
    const nextExpanded = new Set<string>()
    for (const item of expanded) nextExpanded.add(remap(item, from, to, isDir) ?? item)
    expanded.clear()
    for (const item of nextExpanded) expanded.add(item)
    if (selected) selected = remap(selected, from, to, isDir) ?? selected
    if (openPath) openPath = remap(openPath, from, to, isDir) ?? openPath
    if (clipboard) {
      const mapped = remap(clipboard.path, from, to, isDir)
      if (mapped) clipboard = { path: mapped, cut: clipboard.cut }
    }
  }

  function destinationDir(): string | null {
    if (!root) return null
    if (!selected || selected === root) return root
    const kind = kindOf(selected)
    if (kind === 'directory') return selected
    if (kind === 'file' || kind === 'deleted') return parentDir(selected)
    return root
  }

  function insideSelection(): boolean {
    const kind = selected ? kindOf(selected) : null
    return !!selected && !!root && selected !== root && (kind === 'file' || kind === 'directory')
  }

  function kindOf(path: string): 'file' | 'directory' | 'deleted' | null {
    const kind = rowFor(path)?.dataset.kind
    if (kind === 'file' || kind === 'directory' || kind === 'deleted') return kind
    return null
  }

  function rows(): HTMLElement[] {
    return [...tree.querySelectorAll<HTMLElement>('.tree-row')].filter((row) => !row.closest('.tree-children[hidden]'))
  }

  function rowFor(path: string): HTMLElement | null {
    for (const row of tree.querySelectorAll<HTMLElement>('.tree-row')) {
      if (row.dataset.path === path) return row
    }
    return null
  }

  function childrenEl(path: string): HTMLElement | null {
    const next = rowFor(path)?.nextElementSibling
    return next instanceof HTMLElement && next.classList.contains('tree-children') ? next : null
  }

  function ancestors(path: string): string[] {
    if (!root) return []
    const found: string[] = []
    let dir = parentDir(path)
    while (dir !== root && dir !== path) {
      found.push(dir)
      const next = parentDir(dir)
      if (next === dir) break
      dir = next
    }
    return found
  }

  function isInside(path: string): boolean {
    if (!root) return false
    const prefix = root.endsWith('/') ? root : `${root}/`
    return path === root || path.startsWith(prefix)
  }
}

function remap(path: string, from: string, to: string, isDir: boolean): string | null {
  if (path === from) return to
  if (!isDir) return null
  const prefix = from.endsWith('/') ? from : `${from}/`
  if (!path.startsWith(prefix)) return null
  return `${to}${path.slice(from.length)}`
}

function relative(root: string, file: string): string {
  const prefix = root.endsWith('/') ? root : `${root}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

function parentDir(file: string): string {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return index > 0 ? file.slice(0, index) : file
}

function baseName(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] || file
}

function note(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tree-empty'
  el.textContent = text
  return el
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong'
}
