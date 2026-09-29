import type { AgentContextFile, AgentContextNote, AgentPromptSettings, AgentSessionInfo, AgentSessionState, AgentThought, AgentToolUse, AgentTrace, AgentTurn, ContextBudget, ContextSlice, ModelPullProgress } from '../../shared/types'
import { DEFAULT_AGENT_MODEL } from '../../shared/types'
import { referenceDetail, referenceLabel, type TextReference } from './references'

const OPEN_KEY = 'smith.agent.open'
const MODEL_KEY = 'smith.agent.model'
const THINK_KEY = 'smith.agent.think'
const EXTRA_KEY = 'smith.agent.extra'
const CAVEMAN_KEY = 'smith.agent.caveman'
const sources = new WeakMap<HTMLElement, string>()

type Part =
  | { type: 'text'; text: string }
  | {
      type: 'ref'
      label: string
      detail: string
      file: string
      path: string
      absolute: string
      text: string
      kind: string
      start: number
      end: number
    }

export type AgentPanel = {
  toggle: () => void
  restore: () => void
  sync: (project: string | null) => void
  contains: (node: Node | null) => boolean
}

export function mountAgent(
  host: HTMLElement,
  pastedReference: (text: string) => TextReference | null,
  context: { project: () => string | null; focus: () => string | null; onFileChanged: (path: string) => void }
): AgentPanel {
  host.innerHTML = `
    <div id="agent-resize" class="pane-resize pane-resize-left"></div>
    <div class="agent-head">
      <span class="agent-title">Agent</span>
      <div class="agent-actions">
        <button class="agent-settings" type="button" title="Agent settings" aria-label="Agent settings" aria-expanded="false">${settingsIcon()}<span class="agent-budget-pct"></span></button>
        <button class="agent-new" type="button">New</button>
        <button class="agent-stop" type="button" disabled>Stop</button>
        <button class="agent-clear" type="button">Clear</button>
      </div>
      <select class="agent-session" aria-label="Session"></select>
    </div>
    <div class="agent-log">
      <div class="agent-empty">Ask a question, or paste a file selection. A follow-up continues this session.</div>
    </div>
    <div class="agent-context" hidden>
      <div class="agent-context-label">Context</div>
      <div class="agent-context-files"></div>
    </div>
    <form class="agent-composer">
      <div class="agent-input" contenteditable="true" tabindex="0" role="textbox" aria-label="Message the agent"></div>
      <div class="agent-composer-bar">
        <div class="agent-composer-left">
          <button class="agent-mode" type="button" aria-label="Agent" title="Agent">∞ Agent <span aria-hidden="true">▾</span></button>
          <select class="agent-model agent-model-quick" aria-label="Model"></select>
        </div>
        <div class="agent-composer-right">
          <button class="agent-wheel" type="button" title="Context" aria-label="Context">
            <svg viewBox="0 0 16 16" width="16" height="16" aria-hidden="true">
              <circle class="agent-wheel-track" cx="8" cy="8" r="6"></circle>
              <circle class="agent-wheel-value" cx="8" cy="8" r="6"></circle>
            </svg>
          </button>
          <button class="agent-attach" type="button" hidden title="Attach an image" aria-label="Attach an image">${attachIcon()}</button>
          <button class="agent-send" type="submit" aria-label="Send" title="Send">${sendIcon()}</button>
        </div>
      </div>
    </form>
    <div class="agent-settings-window" hidden tabindex="-1" role="dialog" aria-label="Agent settings">
      <div class="agent-settings-head">
        <span>Agent settings</span>
        <button class="agent-settings-close" type="button" title="Close">×</button>
      </div>
      <div class="agent-settings-body">
        <section class="agent-settings-section">
          <h2>Model</h2>
          <div class="agent-model-row">
            <select class="agent-model" aria-label="Model"></select>
            <button class="agent-think" type="button" aria-pressed="false" title="Think before answering. Leave this off for models that do not support thinking.">Think</button>
          </div>
          <form class="agent-pull-form">
            <input class="agent-pull-name" type="text" spellcheck="false" autocomplete="off" placeholder="qwen2.5-coder:7b" aria-label="Model to download" />
            <button class="agent-pull-go" type="submit">Download</button>
          </form>
          <div class="agent-pull-chips"></div>
          <div class="agent-pull-track" hidden>
            <div class="agent-pull-bar" aria-hidden="true"><span class="agent-pull-fill"></span></div>
            <div class="agent-pull-meta">
              <span class="agent-pull-status"></span>
              <button class="agent-pull-cancel" type="button">Cancel</button>
            </div>
          </div>
          <p class="agent-pull-note"></p>
        </section>
        <section class="agent-settings-section">
          <h2>Context</h2>
          <div class="context-card-body"></div>
        </section>
        <section class="agent-settings-section">
          <h2>Instructions</h2>
          <pre class="agent-instructions"></pre>
          <p class="agent-settings-note">These are sent with every message. The working directory and date match the open folder.</p>
        </section>
        <section class="agent-settings-section">
          <h2>Additional instructions</h2>
          <textarea class="agent-extra" maxlength="8000" spellcheck="true" placeholder="Optional notes added after the instructions above."></textarea>
        </section>
        <section class="agent-settings-section">
          <h2>Caveman</h2>
          <label class="agent-caveman">
            <input class="agent-caveman-toggle" type="checkbox" />
            Inject caveman instructions
          </label>
          <pre class="agent-caveman-text"></pre>
          <p class="agent-settings-note">When this is on, that voice is added after the instructions above and before any additional instructions.</p>
        </section>
      </div>
    </div>
  `
  const log = must(host, '.agent-log')
  const contextBar = must(host, '.agent-context')
  const contextList = must(host, '.agent-context-files')
  const input = must(host, '.agent-input')
  const form = must(host, '.agent-composer') as HTMLFormElement
  const sendButton = must(host, '.agent-send') as HTMLButtonElement
  const modelSelects = [...host.querySelectorAll('select.agent-model')] as HTMLSelectElement[]
  const wheel = must(host, '.agent-wheel') as HTMLButtonElement
  const wheelRing = host.querySelector('.agent-wheel-value')
  if (!(wheelRing instanceof SVGCircleElement)) throw new Error('Missing .agent-wheel-value')
  const wheelValue: SVGCircleElement = wheelRing
  const attachButton = must(host, '.agent-attach') as HTMLButtonElement
  const thinkButton = must(host, '.agent-think') as HTMLButtonElement
  const pullForm = must(host, '.agent-pull-form') as HTMLFormElement
  const pullName = must(host, '.agent-pull-name') as HTMLInputElement
  const pullGo = must(host, '.agent-pull-go') as HTMLButtonElement
  const pullChips = must(host, '.agent-pull-chips')
  const pullTrack = must(host, '.agent-pull-track')
  const pullFill = must(host, '.agent-pull-fill')
  const pullStatus = must(host, '.agent-pull-status')
  const pullCancel = must(host, '.agent-pull-cancel') as HTMLButtonElement
  const pullNote = must(host, '.agent-pull-note')
  const stopButton = must(host, '.agent-stop') as HTMLButtonElement
  const clearButton = must(host, '.agent-clear') as HTMLButtonElement
  const newButton = must(host, '.agent-new') as HTMLButtonElement
  const settingsButton = must(host, '.agent-settings') as HTMLButtonElement
  const settingsWindow = must(host, '.agent-settings-window')
  const settingsClose = must(host, '.agent-settings-close') as HTMLButtonElement
  const budgetPct = must(host, '.agent-budget-pct')
  const contextBody = must(host, '.context-card-body')
  const instructions = must(host, '.agent-instructions')
  const extraInput = must(host, '.agent-extra') as HTMLTextAreaElement
  const cavemanToggle = must(host, '.agent-caveman-toggle') as HTMLInputElement
  const cavemanText = must(host, '.agent-caveman-text')
  const sessionSelect = must(host, '.agent-session') as HTMLSelectElement
  let busy = false
  let pulling = false
  let pullingName = ''
  let pullToken = 0
  let sessionId = ''
  let sessionToken = 0
  let contextFiles: AgentContextFile[] = []
  const visionModels = new Set<string>()
  let budgetTimer = 0
  let budgetLoad = 0
  let instructionLoad = 0
  extraInput.value = localStorage.getItem(EXTRA_KEY) ?? ''
  cavemanToggle.checked = localStorage.getItem(CAVEMAN_KEY) === '1'
  contextList.addEventListener('click', (event) => {
    const target = event.target
    const button = target instanceof HTMLElement ? target.closest('.agent-context-remove') : null
    if (!(button instanceof HTMLButtonElement) || !button.dataset.path) return
    void removeContextFile(button.dataset.path)
  })
  stopButton.addEventListener('click', () => {
    if (busy) void window.api.stopAgent()
  })
  clearButton.addEventListener('click', () => {
    void clearChat()
  })
  newButton.addEventListener('click', () => {
    void startSession()
  })
  settingsButton.addEventListener('click', () => {
    openSettings()
  })
  settingsClose.addEventListener('click', () => {
    closeSettings()
  })
  settingsWindow.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape') return
    event.preventDefault()
    event.stopPropagation()
    closeSettings()
  })
  extraInput.addEventListener('input', () => {
    localStorage.setItem(EXTRA_KEY, extraInput.value)
    scheduleBudget()
  })
  cavemanToggle.addEventListener('change', () => {
    localStorage.setItem(CAVEMAN_KEY, cavemanToggle.checked ? '1' : '0')
    void refreshBudget()
  })
  sessionSelect.addEventListener('change', () => {
    void chooseSession(sessionSelect.value)
  })
  for (const select of modelSelects) {
    select.addEventListener('change', () => {
      const value = select.value
      for (const other of modelSelects) {
        if (other !== select && [...other.options].some((option) => option.value === value)) other.value = value
      }
      if (value) localStorage.setItem(MODEL_KEY, value)
      paintAttach()
      void refreshBudget()
    })
  }
  wheel.addEventListener('click', () => {
    openSettings()
  })
  setThinking(localStorage.getItem(THINK_KEY) === '1')
  thinkButton.addEventListener('click', () => {
    setThinking(thinkButton.getAttribute('aria-pressed') !== 'true')
  })
  for (const suggestion of SUGGESTED_MODELS) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'agent-pull-chip'
    chip.dataset.model = suggestion.name
    chip.title = suggestion.name
    chip.textContent = suggestion.label
    pullChips.append(chip)
  }
  pullForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void startPull(pullName.value)
  })
  pullChips.addEventListener('click', (event) => {
    const target = event.target
    const chip = target instanceof HTMLElement ? target.closest('.agent-pull-chip') : null
    if (!(chip instanceof HTMLButtonElement) || !chip.dataset.model) return
    pullName.value = chip.dataset.model
    void startPull(chip.dataset.model)
  })
  pullCancel.addEventListener('click', () => {
    void window.api.cancelPull()
  })
  window.api.onPullProgress((progress) => {
    if (progress.model !== pullingName) return
    paintPull(progress)
  })
  void reloadModels()

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    send()
  })
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      send()
    } else if (event.key === 'Backspace') {
      if (deleteAdjacent(input, true)) event.preventDefault()
    } else if (event.key === 'Delete') {
      if (deleteAdjacent(input, false)) event.preventDefault()
    }
  })
  input.addEventListener('paste', (event) => {
    event.preventDefault()
    const pasted = event.clipboardData?.getData('text/plain') ?? ''
    insertPaste(input, pasted, pastedReference(pasted))
  })

  return {
    toggle() {
      setOpen(host.hasAttribute('hidden'))
      if (!host.hidden) input.focus()
    },
    restore() {
      if (localStorage.getItem(OPEN_KEY) === '1') setOpen(true)
    },
    sync(project) {
      void loadSessions(project)
      if (project) void window.api.refreshProjectIndex(project).catch(() => undefined)
      if (!settingsWindow.hidden) void loadInstructions(project)
    },
    contains: (node) => node !== null && host.contains(node)
  }

  function setOpen(opening: boolean): void {
    host.hidden = !opening
    host.closest('.app')?.classList.toggle('agent-open', opening)
    localStorage.setItem(OPEN_KEY, opening ? '1' : '0')
    if (opening) void reloadModels()
  }

  function send(): void {
    if (busy) return
    const parts = partsFrom(input)
    if (!parts.some((part) => part.type === 'ref' || part.text.trim())) return
    const project = context.project()
    const text = requestText(parts)
    const files = citedFiles(parts)
    const filePart = parts.find((part) => part.type === 'ref' && part.kind === 'file')
    log.querySelector('.agent-empty')?.remove()
    const exchange = document.createElement('div')
    exchange.className = 'agent-exchange'
    const user = document.createElement('div')
    user.className = 'agent-msg agent-msg-user'
    user.append(roleLabel('You'), bubble(renderParts, parts))
    const reply = document.createElement('div')
    reply.className = 'agent-msg agent-msg-agent'
    const replyBody = document.createElement('div')
    replyBody.className = 'agent-bubble'
    const trail = document.createElement('div')
    trail.className = 'agent-trail'
    const thinking = document.createElement('div')
    thinking.className = 'agent-thinking'
    thinking.hidden = true
    const status = document.createElement('div')
    status.className = 'agent-status'
    const live = document.createElement('div')
    live.className = 'agent-live'
    replyBody.append(trail, thinking, status, live)
    reply.append(roleLabel('Agent'), replyBody)
    exchange.append(user, reply)
    log.append(exchange)
    log.scrollTop = log.scrollHeight
    input.replaceChildren()
    if (!project) {
      status.textContent = ''
      live.textContent = 'Open a folder before messaging the agent.'
      live.classList.add('agent-error')
      return
    }
    if (!text) return
    if (!sessionId) {
      status.textContent = ''
      live.textContent = 'The session list is still loading.'
      live.classList.add('agent-error')
      return
    }
    const model = selectedModel()
    if (!model) {
      status.textContent = ''
      live.textContent = 'Choose a model in agent settings. If the list is empty, start Ollama and open settings again.'
      live.classList.add('agent-error')
      return
    }
    rememberFiles(files)
    const think = thinkButton.getAttribute('aria-pressed') === 'true'
    const voice = currentVoice()
    void run(project, text, model, sessionId, files, think, voice, filePart && filePart.type === 'ref' ? filePart.absolute || filePart.path : null, {
      trail,
      thinking,
      status,
      live,
      replyBody
    })
  }

  async function run(
    project: string,
    text: string,
    model: string,
    session: string,
    files: AgentContextFile[],
    think: boolean,
    voice: AgentPromptSettings,
    file: string | null,
    view: { trail: HTMLElement; thinking: HTMLElement; status: HTMLElement; live: HTMLElement; replyBody: HTMLElement }
  ): Promise<void> {
    setBusy(true)
    let answer = ''
    let thought = ''
    let finished = false
    const activity = createActivity(view.trail, true)
    const hideThought = (): void => {
      thought = ''
      view.thinking.textContent = ''
      view.thinking.hidden = true
    }
    const finish = (finalText: string, isError = false): void => {
      if (finished) return
      finished = true
      view.status.textContent = ''
      if (finalText !== 'Stopped.') retitle(text)
      if (isError) {
        view.live.textContent = finalText
        view.live.classList.add('agent-error')
        return
      }
      view.live.remove()
      const rendered = document.createElement('div')
      rendered.className = 'agent-md'
      renderMarkdown(rendered, finalText)
      view.replyBody.append(rendered)
    }
    const stop = window.api.onAgentEvent((event) => {
      if (event.type === 'status') view.status.textContent = event.text
      else if (event.type === 'step') {
        hideThought()
        view.status.textContent = `Step ${event.index} of ${event.total}`
      } else if (event.type === 'thought') {
        activity.add({ kind: 'thought', seconds: event.seconds, text: event.text })
        hideThought()
      } else if (event.type === 'tool') {
        activity.add({ kind: 'tool', name: event.name, ok: event.ok, detail: event.detail })
      } else if (event.type === 'token' && event.channel === 'thinking') {
        thought += event.text
        view.thinking.hidden = false
        view.thinking.textContent = thought
      } else if (event.type === 'token' && event.channel === 'content') {
        view.thinking.hidden = true
        answer += event.text
        view.live.textContent = answer
      } else if (event.type === 'clear-content') {
        answer = ''
        view.live.textContent = ''
      } else if (event.type === 'file-changed') context.onFileChanged(event.path)
      else if (event.type === 'session-files') {
        contextFiles = contextFiles.filter((item) => !event.removed.some((location) => sameLocation(item.path, location)))
        rememberFiles(event.added)
        paintContext()
      } else if (event.type === 'error') {
        finish(event.text, true)
      } else if (event.type === 'done') {
        hideThought()
        finish(event.text || answer)
      } else if (event.type === 'loop-context') {
        activity.add({ kind: 'context', step: event.step, tokens: event.tokens, added: event.added })
        if (event.limit > 0) paintContextPercent(Math.round((event.tokens / event.limit) * 100))
      } else if (event.type === 'context') showBudget(event.budget)
      log.scrollTop = log.scrollHeight
    })
    try {
      await window.api.rememberAgentFiles(project, session, files)
      const result = await window.api.runAgent({
        project,
        text,
        file,
        focus: context.focus(),
        model,
        session,
        files,
        think,
        extra: voice.extra,
        caveman: voice.caveman
      })
      if (result.error) finish(result.error, true)
      else finish(result.text || answer)
    } catch (error) {
      finish(error instanceof Error ? error.message : String(error), true)
    } finally {
      stop()
      setBusy(false)
      log.scrollTop = log.scrollHeight
    }
  }

  function setThinking(on: boolean): void {
    thinkButton.setAttribute('aria-pressed', on ? 'true' : 'false')
    localStorage.setItem(THINK_KEY, on ? '1' : '0')
  }

  function setBusy(running: boolean): void {
    busy = running
    sendButton.disabled = running
    for (const select of modelSelects) select.disabled = running || pulling
    thinkButton.disabled = running
    sessionSelect.disabled = running
    newButton.disabled = running
    stopButton.disabled = !running
  }

  function setPulling(active: boolean): void {
    pulling = active
    pullName.disabled = active
    pullGo.disabled = active
    pullTrack.hidden = !active
    pullCancel.disabled = !active
    for (const chip of pullChips.querySelectorAll('button')) chip.disabled = active
    for (const select of modelSelects) select.disabled = busy || active
    if (!active) {
      pullFill.style.width = '0'
      pullFill.classList.remove('indeterminate')
    }
  }

  async function startPull(raw: string): Promise<void> {
    const name = raw.trim()
    if (pulling) return
    if (!name) {
      pullNote.textContent = 'Enter a model name such as qwen2.5-coder:7b.'
      pullNote.className = 'agent-pull-note error'
      return
    }
    const token = ++pullToken
    pullingName = name
    pullNote.textContent = ''
    pullNote.className = 'agent-pull-note'
    pullStatus.textContent = `Starting ${name}`
    pullFill.style.width = '0'
    pullFill.classList.add('indeterminate')
    setPulling(true)
    try {
      await window.api.pullModel(name)
      if (token !== pullToken) return
      await reloadModels(name)
      if (token !== pullToken) return
      const selected = selectedModel()
      const matches = selected === name || selected.startsWith(`${name}:`)
      pullNote.textContent = matches ? `Installed ${selected}. It is selected above.` : `Installed ${name}.`
      pullNote.className = 'agent-pull-note ok'
      pullName.value = ''
    } catch (error) {
      if (token !== pullToken) return
      const message = pullErrorText(error)
      const cancelled = message === 'Download cancelled.'
      pullNote.textContent = cancelled ? 'Download cancelled.' : message
      pullNote.className = cancelled ? 'agent-pull-note' : 'agent-pull-note error'
    } finally {
      if (token === pullToken) {
        pullingName = ''
        setPulling(false)
      }
    }
  }

  function paintPull(progress: ModelPullProgress): void {
    const known = progress.total > 0
    pullFill.classList.toggle('indeterminate', !known)
    pullFill.style.width = known ? `${Math.min(100, Math.round((progress.completed / progress.total) * 100))}%` : ''
    const amount = known ? `${formatPullBytes(progress.completed)} / ${formatPullBytes(progress.total)}` : ''
    const label = progress.status || 'Downloading'
    pullStatus.textContent = amount ? `${label} · ${amount}` : label
  }

  async function loadSessions(project: string | null): Promise<void> {
    const token = ++sessionToken
    sessionId = ''
    if (!project) {
      sessionSelect.replaceChildren(optionFor('', 'Open a folder'))
      sessionSelect.disabled = true
      contextFiles = []
      paintContext()
      showEmpty()
      return
    }
    sessionSelect.disabled = busy
    try {
      const state = await window.api.listAgentSessions(project)
      if (token !== sessionToken) return
      applyState(state)
    } catch (error) {
      if (token !== sessionToken) return
      showEmpty()
      const note = document.createElement('div')
      note.className = 'agent-error'
      note.textContent = error instanceof Error ? error.message : String(error)
      log.append(note)
    }
  }

  async function startSession(): Promise<void> {
    if (busy) return
    const project = context.project()
    if (!project) return
    const token = ++sessionToken
    try {
      const state = await window.api.newAgentSession(project)
      if (token !== sessionToken) return
      applyState(state)
    } catch {
      if (token !== sessionToken) return
      showEmpty()
    }
  }

  async function chooseSession(id: string): Promise<void> {
    if (busy || !id || id === sessionId) return
    const project = context.project()
    if (!project) return
    const token = ++sessionToken
    try {
      const state = await window.api.readAgentSession(project, id)
      if (token !== sessionToken) return
      applyState(state)
    } catch {
      if (token !== sessionToken) return
      sessionSelect.value = sessionId
    }
  }

  function applyState(state: AgentSessionState): void {
    fillSessions(state.sessions, state.session.id)
    sessionId = state.session.id
    contextFiles = state.session.files
    paintContext()
    paintTurns(state.session.turns)
  }

  function fillSessions(sessions: AgentSessionInfo[], active: string): void {
    sessionSelect.replaceChildren()
    for (const info of sessions) sessionSelect.append(sessionOption(info))
    if (sessions.some((info) => info.id === active)) sessionSelect.value = active
  }

  async function clearChat(): Promise<void> {
    if (busy) await window.api.stopAgent()
    const project = context.project()
    if (!project || !sessionId) {
      showEmpty()
      return
    }
    try {
      applyState(await window.api.clearAgentSession(project, sessionId))
    } catch {
      showEmpty()
    }
  }

  function currentVoice(): AgentPromptSettings {
    return { extra: extraInput.value.trim(), caveman: cavemanToggle.checked }
  }

  function openSettings(): void {
    settingsWindow.hidden = false
    settingsButton.setAttribute('aria-expanded', 'true')
    settingsWindow.focus()
    if (!contextBody.childElementCount && !contextBody.textContent) contextBody.textContent = 'Counting tokens…'
    void loadInstructions(context.project())
    void refreshBudget()
  }

  function closeSettings(): void {
    settingsWindow.hidden = true
    settingsButton.setAttribute('aria-expanded', 'false')
  }

  function scheduleBudget(): void {
    window.clearTimeout(budgetTimer)
    budgetTimer = window.setTimeout(() => {
      void refreshBudget()
    }, 300)
  }

  async function loadInstructions(project: string | null): Promise<void> {
    const token = ++instructionLoad
    try {
      const preview = await window.api.agentPrompt(project)
      if (token !== instructionLoad || settingsWindow.hidden) return
      instructions.textContent = preview.base
      cavemanText.textContent = preview.caveman
    } catch (error) {
      if (token !== instructionLoad || settingsWindow.hidden) return
      instructions.textContent = error instanceof Error ? error.message : String(error)
    }
  }

  async function refreshBudget(): Promise<void> {
    const token = ++budgetLoad
    const project = context.project()
    const model = selectedModel()
    if (!project || !sessionId || !model) {
      if (!settingsWindow.hidden) contextBody.textContent = 'Open a folder and choose a model.'
      return
    }
    try {
      const budget = await window.api.contextBudget(project, sessionId, model, context.focus(), currentVoice())
      if (token !== budgetLoad) return
      showBudget(budget)
    } catch (error) {
      if (token !== budgetLoad || settingsWindow.hidden) return
      contextBody.textContent = error instanceof Error ? error.message : String(error)
    }
  }

  async function reloadModels(prefer?: string): Promise<void> {
    const vision = await loadModels(modelSelects, prefer)
    visionModels.clear()
    for (const name of vision) visionModels.add(name)
    paintAttach()
  }

  function selectedModel(): string {
    return modelSelects.find((select) => select.value)?.value ?? ''
  }

  function paintAttach(): void {
    attachButton.hidden = !visionModels.has(selectedModel())
  }

  function paintContextPercent(percent: number | null): void {
    budgetPct.textContent = percent === null ? '' : `${percent}%`
    budgetPct.classList.toggle('over', percent !== null && percent > 100)
    const used = percent === null ? 0 : Math.min(100, Math.max(0, percent))
    const length = 2 * Math.PI * 6
    wheelValue.style.strokeDasharray = `${(used / 100) * length} ${length}`
    wheel.classList.toggle('over', percent !== null && percent > 100)
    wheel.title = percent === null ? 'Context' : `${percent}% of the context window`
  }

  function showBudget(budget: ContextBudget): void {
    const percent = budget.limit > 0 ? Math.round((budget.used / budget.limit) * 100) : null
    paintContextPercent(percent)
    if (!settingsWindow.hidden) renderBudget(contextBody, budget)
  }

  function rememberFiles(incoming: AgentContextFile[]): void {
    let changed = false
    for (const file of incoming) {
      if (contextFiles.some((item) => sameLocation(item.path, file.path))) continue
      contextFiles.push(file)
      changed = true
    }
    if (changed) paintContext()
  }

  async function removeContextFile(location: string): Promise<void> {
    const project = context.project()
    const id = sessionId
    contextFiles = contextFiles.filter((item) => !sameLocation(item.path, location))
    paintContext()
    if (!project || !id) return
    try {
      const state = await window.api.forgetAgentFile(project, id, location)
      if (sessionId !== id) return
      contextFiles = state.session.files
      paintContext()
    } catch {
      contextFiles = contextFiles.filter((item) => !sameLocation(item.path, location))
      paintContext()
    }
  }

  function paintContext(): void {
    contextList.replaceChildren()
    contextBar.hidden = contextFiles.length === 0
    for (const file of contextFiles) {
      const chip = document.createElement('span')
      chip.className = 'agent-context-file'
      const name = document.createElement('span')
      name.className = 'agent-context-name'
      name.textContent = file.name
      const location = document.createElement('span')
      location.className = 'agent-context-path'
      location.textContent = file.path
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'agent-context-remove'
      remove.dataset.path = file.path
      remove.title = 'Remove from context'
      remove.textContent = '×'
      chip.append(name, location, remove)
      contextList.append(chip)
    }
  }

  function retitle(text: string): void {
    const option = [...sessionSelect.options].find((item) => item.value === sessionId)
    if (!option || option.dataset.titled === '1') return
    option.dataset.titled = '1'
    option.textContent = `${formatStamp(option.dataset.created ?? '')} — ${clipTitle(text)}`
  }

  function paintTurns(turns: AgentTurn[]): void {
    log.replaceChildren()
    if (turns.length === 0) {
      showEmpty()
      return
    }
    let index = 0
    while (index < turns.length) {
      const turn = turns[index]
      if (turn.role !== 'user') {
        index += 1
        continue
      }
      const next = turns[index + 1]
      const exchange = document.createElement('div')
      exchange.className = 'agent-exchange'
      const user = document.createElement('div')
      user.className = 'agent-msg agent-msg-user'
      const userBody = document.createElement('div')
      userBody.className = 'agent-bubble'
      userBody.textContent = turn.content
      user.append(roleLabel('You'), userBody)
      exchange.append(user)
      if (next?.role === 'assistant') {
        const reply = document.createElement('div')
        reply.className = 'agent-msg agent-msg-agent'
        const replyBody = document.createElement('div')
        replyBody.className = 'agent-bubble'
        if (next.tools && next.tools.length > 0) {
          const trail = document.createElement('div')
          trail.className = 'agent-trail'
          const activity = createActivity(trail, false)
          for (const item of next.tools) activity.add(item)
          replyBody.append(trail)
        }
        const rendered = document.createElement('div')
        rendered.className = 'agent-md'
        renderMarkdown(rendered, next.content)
        replyBody.append(rendered)
        reply.append(roleLabel('Agent'), replyBody)
        exchange.append(reply)
        index += 2
      } else {
        index += 1
      }
      log.append(exchange)
    }
    log.scrollTop = log.scrollHeight
  }

  function showEmpty(): void {
    const empty = document.createElement('div')
    empty.className = 'agent-empty'
    empty.textContent = 'Ask a question, or paste a file selection. A follow-up continues this session.'
    log.replaceChildren(empty)
  }
}

async function loadModels(selects: HTMLSelectElement[], prefer?: string): Promise<string[]> {
  const token = ++modelLoad
  const saved = selects.find((select) => select.value)?.value || localStorage.getItem(MODEL_KEY) || ''
  const preferred = prefer?.trim() || saved || DEFAULT_AGENT_MODEL
  try {
    const models = await window.api.listModels()
    if (token !== modelLoad) return []
    if (models.length === 0) {
      for (const select of selects) {
        const option = document.createElement('option')
        option.value = ''
        option.textContent = 'No models installed'
        select.replaceChildren(option)
      }
      return []
    }
    const installed = matchModel(models.map((model) => model.name), preferred)
    for (const select of selects) fillModels(select, models.map((model) => model.name), installed)
    return models.filter((model) => model.vision).map((model) => model.name)
  } catch {
    if (token !== modelLoad) return []
    if (preferred) {
      for (const select of selects) fillModels(select, [preferred], preferred)
    } else {
      for (const select of selects) {
        const option = document.createElement('option')
        option.value = ''
        option.textContent = 'Ollama unavailable'
        select.replaceChildren(option)
      }
    }
    return []
  }
}

function matchModel(models: string[], preferred: string): string {
  if (models.includes(preferred)) return preferred
  const tagged = models.find((name) => name === `${preferred}:latest` || name.startsWith(`${preferred}:`))
  return tagged ?? preferred
}

function fillModels(select: HTMLSelectElement, models: string[], preferred: string): void {
  select.replaceChildren()
  for (const name of models) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    select.append(option)
  }
  const pick = models.includes(preferred) ? preferred : (models[0] ?? '')
  if (!pick) return
  select.value = pick
  localStorage.setItem(MODEL_KEY, pick)
}

let modelLoad = 0

const SUGGESTED_MODELS = [
  { label: 'Qwen Coder 7B', name: 'qwen2.5-coder:7b' },
  { label: 'Llama 3.2', name: 'llama3.2' },
  { label: 'Gemma 3 4B', name: 'gemma3:4b' },
  { label: 'DeepSeek R1 8B', name: 'deepseek-r1:8b' },
  { label: 'Mistral', name: 'mistral' }
]

function sendIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 4.2 5.2 11l1.4 1.4L11 7.9V19.5h2V7.9l4.4 4.5 1.4-1.4L12 4.2z"/></svg>`
}

function attachIcon(): string {
  return `<svg viewBox="0 0 24 24" width="16" height="16" aria-hidden="true"><path fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" d="M8.2 12.6 14 6.8a3.1 3.1 0 0 1 4.4 4.4l-7.2 7.2a4.4 4.4 0 0 1-6.2-6.2l6.5-6.5"/></svg>`
}

function settingsIcon(): string {
  return `<svg class="agent-settings-icon" viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.8 7.8 0 0 0 .1-1 7.8 7.8 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.4a.5.5 0 0 0-.6-.2l-2.5 1a7.4 7.4 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.6L4.6 11a7.8 7.8 0 0 0-.1 1 7.8 7.8 0 0 0 .1 1l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.4a.5.5 0 0 0 .6.2l2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.6L19.4 13zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>`
}

function pullErrorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.split('Error:').pop()?.trim() || raw
}

function formatPullBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(0)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`
}

const SLICE_COLOR: Record<ContextSlice['id'], string> = {
  instructions: '#61afef',
  tools: '#c678dd',
  project: '#56b6c2',
  conversation: '#e5c07b',
  files: '#98c379'
}

function renderBudget(body: HTMLElement, budget: ContextBudget): void {
  body.replaceChildren()
  const chart = document.createElement('div')
  chart.className = 'context-chart'
  chart.append(pieChart(budget))
  const legend = document.createElement('ul')
  legend.className = 'context-legend'
  const whole = budget.limit > 0 ? budget.limit : Math.max(budget.used, 1)
  for (const item of budget.slices) legend.append(legendRow(item.label, SLICE_COLOR[item.id], item.tokens, whole))
  const free = Math.max(0, budget.limit - budget.used)
  if (budget.limit > 0) legend.append(legendRow('Available', '#3a3f4b', free, budget.limit))
  chart.append(legend)
  body.append(chart)
  const summary = document.createElement('p')
  summary.className = 'context-summary'
  summary.textContent = summaryText(budget)
  body.append(summary)
  if (budget.used > budget.limit && budget.limit > 0) {
    const over = document.createElement('p')
    over.className = 'context-over'
    over.textContent = `Over the window by ${formatCount(budget.used - budget.limit)} tokens. Remove files or start a new session.`
    body.append(over)
  }
  const note = document.createElement('p')
  note.className = 'context-note'
  note.textContent = budget.approximate
    ? 'Counts are estimated at about 4 characters per token. After this model replies, the next count uses its measured rate.'
    : 'Counts use the rate measured from this model’s last reply.'
  body.append(note)
}

function summaryText(budget: ContextBudget): string {
  const used = `${formatCount(budget.used)} tokens loaded with the next message`
  if (budget.limit <= 0) return `${used}. The context window is unavailable.`
  const window = `${formatCount(budget.limit)} token window`
  if (budget.loaded) {
    const memory = budget.vramBytes ? `, ${formatBytes(budget.vramBytes)} in memory` : ''
    const maximum = budget.modelLimit > budget.limit ? ` The model allows up to ${formatCount(budget.modelLimit)}.` : ''
    return `${used}, of the loaded ${window}${memory}.${maximum}`
  }
  return `${used}, of the model’s ${window}. It is not loaded, so Ollama may open a shorter window from free memory.`
}

function legendRow(label: string, color: string, tokens: number, whole: number): HTMLElement {
  const row = document.createElement('li')
  const swatch = document.createElement('i')
  swatch.style.background = color
  const name = document.createElement('span')
  name.textContent = label
  const value = document.createElement('span')
  value.className = 'context-legend-value'
  const share = whole > 0 ? Math.round((tokens / whole) * 100) : 0
  value.textContent = `${formatCount(tokens)} · ${share}%`
  row.append(swatch, name, value)
  return row
}

function pieChart(budget: ContextBudget): SVGSVGElement {
  const svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg')
  svg.setAttribute('viewBox', '0 0 120 120')
  svg.classList.add('context-pie')
  const parts: Array<{ tokens: number; color: string }> = budget.slices
    .filter((item) => item.tokens > 0)
    .map((item) => ({ tokens: item.tokens, color: SLICE_COLOR[item.id] }))
  const free = budget.limit > budget.used ? budget.limit - budget.used : 0
  if (free > 0) parts.push({ tokens: free, color: '#2c313a' })
  const total = parts.reduce((sum, part) => sum + part.tokens, 0)
  if (total <= 0) {
    svg.append(fullCircle('#2c313a'))
    return svg
  }
  if (parts.length === 1) {
    svg.append(fullCircle(parts[0].color))
    return svg
  }
  let cursor = 0
  for (const part of parts) {
    const sweep = (part.tokens / total) * Math.PI * 2
    svg.append(pieSlice(cursor, cursor + sweep, part.color))
    cursor += sweep
  }
  return svg
}

function fullCircle(color: string): SVGCircleElement {
  const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle')
  circle.setAttribute('cx', '60')
  circle.setAttribute('cy', '60')
  circle.setAttribute('r', '52')
  circle.setAttribute('fill', color)
  return circle
}

function pieSlice(start: number, end: number, color: string): SVGPathElement {
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path')
  const radius = 52
  const center = 60
  const angle = (value: number): { x: number; y: number } => ({
    x: center + radius * Math.sin(value),
    y: center - radius * Math.cos(value)
  })
  const from = angle(start)
  const to = angle(end)
  const large = end - start > Math.PI ? 1 : 0
  path.setAttribute('d', `M ${center} ${center} L ${from.x} ${from.y} A ${radius} ${radius} 0 ${large} 1 ${to.x} ${to.y} Z`)
  path.setAttribute('fill', color)
  return path
}

function formatCount(value: number): string {
  return value.toLocaleString('en-US')
}

function formatBytes(bytes: number): string {
  const gb = bytes / (1024 * 1024 * 1024)
  return `${gb >= 10 ? gb.toFixed(0) : gb.toFixed(1)} GB`
}

type ActivityRow = AgentTrace

function createActivity(host: HTMLElement, open: boolean): { add(row: ActivityRow): void } {
  const details = document.createElement('details')
  details.className = 'agent-activity'
  details.open = open
  const summary = document.createElement('summary')
  summary.className = 'agent-activity-summary'
  const title = document.createElement('span')
  title.className = 'agent-activity-title'
  summary.append(title)
  const list = document.createElement('ul')
  list.className = 'agent-activity-list'
  details.append(summary, list)
  const rows: ActivityRow[] = []
  let mounted = false
  return {
    add(row) {
      if (!mounted) {
        host.append(details)
        mounted = true
      }
      rows.push(row)
      list.append(activityRow(row))
      title.textContent = activitySummary(rows)
    }
  }
}

function activityRow(row: ActivityRow): HTMLLIElement {
  if (row.kind === 'thought') return thoughtRow(row)
  if (row.kind === 'context') return contextRow(row)
  const item = document.createElement('li')
  item.className = 'agent-activity-row'
  if (!row.ok) item.classList.add('agent-activity-failed')
  const label = document.createElement('span')
  label.className = 'agent-activity-label'
  label.textContent = toolLabel(row.name)
  const detail = document.createElement('span')
  detail.className = 'agent-activity-detail'
  detail.textContent = row.detail
  if (row.detail) detail.title = row.detail
  item.append(label, detail)
  return item
}

function contextRow(row: AgentContextNote): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'agent-activity-row'
  const label = document.createElement('span')
  label.className = 'agent-activity-label'
  label.textContent = 'Context'
  const detail = document.createElement('span')
  detail.className = 'agent-activity-detail'
  detail.textContent = row.added > 0 ? `${formatCount(row.tokens)} · +${formatCount(row.added)}` : formatCount(row.tokens)
  detail.title = row.added > 0
    ? `Step ${row.step} sent ${formatCount(row.tokens)} tokens, ${formatCount(row.added)} more than the previous step.`
    : `Step ${row.step} sent ${formatCount(row.tokens)} tokens.`
  item.append(label, detail)
  return item
}

function thoughtRow(row: AgentThought): HTMLLIElement {
  const item = document.createElement('li')
  item.className = 'agent-activity-thought'
  const details = document.createElement('details')
  details.className = 'agent-thought'
  const summary = document.createElement('summary')
  summary.className = 'agent-thought-summary'
  const label = document.createElement('span')
  label.className = 'agent-activity-label'
  label.textContent = 'Thought'
  const time = document.createElement('span')
  time.className = 'agent-activity-detail'
  time.textContent = `${row.seconds}s`
  summary.append(label, time)
  const body = document.createElement('div')
  body.className = 'agent-thought-body'
  body.textContent = row.text
  details.append(summary, body)
  item.append(details)
  return item
}

function activitySummary(rows: ActivityRow[]): string {
  const headline = activityHeadline(rows)
  const latest = [...rows].reverse().find((row): row is AgentContextNote => row.kind === 'context')
  if (!latest) return headline
  const count = `${formatCount(latest.tokens)} tokens`
  return headline === 'Working' ? count : `${headline} · ${count}`
}

function activityHeadline(rows: ActivityRow[]): string {
  const tools = rows.filter((row): row is AgentToolUse => row.kind === 'tool')
  if (tools.length === 1) {
    const tool = tools[0]
    return tool.detail ? `${toolLabel(tool.name)} ${tool.detail}` : toolLabel(tool.name)
  }
  const count = (names: string[]): number => tools.filter((tool) => names.includes(tool.name)).length
  const explored = count(['read_file', 'list_files'])
  const searches = count(['grep', 'web_search'])
  const edited = count(['edit_file', 'write_file'])
  const commands = count(['run_command'])
  const moved = count(['move_file'])
  const deleted = count(['delete_file'])
  const fetched = count(['fetch_url'])
  const known = explored + searches + edited + commands + moved + deleted + fetched
  const parts: string[] = []
  if (explored) parts.push(explored === 1 ? 'Explored 1 file' : `Explored ${explored} files`)
  if (searches) parts.push(searches === 1 ? '1 search' : `${searches} searches`)
  if (edited) parts.push(edited === 1 ? 'Edited 1 file' : `Edited ${edited} files`)
  if (commands) parts.push(commands === 1 ? 'Ran 1 command' : `Ran ${commands} commands`)
  if (moved) parts.push(moved === 1 ? 'Moved 1 file' : `Moved ${moved} files`)
  if (deleted) parts.push(deleted === 1 ? 'Deleted 1 file' : `Deleted ${deleted} files`)
  if (fetched) parts.push(fetched === 1 ? 'Fetched 1 page' : `Fetched ${fetched} pages`)
  const other = tools.length - known
  if (other > 0) parts.push(other === 1 ? '1 other tool' : `${other} other tools`)
  if (parts.length > 0) return parts.join(', ')
  const thoughts = rows.filter((row): row is AgentThought => row.kind === 'thought')
  if (thoughts.length === 1) return `Thought ${thoughts[0].seconds}s`
  return thoughts.length > 1 ? `Thought ${thoughts.length} times` : 'Working'
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    read_file: 'Read',
    grep: 'Grep',
    list_files: 'List',
    edit_file: 'Edit',
    write_file: 'Write',
    move_file: 'Move',
    delete_file: 'Delete',
    run_command: 'Run',
    web_search: 'Search',
    fetch_url: 'Fetch'
  }
  return labels[name] ?? name
}

function sessionOption(info: AgentSessionInfo): HTMLOptionElement {
  const option = document.createElement('option')
  option.value = info.id
  option.dataset.created = info.created
  if (info.title && info.title !== 'New session') option.dataset.titled = '1'
  option.textContent = info.title && info.title !== 'New session'
    ? `${formatStamp(info.created)} — ${info.title}`
    : formatStamp(info.created)
  return option
}

function optionFor(value: string, label: string): HTMLOptionElement {
  const option = document.createElement('option')
  option.value = value
  option.textContent = label
  return option
}

function formatStamp(iso: string): string {
  const date = new Date(iso)
  if (Number.isNaN(date.getTime())) return iso
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec']
  const hours = String(date.getHours()).padStart(2, '0')
  const minutes = String(date.getMinutes()).padStart(2, '0')
  return `${date.getDate()} ${months[date.getMonth()]} ${hours}:${minutes}`
}

function clipTitle(text: string): string {
  const line = text.split('\n').map((part) => part.trim()).find((part) => part.length > 0) ?? 'New session'
  return line.length > 48 ? `${line.slice(0, 48)}…` : line
}

function insertPaste(input: HTMLElement, pasted: string, info: TextReference | null): void {
  const node = info ? makeChip(info) : document.createTextNode(pasted)
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !input.contains(selection.anchorNode)) {
    input.append(node)
    return
  }
  const range = selection.getRangeAt(0)
  range.deleteContents()
  range.insertNode(node)
  range.setStartAfter(node)
  range.collapse(true)
  selection.removeAllRanges()
  selection.addRange(range)
}

function makeChip(info: TextReference): HTMLElement {
  const chip = document.createElement('span')
  chip.className = 'agent-ref'
  chip.contentEditable = 'false'
  chip.dataset.label = referenceLabel(info)
  chip.dataset.detail = referenceDetail(info)
  chip.dataset.file = info.file
  chip.dataset.path = info.path
  chip.dataset.absolute = info.absolute ?? ''
  chip.dataset.kind = info.kind
  chip.dataset.start = String(info.start)
  chip.dataset.end = String(info.end)
  sources.set(chip, info.raw || info.text)
  const icon = document.createElement('span')
  icon.className = 'agent-ref-icon'
  icon.textContent = info.kind === 'terminal' ? '>_ ' : ''
  chip.append(icon, document.createTextNode(chip.dataset.label))
  return chip
}

function deleteAdjacent(input: HTMLElement, backward: boolean): boolean {
  const selection = window.getSelection()
  if (!selection || selection.rangeCount === 0 || !input.contains(selection.anchorNode)) return false
  const range = selection.getRangeAt(0)
  if (!range.collapsed) return false
  const node = range.startContainer
  const offset = range.startOffset
  let neighbor: ChildNode | null = null
  if (node === input) neighbor = input.childNodes[backward ? offset - 1 : offset] ?? null
  else if (node.nodeType === Node.TEXT_NODE) {
    if (backward && offset === 0) neighbor = node.previousSibling
    if (!backward && offset === node.textContent?.length) neighbor = node.nextSibling
  }
  if (neighbor instanceof HTMLElement && neighbor.classList.contains('agent-ref')) {
    neighbor.remove()
    return true
  }
  return false
}

function partsFrom(node: Node): Part[] {
  const parts: Part[] = []
  node.childNodes.forEach((child) => {
    if (child.nodeType === Node.TEXT_NODE) {
      if (child.textContent) parts.push({ type: 'text', text: child.textContent })
    } else if (child instanceof HTMLElement && child.classList.contains('agent-ref')) {
      parts.push({
        type: 'ref',
        label: child.dataset.label ?? '',
        detail: child.dataset.detail || child.dataset.label || '',
        file: child.dataset.file ?? '',
        path: child.dataset.path ?? '',
        absolute: child.dataset.absolute ?? '',
        text: sources.get(child) ?? '',
        kind: child.dataset.kind ?? 'file',
        start: Number(child.dataset.start) || 0,
        end: Number(child.dataset.end) || 0
      })
    } else if (child instanceof HTMLBRElement) {
      parts.push({ type: 'text', text: '\n' })
    } else if (child instanceof HTMLDivElement) {
      if (parts.length) parts.push({ type: 'text', text: '\n' })
      parts.push(...partsFrom(child))
    }
  })
  return parts
}

function requestText(parts: Part[]): string {
  const chunks: string[] = []
  for (const part of parts) {
    if (part.type === 'text') {
      if (part.text.trim()) chunks.push(part.text.trim())
      continue
    }
    if (part.kind === 'file') chunks.push(fileCitation(part))
    else chunks.push(`Terminal selection (${part.detail}):\n${part.text}`)
  }
  return chunks.join('\n\n').trim()
}

function fileCitation(part: Extract<Part, { type: 'ref' }>): string {
  const location = part.path || part.absolute || part.file
  if (!part.start) return `Referenced ${location}.`
  const span = part.start === part.end ? `line ${part.start}` : `lines ${part.start}-${part.end}`
  return `Referenced ${location} ${span}.`
}

function citedFiles(parts: Part[]): AgentContextFile[] {
  const files: AgentContextFile[] = []
  for (const part of parts) {
    if (part.type !== 'ref' || part.kind !== 'file') continue
    const location = part.path || part.absolute || part.file
    if (!location || files.some((item) => sameLocation(item.path, location))) continue
    files.push({ name: part.file || location.split(/[\\/]/).pop() || location, path: location })
  }
  return files
}

function sameLocation(left: string, right: string): boolean {
  return left.replace(/\\/g, '/') === right.replace(/\\/g, '/')
}

function roleLabel(text: string): HTMLElement {
  const label = document.createElement('div')
  label.className = 'agent-role'
  label.textContent = text
  return label
}

function bubble(fill: (parent: HTMLElement, parts: Part[]) => void, parts: Part[]): HTMLElement {
  const body = document.createElement('div')
  body.className = 'agent-bubble'
  fill(body, parts)
  return body
}

function renderParts(parent: HTMLElement, parts: Part[]): void {
  for (const part of parts) {
    if (part.type === 'ref') {
      const chip = document.createElement('span')
      chip.className = 'agent-ref'
      const icon = document.createElement('span')
      icon.className = 'agent-ref-icon'
      icon.textContent = part.kind === 'terminal' ? '>_ ' : ''
      chip.append(icon, document.createTextNode(part.label))
      parent.append(chip)
    } else {
      parent.append(document.createTextNode(part.text))
    }
  }
}

function renderMarkdown(parent: HTMLElement, source: string): void {
  const chunks: Array<{ type: 'md'; text: string } | { type: 'code'; lang: string; text: string }> = []
  const pattern = /```([^\n]*)\n([\s\S]*?)```/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    if (match.index > last) chunks.push({ type: 'md', text: source.slice(last, match.index) })
    chunks.push({ type: 'code', lang: match[1].trim(), text: match[2].replace(/\n$/, '') })
    last = match.index + match[0].length
  }
  if (last < source.length) chunks.push({ type: 'md', text: source.slice(last) })
  for (const chunk of chunks) {
    if (chunk.type === 'md') renderBlocks(parent, chunk.text)
    else {
      const pre = document.createElement('pre')
      pre.className = 'agent-md-code'
      if (chunk.lang) {
        const badge = document.createElement('span')
        badge.className = 'agent-md-lang'
        badge.textContent = chunk.lang
        pre.append(badge)
      }
      const code = document.createElement('code')
      code.textContent = chunk.text
      pre.append(code)
      parent.append(pre)
    }
  }
}

function renderBlocks(parent: HTMLElement, source: string): void {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    if (line.startsWith('@@ref ')) {
      const caption = document.createElement('div')
      caption.className = 'agent-ref-detail'
      caption.textContent = line.slice(6)
      parent.append(caption)
      index += 1
      continue
    }
    const heading = /^(#{1,3})\s+(.*)$/.exec(line)
    if (heading) {
      const title = document.createElement('div')
      title.className = 'agent-md-h'
      appendInline(title, heading[2])
      parent.append(title)
      index += 1
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      const list = document.createElement('ul')
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) {
        const item = document.createElement('li')
        appendInline(item, lines[index].replace(/^[-*]\s+/, ''))
        list.append(item)
        index += 1
      }
      parent.append(list)
      continue
    }
    const paragraph: string[] = []
    while (
      index < lines.length &&
      lines[index].trim() &&
      !lines[index].startsWith('@@ref ') &&
      !/^#{1,3}\s+/.test(lines[index]) &&
      !/^[-*]\s+/.test(lines[index])
    ) {
      paragraph.push(lines[index])
      index += 1
    }
    const block = document.createElement('p')
    appendInline(block, paragraph.join(' '))
    parent.append(block)
  }
}

function appendInline(parent: HTMLElement, text: string): void {
  const pattern = /(`+)([\s\S]*?)\1|\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)))
    if (match[1]) {
      const code = document.createElement('code')
      code.textContent = match[2]
      parent.append(code)
    } else if (match[3]) {
      const strong = document.createElement('strong')
      strong.textContent = match[3]
      parent.append(strong)
    } else {
      const em = document.createElement('em')
      em.textContent = match[4]
      parent.append(em)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)))
}

function must(root: ParentNode, selector: string): HTMLElement {
  const el = root.querySelector(selector)
  if (!(el instanceof HTMLElement)) throw new Error(`Missing ${selector}`)
  return el
}
