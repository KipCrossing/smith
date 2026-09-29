import { app } from 'electron'
import { spawn, type ChildProcess } from 'child_process'
import { createServer } from 'net'
import { createWriteStream } from 'fs'
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { availableParallelism, tmpdir } from 'os'
import { dirname, join } from 'path'
import type { VoiceId, VoicePackage, VoiceProgress } from '../../shared/types'

const WHISPER_RELEASE = 'b5130'
const PIPER_RELEASE = '2023.11.14-2'
const WHISPER_MODEL_URL = 'https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-turbo-q5_0.bin'
const PIPER_VOICE_URL = 'https://huggingface.co/rhasspy/piper-voices/resolve/main/en/en_US/lessac/medium/en_US-lessac-medium'

const PACKAGES: Record<VoiceId, { name: string; detail: string }> = {
  whisper: { name: 'Whisper', detail: 'Speech to text · large-v3-turbo · about 560 MB' },
  piper: { name: 'Piper', detail: 'Text to speech · Lessac · about 80 MB' }
}

export function voiceRoot(): string {
  return join(app.getPath('userData'), 'voice')
}

export async function voiceStatus(): Promise<VoicePackage[]> {
  const ids: VoiceId[] = ['whisper', 'piper']
  return Promise.all(ids.map(async (id) => {
    const info = PACKAGES[id]
    const available = assetFor(id) !== null
    return {
      id,
      name: info.name,
      detail: available ? info.detail : 'No build is published for this computer',
      installed: available && await isInstalled(id),
      available
    }
  }))
}

export function warmWhisper(): void {
  void ensureServer().catch(() => undefined)
}

export function stopWhisper(): void {
  const current = whisperProcess
  whisperProcess = null
  whisperUrl = ''
  current?.kill()
  void rm(whisperPidFile(), { force: true })
}

export function stopSpeaking(): void {
  speechAbort?.abort()
}

export async function speakText(text: string): Promise<ArrayBuffer> {
  const spoken = text.trim()
  if (!spoken) throw new Error('There is nothing to read.')
  speechAbort?.abort()
  const controller = new AbortController()
  speechAbort = controller
  try {
    const wav = await runPiper(spoken, controller.signal)
    return bodyBytes(wav)
  } finally {
    if (speechAbort === controller) speechAbort = null
  }
}

export async function transcribeWav(wav: Buffer): Promise<string> {
  if (wav.length < 44) throw new Error('The recording was empty.')
  if (wav.length > 8_000_000) throw new Error('The recording is too long.')
  try {
    return await inferWav(wav)
  } catch (error) {
    if (!serverDown(error)) throw error
    stopWhisper()
    return inferWav(wav)
  }
}

export async function downloadVoice(
  id: VoiceId,
  onProgress: (progress: VoiceProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const asset = assetFor(id)
  if (!asset) throw new Error(`${PACKAGES[id].name} has no build for this computer.`)
  const root = join(voiceRoot(), id)
  const runtime = join(root, 'runtime')
  await mkdir(root, { recursive: true })
  await rm(runtime, { recursive: true, force: true })
  await mkdir(runtime, { recursive: true })

  const archive = join(root, 'runtime.part')
  onProgress({ id, status: `Downloading ${PACKAGES[id].name}`, completed: 0, total: 0 })
  await downloadFile(asset, archive, signal, (completed, total) => {
    onProgress({ id, status: `Downloading ${PACKAGES[id].name}`, completed, total })
  })
  throwIfAborted(signal)
  onProgress({ id, status: `Unpacking ${PACKAGES[id].name}`, completed: 0, total: 0 })
  await extractArchive(archive, runtime, signal)
  await rm(archive, { force: true })

  if (id === 'whisper') {
    const binary = await findFile(runtime, ['whisper-cli', 'whisper-cli.exe'])
    if (!binary) throw new Error('The Whisper download did not contain whisper-cli.')
    await makeExecutable(binary)
    const model = join(root, 'ggml-large-v3-turbo-q5_0.bin')
    onProgress({ id, status: 'Downloading the speech model', completed: 0, total: 0 })
    await downloadFile(WHISPER_MODEL_URL, model, signal, (completed, total) => {
      onProgress({ id, status: 'Downloading the speech model', completed, total })
    })
    warmWhisper()
    return
  }

  const binary = await findFile(runtime, ['piper', 'piper.exe'])
  if (!binary) throw new Error('The Piper download did not contain piper.')
  await makeExecutable(binary)
  const folder = dirname(binary)
  onProgress({ id, status: 'Downloading the Lessac voice', completed: 0, total: 0 })
  await downloadFile(`${PIPER_VOICE_URL}.onnx`, join(folder, 'en_US-lessac-medium.onnx'), signal, (completed, total) => {
    onProgress({ id, status: 'Downloading the Lessac voice', completed, total })
  })
  throwIfAborted(signal)
  onProgress({ id, status: 'Downloading the voice notes', completed: 0, total: 0 })
  await downloadFile(`${PIPER_VOICE_URL}.onnx.json`, join(folder, 'en_US-lessac-medium.onnx.json'), signal, (completed, total) => {
    onProgress({ id, status: 'Downloading the voice notes', completed, total })
  })
}

let whisperProcess: ChildProcess | null = null
let whisperUrl = ''
let whisperStarting: Promise<string> | null = null
let speechAbort: AbortController | null = null
let speaker: ChildProcess | null = null

async function inferWav(wav: Buffer): Promise<string> {
  const endpoint = await ensureServer()
  const payload = speechForm(wav)
  let response: Response
  try {
    response = await fetch(`${endpoint}/inference`, {
      method: 'POST',
      headers: { 'Content-Type': payload.contentType },
      body: bodyBytes(payload.body),
      signal: AbortSignal.timeout(120_000)
    })
  } catch (error) {
    if (!whisperAlive()) throw new Error('Whisper stopped. It will load again on the next recording.')
    if (error instanceof Error && error.name === 'TimeoutError') throw new Error('Transcription took too long.')
    throw error
  }
  const raw = await response.text()
  if (!response.ok) throw new Error(lastUsefulLine(raw) || 'Whisper could not transcribe that recording.')
  let text = raw
  try {
    const parsed = JSON.parse(raw) as { text?: string }
    if (typeof parsed.text === 'string') text = parsed.text
  } catch {
    text = raw
  }
  const spoken = cleanTranscript(text)
  if (!spoken || !/[0-9A-Za-z]/.test(spoken)) throw new Error('No speech was heard.')
  return spoken
}

function serverDown(error: unknown): boolean {
  return error instanceof Error && error.message === 'Whisper stopped. It will load again on the next recording.'
}

async function ensureServer(): Promise<string> {
  if (whisperAlive()) return whisperUrl
  if (!whisperStarting) whisperStarting = launchServer().finally(() => { whisperStarting = null })
  return whisperStarting
}

async function launchServer(): Promise<string> {
  const located = await locateWhisper()
  if (!located) throw new Error('Download Whisper in agent settings.')
  await stopStaleServer()
  await makeExecutable(located.server)
  const port = await freePort()
  const publicDir = join(voiceRoot(), 'whisper', 'server-public')
  await mkdir(publicDir, { recursive: true })
  const threads = Math.max(2, Math.min(8, availableParallelism()))
  const proc = spawn(located.server, [
    '-m', located.model,
    '--host', '127.0.0.1',
    '--port', String(port),
    '--public', publicDir,
    '-l', 'en',
    '-nt',
    '--no-gpu',
    '-t', String(threads),
    '-bs', '1',
    '-bo', '1'
  ], {
    cwd: dirname(located.server),
    env: libraryEnv(dirname(located.server))
  })
  whisperProcess = proc
  whisperUrl = `http://127.0.0.1:${port}`
  proc.on('exit', () => {
    if (whisperProcess === proc) {
      whisperProcess = null
      whisperUrl = ''
    }
  })
  try {
    if (proc.pid) await writeFile(whisperPidFile(), String(proc.pid))
    await waitUntilListening(proc)
  } catch (error) {
    if (whisperProcess === proc) {
      whisperProcess = null
      whisperUrl = ''
    }
    if (proc.exitCode === null) proc.kill()
    throw error
  }
  const drain = (): void => undefined
  proc.stdout?.on('data', drain)
  proc.stderr?.on('data', drain)
  return whisperUrl
}

function whisperPidFile(): string {
  return join(voiceRoot(), 'whisper', 'server.pid')
}

async function stopStaleServer(): Promise<void> {
  let pid = 0
  try {
    pid = Number(await readFile(whisperPidFile(), 'utf8'))
  } catch {
    return
  }
  if (!pid || pid === process.pid) return
  try {
    process.kill(pid, 'SIGTERM')
  } catch {
    await rm(whisperPidFile(), { force: true })
    return
  }
  const deadline = Date.now() + 3000
  while (Date.now() < deadline && processExists(pid)) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  if (processExists(pid)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // The previous server has already exited.
    }
  }
  await rm(whisperPidFile(), { force: true })
}

function processExists(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function whisperAlive(): boolean {
  return Boolean(whisperProcess && whisperProcess.exitCode === null && !whisperProcess.killed)
}

function waitUntilListening(proc: ChildProcess): Promise<void> {
  return new Promise((resolve, reject) => {
    let log = ''
    const timer = setTimeout(() => {
      cleanup()
      reject(new Error('Whisper took too long to load.'))
    }, 90_000)
    const onData = (chunk: Buffer): void => {
      log += chunk.toString()
      if (log.length > 8000) log = log.slice(-8000)
      if (log.includes('whisper server listening')) {
        cleanup()
        resolve()
      }
    }
    const onExit = (): void => {
      cleanup()
      reject(new Error(lastUsefulLine(log) || 'Whisper stopped while loading.'))
    }
    const onError = (error: Error): void => {
      cleanup()
      reject(error)
    }
    const cleanup = (): void => {
      clearTimeout(timer)
      proc.stdout?.off('data', onData)
      proc.stderr?.off('data', onData)
      proc.off('exit', onExit)
      proc.off('error', onError)
    }
    proc.stdout?.on('data', onData)
    proc.stderr?.on('data', onData)
    proc.on('exit', onExit)
    proc.on('error', onError)
  })
}

async function locateWhisper(): Promise<{ server: string; model: string } | null> {
  const root = join(voiceRoot(), 'whisper')
  const server = await findFile(join(root, 'runtime'), ['whisper-server', 'whisper-server.exe'])
  const model = join(root, 'ggml-large-v3-turbo-q5_0.bin')
  if (!server || !await bigEnough(model, 100_000_000)) return null
  return { server, model }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer()
    probe.once('error', reject)
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address()
      const port = typeof address === 'object' && address ? address.port : 0
      probe.close(() => resolve(port))
    })
  })
}

function bodyBytes(bytes: Buffer): ArrayBuffer {
  const copy = new ArrayBuffer(bytes.byteLength)
  new Uint8Array(copy).set(bytes)
  return copy
}

function speechForm(wav: Buffer): { body: Buffer; contentType: string } {
  const boundary = `smith-${Date.now()}`
  const head = Buffer.from(
    `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="speech.wav"\r\nContent-Type: audio/wav\r\n\r\n`
  )
  const tail = Buffer.from(`\r\n--${boundary}\r\nContent-Disposition: form-data; name="response_format"\r\n\r\njson\r\n--${boundary}--\r\n`)
  return {
    body: Buffer.concat([head, wav, tail]),
    contentType: `multipart/form-data; boundary=${boundary}`
  }
}

async function runPiper(text: string, signal: AbortSignal): Promise<Buffer> {
  const located = await locatePiper()
  if (!located) throw new Error('Download Piper in agent settings.')
  await makeExecutable(located.binary)
  const folder = dirname(located.binary)
  const dir = await mkdtemp(join(tmpdir(), 'smith-piper-'))
  const file = join(dir, 'speech.wav')
  try {
    await synthesize(located.binary, located.model, folder, file, text, signal)
    return await readFile(file)
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

function synthesize(binary: string, model: string, folder: string, file: string, text: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Speech cancelled.'))
      return
    }
    const proc = spawn(binary, [
      '--quiet',
      '-m', model,
      '--espeak_data', join(folder, 'espeak-ng-data'),
      '-f', file
    ], {
      cwd: folder,
      env: libraryEnv(folder)
    })
    speaker = proc
    let stderr = ''
    const onAbort = (): void => {
      proc.kill()
    }
    signal.addEventListener('abort', onAbort)
    proc.stderr.on('data', (chunk: Buffer) => {
      stderr += chunk.toString()
      if (stderr.length > 4000) stderr = stderr.slice(-4000)
    })
    proc.on('error', (error) => {
      signal.removeEventListener('abort', onAbort)
      if (speaker === proc) speaker = null
      reject(error)
    })
    proc.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (speaker === proc) speaker = null
      if (signal.aborted) reject(new Error('Speech cancelled.'))
      else if (code !== 0) reject(new Error(lastUsefulLine(stderr) || 'Piper could not read that reply.'))
      else resolve()
    })
    proc.stdin.write(text)
    proc.stdin.end()
  })
}

async function locatePiper(): Promise<{ binary: string; model: string } | null> {
  const root = join(voiceRoot(), 'piper')
  const binary = await findFile(join(root, 'runtime'), ['piper', 'piper.exe'])
  if (!binary) return null
  const model = join(dirname(binary), 'en_US-lessac-medium.onnx')
  if (!await bigEnough(model, 1_000_000)) return null
  return { binary, model }
}

function libraryEnv(libDir: string): NodeJS.ProcessEnv {
  const env = { ...process.env }
  const key = process.platform === 'darwin' ? 'DYLD_LIBRARY_PATH' : 'LD_LIBRARY_PATH'
  if (process.platform !== 'win32') env[key] = [libDir, env[key]].filter(Boolean).join(':')
  return env
}

function cleanTranscript(stdout: string): string {
  return stdout
    .split('\n')
    .map((line) => line.replace(/^\[[^\]]+\]\s*/, '').trim())
    .filter((line) => line && line !== '[BLANK_AUDIO]')
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function lastUsefulLine(text: string): string {
  return text.split('\n').map((line) => line.trim()).filter(Boolean).pop() ?? ''
}

function assetFor(id: VoiceId): string | null {
  if (id === 'whisper') return whisperAsset()
  return piperAsset()
}

function whisperAsset(): string | null {
  const base = `https://github.com/ggml-org/whisper.cpp/releases/download/${WHISPER_RELEASE}/`
  if (process.platform === 'linux' && process.arch === 'x64') return `${base}whisper-bin-ubuntu-x64.tar.gz`
  if (process.platform === 'linux' && process.arch === 'arm64') return `${base}whisper-bin-ubuntu-arm64.tar.gz`
  if (process.platform === 'win32' && process.arch === 'x64') return `${base}whisper-bin-x64.zip`
  if (process.platform === 'win32' && process.arch === 'ia32') return `${base}whisper-bin-Win32.zip`
  if (process.platform === 'win32' && process.arch === 'arm64') return `${base}whisper-bin-win-cpu-arm64.zip`
  return null
}

function piperAsset(): string | null {
  const base = `https://github.com/rhasspy/piper/releases/download/${PIPER_RELEASE}/`
  if (process.platform === 'linux' && process.arch === 'x64') return `${base}piper_linux_x86_64.tar.gz`
  if (process.platform === 'linux' && process.arch === 'arm64') return `${base}piper_linux_aarch64.tar.gz`
  if (process.platform === 'linux' && process.arch === 'arm') return `${base}piper_linux_armv7l.tar.gz`
  if (process.platform === 'darwin' && process.arch === 'arm64') return `${base}piper_macos_aarch64.tar.gz`
  if (process.platform === 'darwin' && process.arch === 'x64') return `${base}piper_macos_x64.tar.gz`
  if (process.platform === 'win32' && process.arch === 'x64') return `${base}piper_windows_amd64.zip`
  return null
}

async function isInstalled(id: VoiceId): Promise<boolean> {
  const root = join(voiceRoot(), id)
  if (id === 'whisper') {
    const binary = await findFile(join(root, 'runtime'), ['whisper-cli', 'whisper-cli.exe'])
    return Boolean(binary) && await bigEnough(join(root, 'ggml-large-v3-turbo-q5_0.bin'), 100_000_000)
  }
  const binary = await findFile(join(root, 'runtime'), ['piper', 'piper.exe'])
  if (!binary) return false
  const folder = dirname(binary)
  const voice = await bigEnough(join(folder, 'en_US-lessac-medium.onnx'), 1_000_000)
  const notes = await bigEnough(join(folder, 'en_US-lessac-medium.onnx.json'), 100)
  return voice && notes
}

async function bigEnough(path: string, minimum: number): Promise<boolean> {
  try {
    const info = await stat(path)
    return info.isFile() && info.size >= minimum
  } catch {
    return false
  }
}

async function findFile(dir: string, names: string[]): Promise<string | null> {
  let entries
  try {
    entries = await readdir(dir, { withFileTypes: true })
  } catch {
    return null
  }
  for (const entry of entries) {
    const full = join(dir, entry.name)
    if (entry.isDirectory()) {
      const found = await findFile(full, names)
      if (found) return found
    } else if (names.includes(entry.name)) {
      return full
    }
  }
  return null
}

async function makeExecutable(path: string): Promise<void> {
  if (process.platform === 'win32') return
  await chmod(path, 0o755)
}

async function downloadFile(
  url: string,
  destination: string,
  signal: AbortSignal,
  onProgress: (completed: number, total: number) => void
): Promise<void> {
  const partial = `${destination}.partial`
  const response = await fetch(url, { signal, redirect: 'follow', headers: { 'User-Agent': 'smith' } })
  if (!response.ok || !response.body) throw new Error(`Download failed (${response.status}).`)
  const total = Number(response.headers.get('content-length') || 0)
  const reader = response.body.getReader()
  const file = createWriteStream(partial)
  let completed = 0
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      throwIfAborted(signal)
      await writeChunk(file, Buffer.from(value))
      completed += value.byteLength
      onProgress(completed, total)
    }
    await endStream(file)
  } catch (error) {
    file.destroy()
    await rm(partial, { force: true })
    if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) {
      throw new Error('Download cancelled.')
    }
    throw error
  }
  await rename(partial, destination)
}

function writeChunk(file: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (file.write(chunk)) return Promise.resolve()
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      file.off('drain', onDrain)
      reject(error)
    }
    const onDrain = (): void => {
      file.off('error', onError)
      resolve()
    }
    file.once('error', onError)
    file.once('drain', onDrain)
  })
}

function endStream(file: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    file.end((error?: Error | null) => (error ? reject(error) : resolve()))
  })
}

function extractArchive(archive: string, destination: string, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Download cancelled.'))
      return
    }
    const child = spawn('tar', ['-xf', archive, '-C', destination])
    const onAbort = (): void => {
      child.kill()
    }
    signal.addEventListener('abort', onAbort)
    let message = ''
    child.stderr.on('data', (chunk: Buffer) => {
      message += chunk.toString()
    })
    child.on('error', () => {
      signal.removeEventListener('abort', onAbort)
      reject(new Error('Could not unpack the download. tar is required.'))
    })
    child.on('close', (code) => {
      signal.removeEventListener('abort', onAbort)
      if (signal.aborted) reject(new Error('Download cancelled.'))
      else if (code === 0) resolve()
      else reject(new Error(message.trim() || 'Could not unpack the download.'))
    })
  })
}

function throwIfAborted(signal: AbortSignal): void {
  if (signal.aborted) throw new Error('Download cancelled.')
}
