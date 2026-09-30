import path from 'path'
import type { AgentTrace, AssistantEvent, AssistantSettings } from '../../shared/types'
import { contextLimit } from './budget'
import { chat, type ChatMessage } from './ollama'
import { assistantInstructions } from './assistantPrompt'
import {
  appendAssistantTurns,
  documentFile,
  readAssistantDocument,
  readAssistantSession
} from './assistantSessions'
import { AssistantTools } from './assistantTools'

const TEXT_STEPS = 20

const runs = new Map<number, AbortController>()

export function beginAssistant(id: number): AbortSignal {
  const previous = runs.get(id)
  if (previous) previous.abort()
  const controller = new AbortController()
  runs.set(id, controller)
  return controller.signal
}

export function stopAssistant(id: number): void {
  runs.get(id)?.abort()
}

export function endAssistant(id: number, signal: AbortSignal): void {
  const current = runs.get(id)
  if (current?.signal === signal) runs.delete(id)
}

export async function runAssistant(
  id: string,
  text: string,
  settings: AssistantSettings,
  emit: (event: AssistantEvent) => void,
  signal: AbortSignal
): Promise<string> {
  const task = text.trim()
  if (!task) throw new Error('Message is empty.')
  const state = await readAssistantSession(id)
  const dir = path.dirname(documentFile(state.session.id))
  const tools = new AssistantTools(dir, true)
  tools.signal = signal
  const answer = await loop(
    tools,
    assistantInstructions(settings.extra),
    task,
    state.session.turns.map((turn) => ({ role: turn.role, content: turn.content })),
    settings.model,
    settings.think,
    TEXT_STEPS,
    state.session.id,
    emit,
    signal
  )
  const traces = lastTraces(emit)
  await appendAssistantTurns(state.session.id, [
    { role: 'user', content: task },
    { role: 'assistant', content: answer, tools: traces.length > 0 ? traces : undefined }
  ])
  emit({ type: 'done', text: answer })
  return answer
}

const traceLog = new WeakMap<object, AgentTrace[]>()

async function loop(
  tools: AssistantTools,
  instructions: string,
  task: string,
  prior: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  think: boolean,
  maxSteps: number,
  sessionId: string,
  emit: (event: AssistantEvent) => void,
  signal: AbortSignal
): Promise<string> {
  const messages: ChatMessage[] = [
    { role: 'system', content: instructions },
    ...prior.map((turn) => ({ role: turn.role, content: turn.content })),
    { role: 'user', content: task }
  ]
  const schemas = tools.schemas()
  const traces: AgentTrace[] = []
  traceLog.set(emit, traces)
  const limit = await contextLimit(model).catch(() => 0)
  let answer = ''
  let plainTools = false
  for (let step = 1; step <= maxSteps; step += 1) {
    if (signal.aborted) throw new Error('Stopped.')
    emit({ type: 'clear-content' })
    emit({ type: 'status', text: `Step ${step}` })
    let message: ChatMessage
    try {
      message = await chat(messages, {
        model,
        tools: plainTools ? undefined : schemas,
        think,
        temperature: 0.3,
        numCtx: limit > 0 ? Math.min(limit, 8192) : 8192,
        keepAlive: -1,
        signal,
        onToken: (channel, text) => emit({ type: 'token', channel, text })
      })
    } catch (error) {
      if (!plainTools && noToolSupport(error)) {
        plainTools = true
        messages[0] = { role: 'system', content: `${instructions}\n\n${plainToolGuide(schemas)}` }
        step -= 1
        continue
      }
      throw error
    }
    if (message.thinking?.trim()) {
      const text = message.thinking.trim().slice(0, 40_000)
      traces.push({ kind: 'thought', seconds: message.thinkingSeconds || 1, text })
      emit({ type: 'thought', seconds: message.thinkingSeconds || 1, text })
    }
    const calls = plainTools ? textToolCalls(message.content) : (message.tool_calls ?? []).map((call) => call.function)
    if (calls.length === 0) {
      answer = message.content.trim() || 'I do not have a reply.'
      break
    }
    messages.push(message)
    for (const call of calls) {
      if (signal.aborted) throw new Error('Stopped.')
      const name = call.name
      const detail = detailOf(name, call.arguments)
      emit({ type: 'status', text: labelOf(name, detail) })
      const result = await tools.execute(name, call.arguments)
      const ok = result.result.ok === true
      traces.push({ kind: 'tool', name, ok, detail })
      emit({ type: 'tool', name, ok, detail })
      if (result.changed) emit({ type: 'document', text: await readAssistantDocument(sessionId) })
      const payload = clipResult(result.result)
      if (plainTools) messages.push({ role: 'user', content: `Result of ${name}:\n${payload}` })
      else messages.push({ role: 'tool', tool_name: name, content: payload })
    }
    answer = ''
  }
  if (!answer) answer = `Stopped after ${maxSteps} steps.`
  return answer
}

function lastTraces(emit: (event: AssistantEvent) => void): AgentTrace[] {
  return traceLog.get(emit) ?? []
}

function noToolSupport(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error)
  return /does not support tools/i.test(message)
}

function plainToolGuide(schemas: ReturnType<AssistantTools['schemas']>): string {
  const lines = schemas.map((tool) => `- ${tool.function.name}: ${tool.function.description}`)
  return [
    'This model has no tool-calling API. To use a tool, reply with one JSON object and no other text:',
    '{"tool":"tool_name","arguments":{}}',
    'Tools:',
    ...lines,
    'When the work is done, reply in plain sentences and no JSON.'
  ].join('\n')
}

function textToolCalls(content: string): Array<{ name: string; arguments: Record<string, unknown> }> {
  const trimmed = content.trim().replace(/^```(?:json)?\s*/i, '').replace(/```$/i, '').trim()
  const start = trimmed.indexOf('{')
  const end = trimmed.lastIndexOf('}')
  if (start < 0 || end <= start) return []
  const outside = `${trimmed.slice(0, start)}${trimmed.slice(end + 1)}`.replace(/```/g, '').trim()
  if (outside.length > 40) return []
  try {
    const body = JSON.parse(trimmed.slice(start, end + 1)) as Record<string, unknown>
    const name = typeof body.tool === 'string' ? body.tool : ''
    const args = body.arguments
    if (!name || !args || typeof args !== 'object' || Array.isArray(args)) return []
    return [{ name, arguments: args as Record<string, unknown> }]
  } catch {
    return []
  }
}

function clipResult(result: Record<string, unknown>): string {
  const text = JSON.stringify(result)
  return text.length > 2500 ? `${text.slice(0, 2500)}…` : text
}

function detailOf(name: string, args: Record<string, unknown> | undefined): string {
  const value = (key: string): string => {
    const raw = args?.[key]
    return typeof raw === 'string' ? raw.trim().replace(/\s+/g, ' ') : ''
  }
  if (name === 'web_search') return clip(value('query'))
  if (name === 'fetch_url') return clip(value('url'))
  if (name === 'append_document') return 'Add to the document'
  if (name === 'replace_document') return 'Rewrite the document'
  if (name === 'edit_document') return 'Edit the document'
  if (name === 'read_document') return 'Read the document'
  return ''
}

function labelOf(name: string, detail: string): string {
  const names: Record<string, string> = {
    web_search: 'Searching',
    fetch_url: 'Reading a page',
    read_document: 'Reading the document',
    edit_document: 'Editing the document',
    append_document: 'Adding to the document',
    replace_document: 'Rewriting the document'
  }
  const label = names[name] ?? name
  return detail ? `${label} · ${detail}` : label
}

function clip(text: string): string {
  return text.length > 160 ? `${text.slice(0, 159)}…` : text
}
