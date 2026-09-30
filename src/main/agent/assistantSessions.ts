import { app } from 'electron'
import { mkdir, readFile, rm, writeFile } from 'fs/promises'
import path from 'path'
import type {
  AgentTrace,
  AssistantKind,
  AssistantSession,
  AssistantSessionInfo,
  AssistantSessionState,
  AssistantTurn,
  AssistantWhisperLine
} from '../../shared/types'

const INDEX = 'index.json'
const TITLE = 'New session'
const DOCUMENT = 'document.md'
const ID_PATTERN = /^\d{8}T\d{6}-\d{3}[a-z]?$/

type IndexFile = {
  active: string
  sessions: AssistantSessionInfo[]
}

const chains = new Map<string, Promise<unknown>>()

export function assistantRoot(): string {
  return path.join(app.getPath('userData'), 'assistant')
}

export async function listAssistantSessions(): Promise<AssistantSessionState> {
  return exclusive(() => openActive())
}

export async function readAssistantSession(id: string): Promise<AssistantSessionState> {
  const sessionId = requireId(id)
  return exclusive(async () => {
    const index = await loadIndex()
    if (!index.sessions.some((item) => item.id === sessionId)) throw new Error('Session not found.')
    index.active = sessionId
    await saveIndex(index)
    return stateFrom(index, sessionId)
  })
}

export async function createAssistantSession(): Promise<AssistantSessionState> {
  return exclusive(async () => {
    const index = await loadIndex()
    const session = emptySession(uniqueId(index.sessions.map((item) => item.id)), 'text')
    index.sessions.push(infoOf(session))
    index.active = session.id
    await writeSession(session)
    await writeFile(documentPath(session.id), '', 'utf8')
    await saveIndex(index)
    return { session, sessions: ordered(index.sessions), document: '' }
  })
}

export async function deleteAssistantSession(id: string): Promise<AssistantSessionState> {
  const sessionId = requireId(id)
  return exclusive(async () => {
    const index = await loadIndex()
    index.sessions = index.sessions.filter((item) => item.id !== sessionId)
    if (index.active === sessionId) index.active = index.sessions[0]?.id ?? ''
    await rm(sessionDir(sessionId), { recursive: true, force: true })
    await saveIndex(index)
    if (index.sessions.length === 0 || !index.sessions.some((item) => item.id === index.active)) return openActive()
    return stateFrom(index, index.active)
  })
}

export async function readAssistantDocument(id: string): Promise<string> {
  const sessionId = requireId(id)
  return exclusive(() => readDocument(sessionId))
}

export async function writeAssistantDocument(id: string, contents: string): Promise<void> {
  const sessionId = requireId(id)
  await exclusive(async () => {
    await mkdir(sessionDir(sessionId), { recursive: true })
    await writeFile(documentPath(sessionId), contents, 'utf8')
  })
}

export async function appendAssistantTurns(id: string, turns: AssistantTurn[]): Promise<void> {
  const sessionId = requireId(id)
  await exclusive(async () => {
    const index = await loadIndex()
    const session = await loadSession(sessionId)
    session.turns.push(...turns.filter((turn) => turn.content.trim().length > 0 || turn.role === 'assistant'))
    const firstUser = session.turns.find((turn) => turn.role === 'user' && turn.content.trim() && turn.content !== '…')
    if (session.title === TITLE && firstUser) session.title = titleFrom(firstUser.content)
    session.updated = new Date().toISOString()
    replaceInfo(index, session)
    await writeSession(session)
    await saveIndex(index)
  })
}

export async function appendAssistantHeard(id: string, text: string): Promise<void> {
  const line = text.trim()
  if (!line) return
  const sessionId = requireId(id)
  await exclusive(async () => {
    const session = await loadSession(sessionId)
    session.heard.push({ at: new Date().toISOString(), text: line.slice(0, 8_000) })
    session.updated = new Date().toISOString()
    await writeSession(session)
  })
}

export function documentFile(id: string): string {
  return documentPath(requireId(id))
}

async function openActive(): Promise<AssistantSessionState> {
  const index = await loadIndex()
  if (index.sessions.length === 0 || !index.sessions.some((item) => item.id === index.active)) {
    const session = emptySession(uniqueId(index.sessions.map((item) => item.id)), 'text')
    index.sessions.push(infoOf(session))
    index.active = session.id
    await writeSession(session)
    await writeFile(documentPath(session.id), '', 'utf8')
    await saveIndex(index)
    return { session, sessions: ordered(index.sessions), document: '' }
  }
  return stateFrom(index, index.active)
}

async function stateFrom(index: IndexFile, id: string): Promise<AssistantSessionState> {
  const session = await loadSession(id)
  return { session, sessions: ordered(index.sessions), document: await readDocument(id) }
}

function emptySession(id: string, kind: AssistantKind): AssistantSession {
  const now = new Date().toISOString()
  return { id, created: now, updated: now, title: TITLE, kind, turns: [], heard: [] }
}

function infoOf(session: AssistantSession): AssistantSessionInfo {
  return { id: session.id, created: session.created, updated: session.updated, title: session.title, kind: session.kind }
}

function replaceInfo(index: IndexFile, session: AssistantSession): void {
  const info = infoOf(session)
  const at = index.sessions.findIndex((item) => item.id === session.id)
  if (at === -1) index.sessions.push(info)
  else index.sessions[at] = info
}

function ordered(sessions: AssistantSessionInfo[]): AssistantSessionInfo[] {
  return [...sessions].sort((a, b) => b.created.localeCompare(a.created))
}

function titleFrom(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? TITLE
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

async function loadIndex(): Promise<IndexFile> {
  const dir = await rootDir()
  try {
    const parsed = JSON.parse(await readFile(path.join(dir, INDEX), 'utf8')) as Partial<IndexFile>
    const sessions = Array.isArray(parsed.sessions) ? parsed.sessions.flatMap(readInfo) : []
    const active = typeof parsed.active === 'string' ? parsed.active : ''
    return { active, sessions }
  } catch {
    return { active: '', sessions: [] }
  }
}

async function saveIndex(index: IndexFile): Promise<void> {
  const dir = await rootDir()
  await writeFile(path.join(dir, INDEX), JSON.stringify(index, null, 2), 'utf8')
}

async function loadSession(id: string): Promise<AssistantSession> {
  const file = path.join(sessionDir(id), 'session.json')
  try {
    const parsed = JSON.parse(await readFile(file, 'utf8')) as Partial<AssistantSession>
    const kind: AssistantKind = parsed.kind === 'voice' ? 'voice' : 'text'
    return {
      id,
      created: typeof parsed.created === 'string' ? parsed.created : new Date().toISOString(),
      updated: typeof parsed.updated === 'string' ? parsed.updated : new Date().toISOString(),
      title: typeof parsed.title === 'string' && parsed.title.trim() ? parsed.title : TITLE,
      kind,
      turns: Array.isArray(parsed.turns) ? parsed.turns.flatMap(readTurn) : [],
      heard: Array.isArray(parsed.heard) ? parsed.heard.flatMap(readHeard) : []
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : ''
    if (code === 'ENOENT') throw new Error('Session not found.')
    return emptySession(id, 'text')
  }
}

async function writeSession(session: AssistantSession): Promise<void> {
  await mkdir(sessionDir(session.id), { recursive: true })
  await writeFile(path.join(sessionDir(session.id), 'session.json'), JSON.stringify(session, null, 2), 'utf8')
}

async function readDocument(id: string): Promise<string> {
  try {
    return await readFile(documentPath(id), 'utf8')
  } catch {
    return ''
  }
}

async function rootDir(): Promise<string> {
  const dir = assistantRoot()
  await mkdir(dir, { recursive: true })
  return dir
}

function sessionDir(id: string): string {
  return path.join(assistantRoot(), id)
}

function documentPath(id: string): string {
  return path.join(sessionDir(id), DOCUMENT)
}

function readInfo(raw: unknown): AssistantSessionInfo[] {
  if (!raw || typeof raw !== 'object') return []
  const row = raw as Record<string, unknown>
  if (typeof row.id !== 'string' || !ID_PATTERN.test(row.id)) return []
  if (typeof row.created !== 'string' || typeof row.updated !== 'string') return []
  const title = typeof row.title === 'string' && row.title.trim() ? row.title : TITLE
  const kind: AssistantKind = row.kind === 'voice' ? 'voice' : 'text'
  return [{ id: row.id, created: row.created, updated: row.updated, title, kind }]
}

function readTurn(raw: unknown): AssistantTurn[] {
  if (!raw || typeof raw !== 'object') return []
  const row = raw as Record<string, unknown>
  if ((row.role !== 'user' && row.role !== 'assistant') || typeof row.content !== 'string') return []
  const tools = Array.isArray(row.tools) ? row.tools.flatMap(readTrace) : undefined
  return [{ role: row.role, content: row.content, tools: tools && tools.length > 0 ? tools : undefined }]
}

function readHeard(raw: unknown): AssistantWhisperLine[] {
  if (!raw || typeof raw !== 'object') return []
  const row = raw as Record<string, unknown>
  if (typeof row.text !== 'string' || !row.text.trim()) return []
  const at = typeof row.at === 'string' ? row.at : new Date().toISOString()
  return [{ at, text: row.text.trim().slice(0, 8_000) }]
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

function exclusive<T>(work: () => Promise<T>): Promise<T> {
  const key = assistantRoot()
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(work, work)
  chains.set(key, run.then(() => undefined, () => undefined))
  return run
}
