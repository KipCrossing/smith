import { DEFAULT_AGENT_MODEL, type InstalledModel } from '../../shared/types'

const DEFAULT_HOST = 'http://localhost:11434'
const TIMEOUT_MS = 600_000

export type Channel = 'thinking' | 'content'

export interface ToolCall {
  function: {
    name: string
    arguments: Record<string, unknown>
  }
}

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
  thinking?: string
  thinkingSeconds?: number
  tool_calls?: ToolCall[]
  tool_name?: string
}

export interface ToolSchema {
  type: 'function'
  function: {
    name: string
    description: string
    parameters: Record<string, unknown>
  }
}

export interface PromptOptions {
  model?: string
  system?: string
  history?: ChatMessage[]
  tools?: ToolSchema[]
  think?: boolean
  temperature?: number
  numCtx?: number
  onToken?: (channel: Channel, text: string) => void
  onUsage?: (promptTokens: number) => void
  signal?: AbortSignal
}

interface StreamLine {
  message?: {
    content?: string
    thinking?: string
    tool_calls?: Array<{
      function?: { name?: string; arguments?: unknown }
    }>
  }
  done?: boolean
  error?: string
  prompt_eval_count?: number
}

export function ollamaHost(): string {
  return (process.env.OLLAMA_HOST || DEFAULT_HOST).replace(/\/$/, '')
}

export interface PullProgress {
  model: string
  status: string
  completed: number
  total: number
}

interface PullLine {
  status?: string
  digest?: string
  total?: number
  completed?: number
  error?: string
}

const MODEL_NAME = /^[A-Za-z0-9][A-Za-z0-9._:/-]{0,200}$/

export async function pullModel(
  name: string,
  onProgress: (progress: PullProgress) => void,
  signal?: AbortSignal
): Promise<string> {
  const model = name.trim()
  if (!MODEL_NAME.test(model)) throw new Error('Enter a model name such as qwen2.5-coder:7b.')
  const host = ollamaHost()
  let response: Response
  try {
    response = await fetch(`${host}/api/pull`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model, stream: true }),
      signal
    })
  } catch (error) {
    if (signal?.aborted) throw new Error('Download cancelled.')
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not reach Ollama at ${host} (${reason}).`)
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new Error(`Ollama returned ${response.status}${detail ? `: ${detail}` : ''}.`)
  }
  if (!response.body) throw new Error('Ollama returned an empty response.')

  const layers = new Map<string, { completed: number; total: number }>()
  let status = 'Starting download'
  let sawSuccess = false
  let lastSent = 0
  let sentStatus = ''
  const report = (force: boolean): void => {
    const now = Date.now()
    const statusChanged = status !== sentStatus
    if (!force && !statusChanged && now - lastSent < 120) return
    lastSent = now
    sentStatus = status
    let completed = 0
    let total = 0
    for (const layer of layers.values()) {
      completed += layer.completed
      total += layer.total
    }
    onProgress({ model, status, completed, total })
  }
  const take = (line: string): void => {
    const trimmed = line.trim()
    if (!trimmed) return
    const piece = JSON.parse(trimmed) as PullLine
    if (piece.error) throw new Error(piece.error)
    if (piece.status) status = piece.status
    if (piece.status === 'success') sawSuccess = true
    if (piece.digest && typeof piece.total === 'number' && typeof piece.completed === 'number') {
      layers.set(piece.digest, { completed: piece.completed, total: piece.total })
    }
    report(piece.status === 'success')
  }

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  try {
    while (true) {
      const chunk = await reader.read()
      if (chunk.done) break
      pending += decoder.decode(chunk.value, { stream: true })
      const lines = pending.split('\n')
      pending = lines.pop() ?? ''
      for (const line of lines) take(line)
    }
    take(pending)
  } catch (error) {
    if (signal?.aborted) throw new Error('Download cancelled.')
    throw error
  }
  if (signal?.aborted) throw new Error('Download cancelled.')
  if (!sawSuccess) throw new Error('Download ended before Ollama finished.')
  return model
}

export async function listModels(): Promise<InstalledModel[]> {
  const host = ollamaHost()
  let response: Response
  try {
    response = await fetch(`${host}/api/tags`, { signal: AbortSignal.timeout(8_000) })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not reach Ollama at ${host} (${reason}).`)
  }
  if (!response.ok) throw new Error(`Ollama returned ${response.status} while listing models.`)
  const body = (await response.json()) as { models?: Array<{ name?: string; capabilities?: unknown }> }
  const seen = new Set<string>()
  const listed: Array<{ name: string; capabilities: string[] | null }> = []
  for (const model of body.models ?? []) {
    const name = typeof model.name === 'string' ? model.name.trim() : ''
    if (!name || seen.has(name)) continue
    seen.add(name)
    listed.push({
      name,
      capabilities: Array.isArray(model.capabilities) ? model.capabilities.filter((item): item is string => typeof item === 'string') : null
    })
  }
  listed.sort((a, b) => a.name.localeCompare(b.name))
  return Promise.all(listed.map(async (model) => ({
    name: model.name,
    vision: model.capabilities ? model.capabilities.includes('vision') : await seesImages(model.name)
  })))
}

const visionCache = new Map<string, boolean>()

async function seesImages(name: string): Promise<boolean> {
  const cached = visionCache.get(name)
  if (cached !== undefined) return cached
  try {
    const response = await fetch(`${ollamaHost()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model: name }),
      signal: AbortSignal.timeout(8_000)
    })
    if (!response.ok) return false
    const body = (await response.json()) as { capabilities?: unknown }
    if (!Array.isArray(body.capabilities)) return false
    const vision = body.capabilities.includes('vision')
    visionCache.set(name, vision)
    return vision
  } catch {
    return false
  }
}

export async function prompt(task: string, options: PromptOptions = {}): Promise<ChatMessage> {
  const messages: ChatMessage[] = []
  if (options.system) messages.push({ role: 'system', content: options.system })
  if (options.history) messages.push(...options.history)
  messages.push({ role: 'user', content: task })
  return chat(messages, options)
}

export async function chat(messages: ChatMessage[], options: PromptOptions = {}): Promise<ChatMessage> {
  const host = ollamaHost()
  const model = options.model?.trim() || process.env.OLLAMA_MODEL || DEFAULT_AGENT_MODEL

  const body: Record<string, unknown> = {
    model,
    messages,
    stream: true,
    options: {
      temperature: options.temperature ?? 0.2,
      ...(options.numCtx && options.numCtx > 0 ? { num_ctx: options.numCtx } : {})
    }
  }
  if (options.think) body.think = true
  if (options.tools) body.tools = options.tools

  let response: Response
  try {
    response = await fetch(`${host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: options.signal ? AbortSignal.any([AbortSignal.timeout(TIMEOUT_MS), options.signal]) : AbortSignal.timeout(TIMEOUT_MS)
    })
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`Could not reach Ollama at ${host} (${reason}).`)
  }
  if (!response.ok) {
    const detail = (await response.text()).slice(0, 500)
    throw new Error(`Ollama returned ${response.status}${detail ? `: ${detail}` : ''}.`)
  }
  if (!response.body) throw new Error('Ollama returned an empty response.')

  let content = ''
  let thinking = ''
  let thinkingStarted = 0
  let thinkingEnded = 0
  let promptTokens = 0
  const calls: ToolCall[] = []
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let pending = ''
  while (true) {
    const chunk = await reader.read()
    if (chunk.done) break
    pending += decoder.decode(chunk.value, { stream: true })
    const lines = pending.split('\n')
    pending = lines.pop() ?? ''
    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed) continue
      const piece = JSON.parse(trimmed) as StreamLine
      if (piece.error) throw new Error(piece.error)
      if (typeof piece.prompt_eval_count === 'number') promptTokens = piece.prompt_eval_count
      const message = piece.message
      if (!message) continue
      if (message.thinking) {
        const now = Date.now()
        if (!thinkingStarted) thinkingStarted = now
        thinkingEnded = now
        thinking += message.thinking
        options.onToken?.('thinking', message.thinking)
      }
      if (message.content) {
        content += message.content
        options.onToken?.('content', message.content)
      }
      if (message.tool_calls) {
        for (const call of message.tool_calls) {
          const name = call.function?.name
          if (!name) continue
          calls.push({
            function: { name, arguments: parseArguments(call.function?.arguments) }
          })
        }
      }
    }
  }

  const result: ChatMessage = { role: 'assistant', content }
  if (thinking) {
    result.thinking = thinking
    result.thinkingSeconds = Math.max(1, Math.round((thinkingEnded - thinkingStarted) / 1000))
  }
  if (calls.length > 0) result.tool_calls = calls
  if (promptTokens > 0) options.onUsage?.(promptTokens)
  return result
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>
  if (typeof value !== 'string' || !value.trim()) return {}
  try {
    const parsed = JSON.parse(value) as unknown
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, unknown>
  } catch {
    return { _raw: value }
  }
  return {}
}
