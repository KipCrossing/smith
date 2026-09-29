export type DirEntry = {
  name: string
  path: string
  kind: 'file' | 'directory'
}

export type EntryKind = 'file' | 'directory' | null

export type ListedFiles = {
  paths: string[]
  truncated: boolean
}

export type MenuAction =
  | 'open-folder'
  | 'open-file'
  | 'save'
  | 'save-as'
  | 'close-tab'
  | 'quick-open'
  | 'find'
  | 'find-in-folder'
  | 'command-palette'
  | 'next-tab'
  | 'prev-tab'
  | 'toggle-terminal'
  | 'toggle-agent'
  | 'new-file'
  | 'save-all'
  | 'goto-line'
  | 'toggle-wrap'
  | 'reopen-tab'
  | 'focus-tree'

export type GitEntry = {
  path: string
  code: string
}

export type GitChange = {
  path: string
  code: string
  staged: boolean
}

export type GitSnapshot = {
  repo: boolean
  branch: string
  entries: GitEntry[]
  changes: GitChange[]
}

export type GitMark = {
  line: number
  add: boolean
  change: boolean
  deleteBefore: boolean
  deleteAfter: boolean
}

export type GitDiffLine = {
  kind: 'same' | 'add' | 'del'
  text: string
}

export type GitDiff = {
  binary: boolean
  lines: GitDiffLine[]
}

export type FolderBuffer = {
  path: string
  text: string
  dirty: boolean
}

export type FolderQuery = {
  root: string
  find: string
  regex: boolean
  caseSensitive: boolean
  wholeWord: boolean
  preserveCase: boolean
  include: string
  exclude: string
  buffers: FolderBuffer[]
}

export type FolderHit = {
  path: string
  line: number
  column: number
  preview: string
}

export type FolderSearchResult = {
  hits: FolderHit[]
  total: number
  files: number
  truncated: boolean
  listTruncated: boolean
}

export type FolderReplaceResult = {
  replacements: number
  files: number
  updates: FolderBuffer[]
}

export const FILE_LIST_LIMIT = 4000
export const MAX_FILE_BYTES = 1024 * 1024

export const SKIP_NAMES = new Set(['node_modules', '.git'])

export interface TerminalSession {
  directory: string
  shell: string
}

export const DEFAULT_AGENT_MODEL = 'qwen3.5:9b'

export interface AgentToolUse {
  kind: 'tool'
  name: string
  ok: boolean
  detail: string
}

export interface AgentThought {
  kind: 'thought'
  seconds: number
  text: string
}

export interface AgentContextNote {
  kind: 'context'
  step: number
  tokens: number
  added: number
}

export type AgentTrace = AgentToolUse | AgentThought | AgentContextNote

export interface AgentTurn {
  role: 'user' | 'assistant'
  content: string
  tools?: AgentTrace[]
}

export interface AgentContextFile {
  name: string
  path: string
}

export interface AgentSessionInfo {
  id: string
  created: string
  updated: string
  title: string
}

export interface AgentSession extends AgentSessionInfo {
  turns: AgentTurn[]
  files: AgentContextFile[]
}

export interface AgentSessionState {
  session: AgentSession
  sessions: AgentSessionInfo[]
}

export interface AgentPromptSettings {
  extra: string
  caveman: boolean
}

export interface AgentPromptPreview {
  base: string
  caveman: string
}

export interface AgentRequest {
  project: string
  text: string
  file: string | null
  focus: string | null
  model: string
  session: string
  files: AgentContextFile[]
  think: boolean
  extra: string
  caveman: boolean
}

export interface AgentResult {
  text: string
  error: string | null
}

export interface ContextSlice {
  id: 'instructions' | 'tools' | 'project' | 'conversation' | 'files'
  label: string
  tokens: number
}

export interface ContextBudget {
  model: string
  slices: ContextSlice[]
  used: number
  limit: number
  modelLimit: number
  loaded: boolean
  vramBytes: number | null
  approximate: boolean
}

export interface InstalledModel {
  name: string
  vision: boolean
}

export interface ModelPullProgress {
  model: string
  status: string
  completed: number
  total: number
}

export type VoiceId = 'whisper' | 'piper'

export interface VoicePackage {
  id: VoiceId
  name: string
  detail: string
  installed: boolean
  available: boolean
}

export interface VoiceProgress {
  id: VoiceId
  status: string
  completed: number
  total: number
}

export type AgentEvent =
  | { type: 'status'; text: string }
  | { type: 'step'; index: number; total: number }
  | { type: 'tool'; name: string; ok: boolean; detail: string }
  | { type: 'thought'; seconds: number; text: string }
  | { type: 'token'; channel: 'thinking' | 'content'; text: string }
  | { type: 'clear-content' }
  | { type: 'file-changed'; path: string }
  | { type: 'session-files'; added: AgentContextFile[]; removed: string[] }
  | { type: 'done'; text: string }
  | { type: 'error'; text: string }
  | { type: 'context'; budget: ContextBudget }
  | { type: 'loop-context'; step: number; tokens: number; added: number; limit: number }

export interface EditorApi {
  openFolder: () => Promise<string | null>
  listDir: (dir: string) => Promise<DirEntry[]>
  readFile: (file: string) => Promise<string>
  writeFile: (file: string, contents: string) => Promise<void>
  statKind: (target: string) => Promise<EntryKind>
  listFiles: (root: string) => Promise<ListedFiles>
  createFile: (root: string, dir: string, name: string) => Promise<string>
  createDirectory: (root: string, dir: string, name: string) => Promise<string>
  renamePath: (root: string, from: string, name: string) => Promise<string>
  removePath: (root: string, target: string) => Promise<void>
  copyPath: (root: string, from: string, toDir: string) => Promise<string>
  movePath: (root: string, from: string, toDir: string) => Promise<string>
  duplicatePath: (root: string, target: string) => Promise<string>
  showItem: (target: string) => Promise<void>
  getLastFolder: () => Promise<string | null>
  setLastFolder: (folder: string) => Promise<void>
  recentFolders: () => Promise<string[]>
  openFileDialog: (dir: string | null) => Promise<string | null>
  saveFileDialog: (current: string | null) => Promise<string | null>
  saveTextFile: (file: string, contents: string) => Promise<void>
  gitStatus: (root: string) => Promise<GitSnapshot>
  gitGutter: (root: string, file: string, text: string) => Promise<GitMark[]>
  gitDiff: (root: string, file: string, text: string | null) => Promise<GitDiff>
  gitChangeDiff: (root: string, file: string, staged: boolean) => Promise<GitDiff>
  gitStage: (root: string, paths: string[] | null) => Promise<void>
  gitUnstage: (root: string, paths: string[] | null) => Promise<void>
  gitCommit: (root: string, message: string, stageAll: boolean) => Promise<void>
  searchFolder: (query: FolderQuery) => Promise<FolderSearchResult>
  replaceFolder: (query: FolderQuery, replace: string) => Promise<FolderReplaceResult>
  getPathForFile: (file: File) => string
  onMenuAction: (callback: (action: MenuAction) => void) => () => void
  onOpenRecent: (callback: (folder: string) => void) => () => void
  terminalStart: (cwd: string | null) => Promise<TerminalSession>
  terminalWrite: (data: string) => void
  terminalStop: () => Promise<void>
  onTerminalData: (callback: (data: string) => void) => () => void
  listModels: () => Promise<InstalledModel[]>
  pullModel: (name: string) => Promise<void>
  cancelPull: () => Promise<void>
  onPullProgress: (callback: (progress: ModelPullProgress) => void) => () => void
  voiceStatus: () => Promise<VoicePackage[]>
  downloadVoice: (id: VoiceId) => Promise<void>
  cancelVoiceDownload: () => Promise<void>
  transcribe: (wav: ArrayBuffer) => Promise<string>
  speak: (text: string) => Promise<ArrayBuffer>
  stopSpeaking: () => Promise<void>
  onVoiceProgress: (callback: (progress: VoiceProgress) => void) => () => void
  listAgentSessions: (root: string) => Promise<AgentSessionState>
  readAgentSession: (root: string, id: string) => Promise<AgentSessionState>
  newAgentSession: (root: string) => Promise<AgentSessionState>
  clearAgentSession: (root: string, id: string) => Promise<AgentSessionState>
  forgetAgentFile: (root: string, id: string, path: string) => Promise<AgentSessionState>
  rememberAgentFiles: (root: string, id: string, files: AgentContextFile[]) => Promise<AgentContextFile[]>
  contextBudget: (root: string, session: string, model: string, focus: string | null, voice: AgentPromptSettings) => Promise<ContextBudget>
  agentPrompt: (root: string | null) => Promise<AgentPromptPreview>
  refreshProjectIndex: (root: string) => Promise<void>
  runAgent: (request: AgentRequest) => Promise<AgentResult>
  stopAgent: () => Promise<void>
  onAgentEvent: (callback: (event: AgentEvent) => void) => () => void
}
