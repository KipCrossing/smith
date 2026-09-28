import type { GitChange, GitSnapshot } from '../../shared/types'

export type GitViewController = {
  setSnapshot: (snapshot: GitSnapshot | null, root: string | null) => void
  contains: (node: Node | null) => boolean
}

type GitActions = {
  onOpen: (path: string, code: string, staged: boolean) => void
  onStage: (paths: string[] | null) => Promise<void>
  onUnstage: (paths: string[] | null) => Promise<void>
  onCommit: (message: string, stageAll: boolean) => Promise<void>
  onError: (error: unknown) => void
}

export function mountGitView(host: HTMLElement, actions: GitActions): GitViewController {
  host.innerHTML = `
    <div class="side-title">Source Control</div>
    <form class="git-commit">
      <textarea class="git-message" rows="3" spellcheck="false" placeholder="Message"></textarea>
      <button type="submit" class="git-commit-btn" disabled>✓ Commit</button>
    </form>
    <div class="git-list"></div>
  `
  const form = host.querySelector('.git-commit')
  const input = host.querySelector('.git-message')
  const submit = host.querySelector('.git-commit-btn')
  const list = host.querySelector('.git-list')
  if (!(form instanceof HTMLFormElement) || !(input instanceof HTMLTextAreaElement)) throw new Error('Missing git form')
  if (!(submit instanceof HTMLButtonElement) || !(list instanceof HTMLElement)) throw new Error('Missing git list')
  const message = input
  const commitButton = submit
  const fileList = list

  let changes: GitChange[] = []
  let busy = false
  let selected = ''
  let stagedOpen = true
  let changesOpen = true

  message.addEventListener('input', syncButton)
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void commit()
  })
  message.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
      event.preventDefault()
      void commit()
    }
  })

  function syncButton(): void {
    const staged = changes.some((change) => change.staged)
    const pending = changes.some((change) => !change.staged)
    commitButton.disabled = busy || message.value.trim().length === 0 || (!staged && !pending)
  }

  async function commit(): Promise<void> {
    if (commitButton.disabled) return
    const stageAll = !changes.some((change) => change.staged)
    busy = true
    syncButton()
    try {
      await actions.onCommit(message.value, stageAll)
      message.value = ''
    } catch (error) {
      actions.onError(error)
    } finally {
      busy = false
      syncButton()
    }
  }

  return {
    setSnapshot(snapshot, root) {
      const scroll = fileList.scrollTop
      fileList.replaceChildren()
      changes = []
      if (!root || !snapshot?.repo) {
        form.hidden = true
        fileList.append(note(root ? 'This folder is not a git repository.' : 'Open a folder to see changes.'))
        syncButton()
        return
      }
      form.hidden = false
      message.placeholder = snapshot.branch
        ? `Message (Ctrl+Enter to commit on "${snapshot.branch}")`
        : 'Message (Ctrl+Enter to commit)'
      changes = snapshot.changes
      syncButton()
      if (changes.length === 0) {
        fileList.append(note('No changes.'))
        return
      }
      const staged = changes.filter((change) => change.staged).sort(byPath)
      const pending = changes.filter((change) => !change.staged).sort(byPath)
      if (staged.length > 0) fileList.append(section('Staged Changes', staged, true, root))
      if (pending.length > 0) fileList.append(section('Changes', pending, false, root))
      fileList.scrollTop = scroll
    },
    contains: (node) => node !== null && host.contains(node)
  }

  function section(title: string, rows: GitChange[], staged: boolean, root: string): HTMLElement {
    const group = document.createElement('section')
    group.className = 'git-section'
    if ((staged && !stagedOpen) || (!staged && !changesOpen)) group.classList.add('collapsed')
    const heading = document.createElement('div')
    heading.className = 'git-heading'
    const twist = document.createElement('button')
    twist.type = 'button'
    twist.className = 'git-twist'
    twist.textContent = group.classList.contains('collapsed') ? '▸' : '▾'
    const label = document.createElement('span')
    label.textContent = title
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'git-action'
    action.textContent = staged ? '−' : '+'
    action.title = staged ? 'Unstage All' : 'Stage All'
    const count = document.createElement('span')
    count.className = 'git-count'
    count.textContent = String(rows.length)
    heading.append(twist, label, action, count)
    heading.addEventListener('click', (event) => {
      if (event.target === action) return
      if (staged) stagedOpen = !stagedOpen
      else changesOpen = !changesOpen
      group.classList.toggle('collapsed', staged ? !stagedOpen : !changesOpen)
      twist.textContent = group.classList.contains('collapsed') ? '▸' : '▾'
    })
    action.addEventListener('click', () => {
      const paths = rows.map((row) => row.path)
      void run(staged ? actions.onUnstage(paths) : actions.onStage(paths))
    })
    group.append(heading)
    for (const change of rows) group.append(row(change, root))
    return group
  }

  function row(change: GitChange, root: string): HTMLElement {
    const button = document.createElement('div')
    button.className = 'git-row'
    button.tabIndex = 0
    button.setAttribute('role', 'button')
    const key = `${change.staged ? 's' : 'u'}:${change.path}`
    if (key === selected) button.classList.add('active')
    const name = document.createElement('span')
    name.className = 'git-name'
    name.textContent = baseName(change.path)
    const filePath = document.createElement('span')
    filePath.className = 'git-path'
    filePath.textContent = parentPath(root, change.path)
    const action = document.createElement('button')
    action.type = 'button'
    action.className = 'git-action'
    action.textContent = change.staged ? '−' : '+'
    action.title = change.staged ? 'Unstage' : 'Stage'
    const badge = document.createElement('span')
    badge.className = 'git-badge'
    badge.dataset.git = change.code
    badge.textContent = change.code
    button.append(name, filePath, action, badge)
    const open = (): void => {
      selected = key
      for (const item of fileList.querySelectorAll('.git-row.active')) item.classList.remove('active')
      button.classList.add('active')
      actions.onOpen(change.path, change.code, change.staged)
    }
    button.addEventListener('click', open)
    button.addEventListener('keydown', (event) => {
      if (event.key !== 'Enter' || event.target !== button) return
      event.preventDefault()
      open()
    })
    action.addEventListener('click', (event) => {
      event.stopPropagation()
      void run(change.staged ? actions.onUnstage([change.path]) : actions.onStage([change.path]))
    })
    return button
  }

  async function run(work: Promise<void>): Promise<void> {
    try {
      await work
    } catch (error) {
      actions.onError(error)
    }
  }
}

function note(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'tree-empty'
  el.textContent = text
  return el
}

function byPath(a: GitChange, b: GitChange): number {
  return a.path.localeCompare(b.path)
}

function baseName(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] || file
}

function parentPath(root: string, file: string): string {
  const relative = relativePath(root, file)
  const slash = Math.max(relative.lastIndexOf('/'), relative.lastIndexOf('\\'))
  return slash === -1 ? '' : relative.slice(0, slash)
}

function relativePath(root: string, file: string): string {
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}
