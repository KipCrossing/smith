import { mkdir, readFile, writeFile } from 'fs/promises'
import path from 'path'
import type { AgentContextFile, AgentSession, AgentSessionInfo, AgentSessionState, AgentTrace, AgentTurn } from '../../shared/types'
import { ensureAgentDir } from './history'

const SESSIONS = 'sessions'
const INDEX = 'index.json'
const TITLE = 'New session'
const ID_PATTERN = /^\d{8}T\d{6}-\d{3}[a-z]?$/

type IndexFile = {
  active: string
  sessions: AgentSessionInfo[]
}

type SessionFile = AgentSession

const chains = new Map<string, Promise<unknown>>()
const revisions = new Map<string, number>()

export function beginSessionWrite(root: string, id: string): number {
  return revisions.get(revisionKey(root, id)) ?? 0
}

export async function listSessions(root: string): Promise<AgentSessionState> {
  return exclusive(root, async () => openActive(root))
}

export async function readSession(root: string, id: string): Promise<AgentSessionState> {
  const sessionId = requireId(id)
  return exclusive(root, async () => {
    const index = await loadIndex(root)
    if (!index.sessions.some((item) => item.id === sessionId)) throw new Error('Session not found.')
    index.active = sessionId
    await saveIndex(root, index)
    return stateFrom(root, index, sessionId)
  })
}

export async function createSession(root: string): Promise<AgentSessionState> {
  return exclusive(root, async () => {
    const index = await loadIndex(root)
    const session = emptySession(uniqueId(index.sessions.map((item) => item.id)))
    index.sessions.push(infoOf(session))
    index.active = session.id
    await writeSession(root, session)
    await saveIndex(root, index)
    return { session, sessions: ordered(index.sessions) }
  })
}

export async function clearSession(root: string, id: string): Promise<AgentSessionState> {
  const sessionId = requireId(id)
  return exclusive(root, async () => {
    bump(root, sessionId)
    const index = await loadIndex(root)
    const session = await loadSession(root, sessionId)
    session.turns = []
    session.files = []
    session.title = TITLE
    session.updated = new Date().toISOString()
    replaceInfo(index, session)
    await writeSession(root, session)
    await saveIndex(root, index)
    return { session, sessions: ordered(index.sessions) }
  })
}

export async function appendSessionTurns(
  root: string,
  id: string,
  turns: AgentTurn[],
  revision: number
): Promise<boolean> {
  const sessionId = requireId(id)
  return exclusive(root, async () => {
    if ((revisions.get(revisionKey(root, sessionId)) ?? 0) !== revision) return false
    const index = await loadIndex(root)
    const session = await loadSession(root, sessionId)
    session.turns.push(...turns.filter((turn) => turn.content.trim().length > 0 || turn.role === 'assistant'))
    const firstUser = session.turns.find((turn) => turn.role === 'user' && turn.content.trim())
    if (session.title === TITLE && firstUser) session.title = titleFrom(firstUser.content)
    session.updated = new Date().toISOString()
    replaceInfo(index, session)
    await writeSession(root, session)
    await saveIndex(root, index)
    return true
  })
}

export async function rememberSessionFiles(
  root: string,
  id: string,
  incoming: AgentContextFile[]
): Promise<AgentContextFile[]> {
  const sessionId = requireId(id)
  return exclusive(root, async () => {
    const session = await loadSession(root, sessionId)
    let changed = false
    for (const file of incoming) {
      const location = file.path.trim()
      if (!location) continue
      if (session.files.some((item) => samePath(item.path, location))) continue
      const name = file.name.trim() || path.basename(location)
      session.files.push({ name, path: location })
      changed = true
    }
    if (changed) {
      session.updated = new Date().toISOString()
      await writeSession(root, session)
    }
    return session.files
  })
}

export async function forgetSessionFile(root: string, id: string, filePath: string): Promise<AgentSessionState> {
  const sessionId = requireId(id)
  const location = filePath.trim()
  if (!location) throw new Error('Unknown file.')
  return exclusive(root, async () => {
    const index = await loadIndex(root)
    const session = await loadSession(root, sessionId)
    session.files = session.files.filter((item) => !samePath(item.path, location))
    session.updated = new Date().toISOString()
    await writeSession(root, session)
    return { session, sessions: ordered(index.sessions) }
  })
}

export type SessionFileEdit =
  | { kind: 'add'; file: AgentContextFile }
  | { kind: 'drop'; path: string; tree: boolean }
  | { kind: 'relocate'; from: string; to: string; tree: boolean }

export async function applySessionFileEdits(
  root: string,
  id: string,
  revision: number,
  edit: SessionFileEdit
): Promise<{ added: AgentContextFile[]; removed: string[] } | null> {
  const sessionId = requireId(id)
  return exclusive(root, async () => {
    if ((revisions.get(revisionKey(root, sessionId)) ?? 0) !== revision) return null
    const session = await loadSession(root, sessionId)
    const change = editSessionFiles(session.files, edit)
    if (change.added.length === 0 && change.removed.length === 0) return change
    session.files = change.files
    session.updated = new Date().toISOString()
    await writeSession(root, session)
    return { added: change.added, removed: change.removed }
  })
}

export async function readSessionFiles(root: string, id: string): Promise<AgentContextFile[]> {
  const sessionId = requireId(id)
  return exclusive(root, async () => (await loadSession(root, sessionId)).files)
}

export async function readTurns(root: string, id: string): Promise<AgentTurn[]> {
  const sessionId = requireId(id)
  return exclusive(root, async () => (await loadSession(root, sessionId)).turns)
}

async function openActive(root: string): Promise<AgentSessionState> {
  const index = await loadIndex(root)
  if (index.sessions.length === 0 || !index.sessions.some((item) => item.id === index.active)) {
    const session = emptySession(uniqueId(index.sessions.map((item) => item.id)))
    index.sessions.push(infoOf(session))
    index.active = session.id
    await writeSession(root, session)
    await saveIndex(root, index)
    return { session, sessions: ordered(index.sessions) }
  }
  return stateFrom(root, index, index.active)
}

async function stateFrom(root: string, index: IndexFile, id: string): Promise<AgentSessionState> {
  const session = await loadSession(root, id)
  return { session, sessions: ordered(index.sessions) }
}

function emptySession(id: string): SessionFile {
  const now = new Date().toISOString()
  return { id, created: now, updated: now, title: TITLE, turns: [], files: [] }
}

function infoOf(session: SessionFile): AgentSessionInfo {
  return { id: session.id, created: session.created, updated: session.updated, title: session.title }
}

function replaceInfo(index: IndexFile, session: SessionFile): void {
  const info = infoOf(session)
  const at = index.sessions.findIndex((item) => item.id === session.id)
  if (at === -1) index.sessions.push(info)
  else index.sessions[at] = info
}

function ordered(sessions: AgentSessionInfo[]): AgentSessionInfo[] {
  return [...sessions].sort((a, b) => b.created.localeCompare(a.created))
}

function titleFrom(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? TITLE
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

async function loadIndex(root: string): Promise<IndexFile> {
  const dir = await sessionsDir(root)
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, INDEX), 'utf8')) as Partial<IndexFile>
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions.flatMap(readInfo) : []
    const active = typeof parsed.active === 'string' ? parsed.active : ''
    return { active, sessions }
  } catch {
    return { active: '', sessions: [] }
  }
}

async function saveIndex(root: string, index: IndexFile): Promise<void> {
  const dir = await sessionsDir(root)
  await writeFile(path.join(dir, INDEX), JSON.stringify(index, null, 2), 'utf8')
}

async function loadSession(root: string, id: string): Promise<SessionFile> {
  const file = path.join(await sessionsDir(root), `${requireId(id)}.json`)
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<SessionFile>
    return {
      id,
      created: typeof parsed.created === 'string' ? parsed.created : new Date().toISOString(),
      updated: typeof parsed.updated === 'string' ? parsed.updated : new Date().toISOString(),
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : TITLE,
      turns: Array.isArray(parsed.turns) ? parsed.turns.flatMap(readTurn) : [],
      files: Array.isArray(parsed.files) ? parsed.files.flatMap(readContextFile) : []
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
    if (code === 'ENOENT') throw new Error('Session not found.')
    return emptySession(id)
  }
}

async function writeSession(root: string, session: SessionFile): Promise<void> {
  const dir = await sessionsDir(root)
  await writeFile(path.join(dir, `${session.id}.json`), JSON.stringify(session, null, 2), 'utf8')
}

async function sessionsDir(root: string): Promise<string> {
  const dir = path.join(await ensureAgentDir(root), SESSIONS)
  await mkdir(dir, { recursive: true })
  return dir
}

function readInfo(raw: unknown): AgentSessionInfo[] {
  if (!raw || typeof raw !== 'object') return []
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !ID_PATTERN.test(row.id)) return []
  if (typeof row.created !== 'string' || typeof row.updated !== 'string') return []
  const title = typeof row.title === 'string' && row.title.trim() ? row.title : TITLE
  return [{ id: row.id, created: row.created, updated: row.updated, title }]
}

function readContextFile(raw: unknown): AgentContextFile[] {
  if (!raw || typeof raw !== 'object') return []
  const row = raw as Record<string, unknown>
  if (typeof row.path !== 'string' || !row.path.trim() || row.path.length > 1000) return []
  const location = row.path.trim()
  const name = typeof row.name === 'string' && row.name.trim() ? row.name.trim().slice(0, 300) : path.basename(location)
  return [{ name, path: location }]
}

function editSessionFiles(
  files: AgentContextFile[],
  edit: SessionFileEdit
): { files: AgentContextFile[]; added: AgentContextFile[]; removed: string[] } {
  const removed: string[] = []
  const added: AgentContextFile[] = []
  let next = files.filter((file) => {
    const drop = edit.kind === 'drop' && (edit.tree ? underPath(file.path, edit.path) : samePath(file.path, edit.path))
    const move = edit.kind === 'relocate' && (edit.tree ? underPath(file.path, edit.from) : samePath(file.path, edit.from))
    if (!drop && !move) return true
    removed.push(file.path)
    if (edit.kind === 'relocate') {
      const rest = edit.tree ? relativeUnder(file.path, edit.from) : ''
      added.push(contextFile(rest ? `${slash(edit.to)}/${rest}` : edit.to))
    }
    return false
  })
  for (const file of added) {
    if (next.some((item) => samePath(item.path, file.path))) continue
    next.push(file)
  }
  if (edit.kind === 'add' || (edit.kind === 'relocate' && !edit.tree)) {
    const file = edit.kind === 'add' ? contextFile(edit.file.path, edit.file.name) : contextFile(edit.to)
    if (file.path && !next.some((item) => samePath(item.path, file.path))) {
      next.push(file)
      added.push(file)
    }
  }
  const fresh = added.filter((file) => next.some((item) => samePath(item.path, file.path)))
  return { files: next, added: fresh, removed }
}

function contextFile(location: string, name?: string): AgentContextFile {
  const pathName = location.trim()
  const base = pathName.split(/[\\/]/).pop() || pathName
  return { name: (name?.trim() || base).slice(0, 300), path: pathName }
}

function slash(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/+$/, '')
}

function underPath(file: string, prefix: string): boolean {
  const left = slash(file)
  const right = slash(prefix)
  return left === right || left.startsWith(`${right}/`)
}

function relativeUnder(file: string, prefix: string): string {
  const left = slash(file)
  const right = slash(prefix)
  if (left === right) return ''
  return left.slice(right.length + 1)
}

function samePath(left: string, right: string): boolean {
  return left.replace(/\\/g, '/') === right.replace(/\\/g, '/')
}

function readTurn(raw: unknown): AgentTurn[] {
  if (!raw || typeof raw !== 'object') return []
  const row = raw as Record<string, unknown>
  if ((row.role !== 'user' && row.role !== 'assistant') || typeof row.content !== 'string') return []
  const tools = Array.isArray(row.tools) ? row.tools.flatMap(readTrace) : undefined
  return [{ role: row.role, content: row.content, tools: tools && tools.length > 0 ? tools : undefined }]
}

function readTrace(raw: unknown): AgentTrace[] {
  if (!raw || typeof raw !== 'object') return []
  const row = raw as Record<string, unknown>
  if (row.kind === 'thought') {
    const text = typeof row.text === 'string' ? row.text.trim().slice(0, 40_000) : ''
    if (!text) return []
    const seconds = typeof row.seconds === 'number' && row.seconds > 0 ? Math.round(row.seconds) : 1
    return [{ kind: 'thought', seconds, text }]
  }
  if (typeof row.name !== 'string' || !row.name) return []
  const detail = typeof row.detail === 'string' ? row.detail.trim().slice(0, 200) : ''
  return [{ kind: 'tool', name: row.name, ok: row.ok === true, detail }]
}

function requireId(id: string): string {
  if (!ID_PATTERN.test(id)) throw new Error('Unknown session.')
  return id
}

function uniqueId(taken: string[]): string {
  const used = new Set(taken)
  let id = stampId(new Date())
  let extra = 0
  while (used.has(id)) {
    extra += 1
    id = `${stampId(new Date())}${String.fromCharCode(96 + extra)}`
  }
  return id
}

function stampId(date: Date): string {
  const pad = (value: number, width = 2): string => String(value).padStart(width, '0')
  return `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}T${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}-${pad(date.getMilliseconds(), 3)}`
}

function revisionKey(root: string, id: string): string {
  return `${path.resolve(root)}:${id}`
}

function bump(root: string, id: string): void {
  const key = revisionKey(root, id)
  revisions.set(key, (revisions.get(key) ?? 0) + 1)
}

function exclusive<T>(root: string, work: () => Promise<T>): Promise<T> {
  const key = path.resolve(root)
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(work, work)
  chains.set(key, run.then(() => undefined, () => undefined))
  return run
}
