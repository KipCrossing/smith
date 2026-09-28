import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { AgentEvent, EditorApi, MenuAction, ModelPullProgress } from '../shared/types'

const api: EditorApi = {
  openFolder: () => ipcRenderer.invoke('dialog:open-folder'),
  listDir: (dir) => ipcRenderer.invoke('fs:list-dir', dir),
  readFile: (file) => ipcRenderer.invoke('fs:read-file', file),
  writeFile: (file, contents) => ipcRenderer.invoke('fs:write-file', file, contents),
  statKind: (target) => ipcRenderer.invoke('fs:stat-kind', target),
  listFiles: (root) => ipcRenderer.invoke('fs:list-files', root),
  createFile: (root, dir, name) => ipcRenderer.invoke('fs:create-file', root, dir, name),
  createDirectory: (root, dir, name) => ipcRenderer.invoke('fs:create-directory', root, dir, name),
  renamePath: (root, from, name) => ipcRenderer.invoke('fs:rename', root, from, name),
  removePath: (root, target) => ipcRenderer.invoke('fs:remove', root, target),
  copyPath: (root, from, toDir) => ipcRenderer.invoke('fs:copy', root, from, toDir),
  movePath: (root, from, toDir) => ipcRenderer.invoke('fs:move', root, from, toDir),
  duplicatePath: (root, target) => ipcRenderer.invoke('fs:duplicate', root, target),
  showItem: (target) => ipcRenderer.invoke('shell:show-item', target),
  getLastFolder: () => ipcRenderer.invoke('app:get-last-folder'),
  setLastFolder: (folder) => ipcRenderer.invoke('app:set-last-folder', folder),
  recentFolders: () => ipcRenderer.invoke('app:recent-folders'),
  openFileDialog: (dir) => ipcRenderer.invoke('dialog:open-file', dir),
  saveFileDialog: (current) => ipcRenderer.invoke('dialog:save-file', current),
  saveTextFile: (file, contents) => ipcRenderer.invoke('fs:save-text', file, contents),
  gitStatus: (root) => ipcRenderer.invoke('git:status', root),
  gitGutter: (root, file, text) => ipcRenderer.invoke('git:gutter', root, file, text),
  gitDiff: (root, file, text) => ipcRenderer.invoke('git:diff', root, file, text),
  gitChangeDiff: (root, file, staged) => ipcRenderer.invoke('git:change-diff', root, file, staged),
  gitStage: (root, paths) => ipcRenderer.invoke('git:stage', root, paths),
  gitUnstage: (root, paths) => ipcRenderer.invoke('git:unstage', root, paths),
  gitCommit: (root, message, stageAll) => ipcRenderer.invoke('git:commit', root, message, stageAll),
  searchFolder: (query) => ipcRenderer.invoke('search:folder', query),
  replaceFolder: (query, replace) => ipcRenderer.invoke('search:replace', query, replace),
  getPathForFile: (file) => webUtils.getPathForFile(file),
  onMenuAction: (callback: (action: MenuAction) => void): (() => void) => {
    const listener = (_event: unknown, action: MenuAction): void => callback(action)
    ipcRenderer.on('menu-action', listener)
    return () => ipcRenderer.removeListener('menu-action', listener)
  },
  onOpenRecent: (callback) => {
    const listener = (_event: unknown, folder: string): void => callback(folder)
    ipcRenderer.on('app:open-recent', listener)
    return () => ipcRenderer.removeListener('app:open-recent', listener)
  },
  terminalStart: (cwd) => ipcRenderer.invoke('terminal:start', cwd),
  terminalWrite: (data) => ipcRenderer.send('terminal:write', data),
  terminalStop: () => ipcRenderer.invoke('terminal:stop'),
  onTerminalData: (callback) => {
    const listener = (_event: unknown, data: string): void => callback(data)
    ipcRenderer.on('terminal:data', listener)
    return () => ipcRenderer.removeListener('terminal:data', listener)
  },
  listModels: () => ipcRenderer.invoke('agent:models'),
  pullModel: (name) => ipcRenderer.invoke('agent:pull', name),
  cancelPull: () => ipcRenderer.invoke('agent:pull-cancel'),
  onPullProgress: (callback) => {
    const listener = (_event: unknown, progress: ModelPullProgress): void => callback(progress)
    ipcRenderer.on('agent:pull-progress', listener)
    return () => ipcRenderer.removeListener('agent:pull-progress', listener)
  },
  listAgentSessions: (root) => ipcRenderer.invoke('agent:sessions', root),
  readAgentSession: (root, id) => ipcRenderer.invoke('agent:session-read', root, id),
  newAgentSession: (root) => ipcRenderer.invoke('agent:session-new', root),
  clearAgentSession: (root, id) => ipcRenderer.invoke('agent:session-clear', root, id),
  forgetAgentFile: (root, id, filePath) => ipcRenderer.invoke('agent:session-forget-file', root, id, filePath),
  rememberAgentFiles: (root, id, files) => ipcRenderer.invoke('agent:session-remember-files', root, id, files),
  contextBudget: (root, session, model, focus) => ipcRenderer.invoke('agent:context', root, session, model, focus),
  refreshProjectIndex: (root) => ipcRenderer.invoke('agent:index', root),
  runAgent: (request) => ipcRenderer.invoke('agent:run', request),
  stopAgent: () => ipcRenderer.invoke('agent:stop'),
  onAgentEvent: (callback) => {
    const listener = (_event: unknown, payload: AgentEvent): void => callback(payload)
    ipcRenderer.on('agent:event', listener)
    return () => ipcRenderer.removeListener('agent:event', listener)
  }
}

contextBridge.exposeInMainWorld('api', api)
