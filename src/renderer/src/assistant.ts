import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { LanguageDescription, indentOnInput } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { searchKeymap, openSearchPanel } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view'
import type { AgentThought, AgentToolUse, AgentTrace, AssistantEvent, AssistantSessionState, AssistantSettings, InstalledModel } from '../../shared/types'
import { renderMarkdown } from './markdown'
import { DEFAULT_AGENT_MODEL } from '../../shared/types'

const MODEL_KEY = 'smith.assistant.model'
const THINK_KEY = 'smith.assistant.think'
const EXTRA_KEY = 'smith.assistant.extra'

export type AssistantPanel = {
  setOpen: (open: boolean) => void
  save: () => void
  find: () => void
  contains: (node: Node | null) => boolean
}

export function mountAssistant(host: HTMLElement): AssistantPanel {
  host.innerHTML = `
    <aside class="assistant-sessions">
      <div class="assistant-session-bar">
        <span>Sessions</span>
        <button class="assistant-new-text" type="button">New</button>
      </div>
      <div class="assistant-session-list"></div>
    </aside>
    <section class="assistant-chat">
      <div class="assistant-head">
        <span class="assistant-title">Assistant</span>
        <button class="agent-settings" type="button" title="Assistant settings" aria-label="Assistant settings">${gearIcon()}</button>
        <button class="assistant-stop" type="button" disabled>Stop</button>
      </div>
      <div class="assistant-log"></div>
      <div class="assistant-status"></div>
      <form class="agent-composer assistant-composer">
        <div class="agent-input assistant-input" contenteditable="true" tabindex="0" role="textbox" aria-label="Message the assistant"></div>
        <div class="agent-composer-bar">
          <div class="agent-composer-left">
            <select class="agent-model agent-model-quick assistant-model-quick" aria-label="Model"></select>
          </div>
          <div class="agent-composer-right">
            <button class="agent-send assistant-send" type="submit" aria-label="Send" title="Send">${sendIcon()}</button>
          </div>
        </div>
      </form>
      <div class="agent-settings-window assistant-settings" hidden tabindex="-1" role="dialog" aria-label="Assistant settings">
        <div class="agent-settings-head">
          <span>Assistant settings</span>
          <button class="agent-settings-close" type="button" title="Close">×</button>
        </div>
        <div class="agent-settings-body">
          <section class="agent-settings-section">
            <h2>Model</h2>
            <div class="agent-model-row">
              <select class="assistant-model" aria-label="Model"></select>
              <button class="agent-think assistant-think" type="button" aria-pressed="false">Think</button>
            </div>
            <p class="agent-settings-note">This model answers and updates the page.</p>
          </section>
          <section class="agent-settings-section">
            <h2>Instructions</h2>
            <pre class="agent-instructions assistant-instructions"></pre>
            <p class="agent-settings-note">These are sent with every message.</p>
          </section>
          <section class="agent-settings-section">
            <h2>Additional instructions</h2>
            <textarea class="agent-extra assistant-extra" maxlength="8000" spellcheck="true" placeholder="Optional notes added after the instructions above."></textarea>
          </section>
        </div>
      </div>
    </section>
    <section class="assistant-doc">
      <div class="assistant-doc-bar"><span>Document</span><button class="assistant-doc-edit" type="button">Edit</button></div>
      <div class="assistant-doc-view"></div>
      <div class="assistant-doc-editor" hidden></div>
    </section>
  `

  const list = must(host, '.assistant-session-list')
  const log = must(host, '.assistant-log')
  const status = must(host, '.assistant-status')
  const form = must(host, '.assistant-composer') as HTMLFormElement
  const input = must(host, '.assistant-input')
  const stopButton = must(host, '.assistant-stop') as HTMLButtonElement
  const settingsButton = must(host, '.agent-settings') as HTMLButtonElement
  const settingsWindow = must(host, '.assistant-settings')
  const modelSelect = must(host, '.assistant-model') as HTMLSelectElement
  const quickModel = must(host, '.assistant-model-quick') as HTMLSelectElement
  const thinkButton = must(host, '.assistant-think') as HTMLButtonElement
  const extraInput = must(host, '.assistant-extra') as HTMLTextAreaElement
  const instructions = must(host, '.assistant-instructions')
  const docHost = must(host, '.assistant-doc-editor')
  const docView = must(host, '.assistant-doc-view')
  const editButton = must(host, '.assistant-doc-edit') as HTMLButtonElement

  const readOnly = new Compartment()
  const language = new Compartment()
  let suppressDoc = false
  let editing = false
  let source = ''
  let saveTimer = 0
  const view = new EditorView({
    parent: docHost,
    state: EditorState.create({
      doc: '',
      extensions: [
        lineNumbers(),
        drawSelection(),
        history(),
        indentOnInput(),
        keymap.of([...defaultKeymap, ...searchKeymap, ...historyKeymap]),
        oneDark,
        EditorView.lineWrapping,
        language.of([]),
        readOnly.of([]),
        EditorView.theme({
          '&': { height: '100%', fontSize: '14px' },
          '.cm-scroller': { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace' }
        }),
        EditorView.updateListener.of((update) => {
          if (suppressDoc || !update.docChanged) return
          window.clearTimeout(saveTimer)
          saveTimer = window.setTimeout(() => save(), 400)
        })
      ]
    })
  })

  let state: AssistantSessionState | null = null
  let busy = false
  let live: HTMLElement | null = null
  let liveActivity: { add(row: AgentTrace): void } | null = null
  let opened = false
  let pendingUser = ''

  thinkButton.setAttribute('aria-pressed', localStorage.getItem(THINK_KEY) === '1' ? 'true' : 'false')
  extraInput.value = localStorage.getItem(EXTRA_KEY) ?? ''

  must(host, '.assistant-new-text').addEventListener('click', () => { void create() })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void send()
  })
  stopButton.addEventListener('click', () => { void window.api.stopAssistant() })
  settingsButton.addEventListener('click', () => {
    settingsWindow.hidden = !settingsWindow.hidden
    if (!settingsWindow.hidden) {
      void refreshSettings()
      settingsWindow.focus()
    }
  })
  must(host, '.agent-settings-close').addEventListener('click', () => { settingsWindow.hidden = true })
  modelSelect.addEventListener('change', () => chooseModel(modelSelect.value))
  quickModel.addEventListener('change', () => chooseModel(quickModel.value))
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      void send()
    }
  })
  input.addEventListener('paste', (event) => {
    event.preventDefault()
    const pasted = event.clipboardData?.getData('text/plain') ?? ''
    if (pasted) document.execCommand('insertText', false, pasted)
  })
  editButton.addEventListener('click', () => toggleDocEdit())
  thinkButton.addEventListener('click', () => {
    const next = thinkButton.getAttribute('aria-pressed') !== 'true'
    thinkButton.setAttribute('aria-pressed', next ? 'true' : 'false')
    localStorage.setItem(THINK_KEY, next ? '1' : '0')
  })
  extraInput.addEventListener('input', () => {
    localStorage.setItem(EXTRA_KEY, extraInput.value)
    void showInstructions()
  })
  window.api.onAssistantEvent((event) => applyEvent(event))

  void loadLanguage()

  function setOpen(open: boolean): void {
    host.classList.toggle('open', open)
    if (!open) {
      window.clearTimeout(saveTimer)
      save()
      return
    }
    if (!opened) {
      opened = true
      void fillModels()
      void load()
    }
  }

  async function load(): Promise<void> {
    try {
      await show(await window.api.listAssistantSessions())
    } catch (error) {
      status.textContent = messageOf(error)
    }
  }

  async function create(): Promise<void> {
    if (busy) return
    save()
    await show(await window.api.newAssistantSession())
  }

  async function show(next: AssistantSessionState): Promise<void> {
    state = next
    paintSessions()
    paintLog()
    setDocument(next.document)
    status.textContent = ''
  }

  function paintSessions(): void {
    list.replaceChildren()
    if (!state) return
    for (const info of state.sessions) {
      const row = document.createElement('div')
      row.className = 'assistant-session'
      if (info.id === state.session.id) row.classList.add('active')
      const open = document.createElement('button')
      open.type = 'button'
      open.className = 'assistant-session-open'
      const title = document.createElement('span')
      title.className = 'assistant-session-title'
      title.textContent = info.title
      open.append(title)
      open.addEventListener('click', () => {
        if (!state || info.id === state.session.id || busy) return
        save()
        void window.api.readAssistantSession(info.id).then(show).catch((error) => { status.textContent = messageOf(error) })
      })
      const remove = document.createElement('button')
      remove.type = 'button'
      remove.className = 'assistant-session-delete'
      remove.title = 'Delete session'
      remove.textContent = '×'
      remove.addEventListener('click', () => {
        if (busy) return
        void window.api.deleteAssistantSession(info.id).then(show).catch((error) => { status.textContent = messageOf(error) })
      })
      row.append(open, remove)
      list.append(row)
    }
  }

  function paintLog(): void {
    log.replaceChildren()
    live = null
    if (!state || state.session.turns.length === 0) {
      const empty = document.createElement('div')
      empty.className = 'agent-empty'
      empty.textContent = 'Ask for research or writing. The page on the right is the working document.'
      log.append(empty)
      return
    }
    for (const turn of state.session.turns) {
      const bubble = document.createElement('div')
      bubble.className = turn.role === 'user' ? 'agent-msg agent-msg-user' : 'agent-msg agent-msg-agent'
      const body = document.createElement('div')
      body.className = 'agent-bubble'
      if (turn.role === 'assistant' && turn.tools && turn.tools.length > 0) {
        const trail = document.createElement('div')
        trail.className = 'agent-trail'
        const activity = createActivity(trail, false)
        for (const item of turn.tools) activity.add(item)
        body.append(trail)
      }
      const text = document.createElement('div')
      if (turn.role === 'assistant') renderMarkdown(text, turn.content)
      else text.textContent = turn.content
      body.append(text)
      bubble.append(body)
      log.append(bubble)
    }
    log.scrollTop = log.scrollHeight
  }

  function setDocument(text: string): void {
    source = text
    if (view.state.doc.toString() !== text) {
      suppressDoc = true
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
      suppressDoc = false
    }
    if (!editing) renderDocument()
  }

  function renderDocument(): void {
    docView.replaceChildren()
    if (!source.trim()) {
      const empty = document.createElement('p')
      empty.className = 'assistant-doc-empty'
      empty.textContent = 'This page is empty.'
      docView.append(empty)
      return
    }
    renderMarkdown(docView, source)
  }

  function toggleDocEdit(): void {
    if (editing) {
      source = view.state.doc.toString()
      editing = false
      editButton.textContent = 'Edit'
      docHost.hidden = true
      docView.hidden = false
      renderDocument()
      save()
      return
    }
    editing = true
    editButton.textContent = 'Done'
    docView.hidden = true
    docHost.hidden = false
    view.requestMeasure()
    view.focus()
  }

  function save(): void {
    if (!state) return
    if (editing) source = view.state.doc.toString()
    void window.api.writeAssistantDocument(state.session.id, source)
  }

  async function send(): Promise<void> {
    if (!state || busy) return
    const text = (input.textContent ?? '').trim()
    if (!text) return
    pendingUser = text
    input.textContent = ''
    save()
    await run(() => window.api.runAssistant(state!.session.id, text, currentSettings()))
  }

  async function run(work: () => Promise<string>): Promise<void> {
    if (!state) return
    busy = true
    stopButton.disabled = false
    view.dispatch({ effects: readOnly.reconfigure(EditorState.readOnly.of(true)) })
    beginLive()
    try {
      await work()
      if (state) await show(await window.api.readAssistantSession(state.session.id))
    } catch (error) {
      status.textContent = messageOf(error)
      if (pendingUser) input.textContent = pendingUser
      paintLog()
    } finally {
      busy = false
      stopButton.disabled = true
      view.dispatch({ effects: readOnly.reconfigure([]) })
      live = null
      liveActivity = null
    }
  }

  function beginLive(): void {
    if (log.querySelector('.agent-empty')) log.replaceChildren()
    const user = document.createElement('div')
    user.className = 'agent-msg agent-msg-user'
    const userBody = document.createElement('div')
    userBody.className = 'agent-bubble'
    userBody.textContent = pendingUser || '…'
    user.append(userBody)
    const reply = document.createElement('div')
    reply.className = 'agent-msg agent-msg-agent'
    const body = document.createElement('div')
    body.className = 'agent-bubble'
    const trail = document.createElement('div')
    trail.className = 'agent-trail'
    const text = document.createElement('div')
    body.append(trail, text)
    reply.append(body)
    log.append(user, reply)
    live = text
    liveActivity = createActivity(trail, true)
    log.scrollTop = log.scrollHeight
  }

  function applyEvent(event: AssistantEvent): void {
    if (event.type === 'status') status.textContent = event.text
    if (event.type === 'clear-content' && live) live.textContent = ''
    if (event.type === 'token' && event.channel === 'content' && live) {
      live.textContent = `${live.textContent ?? ''}${event.text}`
      log.scrollTop = log.scrollHeight
    }
    if (event.type === 'tool') {
      liveActivity?.add({ kind: 'tool', name: event.name, ok: event.ok, detail: event.detail })
      log.scrollTop = log.scrollHeight
    }
    if (event.type === 'thought') {
      liveActivity?.add({ kind: 'thought', seconds: event.seconds, text: event.text })
      log.scrollTop = log.scrollHeight
    }
    if (event.type === 'document' && busy) setDocument(event.text)
    if (event.type === 'error') status.textContent = event.text
  }

  function currentSettings(): AssistantSettings {
    return {
      model: modelSelect.value || localStorage.getItem(MODEL_KEY) || DEFAULT_AGENT_MODEL,
      think: thinkButton.getAttribute('aria-pressed') === 'true',
      extra: extraInput.value
    }
  }

  async function refreshSettings(): Promise<void> {
    await Promise.all([fillModels(), showInstructions()])
  }

  async function fillModels(): Promise<void> {
    let models: InstalledModel[] = []
    try {
      models = await window.api.listModels()
    } catch {
      models = []
    }
    const preferred = localStorage.getItem(MODEL_KEY) || DEFAULT_AGENT_MODEL
    fillSelect(modelSelect, models, preferred)
    fillSelect(quickModel, models, preferred)
    chooseModel(modelSelect.value || preferred)
  }

  function chooseModel(name: string): void {
    if (!name) return
    localStorage.setItem(MODEL_KEY, name)
    if ([...modelSelect.options].some((option) => option.value === name)) modelSelect.value = name
    if ([...quickModel.options].some((option) => option.value === name)) quickModel.value = name
  }

  async function showInstructions(): Promise<void> {
    instructions.textContent = await window.api.assistantPrompt(extraInput.value)
  }

  async function loadLanguage(): Promise<void> {
    const description = LanguageDescription.matchFilename(languages, 'document.md')
    const support = description ? await description.load() : null
    if (support) view.dispatch({ effects: language.reconfigure(support) })
  }

  return {
    setOpen,
    save() {
      window.clearTimeout(saveTimer)
      save()
    },
    find() {
      if (!editing) toggleDocEdit()
      openSearchPanel(view)
      view.focus()
    },
    contains(node) {
      return node instanceof Node && host.contains(node)
    }
  }
}

function fillSelect(select: HTMLSelectElement, models: InstalledModel[], preferred: string): void {
  const names = models.map((model) => model.name)
  if (preferred && !names.includes(preferred)) names.unshift(preferred)
  select.replaceChildren()
  for (const name of names) {
    const option = document.createElement('option')
    option.value = name
    option.textContent = name
    select.append(option)
  }
  if (names.includes(preferred)) select.value = preferred
  else if (names[0]) select.value = names[0]
}

function createActivity(host: HTMLElement, open: boolean): { add(row: AgentTrace): void } {
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
  const rows: AgentTrace[] = []
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

function activityRow(row: AgentTrace): HTMLLIElement {
  if (row.kind === 'thought') return thoughtRow(row)
  const item = document.createElement('li')
  item.className = 'agent-activity-row'
  if (row.kind === 'tool' && !row.ok) item.classList.add('agent-activity-failed')
  const label = document.createElement('span')
  label.className = 'agent-activity-label'
  label.textContent = row.kind === 'tool' ? toolLabel(row.name) : 'Context'
  const detail = document.createElement('span')
  detail.className = 'agent-activity-detail'
  const text = row.kind === 'tool' ? row.detail : `${row.tokens} tokens`
  detail.textContent = text
  if (text) detail.title = text
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

function activitySummary(rows: AgentTrace[]): string {
  const tools = rows.filter((row): row is AgentToolUse => row.kind === 'tool')
  if (tools.length === 1) {
    const tool = tools[0]
    const label = toolLabel(tool.name)
    return tool.detail ? `${label} ${tool.detail}` : label
  }
  const count = (names: string[]): number => tools.filter((tool) => names.includes(tool.name)).length
  const parts: string[] = []
  const whisper = count(['whisper'])
  const asked = count(['askTextAgent'])
  const searches = count(['web_search'])
  const fetched = count(['fetch_url'])
  const page = count(['read_document', 'edit_document', 'append_document', 'replace_document'])
  if (whisper) parts.push('Whisper')
  if (asked) parts.push(asked === 1 ? 'Asked the worker' : `Asked the worker ${asked} times`)
  if (searches) parts.push(searches === 1 ? '1 search' : `${searches} searches`)
  if (fetched) parts.push(fetched === 1 ? 'Fetched 1 page' : `Fetched ${fetched} pages`)
  if (page) parts.push(page === 1 ? 'Updated the page' : `Updated the page ${page} times`)
  const known = whisper + asked + searches + fetched + page
  const other = tools.length - known
  if (other > 0) parts.push(other === 1 ? '1 other step' : `${other} other steps`)
  if (parts.length > 0) return parts.join(', ')
  const thoughts = rows.filter((row) => row.kind === 'thought')
  return thoughts.length > 0 ? `Thought ${thoughts.length === 1 ? 'once' : `${thoughts.length} times`}` : 'Working'
}

function toolLabel(name: string): string {
  const labels: Record<string, string> = {
    whisper: 'Whisper',
    askTextAgent: 'Voice',
    worker: 'Worker',
    web_search: 'Search',
    fetch_url: 'Fetch',
    read_document: 'Read the page',
    edit_document: 'Edit the page',
    append_document: 'Add to the page',
    replace_document: 'Rewrite the page'
  }
  return labels[name] ?? name
}

function messageOf(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error)
  return raw.split('Error:').pop()?.trim() || raw
}

function sendIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M12 4.2 5.2 11l1.4 1.4L11 7.9V19.5h2V7.9l4.4 4.5 1.4-1.4L12 4.2z"/></svg>`
}

function must(scope: ParentNode, selector: string): HTMLElement {
  const node = scope.querySelector(selector)
  if (!(node instanceof HTMLElement)) throw new Error(`Missing ${selector}`)
  return node
}

function gearIcon(): string {
  return `<svg viewBox="0 0 24 24" width="14" height="14" aria-hidden="true"><path fill="currentColor" d="M19.4 13a7.8 7.8 0 0 0 .1-1 7.8 7.8 0 0 0-.1-1l2.1-1.6a.5.5 0 0 0 .1-.6l-2-3.4a.5.5 0 0 0-.6-.2l-2.5 1a7.4 7.4 0 0 0-1.7-1l-.4-2.6a.5.5 0 0 0-.5-.4h-4a.5.5 0 0 0-.5.4l-.4 2.6a7.4 7.4 0 0 0-1.7 1l-2.5-1a.5.5 0 0 0-.6.2l-2 3.4a.5.5 0 0 0 .1.6L4.6 11a7.8 7.8 0 0 0-.1 1 7.8 7.8 0 0 0 .1 1l-2.1 1.6a.5.5 0 0 0-.1.6l2 3.4a.5.5 0 0 0 .6.2l2.5-1a7.4 7.4 0 0 0 1.7 1l.4 2.6a.5.5 0 0 0 .5.4h4a.5.5 0 0 0 .5-.4l.4-2.6a7.4 7.4 0 0 0 1.7-1l2.5 1a.5.5 0 0 0 .6-.2l2-3.4a.5.5 0 0 0-.1-.6L19.4 13zM12 15.5A3.5 3.5 0 1 1 12 8.5a3.5 3.5 0 0 1 0 7z"/></svg>`
}
