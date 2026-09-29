import type { AgentPromptSettings, ContextBudget, ContextSlice } from '../../shared/types'
import { contextPrompt } from './context'
import { ollamaHost } from './ollama'
import { buildPrompt } from './prompt'
import { projectPrompt, refreshProjectIndex } from './projectIndex'
import { readSessionFiles, readTurns } from './sessions'
import { Toolset, openWorkspace } from './tools'

const FALLBACK_CHARS_PER_TOKEN = 4
const ratios = new Map<string, number>()

export function instructionText(root: string, hasHistory: boolean, voice: AgentPromptSettings = { extra: '', caveman: false }): string {
  const base = buildPrompt(root, voice)
  if (!hasHistory) return base
  return `${base}\n\nEarlier messages are this session. Continue that conversation.`
}

export function notePromptUsage(model: string, characters: number, tokens: number): void {
  if (!model || characters <= 0 || tokens <= 0) return
  ratios.set(model, characters / tokens)
}

export function tokenCount(text: string, model: string): { tokens: number; approximate: boolean } {
  if (!text) return { tokens: 0, approximate: !ratios.has(model) }
  const known = ratios.get(model)
  const per = known && known > 0 ? known : FALLBACK_CHARS_PER_TOKEN
  return { tokens: Math.max(1, Math.round(text.length / per)), approximate: !known }
}

export function contextLengthFromInfo(info: Record<string, unknown>): number {
  let best = 0
  for (const [key, value] of Object.entries(info)) {
    if (!key.endsWith('.context_length') || typeof value !== 'number' || !Number.isFinite(value)) continue
    if (value > best) best = value
  }
  return best
}

export async function contextLimit(model: string): Promise<number> {
  const window = await contextWindow(model)
  return window.limit
}

export async function measureContext(
  project: string,
  session: string,
  model: string,
  focus: string | null = null,
  voice: AgentPromptSettings = { extra: '', caveman: false }
): Promise<ContextBudget> {
  const workspace = await openWorkspace(project)
  await refreshProjectIndex(workspace.root).catch(() => undefined)
  const turns = await readTurns(project, session)
  const files = await readSessionFiles(project, session)
  const fileText = await contextPrompt(workspace, files)
  const instructions = instructionText(workspace.root, turns.length > 0, voice)
  const projectText = await projectPrompt(workspace.root, [focus]).catch(() => '')
  const conversation = turns.map((turn) => turn.content).join('\n')
  const toolText = JSON.stringify(new Toolset(workspace).schemas())
  const slices: ContextSlice[] = [
    slice('instructions', 'Instructions', instructions, model),
    slice('tools', 'Tools', toolText, model),
    slice('project', 'Project', projectText, model),
    slice('conversation', 'Conversation', conversation, model),
    slice('files', 'Files', fileText, model)
  ]
  const used = slices.reduce((sum, item) => sum + item.tokens, 0)
  const window = await contextWindow(model)
  return {
    model,
    slices,
    used,
    limit: window.limit,
    modelLimit: window.modelLimit,
    loaded: window.loaded,
    vramBytes: window.vramBytes,
    approximate: !ratios.has(model)
  }
}

function slice(id: ContextSlice['id'], label: string, text: string, model: string): ContextSlice {
  return { id, label, tokens: tokenCount(text, model).tokens }
}

async function contextWindow(model: string): Promise<{
  limit: number
  modelLimit: number
  loaded: boolean
  vramBytes: number | null
}> {
  const modelLimit = await modelContext(model)
  const running = await loadedModel(model)
  if (running) {
    return {
      limit: running.context || modelLimit,
      modelLimit: modelLimit || running.context,
      loaded: true,
      vramBytes: running.vram
    }
  }
  return { limit: modelLimit, modelLimit, loaded: false, vramBytes: null }
}

async function modelContext(model: string): Promise<number> {
  try {
    const response = await fetch(`${ollamaHost()}/api/show`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model }),
      signal: AbortSignal.timeout(8_000)
    })
    if (!response.ok) return 0
    const body = (await response.json()) as { model_info?: Record<string, unknown> }
    return contextLengthFromInfo(body.model_info ?? {})
  } catch {
    return 0
  }
}

async function loadedModel(model: string): Promise<{ context: number; vram: number | null } | null> {
  try {
    const response = await fetch(`${ollamaHost()}/api/ps`, { signal: AbortSignal.timeout(8_000) })
    if (!response.ok) return null
    const body = (await response.json()) as {
      models?: Array<{ name?: string; model?: string; context_length?: number; size_vram?: number }>
    }
    const match = (body.models ?? []).find((item) => item.name === model || item.model === model)
    if (!match || typeof match.context_length !== 'number') return null
    return {
      context: match.context_length,
      vram: typeof match.size_vram === 'number' ? match.size_vram : null
    }
  } catch {
    return null
  }
}
