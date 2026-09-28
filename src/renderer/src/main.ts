import { EditorState } from '@codemirror/state'
import type { FolderBuffer, GitSnapshot, MenuAction } from '../../shared/types'
import { mountAgent } from './agent'
import { createEditor, type CursorStatus, type EditorController } from './editor'
import { mountFindFolder } from './findFolder'
import { mountDiffView } from './diffView'
import { mountGitView } from './gitView'
import { mountPalette, type PaletteCommand } from './palette'
import { rememberReference, referenceForPaste } from './references'
import { mountPanes } from './panes'
import { mountTerminal } from './terminal'
import { mountTree } from './tree'
import './styles.css'

type Tab = {
  path: string
  name: string
  dirty: boolean
  language: string
  state: EditorState
}

const app = document.querySelector('#app')
if (!app) throw new Error('Missing #app')

app.innerHTML = `
  <div class="app">
    <aside class="sidebar">
      <div class="view-bar" role="tablist">
        <button id="view-files" class="view-tab active" type="button" title="Explorer (Ctrl+Shift+E)" aria-selected="true">${filesIcon()}</button>
        <button id="view-search" class="view-tab" type="button" title="Search (Ctrl+Shift+F)" aria-selected="false">${searchIcon()}</button>
        <button id="view-git" class="view-tab" type="button" title="Source Control" aria-selected="false">${gitIcon()}</button>
      </div>
      <div id="files-view" class="side-view">
        <div class="sidebar-bar">
          <button id="open-folder" type="button">Open Folder</button>
          <span id="folder-name" class="folder-name"></span>
        </div>
        <div class="sidebar-tools">
          <button id="new-file" type="button" title="New File (Ctrl+N)">New File</button>
          <button id="new-folder" type="button" title="New Folder">New Folder</button>
          <button id="copy-entry" type="button" title="Copy">Copy</button>
          <button id="paste-entry" type="button" title="Paste">Paste</button>
          <button id="rename-entry" type="button" title="Rename (F2)">Rename</button>
          <button id="delete-entry" type="button" title="Delete">Delete</button>
          <button id="refresh-tree" type="button" title="Refresh">Refresh</button>
        </div>
        <div id="tree" class="tree"></div>
      </div>
      <div id="search-view" class="side-view" hidden></div>
      <div id="git-view" class="side-view" hidden></div>
      <div id="sidebar-resize" class="pane-resize"></div>
    </aside>
    <section class="main">
      <div id="tabs" class="tabs"></div>
      <div id="editor" class="editor">
        <div id="empty" class="empty">Open a folder, or drop a file here.</div>
        <div id="diff" class="diff-view" hidden></div>
      </div>
      <div id="terminal-resize" class="terminal-resize" hidden></div>
      <div id="terminal" class="terminal" hidden>
        <div id="terminal-title" class="terminal-title"></div>
        <div id="terminal-body" class="terminal-body"></div>
      </div>
      <footer id="status" class="status">
        <span id="status-cursor"></span>
        <span id="status-language"></span>
        <button id="status-wrap" type="button" title="Toggle word wrap">Wrap</button>
        <span id="status-path"></span>
      </footer>
    </section>
    <aside id="agent" class="agent" hidden></aside>
  </div>
  <div id="quick-open" class="quick-open hidden">
    <input id="quick-open-input" type="text" placeholder="Go to file" spellcheck="false" />
    <ul id="quick-open-list"></ul>
  </div>
  <div id="goto-line" class="quick-open hidden">
    <input id="goto-line-input" type="text" inputmode="numeric" placeholder="Go to line" spellcheck="false" />
  </div>
`

const treeEl = mustGet('tree')
const tabsEl = mustGet('tabs')
const editorEl = mustGet('editor')
const emptyEl = mustGet('empty')
const folderNameEl = mustGet('folder-name')
const quickOpenEl = mustGet('quick-open')
const quickOpenInput = mustGet('quick-open-input') as HTMLInputElement
const quickOpenList = mustGet('quick-open-list')
const statusCursor = mustGet('status-cursor')
const statusLanguage = mustGet('status-language')
const statusWrap = mustGet('status-wrap')
const statusPath = mustGet('status-path')
const gotoEl = mustGet('goto-line')
const gotoInput = mustGet('goto-line-input') as HTMLInputElement

const tabs: Tab[] = []
let active = -1
let folder: string | null = null
let filePaths: string[] = []
let fileListTruncated = false
let quickOpenIndex = 0
let message = ''
let gitTimer = 0
let gitToken = 0
const closedPaths: string[] = []

const terminal = mountTerminal(
  mustGet('terminal'),
  mustGet('terminal-resize'),
  mustGet('terminal-title'),
  mustGet('terminal-body'),
  () => folder
)

const editor: EditorController = createEditor(
  editorEl,
  () => {
    message = ''
    scheduleGit()
    const tab = currentTab()
    if (!tab || tab.dirty) {
      renderStatus()
      return
    }
    tab.dirty = true
    renderTabs()
    renderStatus()
  },
  (cursor) => renderStatus(cursor)
)

const agent = mountAgent(
  mustGet('agent'),
  (text) => referenceForPaste(text, [terminal.selection(), editor.selectionReference(activeFile())]),
  {
    project: () => folder,
    focus: () => activeFile()?.absolute ?? null,
    onFileChanged: (file) => {
      void reloadEdited(file)
    }
  }
)

const appEl = document.querySelector('.app')
if (!(appEl instanceof HTMLElement)) throw new Error('Missing .app')
mountPanes(appEl, mustGet('sidebar-resize'), mustGet('agent-resize'))

const tree = mountTree(treeEl, {
  openFile: (file) => openFile(file),
  onChanged: () => {
    if (folder) void indexFolder(folder)
    void refreshGit()
  },
  onMessage: (text) => {
    message = text
    renderStatus()
  },
  onRetarget: (from, to, isDir) => retargetTabs(from, to, isDir),
  onRemove: (target, isDir) => forgetTabs(target, isDir)
})

mustGet('open-folder').addEventListener('click', () => {
  void openFolder()
})
mustGet('new-file').addEventListener('click', () => tree.newFile())
mustGet('new-folder').addEventListener('click', () => tree.newFolder())
mustGet('copy-entry').addEventListener('click', () => tree.copy())
mustGet('paste-entry').addEventListener('click', () => tree.paste())
mustGet('rename-entry').addEventListener('click', () => tree.rename())
mustGet('delete-entry').addEventListener('click', () => tree.remove())
mustGet('refresh-tree').addEventListener('click', () => {
  void tree.refresh().then(() => {
    if (folder) void indexFolder(folder)
  })
})
statusCursor.addEventListener('click', () => openGoto())
statusWrap.addEventListener('click', () => {
  editor.toggleWrap()
  paintWrap()
})
paintWrap()

const findFolder = mountFindFolder(mustGet('search-view'), {
  root: () => folder,
  buffers: folderBuffers,
  onOpen: (file, line, column) => {
    void openFile(file).then(() => editor.goToLine(line, column))
  },
  onReplaced: (updates) => {
    applyReplacements(updates)
    void refreshGit()
  },
  onMessage: (text) => {
    message = text
    renderStatus()
  }
})

const diffView = mountDiffView(mustGet('diff'), (file) => {
  void openFile(file)
})

const gitView = mountGitView(mustGet('git-view'), {
  onOpen: (file, code, staged) => {
    void showGitChanges(file, code, staged)
  },
  onStage: async (paths) => {
    if (!folder) return
    await window.api.gitStage(folder, paths)
    await refreshGit()
  },
  onUnstage: async (paths) => {
    if (!folder) return
    await window.api.gitUnstage(folder, paths)
    await refreshGit()
  },
  onCommit: async (text, stageAll) => {
    if (!folder) return
    await window.api.gitCommit(folder, text, stageAll)
    await refreshGit()
  },
  onError: (error) => {
    message = errorText(error)
    renderStatus()
  }
})

mustGet('view-files').addEventListener('click', () => showSide('files'))
mustGet('view-search').addEventListener('click', () => {
  showSide('search')
  findFolder.focus()
})
mustGet('view-git').addEventListener('click', () => {
  showSide('git')
  void refreshGit()
})

const palette = mountPalette(paletteCommands, () => editor.focus())

window.addEventListener('keydown', (event) => {
  const mod = event.metaKey || event.ctrlKey
  if (!mod) return
  const key = event.key.toLowerCase()
  if (event.code === 'Backquote' && !event.altKey && !event.shiftKey) {
    event.preventDefault()
    terminal.toggle()
    return
  }
  if (event.altKey && event.code === 'KeyA') {
    event.preventDefault()
    agent.toggle()
    return
  }
  if (event.shiftKey && !event.altKey && key === 'p') {
    event.preventDefault()
    togglePalette()
    return
  }
  if (event.shiftKey && !event.altKey && key === 'f') {
    event.preventDefault()
    toggleFind()
    return
  }
  if (event.shiftKey && !event.altKey && key === 'o') {
    event.preventDefault()
    void openFileDialog()
    return
  }
  if (
    isTypingTarget(event.target) ||
    terminal.contains(event.target instanceof Node ? event.target : null) ||
    agent.contains(event.target instanceof Node ? event.target : null) ||
    palette.contains(event.target instanceof Node ? event.target : null) ||
    findFolder.contains(event.target instanceof Node ? event.target : null)
  ) {
    return
  }
  if (key === 'o' && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    void openFolder()
  } else if (key === 's' && event.shiftKey) {
    event.preventDefault()
    void saveAll()
  } else if (key === 's') {
    event.preventDefault()
    void saveActive()
  } else if (key === 'n' && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    tree.newFile()
  } else if (key === 'g' && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    openGoto()
  } else if (key === 't' && event.shiftKey && !event.altKey) {
    event.preventDefault()
    reopenClosed()
  } else if (key === 'e' && event.shiftKey && !event.altKey) {
    event.preventDefault()
    showSide('files')
    tree.focus()
  } else if (key === 'p' && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    toggleQuickOpen()
  } else if (key === 'w') {
    event.preventDefault()
    closeTab(active)
  } else if (key === 'f' && !event.shiftKey && !event.altKey) {
    event.preventDefault()
    editor.openFind()
  } else if (event.key === 'Tab') {
    event.preventDefault()
    cycleTab(event.shiftKey ? -1 : 1)
  }
}, true)

gotoInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') {
    event.preventDefault()
    const line = Number(gotoInput.value.trim())
    hideGoto()
    if (!Number.isFinite(line)) return
    editor.goToLine(line)
  } else if (event.key === 'Escape') {
    event.preventDefault()
    hideGoto()
  }
})

quickOpenInput.addEventListener('input', () => {
  quickOpenIndex = 0
  renderQuickOpen()
})

quickOpenInput.addEventListener('keydown', (event) => {
  const matches = filteredFiles()
  if (event.key === 'ArrowDown') {
    event.preventDefault()
    quickOpenIndex = Math.min(quickOpenIndex + 1, Math.max(matches.length - 1, 0))
    renderQuickOpen()
  } else if (event.key === 'ArrowUp') {
    event.preventDefault()
    quickOpenIndex = Math.max(quickOpenIndex - 1, 0)
    renderQuickOpen()
  } else if (event.key === 'Enter') {
    event.preventDefault()
    const chosen = matches[quickOpenIndex]
    if (chosen) {
      hideQuickOpen()
      void openFile(chosen)
    }
  } else if (event.key === 'Escape') {
    event.preventDefault()
    hideQuickOpen()
  }
})

window.addEventListener('focus', () => {
  if (!folder || document.querySelector('.tree-name')) return
  void tree.refresh().then(() => {
    if (folder) void indexFolder(folder)
  })
  void refreshGit()
})

window.addEventListener('dragover', (event) => {
  event.preventDefault()
})

window.addEventListener('drop', (event) => {
  event.preventDefault()
  const dropped = event.dataTransfer?.files[0]
  if (!dropped) return
  void openDropped(window.api.getPathForFile(dropped))
})

window.api.onMenuAction((action) => {
  runMenuAction(action)
})

window.api.onOpenRecent((next) => {
  void setFolder(next).catch((error: unknown) => {
    message = errorText(error)
    renderStatus()
  })
})

editorEl.addEventListener('copy', rememberEditorCopy, true)
editorEl.addEventListener('cut', rememberEditorCopy, true)

void (async () => {
  await restoreLastFolder()
  terminal.restore()
  agent.restore()
})()
renderStatus()

function runMenuAction(action: MenuAction): void {
  if (action === 'open-folder') void openFolder()
  else if (action === 'open-file') void openFileDialog()
  else if (action === 'save') void saveActive()
  else if (action === 'save-as') void saveAs()
  else if (action === 'close-tab') closeTab(active)
  else if (action === 'quick-open') toggleQuickOpen()
  else if (action === 'find') editor.openFind()
  else if (action === 'find-in-folder') toggleFind()
  else if (action === 'command-palette') togglePalette()
  else if (action === 'next-tab') cycleTab(1)
  else if (action === 'prev-tab') cycleTab(-1)
  else if (action === 'toggle-terminal') terminal.toggle()
  else if (action === 'toggle-agent') agent.toggle()
  else if (action === 'new-file') tree.newFile()
  else if (action === 'save-all') void saveAll()
  else if (action === 'goto-line') openGoto()
  else if (action === 'toggle-wrap') {
    editor.toggleWrap()
    paintWrap()
  } else if (action === 'reopen-tab') reopenClosed()
  else if (action === 'focus-tree') {
    showSide('files')
    tree.focus()
  }
}

async function restoreLastFolder(): Promise<void> {
  const last = await window.api.getLastFolder()
  if (last) await setFolder(last)
}

async function openFolder(): Promise<void> {
  const chosen = await window.api.openFolder()
  if (chosen) await setFolder(chosen)
}

async function setFolder(next: string): Promise<void> {
  diffView.hide()
  folder = next
  folderNameEl.textContent = baseName(next)
  message = ''
  filePaths = []
  fileListTruncated = false
  await tree.load(next)
  void indexFolder(next)
  await window.api.setLastFolder(next)
  terminal.sync(next)
  agent.sync(next)
  renderStatus()
  void refreshGit()
}

async function indexFolder(root: string): Promise<void> {
  try {
    const listed = await window.api.listFiles(root)
    if (folder !== root) return
    filePaths = listed.paths
    fileListTruncated = listed.truncated
  } catch (error) {
    if (folder !== root) return
    message = errorText(error)
  }
  renderStatus()
  if (!quickOpenEl.classList.contains('hidden')) renderQuickOpen()
}

async function openDropped(target: string): Promise<void> {
  const kind = await window.api.statKind(target)
  if (kind === 'directory') await setFolder(target)
  else if (kind === 'file') {
    if (!folder) await setFolder(parentDir(target))
    await openFile(target)
  }
}

async function showGitChanges(file: string, code: string, staged = false): Promise<void> {
  const root = folder
  if (!root) return
  const kind = await window.api.statKind(file)
  if (kind === 'directory') {
    diffView.hide()
    showSide('files')
    void tree.markOpen(file)
    return
  }
  const label = `${relativePath(root, file)}${staged ? ' (staged)' : ''}`
  try {
    const diff = await window.api.gitChangeDiff(root, file, staged)
    if (folder !== root) return
    if (diff.binary) {
      diffView.showMessage(file, label, 'Binary file.', code !== 'D' && kind === 'file')
      return
    }
    const changed = diff.lines.some((line) => line.kind !== 'same')
    await diffView.show(file, changed ? label : `${label} — no differences`, diff.lines, code !== 'D' && kind === 'file')
  } catch (error) {
    message = errorText(error)
    renderStatus()
  }
}

async function openFile(file: string): Promise<void> {
  diffView.hide()
  const existing = tabs.findIndex((tab) => tab.path === file)
  if (existing !== -1) {
    switchTo(existing)
    return
  }
  let text: string
  try {
    text = await window.api.readFile(file)
  } catch (error) {
    message = errorText(error)
    renderStatus()
    return
  }
  const name = baseName(file)
  const created = await editor.createState(text, name)
  syncActive()
  tabs.push({ path: file, name, dirty: false, language: created.language, state: created.state })
  active = tabs.length - 1
  editor.load(created.state)
  emptyEl.hidden = true
  message = ''
  renderTabs()
  renderStatus()
  editor.focus()
  void tree.markOpen(file)
  void refreshGitGutter()
}

async function saveActive(): Promise<void> {
  const tab = currentTab()
  if (!tab) return
  try {
    await window.api.writeFile(tab.path, editor.getText())
  } catch (error) {
    message = errorText(error)
    renderStatus()
    return
  }
  tab.dirty = false
  tab.state = editor.getState()
  message = 'Saved'
  renderTabs()
  renderStatus()
  void refreshGit()
}

async function saveAll(): Promise<void> {
  syncActive()
  const dirty = tabs.filter((tab) => tab.dirty)
  if (dirty.length === 0) return
  try {
    for (const tab of dirty) {
      const text = tab === currentTab() ? editor.getText() : tab.state.doc.toString()
      await window.api.writeFile(tab.path, text)
      tab.dirty = false
      if (tab === currentTab()) tab.state = editor.getState()
    }
  } catch (error) {
    message = errorText(error)
    renderTabs()
    renderStatus()
    return
  }
  message = 'Saved'
  renderTabs()
  renderStatus()
  void refreshGit()
}

function closeTab(index: number, force = false): void {
  const tab = tabs[index]
  if (!tab) return
  if (index === active) syncActive()
  if (!force && tab.dirty && !window.confirm(`${tab.name} has unsaved changes. Close it without saving?`)) return
  if (!force) closedPaths.push(tab.path)
  if (closedPaths.length > 30) closedPaths.shift()
  tabs.splice(index, 1)
  if (tabs.length === 0) {
    active = -1
    emptyEl.hidden = false
    editor.setGitGutter([])
  } else if (index < active) {
    active -= 1
  } else if (index === active) {
    active = Math.min(index, tabs.length - 1)
    editor.load(tabs[active].state)
  }
  message = ''
  renderTabs()
  renderStatus()
  void tree.markOpen(currentTab()?.path ?? null)
}

function reopenClosed(): void {
  const path = closedPaths.pop()
  if (path) void openFile(path)
}

function retargetTabs(from: string, to: string, isDir: boolean): void {
  let changed = false
  for (const tab of tabs) {
    const next = remapPath(tab.path, from, to, isDir)
    if (!next || next === tab.path) continue
    tab.path = next
    tab.name = baseName(next)
    changed = true
  }
  if (!changed) return
  renderTabs()
  renderStatus()
}

function forgetTabs(target: string, isDir: boolean): void {
  const prefix = `${target}/`
  for (let index = tabs.length - 1; index >= 0; index--) {
    const tab = tabs[index]
    if (tab.path === target || (isDir && tab.path.startsWith(prefix))) closeTab(index, true)
  }
}

function remapPath(path: string, from: string, to: string, isDir: boolean): string | null {
  if (path === from) return to
  if (!isDir) return null
  const prefix = from.endsWith('/') ? from : `${from}/`
  if (!path.startsWith(prefix)) return null
  return `${to}${path.slice(from.length)}`
}

function switchTo(index: number): void {
  if (index === active || !tabs[index]) return
  diffView.hide()
  syncActive()
  active = index
  editor.load(tabs[active].state)
  emptyEl.hidden = true
  editor.focus()
  renderTabs()
  renderStatus()
  void tree.markOpen(tabs[active].path)
  void refreshGitGutter()
}

function cycleTab(step: number): void {
  if (tabs.length < 2) return
  const next = (active + step + tabs.length) % tabs.length
  switchTo(next)
}

function syncActive(): void {
  const tab = currentTab()
  if (!tab) return
  tab.state = editor.getState()
}

function openGoto(): void {
  if (!currentTab()) return
  hideQuickOpen(false)
  palette.hide(false)
  gotoEl.classList.remove('hidden')
  gotoInput.value = String(editor.cursor().line)
  gotoInput.focus()
  gotoInput.select()
}

function hideGoto(focusEditor = true): void {
  gotoEl.classList.add('hidden')
  if (focusEditor) editor.focus()
}

function toggleQuickOpen(): void {
  if (quickOpenEl.classList.contains('hidden')) {
    if (!folder) {
      message = 'Open a folder first.'
      renderStatus()
      return
    }
    hideGoto(false)
    palette.hide(false)
    quickOpenEl.classList.remove('hidden')
    quickOpenInput.value = ''
    quickOpenIndex = 0
    renderQuickOpen()
    quickOpenInput.focus()
  } else {
    hideQuickOpen()
  }
}

function hideQuickOpen(focusEditor = true): void {
  quickOpenEl.classList.add('hidden')
  if (focusEditor) editor.focus()
}

function togglePalette(): void {
  if (palette.isOpen()) {
    palette.hide()
    return
  }
  hideQuickOpen(false)
  hideGoto(false)
  palette.open()
}

function toggleFind(): void {
  hideQuickOpen(false)
  hideGoto(false)
  palette.hide(false)
  showSide('search')
  findFolder.focus()
}

function showSide(view: 'files' | 'search' | 'git'): void {
  const files = mustGet('files-view')
  const search = mustGet('search-view')
  const git = mustGet('git-view')
  files.hidden = view !== 'files'
  search.hidden = view !== 'search'
  git.hidden = view !== 'git'
  for (const [id, selected] of [
    ['view-files', view === 'files'],
    ['view-search', view === 'search'],
    ['view-git', view === 'git']
  ] as const) {
    const button = mustGet(id)
    button.classList.toggle('active', selected)
    button.setAttribute('aria-selected', selected ? 'true' : 'false')
  }
}

async function paletteCommands(): Promise<PaletteCommand[]> {
  const recent = await window.api.recentFolders().catch(() => [])
  const commands: PaletteCommand[] = [
    { label: 'New File', hint: 'Ctrl+N', run: () => tree.newFile() },
    { label: 'Open File', hint: 'Ctrl+Shift+O', run: () => void openFileDialog() },
    { label: 'Open Folder', hint: 'Ctrl+O', run: () => void openFolder() },
    { label: 'Save', hint: 'Ctrl+S', run: () => void saveActive() },
    { label: 'Save As', run: () => void saveAs() },
    { label: 'Save All', hint: 'Ctrl+Shift+S', run: () => void saveAll() },
    { label: 'Close Tab', hint: 'Ctrl+W', run: () => closeTab(active) },
    { label: 'Reopen Closed Tab', hint: 'Ctrl+Shift+T', run: () => reopenClosed() },
    { label: 'Quick Open', hint: 'Ctrl+P', run: () => toggleQuickOpen() },
    { label: 'Find', hint: 'Ctrl+F', run: () => editor.openFind() },
    { label: 'Find in Folder', hint: 'Ctrl+Shift+F', run: () => toggleFind() },
    { label: 'Go to Line', hint: 'Ctrl+G', run: () => openGoto() },
    {
      label: 'Toggle Word Wrap',
      run: () => {
        editor.toggleWrap()
        paintWrap()
      }
    },
    { label: 'Toggle Terminal', hint: 'Ctrl+`', run: () => terminal.toggle() },
    { label: 'Toggle Agent Panel', hint: 'Ctrl+Alt+A', run: () => agent.toggle() },
    { label: 'Focus Explorer', hint: 'Ctrl+Shift+E', run: () => { showSide('files'); tree.focus() } }
  ]
  for (const item of recent) {
    commands.push({
      label: `Open Recent: ${baseName(item)}`,
      hint: item,
      run: () => void setFolder(item)
    })
  }
  return commands
}

async function openFileDialog(): Promise<void> {
  const chosen = await window.api.openFileDialog(folder)
  if (!chosen) return
  if (!folder) await setFolder(parentDir(chosen))
  await openFile(chosen)
}

async function saveAs(): Promise<void> {
  const tab = currentTab()
  if (!tab) return
  syncActive()
  const chosen = await window.api.saveFileDialog(tab.path)
  if (!chosen) return
  if (tabs.some((item, index) => item.path === chosen && index !== active)) {
    message = 'That file is already open in another tab.'
    renderStatus()
    return
  }
  const text = editor.getText()
  try {
    await window.api.saveTextFile(chosen, text)
  } catch (error) {
    message = errorText(error)
    renderStatus()
    return
  }
  tab.path = chosen
  tab.name = baseName(chosen)
  tab.dirty = false
  tab.state = editor.getState()
  message = 'Saved'
  renderTabs()
  renderStatus()
  void tree.markOpen(chosen)
  if (folder) void indexFolder(folder)
  void refreshGit()
}

function folderBuffers(): FolderBuffer[] {
  syncActive()
  return tabs.map((tab) => ({
    path: tab.path,
    text: tab === currentTab() ? editor.getText() : tab.state.doc.toString(),
    dirty: tab.dirty
  }))
}

function applyReplacements(updates: FolderBuffer[]): void {
  for (const update of updates) {
    const index = tabs.findIndex((tab) => tab.path === update.path)
    if (index === -1) continue
    const tab = tabs[index]
    if (index === active) {
      editor.replaceDocument(update.text)
      tab.state = editor.getState()
    } else {
      tab.state = tab.state.update({ changes: { from: 0, to: tab.state.doc.length, insert: update.text } }).state
    }
    tab.dirty = update.dirty
  }
  renderTabs()
  renderStatus()
}

function scheduleGit(): void {
  window.clearTimeout(gitTimer)
  gitTimer = window.setTimeout(() => void refreshGit(), 250)
}

async function refreshGit(): Promise<void> {
  await Promise.all([refreshGitStatus(), refreshGitGutter()])
}

async function refreshGitStatus(): Promise<void> {
  const root = folder
  if (!root) {
    tree.setGit([])
    gitView.setSnapshot(null, null)
    return
  }
  let snapshot: GitSnapshot = { repo: false, branch: '', entries: [], changes: [] }
  try {
    snapshot = await window.api.gitStatus(root)
  } catch (error) {
    message = errorText(error)
    renderStatus()
  }
  if (folder !== root) return
  const known = new Set(snapshot.entries.map((entry) => entry.path))
  const entries = snapshot.entries.slice()
  for (const tab of tabs) {
    if (tab.dirty && !known.has(tab.path)) entries.push({ path: tab.path, code: 'M' })
  }
  tree.setGit(entries)
  gitView.setSnapshot(snapshot, root)
}

async function refreshGitGutter(): Promise<void> {
  const tab = currentTab()
  const root = folder
  if (!tab || !root) {
    editor.setGitGutter([])
    return
  }
  const token = ++gitToken
  const text = editor.getText()
  const path = tab.path
  try {
    const marks = await window.api.gitGutter(root, path, text)
    if (token !== gitToken || currentTab()?.path !== path) return
    editor.setGitGutter(marks)
  } catch {
    if (token === gitToken) editor.setGitGutter([])
  }
}

function filteredFiles(): string[] {
  const query = quickOpenInput.value.trim().toLowerCase()
  const matched = query.length === 0 ? filePaths : filePaths.filter((file) => file.toLowerCase().includes(query))
  return matched.slice(0, 50)
}

function renderQuickOpen(): void {
  const matches = filteredFiles()
  if (quickOpenIndex >= matches.length) quickOpenIndex = Math.max(matches.length - 1, 0)
  quickOpenList.replaceChildren()
  for (const [index, file] of matches.entries()) {
    const item = document.createElement('li')
    if (index === quickOpenIndex) item.className = 'selected'
    const name = document.createElement('span')
    name.textContent = baseName(file)
    const rest = document.createElement('span')
    rest.className = 'path'
    rest.textContent = folder ? `  ${relativePath(folder, file)}` : ''
    item.append(name, rest)
    item.addEventListener('mousedown', (event) => {
      event.preventDefault()
      hideQuickOpen()
      void openFile(file)
    })
    quickOpenList.append(item)
  }
  quickOpenList.children[quickOpenIndex]?.scrollIntoView({ block: 'nearest' })
}

function renderTabs(): void {
  tabsEl.replaceChildren()
  tabs.forEach((tab, index) => {
    const button = document.createElement('button')
    button.type = 'button'
    button.className = `tab${index === active ? ' active' : ''}${tab.dirty ? ' dirty' : ''}`
    const name = document.createElement('span')
    name.className = 'tab-name'
    name.textContent = tab.name
    const close = document.createElement('span')
    close.className = 'tab-close'
    close.textContent = '×'
    close.addEventListener('click', (event) => {
      event.stopPropagation()
      closeTab(index)
    })
    button.addEventListener('auxclick', (event) => {
      if (event.button !== 1) return
      event.preventDefault()
      event.stopPropagation()
      closeTab(index)
    })
    button.append(name, close)
    button.addEventListener('click', () => switchTo(index))
    tabsEl.append(button)
  })
}

function renderStatus(cursor: CursorStatus = editor.cursor()): void {
  const tab = currentTab()
  statusCursor.textContent = tab ? `Ln ${cursor.line}, Col ${cursor.column}` : ''
  statusLanguage.textContent = tab?.language ?? ''
  const parts: string[] = []
  if (tab) parts.push(tab.path)
  if (message) parts.push(message)
  if (fileListTruncated) parts.push('file list capped at 4000')
  statusPath.textContent = parts.join(' · ')
}

function currentTab(): Tab | null {
  return tabs[active] ?? null
}

function activeFile(): { name: string; path: string; absolute: string } | null {
  const tab = currentTab()
  if (!tab) return null
  return {
    name: tab.name,
    path: folder ? relativePath(folder, tab.path) : tab.path,
    absolute: tab.path
  }
}

async function reloadEdited(file: string): Promise<void> {
  void tree.refresh()
  const index = tabs.findIndex((tab) => tab.path === file)
  if (index === -1) return
  const tab = tabs[index]
  if (tab.dirty) {
    message = 'Agent changed this file on disk. Save or close it before the editor reloads it.'
    renderStatus()
    return
  }
  let text: string
  try {
    text = await window.api.readFile(file)
  } catch {
    return
  }
  const created = await editor.createState(text, tab.name)
  tab.state = created.state
  tab.language = created.language
  tab.dirty = false
  if (index === active) editor.load(created.state)
  message = 'Updated by agent'
  renderTabs()
  renderStatus()
  void refreshGit()
}

function rememberEditorCopy(): void {
  const info = editor.selectionReference(activeFile())
  if (info) rememberReference(info)
}

function baseName(file: string): string {
  const parts = file.split(/[\\/]/)
  return parts[parts.length - 1] || file
}

function parentDir(file: string): string {
  const index = Math.max(file.lastIndexOf('/'), file.lastIndexOf('\\'))
  return index > 0 ? file.slice(0, index) : file
}

function relativePath(root: string, file: string): string {
  const prefix = root.endsWith('/') || root.endsWith('\\') ? root : `${root}/`
  return file.startsWith(prefix) ? file.slice(prefix.length) : file
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : 'Something went wrong'
}

function paintWrap(): void {
  const on = editor.wrapping()
  statusWrap.classList.toggle('on', on)
  statusWrap.textContent = on ? 'Wrap: on' : 'Wrap'
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA'
}

function filesIcon(): string {
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="currentColor" d="M3 1.5h4.2L9 3.2H13a1 1 0 0 1 1 1V13a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1V2.5a1 1 0 0 1 1-1z"/></svg>'
}

function searchIcon(): string {
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.4" d="M7 2.5a4.5 4.5 0 1 1 0 9 4.5 4.5 0 0 1 0-9z"/><path stroke="currentColor" stroke-width="1.4" d="M10.5 10.5 14 14"/></svg>'
}

function gitIcon(): string {
  return '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="4" cy="4" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="4" cy="12" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><circle cx="12" cy="8" r="1.6" fill="none" stroke="currentColor" stroke-width="1.3"/><path stroke="currentColor" stroke-width="1.3" d="M4 5.6v4.8M4 8h6.4"/></svg>'
}

function mustGet(id: string): HTMLElement {
  const el = document.getElementById(id)
  if (!el) throw new Error(`Missing #${id}`)
  return el
}
