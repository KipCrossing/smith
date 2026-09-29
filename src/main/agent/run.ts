import type { AgentEvent, AgentPromptSettings, AgentRequest, AgentResult, AgentTrace } from '../../shared/types'
import { record } from './history'
import type { ChatMessage } from './ollama'
import { chat } from './ollama'
import { contextLimit, instructionText, measureContext, notePromptUsage, tokenCount } from './budget'
import { contextPrompt } from './context'
import { projectPrompt, refreshProjectIndex } from './projectIndex'
import { stat } from 'fs/promises'
import { appendSessionTurns, applySessionFileEdits, beginSessionWrite, readSessionFiles, readTurns, type SessionFileEdit } from './sessions'
import { Toolset, openWorkspace, type Workspace } from './tools'

const MAX_STEPS = 50

type Emit = (event: AgentEvent) => void

const runs = new Map<number, AbortController>()

export function beginRun(id: number): AbortSignal {
  runs.get(id)?.abort()
  const controller = new AbortController()
  runs.set(id, controller)
  return controller.signal
}

export function stopRun(id: number): void {
  runs.get(id)?.abort()
}

export function endRun(id: number): void {
  runs.delete(id)
}

export async function runAgent(request: AgentRequest, emit: Emit, signal: AbortSignal): Promise<AgentResult> {
  const task = request.text.trim()
  if (!request.project) {
    const error = 'Open a folder before messaging the agent.'
    emit({ type: 'error', text: error })
    return { text: '', error }
  }
  if (!task) {
    const error = 'Message is empty.'
    emit({ type: 'error', text: error })
    return { text: '', error }
  }
  try {
    const workspace = await openWorkspace(request.project)
    const tools = new Toolset(workspace)
    tools.signal = signal
    const revision = beginSessionWrite(workspace.root, request.session)
    const prior = await readTurns(request.project, request.session)
    const loaded = await readSessionFiles(request.project, request.session)
    const context = await contextPrompt(workspace, loaded)
    await refreshProjectIndex(workspace.root).catch(() => undefined)
    const project = await projectPrompt(workspace.root, [request.focus, request.file]).catch(() => '')
    const voice = promptVoice(request)
    const text = await loop(tools, task, request.model.trim(), request.session, revision, prior, project, context, request.think, voice, emit, signal)
    return { text, error: null }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    emit({ type: 'error', text: message })
    return { text: '', error: message }
  } finally {
    await publishContext(request.project, request.session, request.model.trim(), request.focus, promptVoice(request), emit)
  }
}

function promptVoice(request: AgentRequest): AgentPromptSettings {
  return { extra: request.extra, caveman: request.caveman }
}

async function publishContext(
  project: string,
  session: string,
  model: string,
  focus: string | null,
  voice: AgentPromptSettings,
  emit: Emit
): Promise<void> {
  if (!project || !session || !model) return
  try {
    emit({ type: 'context', budget: await measureContext(project, session, model, focus, voice) })
  } catch {
    // The reply is already done. A failed recount should not change it.
  }
}

async function loop(
  tools: Toolset,
  task: string,
  model: string,
  session: string,
  revision: number,
  prior: { role: 'user' | 'assistant'; content: string }[],
  project: string,
  context: string,
  think: boolean,
  voice: AgentPromptSettings,
  emit: Emit,
  signal: AbortSignal
): Promise<string> {
  const instructions = instructionText(tools.workspace.root, prior.length > 0, voice)
  const system = [instructions, project, context].filter((part) => part.trim()).join('\n\n')
  const messages: ChatMessage[] = [
    { role: 'system', content: system },
    ...prior.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: task }
  ]
  const schemas = tools.schemas()
  const toolLog: AgentTrace[] = []
  const limit = await contextLimit(model)
  let previousPrompt = 0
  let answer = ''

  for (let step = 1; step <= MAX_STEPS; step += 1) {
    if (signal.aborted) return stopped(emit)
    emit({ type: 'step', index: step, total: MAX_STEPS })
    emit({ type: 'clear-content' })
    emit({ type: 'status', text: stepStatus(step, 0) })
    const fitted = fitForWindow(messages, schemas, model, limit)
    if (fitted.trimmed) emit({ type: 'status', text: stepStatus(step, 0, 'trimmed earlier results') })
    let stepTokens = 0
    let message: ChatMessage
    try {
      message = await chat(fitted.messages, {
        model,
        tools: schemas,
        think,
        temperature: 0.2,
        numCtx: limit > 0 ? limit : undefined,
        signal,
        onToken: (channel, text) => emit({ type: 'token', channel, text }),
        onUsage: (promptTokens) => {
          stepTokens = promptTokens
          notePromptUsage(model, promptCharacters(fitted.messages, schemas), promptTokens)
        }
      })
    } catch (error) {
      if (signal.aborted) return stopped(emit)
      const message = error instanceof Error ? error.message : String(error)
      await persist(tools.workspace.root, session, revision, task, message, toolLog)
      throw error
    }
    if (stepTokens > 0) {
      const added = previousPrompt > 0 ? Math.max(0, stepTokens - previousPrompt) : 0
      previousPrompt = stepTokens
      toolLog.push({ kind: 'context', step, tokens: stepTokens, added })
      emit({ type: 'loop-context', step, tokens: stepTokens, added, limit })
      emit({ type: 'status', text: stepStatus(step, stepTokens) })
    }
    if (signal.aborted) return stopped(emit)
    messages.push(message)
    noteThought(message, toolLog, emit)
    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      answer = message.content.trim() || '(no response)'
      break
    }
    for (const call of calls) {
      if (signal.aborted) return stopped(emit)
      const name = call.function.name
      const detail = toolDetail(name, call.function.arguments)
      emit({ type: 'status', text: stepStatus(step, stepTokens, name) })
      const result = await tools.execute(name, call.function.arguments)
      if (signal.aborted) return stopped(emit)
      const ok = result.result.ok === true
      toolLog.push({ kind: 'tool', name, ok, detail })
      emit({ type: 'tool', name, ok, detail })
      for (const changed of result.changed) emit({ type: 'file-changed', path: changed })
      if (ok) await trackSessionFiles(tools.workspace, session, revision, name, result.result, emit)
      messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result.result) })
    }
    answer = ''
  }

  if (!answer) {
    answer = `Stopped after ${MAX_STEPS} steps.`
    emit({ type: 'status', text: answer })
  }
  await persist(tools.workspace.root, session, revision, task, answer, toolLog)
  emit({ type: 'status', text: '' })
  emit({ type: 'done', text: answer })
  return answer
}

async function trackSessionFiles(
  workspace: Workspace,
  session: string,
  revision: number,
  name: string,
  result: Record<string, unknown>,
  emit: Emit
): Promise<void> {
  const edit = await sessionEdit(workspace, name, result)
  if (!edit) return
  try {
    const change = await applySessionFileEdits(workspace.root, session, revision, edit)
    if (!change || (change.added.length === 0 && change.removed.length === 0)) return
    emit({ type: 'session-files', added: change.added, removed: change.removed })
  } catch {
    // The file is already edited. A failed session update should not stop the loop.
  }
}

async function sessionEdit(workspace: Workspace, name: string, result: Record<string, unknown>): Promise<SessionFileEdit | null> {
  if ((name === 'edit_file' || name === 'write_file') && typeof result.path === 'string' && result.path.trim()) {
    const location = result.path.trim()
    return { kind: 'add', file: { name: location.split(/[\\/]/).pop() || location, path: location } }
  }
  if (name === 'delete_file' && typeof result.deleted === 'string' && result.deleted.trim()) {
    return { kind: 'drop', path: result.deleted.trim(), tree: result.kind === 'directory' }
  }
  if (name === 'move_file' && typeof result.moved_from === 'string' && typeof result.moved_to === 'string') {
    const from = result.moved_from.trim()
    const to = result.moved_to.trim()
    if (!from || !to) return null
    return { kind: 'relocate', from, to, tree: await directoryAt(workspace, to) }
  }
  return null
}

async function directoryAt(workspace: Workspace, relative: string): Promise<boolean> {
  try {
    const info = await stat(await workspace.resolve(relative))
    return info.isDirectory()
  } catch {
    return false
  }
}

async function persist(
  root: string,
  session: string,
  revision: number,
  task: string,
  answer: string,
  tools: AgentTrace[]
): Promise<void> {
  try {
    await record(root, task, answer)
  } catch {
    // history.md is a readable log. A failed write should not hide the answer.
  }
  try {
    await appendSessionTurns(root, session, [
      { role: 'user', content: task },
      { role: 'assistant', content: answer, tools }
    ], revision)
  } catch {
    // The reply is already on screen. A failed session write should not hide it.
  }
}

const THOUGHT_LIMIT = 40_000

function noteThought(message: ChatMessage, toolLog: AgentTrace[], emit: Emit): void {
  const text = message.thinking?.trim()
  if (!text) return
  const clipped = text.length > THOUGHT_LIMIT ? `${text.slice(0, THOUGHT_LIMIT)}…` : text
  const seconds = message.thinkingSeconds && message.thinkingSeconds > 0 ? message.thinkingSeconds : 1
  toolLog.push({ kind: 'thought', seconds, text: clipped })
  emit({ type: 'thought', seconds, text: clipped })
}

export function toolDetail(name: string, args: Record<string, unknown> | undefined): string {
  const value = (key: string): string => {
    const raw = args?.[key]
    return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  }
  const line = (key: string): number | null => {
    const raw = args?.[key]
    return typeof raw === 'number' && Number.isFinite(raw) ? raw : null
  }
  const file = (key: string): string => baseName(value(key))
  if (name === 'read_file') {
    const pathName = file('path')
    const start = line('start_line')
    const end = line('end_line')
    if (start && end && end !== start) return clipDetail(`${pathName} L${start}-${end}`)
    if (start) return clipDetail(`${pathName} L${start}`)
    return clipDetail(pathName)
  }
  if (name === 'grep') {
    const pattern = value('pattern')
    const glob = value('glob')
    return clipDetail(glob ? `${pattern} in ${glob}` : pattern)
  }
  if (name === 'list_files') {
    const glob = value('glob') || '*'
    const pathName = value('path')
    return clipDetail(pathName && pathName !== '.' ? `${glob} in ${baseName(pathName)}` : glob)
  }
  if (name === 'edit_file') {
    const pathName = file('path')
    const edits = Array.isArray(args?.edits) ? args.edits.length : 0
    return clipDetail(edits > 1 ? `${pathName} · ${edits} edits` : pathName)
  }
  if (name === 'write_file' || name === 'delete_file') return clipDetail(file('path'))
  if (name === 'move_file') return clipDetail(`${file('source')} → ${file('destination')}`)
  if (name === 'run_command') return clipDetail(value('command'))
  if (name === 'web_search') return clipDetail(value('query'))
  if (name === 'fetch_url') return clipDetail(value('url'))
  return ''
}

function baseName(location: string): string {
  return location.split(/[\\/]/).pop() || location
}

function clipDetail(text: string): string {
  const clean = text.trim()
  return clean.length > 160 ? `${clean.slice(0, 159)}…` : clean
}

function stepStatus(step: number, tokens: number, detail?: string): string {
  const head = `Step ${step} of ${MAX_STEPS}`
  const sized = tokens > 0 ? `${head} · ${tokens.toLocaleString('en-US')} tokens` : head
  return detail ? `${sized} · ${detail}` : sized
}

const REPLY_RESERVE = 4096

function fitForWindow(
  messages: ChatMessage[],
  schemas: unknown,
  model: string,
  limit: number
): { messages: ChatMessage[]; trimmed: boolean } {
  const copy = messages.map((message) => ({ ...message }))
  for (const message of copy) delete message.thinkingSeconds
  if (limit <= 0) return { messages: copy, trimmed: false }
  const budget = Math.max(1024, limit - REPLY_RESERVE)
  if (messageTokens(copy, schemas, model) <= budget) return { messages: copy, trimmed: false }

  let trimmed = false
  const lastAssistant = findLastIndex(copy, (message) => message.role === 'assistant')
  for (let index = 0; index < copy.length; index += 1) {
    if (copy[index].role !== 'assistant' || index === lastAssistant || !copy[index].thinking) continue
    delete copy[index].thinking
    trimmed = true
  }
  if (messageTokens(copy, schemas, model) <= budget) return { messages: copy, trimmed }

  const recentTools = latestToolIndexes(copy)
  for (const index of toolIndexes(copy)) {
    if (recentTools.has(index) || messageTokens(copy, schemas, model) <= budget) continue
    if (copy[index].content.startsWith('(earlier result omitted')) continue
    copy[index].content = '(earlier result omitted to fit the context window)'
    trimmed = true
  }
  for (const max of [8000, 4000, 2000, 800]) {
    if (messageTokens(copy, schemas, model) <= budget) break
    for (const index of toolIndexes(copy)) {
      if (messageTokens(copy, schemas, model) <= budget) break
      if (copy[index].content.length <= max) continue
      copy[index].content = `${copy[index].content.slice(0, max)}\n…(trimmed to fit the context window)`
      trimmed = true
    }
  }
  while (messageTokens(copy, schemas, model) > budget) {
    if (!dropOldestExchange(copy)) break
    trimmed = true
  }
  return { messages: copy, trimmed }
}

function messageTokens(messages: ChatMessage[], schemas: unknown, model: string): number {
  const chars = promptCharacters(messages, schemas)
  if (chars <= 0) return 0
  return tokenCount('x'.repeat(chars), model).tokens
}

function toolIndexes(messages: ChatMessage[]): number[] {
  const indexes: number[] = []
  messages.forEach((message, index) => {
    if (message.role === 'tool') indexes.push(index)
  })
  return indexes
}

function latestToolIndexes(messages: ChatMessage[]): Set<number> {
  const kept = new Set<number>()
  let start = -1
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (messages[index].role === 'assistant') {
      start = index + 1
      break
    }
  }
  if (start < 0) return kept
  for (let index = start; index < messages.length; index += 1) {
    if (messages[index].role === 'tool') kept.add(index)
  }
  return kept
}

function dropOldestExchange(messages: ChatMessage[]): boolean {
  let first = -1
  let last = -1
  messages.forEach((message, index) => {
    if (message.role !== 'assistant') return
    if (first < 0) first = index
    last = index
  })
  if (first < 0 || first === last) return false
  let end = first + 1
  while (end < messages.length && messages[end].role === 'tool') end += 1
  if (messages.slice(first, end).some((message) => message.role === 'user' || message.role === 'system')) return false
  messages.splice(first, end - first)
  return true
}

function findLastIndex(messages: ChatMessage[], match: (message: ChatMessage) => boolean): number {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    if (match(messages[index])) return index
  }
  return -1
}

function promptCharacters(messages: ChatMessage[], schemas: unknown): number {
  let chars = JSON.stringify(schemas).length
  for (const message of messages) {
    chars += message.content.length
    if (message.thinking) chars += message.thinking.length
    if (message.tool_name) chars += message.tool_name.length
    if (message.tool_calls) chars += JSON.stringify(message.tool_calls).length
  }
  return chars
}

function stopped(emit: Emit): string {
  const text = 'Stopped.'
  emit({ type: 'status', text: '' })
  emit({ type: 'done', text })
  return text
}
