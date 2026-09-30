import path from 'path'
import type { AgentTrace, AssistantEvent, AssistantSettings, AssistantTalkResult } from '../../shared/types'
import { contextLimit } from './budget'
import { chat, releaseGpu, warmModel, type ChatMessage } from './ollama'
import { assistantInstructions, voiceSystem } from './assistantPrompt'
import {
  appendAssistantHeard,
  appendAssistantTurns,
  documentFile,
  readAssistantDocument,
  readAssistantSession
} from './assistantSessions'
import { AssistantTools } from './assistantTools'
import { transcribeWav } from './voice'
import { closeVoice, prepareVoice, voicePrepared, voiceTurn } from './voicechat'

const TEXT_STEPS = 20
const WORKER_STEPS = 12

const runs = new Map<number, AbortController>()

export function beginAssistant(id: number): AbortSignal {
  const previous = runs.get(id)
  if (previous) {
    previous.abort()
    closeVoice()
  }
  const controller = new AbortController()
  runs.set(id, controller)
  return controller.signal
}

export function stopAssistant(id: number): void {
  runs.get(id)?.abort()
  closeVoice()
}

export function endAssistant(id: number, signal: AbortSignal): void {
  const current = runs.get(id)
  if (current?.signal === signal) runs.delete(id)
}

export async function prepareAssistantVoice(id: string, settings: AssistantSettings, signal: AbortSignal): Promise<void> {
  const state = await readAssistantSession(id)
  if (state.session.kind !== 'voice') return
  const starting = !voicePrepared(state.session.id)
  if (starting) await releaseGpu(null)
  const system = voiceSystem(recap(state.session.turns), settings.extra)
  await prepareVoice(state.session.id, system, signal)
  if (!starting) return
  try {
    await warmModel(settings.worker, signal)
  } catch {
    // The voice can still talk. A missing worker is reported when work is requested.
  }
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
  if (state.session.kind !== 'text') throw new Error('This session listens by voice.')
  const dir = path.dirname(documentFile(state.session.id))
  const tools = new AssistantTools(dir, true)
  tools.signal = signal
  const answer = await loop(
    tools,
    assistantInstructions('text', settings.extra),
    task,
    state.session.turns.map((turn) => ({ role: turn.role, content: turn.content })),
    settings.model,
    settings.think,
    TEXT_STEPS,
    false,
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

export async function runTalk(
  id: string,
  wav: Buffer,
  settings: AssistantSettings,
  emit: (event: AssistantEvent) => void,
  signal: AbortSignal
): Promise<AssistantTalkResult> {
  const state = await readAssistantSession(id)
  if (state.session.kind !== 'voice') throw new Error('This session is typed.')
  await prepareAssistantVoice(state.session.id, settings, signal)
  const priorHeard = state.session.heard.map((line) => line.text)
  let transcript = ''
  const heard = transcribeWav(wav).then((text) => {
    transcript = text.trim()
    if (transcript) emit({ type: 'heard', text: transcript })
    return transcript
  }).catch(() => '')
  let spoken = ''
  emit({ type: 'clear-content' })
  const turn = await voiceTurn(wav, (delta) => {
    spoken += delta
    emit({ type: 'token', channel: 'content', text: delta })
  }, async (task) => {
    emit({ type: 'status', text: 'Working' })
    const said = await heard
    const lines = [...priorHeard, said].filter((line) => line.trim()).slice(-8)
    const brief = [
      'What the user said:',
      lines.length > 0 ? lines.map((line) => `- ${line}`).join('\n') : '(no transcript)',
      '',
      'The voice model thinks the task is:',
      task.trim() || '(no task)',
      '',
      'Do the work. Put the lasting result in the document. Reply with two or three sentences that can be spoken aloud.'
    ].join('\n')
    const dir = path.dirname(documentFile(state.session.id))
    const tools = new AssistantTools(dir, false)
    tools.signal = signal
    try {
      const answer = await loop(
        tools,
        assistantInstructions('worker', settings.extra),
        brief,
        [],
        settings.worker,
        false,
        WORKER_STEPS,
        true,
        state.session.id,
        emit,
        signal
      )
      emit({ type: 'status', text: '' })
      return spokenSummary(answer)
    } catch (error) {
      if (signal.aborted) throw error
      emit({ type: 'status', text: '' })
      return 'I could not reach the worker model.'
    }
  }, signal)
  const said = transcript || await heard
  if (said) await appendAssistantHeard(state.session.id, said)
  const reply = turn.text.trim() || spoken.trim()
  await appendAssistantTurns(state.session.id, [
    { role: 'user', content: said || '…' },
    { role: 'assistant', content: reply || '…' }
  ])
  emit({ type: 'done', text: reply })
  return { text: reply, audio: turn.audio }
}

async function loop(
  tools: AssistantTools,
  instructions: string,
  task: string,
  prior: Array<{ role: 'user' | 'assistant'; content: string }>,
  model: string,
  think: boolean,
  maxSteps: number,
  quietTools: boolean,
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
  for (let step = 1; step <= maxSteps; step += 1) {
    if (signal.aborted) throw new Error('Stopped.')
    if (!quietTools) emit({ type: 'clear-content' })
    emit({ type: 'status', text: `Step ${step}` })
    const message = await chat(messages, {
      model,
      tools: schemas,
      think,
      temperature: 0.3,
      numCtx: quietTools ? 4096 : limit > 0 ? Math.min(limit, 8192) : 8192,
      keepAlive: -1,
      signal,
      onToken: quietTools ? undefined : (channel, text) => emit({ type: 'token', channel, text })
    })
    messages.push(message)
    if (message.thinking?.trim()) {
      const text = message.thinking.trim().slice(0, 40_000)
      traces.push({ kind: 'thought', seconds: message.thinkingSeconds || 1, text })
      emit({ type: 'thought', seconds: message.thinkingSeconds || 1, text })
    }
    const calls = message.tool_calls ?? []
    if (calls.length === 0) {
      answer = message.content.trim() || 'I do not have a reply.'
      break
    }
    for (const call of calls) {
      if (signal.aborted) throw new Error('Stopped.')
      const name = call.function.name
      const detail = detailOf(name, call.function.arguments)
      emit({ type: 'status', text: labelOf(name, detail) })
      const result = await tools.execute(name, call.function.arguments)
      const ok = result.result.ok === true
      if (!quietTools) {
        traces.push({ kind: 'tool', name, ok, detail })
        emit({ type: 'tool', name, ok, detail })
      }
      if (result.changed) emit({ type: 'document', text: await readAssistantDocument(sessionId) })
      messages.push({ role: 'tool', tool_name: name, content: JSON.stringify(result.result) })
    }
    answer = ''
  }
  if (!answer) answer = `Stopped after ${maxSteps} steps.`
  return answer
}

function lastTraces(emit: (event: AssistantEvent) => void): AgentTrace[] {
  return traceLog.get(emit) ?? []
}

function spokenSummary(text: string): string {
  const plain = text
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/[#>*_`[\]]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
  const sentences = plain.split(/(?<=[.!?])\s+/).filter(Boolean).slice(0, 3)
  const joined = (sentences.length > 0 ? sentences.join(' ') : plain).slice(0, 500).trim()
  return joined || 'I updated the document.'
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

function recap(turns: Array<{ role: string; content: string }>): string {
  return turns.slice(-4).map((turn) => turn.content.trim().split('\n')[0] ?? '').filter(Boolean).join(' ')
}
