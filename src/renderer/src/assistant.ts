import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { LanguageDescription, indentOnInput } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { searchKeymap, openSearchPanel } from '@codemirror/search'
import { Compartment, EditorState } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import { drawSelection, EditorView, keymap, lineNumbers } from '@codemirror/view'
import type { AgentTrace, AssistantEvent, AssistantKind, AssistantSessionState, AssistantSettings, InstalledModel, VoicePackage, VoicechatStatus } from '../../shared/types'
import { renderMarkdown } from './markdown'
import { DEFAULT_AGENT_MODEL, DEFAULT_ASSISTANT_WORKER } from '../../shared/types'

const MODEL_KEY = 'smith.assistant.model'
const THINK_KEY = 'smith.assistant.think'
const EXTRA_KEY = 'smith.assistant.extra'
const WORKER_KEY = 'smith.assistant.worker'

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
        <button class="assistant-new-text" type="button">Text</button>
        <button class="assistant-new-voice" type="button">Voice</button>
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
        <div class="assistant-talk" hidden>
          <button class="assistant-talk-button" type="button">Talk</button>
          <p class="assistant-talk-note"></p>
        </div>
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
            <p class="agent-settings-note">Text sessions use this model. It is the one to choose when the page matters more than the conversation.</p>
          </section>
          <section class="agent-settings-section">
            <h2>Worker</h2>
            <select class="assistant-worker" aria-label="Worker model"></select>
            <p class="agent-settings-note">Voice sessions keep this smaller model beside VoiceChat. ${DEFAULT_ASSISTANT_WORKER} fits a 12 GB GPU. It searches and writes the document. The voice model only decides when to ask it.</p>
            <form class="agent-pull-form assistant-pull-form">
              <input class="assistant-pull-name" type="text" spellcheck="false" autocomplete="off" placeholder="${DEFAULT_ASSISTANT_WORKER}" aria-label="Model to download" />
              <button class="agent-pull-go" type="submit">Download</button>
            </form>
            <div class="agent-pull-track assistant-pull-track" hidden>
              <div class="agent-pull-bar" aria-hidden="true"><span class="agent-pull-fill assistant-pull-fill"></span></div>
              <div class="agent-pull-meta">
                <span class="assistant-pull-status"></span>
                <button class="agent-pull-cancel assistant-pull-cancel" type="button">Cancel</button>
              </div>
            </div>
            <p class="assistant-pull-note"></p>
          </section>
          <section class="agent-settings-section">
            <h2>Voice</h2>
            <ul class="assistant-setup-list">
              <li class="assistant-step" data-step="whisper">Whisper</li>
              <li class="assistant-step" data-step="worker">Worker model</li>
              <li class="assistant-step" data-step="weights">Voice weights</li>
              <li class="assistant-step" data-step="runtime">Speech program</li>
            </ul>
            <p class="assistant-voice-note"></p>
            <div class="assistant-voice-actions">
              <button class="assistant-setup" type="button">Set up voice</button>
            </div>
            <div class="agent-pull-track assistant-weight-track" hidden>
              <div class="agent-pull-bar" aria-hidden="true"><span class="agent-pull-fill assistant-weight-fill"></span></div>
              <div class="agent-pull-meta">
                <span class="assistant-weight-status"></span>
                <button class="agent-pull-cancel assistant-weight-cancel" type="button">Cancel</button>
              </div>
            </div>
            <p class="agent-settings-note">Whisper writes down what you said. The worker does the research and the page. The speech program is VoiceChat, compiled here because no Linux build is published. Set up voice does all of that.</p>
          </section>
          <section class="agent-settings-section">
            <h2>Instructions</h2>
            <pre class="agent-instructions assistant-instructions"></pre>
            <p class="agent-settings-note">These are sent with every text-session message. Voice sessions use a short prompt of their own, because each word of it costs time before the first reply.</p>
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
  const talkBox = must(host, '.assistant-talk')
  const talkButton = must(host, '.assistant-talk-button') as HTMLButtonElement
  const talkNote = must(host, '.assistant-talk-note')
  const stopButton = must(host, '.assistant-stop') as HTMLButtonElement
  const settingsButton = must(host, '.agent-settings') as HTMLButtonElement
  const settingsWindow = must(host, '.assistant-settings')
  const modelSelect = must(host, '.assistant-model') as HTMLSelectElement
  const quickModel = must(host, '.assistant-model-quick') as HTMLSelectElement
  const workerSelect = must(host, '.assistant-worker') as HTMLSelectElement
  const thinkButton = must(host, '.assistant-think') as HTMLButtonElement
  const extraInput = must(host, '.assistant-extra') as HTMLTextAreaElement
  const instructions = must(host, '.assistant-instructions')
  const pullForm = must(host, '.assistant-pull-form') as HTMLFormElement
  const pullName = must(host, '.assistant-pull-name') as HTMLInputElement
  const pullTrack = must(host, '.assistant-pull-track')
  const pullFill = must(host, '.assistant-pull-fill') as HTMLElement
  const pullStatus = must(host, '.assistant-pull-status')
  const pullNote = must(host, '.assistant-pull-note')
  const voiceNote = must(host, '.assistant-voice-note')
  const setupButton = must(host, '.assistant-setup') as HTMLButtonElement
  const weightTrack = must(host, '.assistant-weight-track')
  const weightFill = must(host, '.assistant-weight-fill') as HTMLElement
  const weightStatus = must(host, '.assistant-weight-status')
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
  let recording = false
  let capture: MediaRecorder | null = null
  let captureStream: MediaStream | null = null
  let live: HTMLElement | null = null
  let opened = false
  let pulling = ''
  let voicechat: VoicechatStatus | null = null
  let playback: HTMLAudioElement | null = null
  let pendingUser = ''
  const prepared = new Set<string>()

  thinkButton.setAttribute('aria-pressed', localStorage.getItem(THINK_KEY) === '1' ? 'true' : 'false')
  extraInput.value = localStorage.getItem(EXTRA_KEY) ?? ''

  must(host, '.assistant-new-text').addEventListener('click', () => { void create('text') })
  must(host, '.assistant-new-voice').addEventListener('click', () => { void create('voice') })
  form.addEventListener('submit', (event) => {
    event.preventDefault()
    void send()
  })
  talkButton.addEventListener('click', () => { void toggleTalk() })
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
  workerSelect.addEventListener('change', () => localStorage.setItem(WORKER_KEY, workerSelect.value))
  thinkButton.addEventListener('click', () => {
    const next = thinkButton.getAttribute('aria-pressed') !== 'true'
    thinkButton.setAttribute('aria-pressed', next ? 'true' : 'false')
    localStorage.setItem(THINK_KEY, next ? '1' : '0')
  })
  extraInput.addEventListener('input', () => {
    localStorage.setItem(EXTRA_KEY, extraInput.value)
    void showInstructions()
  })
  pullForm.addEventListener('submit', (event) => {
    event.preventDefault()
    void startPull(pullName.value)
  })
  must(host, '.assistant-pull-cancel').addEventListener('click', () => { void window.api.cancelPull() })
  setupButton.addEventListener('click', () => { void startSetup() })
  must(host, '.assistant-weight-cancel').addEventListener('click', () => { void window.api.cancelVoicechatDownload() })
  window.api.onPullProgress((progress) => {
    if (progress.model !== pulling) return
    const known = progress.total > 0
    pullFill.style.width = known ? `${Math.min(100, Math.round((progress.completed / progress.total) * 100))}%` : '40%'
    pullStatus.textContent = progress.status
  })
  window.api.onVoicechatProgress((progress) => {
    const known = progress.total > 0
    weightFill.style.width = known ? `${Math.min(100, Math.round((progress.completed / progress.total) * 100))}%` : '40%'
    weightStatus.textContent = progress.status
  })
  window.api.onAssistantEvent((event) => applyEvent(event))

  void loadLanguage()

  function setOpen(open: boolean): void {
    host.classList.toggle('open', open)
    if (!open) {
      window.clearTimeout(saveTimer)
      save()
      prepared.clear()
      void window.api.leaveAssistant()
      stopPlayback()
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

  async function create(kind: AssistantKind): Promise<void> {
    if (busy) return
    save()
    await show(await window.api.newAssistantSession(kind))
  }

  async function show(next: AssistantSessionState): Promise<void> {
    state = next
    paintSessions()
    paintLog()
    setDocument(next.document)
    paintComposer()
    if (next.session.kind === 'voice') {
      if (!prepared.has(next.session.id)) {
        status.textContent = 'Loading voice…'
        try {
          await window.api.prepareAssistantVoice(next.session.id, currentSettings())
          prepared.add(next.session.id)
          if (state?.session.id === next.session.id) status.textContent = ''
        } catch (error) {
          if (state?.session.id === next.session.id) status.textContent = messageOf(error)
        }
      }
    } else {
      prepared.clear()
      void window.api.leaveAssistant()
      status.textContent = ''
    }
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
      const kind = document.createElement('span')
      kind.className = 'assistant-session-kind'
      kind.textContent = info.kind === 'voice' ? 'Voice' : 'Text'
      open.append(title, kind)
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
      empty.textContent = state?.session.kind === 'voice'
        ? 'Hold a conversation. The page on the right is the work you share.'
        : 'Ask for research or writing. The page on the right is the working document.'
      log.append(empty)
      return
    }
    for (const turn of state.session.turns) {
      const bubble = document.createElement('div')
      bubble.className = turn.role === 'user' ? 'agent-msg agent-msg-user' : 'agent-msg agent-msg-agent'
      const body = document.createElement('div')
      body.className = 'agent-bubble'
      if (turn.role === 'assistant') renderMarkdown(body, turn.content)
      else body.textContent = turn.content
      bubble.append(body)
      if (turn.role === 'assistant' && turn.tools && state.session.kind === 'text') bubble.append(traceList(turn.tools))
      log.append(bubble)
    }
    log.scrollTop = log.scrollHeight
  }

  function paintComposer(): void {
    const voice = state?.session.kind === 'voice'
    input.hidden = voice === true
    form.querySelector('.agent-composer-bar')?.toggleAttribute('hidden', voice === true)
    talkBox.hidden = voice !== true
    if (!voice || !voicechat || voicechat.runtime === 'cuda' || voicechat.runtime === 'external') talkNote.textContent = ''
    else if (voicechat.runtime === 'cpu') talkNote.textContent = 'Voice is on the CPU, so replies are slow.'
    else talkNote.textContent = 'Set up voice in settings before talking.'
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
    if (!state || state.session.kind !== 'text' || busy) return
    const text = (input.textContent ?? '').trim()
    if (!text) return
    pendingUser = text
    input.textContent = ''
    save()
    await run(() => window.api.runAssistant(state!.session.id, text, currentSettings()))
  }

  async function toggleTalk(): Promise<void> {
    if (!state || state.session.kind !== 'voice' || busy) return
    if (recording) {
      stopCapture()
      return
    }
    const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mime = MediaRecorder.isTypeSupported('audio/webm;codecs=opus') ? 'audio/webm;codecs=opus' : ''
    const recorder = mime ? new MediaRecorder(stream, { mimeType: mime }) : new MediaRecorder(stream)
    const chunks: Blob[] = []
    recorder.addEventListener('dataavailable', (event) => {
      if (event.data.size > 0) chunks.push(event.data)
    })
    recorder.addEventListener('stop', () => {
      capture = null
      captureStream?.getTracks().forEach((track) => track.stop())
      captureStream = null
      void finishTalk(new Blob(chunks, { type: recorder.mimeType || 'audio/webm' }))
    })
    captureStream = stream
    capture = recorder
    recording = true
    talkButton.textContent = 'Stop'
    recorder.start()
  }

  function stopCapture(): void {
    recording = false
    talkButton.textContent = 'Talk'
    if (capture && capture.state !== 'inactive') capture.stop()
  }

  async function finishTalk(blob: Blob): Promise<void> {
    if (!state) return
    if (blob.size < 800) {
      status.textContent = 'The recording was too short.'
      return
    }
    pendingUser = ''
    const wav = await wavFromBlob(blob)
    const sessionId = state.session.id
    await run(async () => {
      const result = await window.api.talkAssistant(sessionId, wav, currentSettings())
      play(result.audio)
      return result.text
    })
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
      if (pendingUser && state?.session.kind === 'text') input.textContent = pendingUser
      paintLog()
    } finally {
      busy = false
      stopButton.disabled = true
      view.dispatch({ effects: readOnly.reconfigure([]) })
      live = null
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
    reply.append(body)
    log.append(user, reply)
    live = body
    log.scrollTop = log.scrollHeight
  }

  function applyEvent(event: AssistantEvent): void {
    if (event.type === 'status') status.textContent = event.text
    if (event.type === 'heard') {
      const bubbles = log.querySelectorAll('.agent-msg-user .agent-bubble')
      const last = bubbles[bubbles.length - 1]
      if (last) last.textContent = event.text
    }
    if (event.type === 'clear-content' && live) live.textContent = ''
    if (event.type === 'token' && event.channel === 'content' && live) {
      live.textContent = `${live.textContent ?? ''}${event.text}`
      log.scrollTop = log.scrollHeight
    }
    if (event.type === 'document' && busy) setDocument(event.text)
    if (event.type === 'error') status.textContent = event.text
  }

  function currentSettings(): AssistantSettings {
    return {
      model: modelSelect.value || localStorage.getItem(MODEL_KEY) || DEFAULT_AGENT_MODEL,
      worker: workerSelect.value || localStorage.getItem(WORKER_KEY) || DEFAULT_ASSISTANT_WORKER,
      think: thinkButton.getAttribute('aria-pressed') === 'true',
      extra: extraInput.value
    }
  }

  async function refreshSettings(): Promise<void> {
    await Promise.all([fillModels(), showInstructions(), showVoice()])
  }

  async function fillModels(): Promise<void> {
    let models: InstalledModel[] = []
    try {
      models = await window.api.listModels()
      pullNote.textContent = ''
    } catch (error) {
      pullNote.textContent = messageOf(error)
    }
    const preferred = localStorage.getItem(MODEL_KEY) || DEFAULT_AGENT_MODEL
    fillSelect(modelSelect, models, preferred)
    fillSelect(quickModel, models, preferred)
    chooseModel(modelSelect.value || preferred)
    fillSelect(workerSelect, models, localStorage.getItem(WORKER_KEY) || DEFAULT_ASSISTANT_WORKER)
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

  async function showVoice(): Promise<void> {
    voicechat = await window.api.voicechatStatus()
    const packages = await window.api.voiceStatus().catch((): VoicePackage[] => [])
    const whisper = packages.some((item) => item.id === 'whisper' && item.installed)
    const workerName = workerSelect.value || localStorage.getItem(WORKER_KEY) || DEFAULT_ASSISTANT_WORKER
    let workerReady = false
    try {
      workerReady = (await window.api.listModels()).some((model) => model.name === workerName)
    } catch {
      workerReady = false
    }
    paintStep('whisper', whisper, whisper ? 'Whisper is installed' : 'Whisper turns speech into text')
    paintStep('worker', workerReady, workerReady ? `${workerName} is installed` : `${workerName} does the research and writing`)
    paintStep('weights', voicechat.weights, voicechat.weights ? 'Voice weights are installed' : 'Voice weights are about 6 GB')
    paintStep('runtime', voicechat.runtime !== 'missing', runtimeLabel(voicechat))
    voiceNote.textContent = voicechat.note
    setupButton.textContent = voicechat.runtime !== 'missing' && voicechat.weights && whisper && workerReady ? 'Set up again' : 'Set up voice'
    paintComposer()
  }

  async function startSetup(): Promise<void> {
    weightTrack.hidden = false
    setupButton.disabled = true
    voiceNote.textContent = ''
    try {
      await window.api.setupVoicechat(workerSelect.value || localStorage.getItem(WORKER_KEY) || DEFAULT_ASSISTANT_WORKER)
      await fillModels()
      await showVoice()
    } catch (error) {
      voiceNote.textContent = messageOf(error)
    } finally {
      weightTrack.hidden = true
      setupButton.disabled = false
    }
  }

  function paintStep(step: string, ready: boolean, detail: string): void {
    const item = host.querySelector(`[data-step="${step}"]`)
    if (!(item instanceof HTMLElement)) return
    item.classList.toggle('ready', ready)
    item.textContent = detail
  }

  async function startPull(name: string): Promise<void> {
    const model = name.trim()
    if (!model || pulling) return
    pulling = model
    pullTrack.hidden = false
    pullNote.textContent = ''
    try {
      await window.api.pullModel(model)
      localStorage.setItem(WORKER_KEY, model)
      pullNote.textContent = `Installed ${model}.`
      await fillModels()
    } catch (error) {
      pullNote.textContent = messageOf(error)
    } finally {
      pulling = ''
      pullTrack.hidden = true
    }
  }

  function play(audio: Uint8Array): void {
    stopPlayback()
    const copy = new Uint8Array(audio.byteLength)
    copy.set(audio)
    const url = URL.createObjectURL(new Blob([copy], { type: 'audio/wav' }))
    const element = new Audio(url)
    playback = element
    element.addEventListener('ended', () => {
      URL.revokeObjectURL(url)
      if (playback === element) playback = null
    })
    void element.play().catch(() => undefined)
  }

  function stopPlayback(): void {
    playback?.pause()
    playback = null
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

function traceList(tools: AgentTrace[]): HTMLElement {
  const details = document.createElement('details')
  details.className = 'agent-activity'
  const summary = document.createElement('summary')
  summary.className = 'agent-activity-summary'
  summary.textContent = `${tools.length} ${tools.length === 1 ? 'step' : 'steps'}`
  const rows = document.createElement('ul')
  rows.className = 'agent-activity-list'
  for (const tool of tools) {
    const row = document.createElement('li')
    row.className = 'agent-activity-row'
    row.textContent = tool.kind === 'tool' ? `${tool.ok ? 'Done' : 'Failed'} · ${tool.name}${tool.detail ? ` · ${tool.detail}` : ''}` : tool.kind === 'thought' ? 'Thought' : ''
    if (row.textContent) rows.append(row)
  }
  details.append(summary, rows)
  return details
}

function runtimeLabel(status: VoicechatStatus): string {
  if (status.runtime === 'cuda') return 'Speech program uses the GPU'
  if (status.runtime === 'cpu') return 'Speech program uses the CPU'
  if (status.runtime === 'external') return 'Speech program is installed'
  return 'Speech program is compiled during setup'
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

async function wavFromBlob(blob: Blob): Promise<ArrayBuffer> {
  const bytes = await blob.arrayBuffer()
  const audio = new AudioContext()
  try {
    const decoded = await audio.decodeAudioData(bytes.slice(0))
    return encodeWav(resampleMono(decoded, 16000), 16000)
  } catch {
    throw new Error('Could not read that recording.')
  } finally {
    await audio.close()
  }
}

function resampleMono(buffer: AudioBuffer, sampleRate: number): Int16Array {
  const channels = buffer.numberOfChannels
  const length = buffer.length
  if (length === 0 || channels === 0) return new Int16Array()
  const mono = new Float32Array(length)
  for (let i = 0; i < length; i++) {
    let sum = 0
    for (let channel = 0; channel < channels; channel++) sum += buffer.getChannelData(channel)[i]
    mono[i] = sum / channels
  }
  const outLength = Math.max(1, Math.round(length * sampleRate / buffer.sampleRate))
  const pcm = new Int16Array(outLength)
  for (let i = 0; i < outLength; i++) {
    const position = i * buffer.sampleRate / sampleRate
    const left = Math.floor(position)
    const right = Math.min(left + 1, length - 1)
    const mix = mono[left] * (1 - (position - left)) + mono[right] * (position - left)
    const clamped = Math.max(-1, Math.min(1, mix))
    pcm[i] = clamped < 0 ? clamped * 0x8000 : clamped * 0x7fff
  }
  return pcm
}

function encodeWav(samples: Int16Array, sampleRate: number): ArrayBuffer {
  const buffer = new ArrayBuffer(44 + samples.length * 2)
  const view = new DataView(buffer)
  const write = (offset: number, text: string): void => {
    for (let i = 0; i < text.length; i++) view.setUint8(offset + i, text.charCodeAt(i))
  }
  write(0, 'RIFF')
  view.setUint32(4, 36 + samples.length * 2, true)
  write(8, 'WAVE')
  write(12, 'fmt ')
  view.setUint32(16, 16, true)
  view.setUint16(20, 1, true)
  view.setUint16(22, 1, true)
  view.setUint32(24, sampleRate, true)
  view.setUint32(28, sampleRate * 2, true)
  view.setUint16(32, 2, true)
  view.setUint16(34, 16, true)
  write(36, 'data')
  view.setUint32(40, samples.length * 2, true)
  for (let i = 0; i < samples.length; i++) view.setInt16(44 + i * 2, samples[i], true)
  return buffer
}
