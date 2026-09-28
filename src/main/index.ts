import { app, BrowserWindow, dialog, ipcMain, Menu, shell } from 'electron'
import { readFile, writeFile } from 'fs/promises'
import { join } from 'path'
import {
  asAbsolute,
  copyInto,
  createDirectory,
  createFile,
  duplicatePath,
  listDir,
  listFiles,
  moveInto,
  readTextFile,
  removePath,
  renamePath,
  saveTextFile,
  statKind,
  writeTextFile
} from './files'
import { gitChangeDiff, gitCommit, gitDiff, gitGutter, gitStage, gitStatus, gitUnstage } from './git'
import { replaceFolder, searchFolder } from './search'
import { startTerminal, stopAllTerminals, stopTerminal, writeTerminal } from './terminal'
import { listModels, pullModel } from './agent/ollama'
import { measureContext } from './agent/budget'
import { refreshProjectIndex } from './agent/projectIndex'
import { beginRun, endRun, runAgent, stopRun } from './agent/run'
import { clearSession, createSession, forgetSessionFile, listSessions, readSession, rememberSessionFiles } from './agent/sessions'
import type { AgentRequest, FolderQuery, MenuAction } from '../shared/types'

const RECENT_LIMIT = 8
const lastFolderPath = () => join(app.getPath('userData'), 'last-folder.json')
const recentFoldersPath = () => join(app.getPath('userData'), 'recent-folders.json')

async function getLastFolder(): Promise<string | null> {
  try {
    const raw = await readFile(lastFolderPath(), 'utf8')
    const parsed = JSON.parse(raw) as { folder?: unknown }
    if (typeof parsed.folder !== 'string') return null
    return (await statKind(asAbsolute(parsed.folder))) === 'directory' ? parsed.folder : null
  } catch {
    return null
  }
}

async function setLastFolder(folder: string): Promise<void> {
  const absolute = asAbsolute(folder)
  if ((await statKind(absolute)) !== 'directory') throw new Error('Not a folder')
  await writeFile(lastFolderPath(), JSON.stringify({ folder: absolute }), 'utf8')
  const recent = [absolute, ...(await readRecentFolders()).filter((item) => item !== absolute)].slice(0, RECENT_LIMIT)
  await writeFile(recentFoldersPath(), JSON.stringify({ folders: recent }), 'utf8')
  await installMenu()
}

async function readRecentFolders(): Promise<string[]> {
  try {
    const raw = await readFile(recentFoldersPath(), 'utf8')
    const parsed = JSON.parse(raw) as { folders?: unknown }
    if (!Array.isArray(parsed.folders)) return []
    const folders: string[] = []
    for (const item of parsed.folders) {
      if (typeof item !== 'string' || folders.includes(item)) continue
      if ((await statKind(asAbsolute(item))) === 'directory') folders.push(item)
      if (folders.length >= RECENT_LIMIT) break
    }
    return folders
  } catch {
    return []
  }
}

function sendMenuAction(action: MenuAction): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('menu-action', action)
}

function sendRecent(folder: string): void {
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0]
  win?.webContents.send('app:open-recent', folder)
}

async function installMenu(): Promise<void> {
  createMenu(await readRecentFolders())
}

function createMenu(recent: string[]): void {
  const menu = Menu.buildFromTemplate([
    {
      label: 'File',
      submenu: [
        { label: 'New File\tCtrl+N', click: () => sendMenuAction('new-file') },
        { label: 'Open File\tCtrl+Shift+O', click: () => sendMenuAction('open-file') },
        { label: 'Open Folder\tCtrl+O', click: () => sendMenuAction('open-folder') },
        {
          label: 'Open Recent',
          submenu:
            recent.length > 0
              ? recent.map((folder) => ({ label: folder, click: () => sendRecent(folder) }))
              : [{ label: 'No Recent Folders', enabled: false }]
        },
        { type: 'separator' },
        { label: 'Quick Open\tCtrl+P', click: () => sendMenuAction('quick-open') },
        { label: 'Command Palette\tCtrl+Shift+P', click: () => sendMenuAction('command-palette') },
        { type: 'separator' },
        { label: 'Save\tCtrl+S', click: () => sendMenuAction('save') },
        { label: 'Save As', click: () => sendMenuAction('save-as') },
        { label: 'Save All\tCtrl+Shift+S', click: () => sendMenuAction('save-all') },
        { label: 'Close Tab\tCtrl+W', click: () => sendMenuAction('close-tab') },
        { label: 'Reopen Closed Tab\tCtrl+Shift+T', click: () => sendMenuAction('reopen-tab') },
        { type: 'separator' },
        { role: 'quit' }
      ]
    },
    {
      label: 'Edit',
      submenu: [
        { role: 'undo' },
        { role: 'redo' },
        { type: 'separator' },
        { role: 'cut' },
        { role: 'copy' },
        { role: 'paste' },
        { type: 'separator' },
        { label: 'Find\tCtrl+F', click: () => sendMenuAction('find') },
        { label: 'Find in Folder\tCtrl+Shift+F', click: () => sendMenuAction('find-in-folder') },
        { label: 'Go to Line\tCtrl+G', click: () => sendMenuAction('goto-line') }
      ]
    },
    {
      label: 'View',
      submenu: [
        { label: 'Focus Explorer\tCtrl+Shift+E', click: () => sendMenuAction('focus-tree') },
        { label: 'Toggle Word Wrap', click: () => sendMenuAction('toggle-wrap') },
        { label: 'Toggle Terminal\tCtrl+`', click: () => sendMenuAction('toggle-terminal') },
        { label: 'Toggle Agent Panel\tCtrl+Alt+A', click: () => sendMenuAction('toggle-agent') }
      ]
    }
  ])
  Menu.setApplicationMenu(menu)
}

function createWindow(): BrowserWindow {
  const win = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 720,
    minHeight: 480,
    show: false,
    backgroundColor: '#282c34',
    title: 'Smith',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  })

  win.on('ready-to-show', () => {
    win.show()
  })
  win.on('close', () => stopTerminal(win.webContents.id))

  if (process.env['ELECTRON_RENDERER_URL']) {
    void win.loadURL(process.env['ELECTRON_RENDERER_URL'])
  } else {
    void win.loadFile(join(__dirname, '../renderer/index.html'))
  }

  return win
}

function registerIpc(): void {
  ipcMain.handle('dialog:open-folder', async () => {
    const result = await dialog.showOpenDialog({ properties: ['openDirectory'] })
    if (result.canceled || result.filePaths.length === 0) return null
    const folder = result.filePaths[0]
    await setLastFolder(folder)
    return folder
  })

  ipcMain.handle('fs:list-dir', async (_event, dir: unknown) => listDir(asAbsolute(dir)))
  ipcMain.handle('fs:read-file', async (_event, file: unknown) => readTextFile(asAbsolute(file)))
  ipcMain.handle('fs:write-file', async (_event, file: unknown, contents: unknown) => {
    if (typeof contents !== 'string') throw new Error('Invalid contents')
    await writeTextFile(asAbsolute(file), contents)
  })
  ipcMain.handle('fs:stat-kind', async (_event, target: unknown) => statKind(asAbsolute(target)))
  ipcMain.handle('fs:list-files', async (_event, root: unknown) => listFiles(asAbsolute(root)))
  ipcMain.handle('fs:create-file', async (_event, root: unknown, dir: unknown, name: unknown) =>
    createFile(String(root), String(dir), String(name))
  )
  ipcMain.handle('fs:create-directory', async (_event, root: unknown, dir: unknown, name: unknown) =>
    createDirectory(String(root), String(dir), String(name))
  )
  ipcMain.handle('fs:rename', async (_event, root: unknown, from: unknown, name: unknown) =>
    renamePath(String(root), String(from), String(name))
  )
  ipcMain.handle('fs:remove', async (_event, root: unknown, target: unknown) => {
    await removePath(String(root), String(target))
  })
  ipcMain.handle('fs:copy', async (_event, root: unknown, from: unknown, toDir: unknown) =>
    copyInto(String(root), String(from), String(toDir))
  )
  ipcMain.handle('fs:move', async (_event, root: unknown, from: unknown, toDir: unknown) =>
    moveInto(String(root), String(from), String(toDir))
  )
  ipcMain.handle('fs:duplicate', async (_event, root: unknown, target: unknown) =>
    duplicatePath(String(root), String(target))
  )
  ipcMain.handle('shell:show-item', async (_event, target: unknown) => {
    shell.showItemInFolder(asAbsolute(target))
  })
  ipcMain.handle('app:get-last-folder', () => getLastFolder())
  ipcMain.handle('app:set-last-folder', async (_event, folder: unknown) => {
    await setLastFolder(asAbsolute(folder))
  })
  ipcMain.handle('app:recent-folders', () => readRecentFolders())
  ipcMain.handle('dialog:open-file', async (_event, dir: unknown) => {
    const result = await dialog.showOpenDialog({
      properties: ['openFile'],
      defaultPath: typeof dir === 'string' && dir.length > 0 ? dir : undefined
    })
    if (result.canceled || result.filePaths.length === 0) return null
    return result.filePaths[0]
  })
  ipcMain.handle('dialog:save-file', async (_event, current: unknown) => {
    const result = await dialog.showSaveDialog({
      defaultPath: typeof current === 'string' && current.length > 0 ? current : undefined
    })
    if (result.canceled || !result.filePath) return null
    return result.filePath
  })
  ipcMain.handle('fs:save-text', async (_event, file: unknown, contents: unknown) => {
    if (typeof contents !== 'string') throw new Error('Invalid contents')
    await saveTextFile(asAbsolute(file), contents)
  })
  ipcMain.handle('git:status', async (_event, root: unknown) => gitStatus(asAbsolute(root)))
  ipcMain.handle('git:gutter', async (_event, root: unknown, file: unknown, text: unknown) => {
    if (typeof text !== 'string') throw new Error('Invalid contents')
    return gitGutter(asAbsolute(root), asAbsolute(file), text)
  })
  ipcMain.handle('git:diff', async (_event, root: unknown, file: unknown, text: unknown) => {
    if (text !== null && typeof text !== 'string') throw new Error('Invalid contents')
    return gitDiff(asAbsolute(root), asAbsolute(file), text)
  })
  ipcMain.handle('git:change-diff', async (_event, root: unknown, file: unknown, staged: unknown) => {
    return gitChangeDiff(asAbsolute(root), asAbsolute(file), staged === true)
  })
  ipcMain.handle('git:stage', async (_event, root: unknown, paths: unknown) => {
    await gitStage(asAbsolute(root), pathList(paths))
  })
  ipcMain.handle('git:unstage', async (_event, root: unknown, paths: unknown) => {
    await gitUnstage(asAbsolute(root), pathList(paths))
  })
  ipcMain.handle('git:commit', async (_event, root: unknown, message: unknown, stageAll: unknown) => {
    if (typeof message !== 'string') throw new Error('Enter a commit message.')
    await gitCommit(asAbsolute(root), message, stageAll === true)
  })
  ipcMain.handle('search:folder', async (_event, raw: unknown) => searchFolder(folderQuery(raw)))
  ipcMain.handle('search:replace', async (_event, raw: unknown, replace: unknown) => {
    if (typeof replace !== 'string') throw new Error('Invalid replacement')
    return replaceFolder(folderQuery(raw), replace)
  })
  ipcMain.handle('terminal:start', (event, cwd: unknown) =>
    startTerminal(event.sender.id, cwd, (data) => {
      if (!event.sender.isDestroyed()) event.sender.send('terminal:data', data)
    })
  )
  ipcMain.on('terminal:write', (event, data: unknown) => writeTerminal(event.sender.id, data))
  ipcMain.handle('terminal:stop', (event) => {
    stopTerminal(event.sender.id)
  })
  ipcMain.handle('agent:models', () => listModels())
  const pulls = new Map<number, AbortController>()
  ipcMain.handle('agent:pull', async (event, name: unknown) => {
    if (typeof name !== 'string') throw new Error('Enter a model name.')
    pulls.get(event.sender.id)?.abort()
    const controller = new AbortController()
    pulls.set(event.sender.id, controller)
    const onGone = (): void => controller.abort()
    event.sender.once('destroyed', onGone)
    try {
      await pullModel(name, (progress) => {
        if (!event.sender.isDestroyed()) event.sender.send('agent:pull-progress', progress)
      }, controller.signal)
    } finally {
      event.sender.removeListener('destroyed', onGone)
      if (pulls.get(event.sender.id) === controller) pulls.delete(event.sender.id)
    }
  })
  ipcMain.handle('agent:pull-cancel', (event) => {
    pulls.get(event.sender.id)?.abort()
  })
  ipcMain.handle('agent:context', (_event, root: unknown, session: unknown, model: unknown, focus: unknown) => {
    if (typeof session !== 'string' || !session.trim()) throw new Error('Choose a session.')
    if (typeof model !== 'string' || !model.trim()) throw new Error('Choose a model.')
    const open = typeof focus === 'string' && focus.trim() ? focus : null
    return measureContext(asAbsolute(root), session, model.trim(), open)
  })
  ipcMain.handle('agent:index', (_event, root: unknown) => refreshProjectIndex(asAbsolute(root)))
  ipcMain.handle('agent:sessions', (_event, root: unknown) => listSessions(asAbsolute(root)))
  ipcMain.handle('agent:session-read', (_event, root: unknown, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Unknown session.')
    return readSession(asAbsolute(root), id)
  })
  ipcMain.handle('agent:session-new', (_event, root: unknown) => createSession(asAbsolute(root)))
  ipcMain.handle('agent:session-clear', (_event, root: unknown, id: unknown) => {
    if (typeof id !== 'string') throw new Error('Unknown session.')
    return clearSession(asAbsolute(root), id)
  })
  ipcMain.handle('agent:session-forget-file', (_event, root: unknown, id: unknown, filePath: unknown) => {
    if (typeof id !== 'string' || typeof filePath !== 'string') throw new Error('Unknown file.')
    return forgetSessionFile(asAbsolute(root), id, filePath)
  })
  ipcMain.handle('agent:session-remember-files', (_event, root: unknown, id: unknown, files: unknown) => {
    if (typeof id !== 'string') throw new Error('Unknown session.')
    return rememberSessionFiles(asAbsolute(root), id, contextFiles(files))
  })
  ipcMain.handle('agent:stop', (event) => {
    stopRun(event.sender.id)
  })
  ipcMain.handle('agent:run', async (event, raw: unknown) => {
    const request = agentRequest(raw)
    const signal = beginRun(event.sender.id)
    const onGone = (): void => stopRun(event.sender.id)
    event.sender.once('destroyed', onGone)
    try {
      return await runAgent(request, (payload) => {
        if (!event.sender.isDestroyed()) event.sender.send('agent:event', payload)
      }, signal)
    } finally {
      event.sender.removeListener('destroyed', onGone)
      endRun(event.sender.id)
    }
  })
}

function pathList(raw: unknown): string[] | null {
  if (raw === null) return null
  if (!Array.isArray(raw)) throw new Error('Invalid paths')
  const paths: string[] = []
  for (const item of raw) {
    if (typeof item !== 'string' || item.length === 0) throw new Error('Invalid paths')
    paths.push(item)
  }
  return paths
}

function folderQuery(raw: unknown): FolderQuery {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid search')
  const row = raw as Record<string, unknown>
  if (typeof row.root !== 'string' || typeof row.find !== 'string') throw new Error('Invalid search')
  const buffers = Array.isArray(row.buffers) ? row.buffers.flatMap((item) => {
    if (!item || typeof item !== 'object') return []
    const buffer = item as Record<string, unknown>
    if (typeof buffer.path !== 'string' || typeof buffer.text !== 'string') return []
    return [{ path: buffer.path, text: buffer.text, dirty: buffer.dirty === true }]
  }) : []
  return {
    root: row.root,
    find: row.find,
    regex: row.regex === true,
    caseSensitive: row.caseSensitive === true,
    wholeWord: row.wholeWord === true,
    preserveCase: row.preserveCase === true,
    include: typeof row.include === 'string' ? row.include : '',
    exclude: typeof row.exclude === 'string' ? row.exclude : '',
    buffers
  }
}

function contextFiles(raw: unknown): { name: string; path: string }[] {
  if (raw == null) return []
  if (!Array.isArray(raw)) throw new Error('Invalid files')
  const files: { name: string; path: string }[] = []
  for (const item of raw) {
    if (!item || typeof item !== 'object') throw new Error('Invalid files')
    const row = item as Record<string, unknown>
    if (typeof row.path !== 'string' || !row.path.trim() || row.path.length > 1000) throw new Error('Invalid files')
    const location = row.path.trim()
    const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 300) : location.split(/[\\/]/).pop() || location
    files.push({ name, path: location })
  }
  return files
}

function agentRequest(raw: unknown): AgentRequest {
  if (!raw || typeof raw !== 'object') throw new Error('Invalid agent request')
  const row = raw as Record<string, unknown>
  if (typeof row.project !== 'string' || !row.project.trim()) throw new Error('Open a folder before messaging the agent.')
  if (typeof row.text !== 'string' || !row.text.trim()) throw new Error('Message is empty.')
  const file = typeof row.file === 'string' && row.file.trim() ? row.file : null
  const focus = typeof row.focus === 'string' && row.focus.trim() ? row.focus : null
  if (typeof row.model !== 'string' || !row.model.trim()) throw new Error('Choose a model.')
  if (typeof row.session !== 'string' || !row.session.trim()) throw new Error('Choose a session.')
  return {
    project: row.project,
    text: row.text,
    file,
    focus,
    model: row.model.trim(),
    session: row.session.trim(),
    files: contextFiles(row.files),
    think: row.think === true
  }
}

app.whenReady().then(() => {
  registerIpc()
  void installMenu().then(() => createWindow())

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('before-quit', () => stopAllTerminals())

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})
