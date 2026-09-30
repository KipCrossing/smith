import { app } from 'electron'
import { type ChildProcess, spawn } from 'child_process'
import { createWriteStream } from 'fs'
import { access, chmod, copyFile, mkdir, readFile, readdir, rename, rm, stat, writeFile } from 'fs/promises'
import { join } from 'path'
import { createInterface } from 'readline'
import { execFile } from 'child_process'
import { availableParallelism } from 'os'
import { promisify } from 'util'
import { listModels, pullModel } from './ollama'
import { downloadVoice, voiceStatus } from './voice'

const execFileAsync = promisify(execFile)
const RELEASE = 'v1.0.1'
const SOURCE = 'https://github.com/sansamour/llama-voicechat.cpp.git'
const CMAKE_URL = 'https://github.com/Kitware/CMake/releases/download/v3.31.8/cmake-3.31.8-linux-x86_64.tar.gz'
const KIND_FILE = 'runtime.txt'
const WEIGHT_BASE = 'https://huggingface.co/hoidhxd/NVIDIA-NemotronLabs-VoiceChat-11B-GGUF/resolve/main/llamacpp/'

const WEIGHTS: Array<{ name: string; minBytes: number }> = [
  { name: 'nemotron_voicechat_11b-stt-llm-Q4_0.gguf', minBytes: 4_000_000_000 },
  { name: 'nemotron_voicechat_11b-stt-llm-Q4_0-function-head.gguf', minBytes: 200_000_000 },
  { name: 'mmproj-voicechat-perception-Q4_0.gguf', minBytes: 300_000_000 },
  { name: 'voicechat-tts-Q4_0.gguf', minBytes: 500_000_000 }
]

export type VoiceRuntime = 'missing' | 'cpu' | 'cuda' | 'external'

export interface VoicechatStatus {
  binary: boolean
  binaryPath: string
  weights: boolean
  runtime: VoiceRuntime
  note: string
}

export interface VoicechatProgress {
  status: string
  completed: number
  total: number
}

type VoiceEvent = {
  name: string
  text: string
  raw: string
}

let child: ChildProcess | null = null
let booted = false
let sessionKey = ''
let ready: Promise<void> | null = null
let writeLine: ((line: string) => void) | null = null
let nextEvent: (() => Promise<VoiceEvent>) | null = null
let wake: ((event: VoiceEvent) => void) | null = null

export function voicechatRoot(): string {
  return join(app.getPath('userData'), 'voicechat')
}

export async function voicechatStatus(): Promise<VoicechatStatus> {
  const binaryPath = await findBinary()
  const weights = await weightsReady()
  const runtime = await runtimeKind(Boolean(binaryPath))
  const note = statusNote(runtime, weights)
  return { binary: Boolean(binaryPath), binaryPath, weights, runtime, note }
}

export async function setupVoicechat(
  worker: string,
  onProgress: (progress: VoicechatProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const packages = await voiceStatus()
  const whisper = packages.find((item) => item.id === 'whisper')
  if (!whisper?.installed) {
    if (!whisper?.available) throw new Error('Whisper has no build for this computer.')
    await downloadVoice('whisper', (progress) => {
      onProgress({ status: progress.status, completed: progress.completed, total: progress.total })
    }, signal)
  }
  const models = await listModels()
  if (!models.some((model) => model.name === worker)) {
    await pullModel(worker, (progress) => {
      onProgress({ status: progress.status || `Downloading ${worker}`, completed: progress.completed, total: progress.total })
    }, signal)
  }
  await downloadVoicechatWeights(onProgress, signal)
  await ensureRuntime(onProgress, signal)
}

export async function downloadVoicechatWeights(
  onProgress: (progress: VoicechatProgress) => void,
  signal: AbortSignal
): Promise<void> {
  const root = voicechatRoot()
  await mkdir(root, { recursive: true })
  for (const file of WEIGHTS) {
    const destination = join(root, file.name)
    if (await bigEnough(destination, file.minBytes)) continue
    const label = `Voice model, part ${WEIGHTS.indexOf(file) + 1} of ${WEIGHTS.length}`
    onProgress({ status: label, completed: 0, total: 0 })
    await downloadFile(`${WEIGHT_BASE}${file.name}`, destination, signal, (completed, total) => {
      onProgress({ status: label, completed, total })
    })
  }
}

export function voicePrepared(sessionId: string): boolean {
  return booted && sessionKey === sessionId && Boolean(child && child.exitCode === null && !child.killed)
}

export function closeVoice(): void {
  const current = child
  const notify = wake
  child = null
  booted = false
  sessionKey = ''
  ready = null
  writeLine = null
  nextEvent = null
  wake = null
  notify?.({ name: 'bye', text: 'Stopped.', raw: '' })
  current?.kill()
}

export async function prepareVoice(sessionId: string, system: string, signal?: AbortSignal): Promise<void> {
  if (child && sessionKey === sessionId && child.exitCode === null && !child.killed) {
    await ready
    return
  }
  closeVoice()
  const binary = await findBinary()
  if (!binary) {
    const status = await voicechatStatus()
    throw new Error(status.note)
  }
  if (!await weightsReady()) throw new Error('Download the VoiceChat weights in Assistant settings.')
  const root = voicechatRoot()
  sessionKey = sessionId
  const proc = spawn(binary, [
    '-m', join(root, WEIGHTS[0].name),
    '--mmproj', join(root, WEIGHTS[2].name),
    '--tts', join(root, WEIGHTS[3].name),
    '--serve',
    '-ngl', '99',
    '--session-seconds', '120'
  ], {
    cwd: root,
    env: { ...process.env, VC_NO_BARGE: '1', VC_FORCE_BOS: '1' },
    stdio: ['pipe', 'pipe', 'pipe']
  })
  child = proc
  let stderr = ''
  proc.stderr?.on('data', (chunk: Buffer) => {
    stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000)
  })
  const lines: VoiceEvent[] = []
  const waiters: Array<(event: VoiceEvent) => void> = []
  const push = (event: VoiceEvent): void => {
    const waiter = waiters.shift()
    if (waiter) waiter(event)
    else lines.push(event)
  }
  if (proc.stdout) {
    const reader = createInterface({ input: proc.stdout })
    reader.on('line', (line) => {
      const trimmed = line.trim()
      if (!trimmed) return
      push(parseEvent(trimmed))
    })
  }
  proc.on('exit', () => {
    if (child === proc) {
      child = null
      booted = false
      sessionKey = ''
      push({ name: 'bye', text: stderr.trim().slice(-500), raw: '' })
    }
  })
  writeLine = (line) => {
    proc.stdin?.write(`${line}\n`)
  }
  wake = push
  nextEvent = () => new Promise((resolve) => {
    const queued = lines.shift()
    if (queued) resolve(queued)
    else waiters.push(resolve)
  })
  ready = (async () => {
    const opened = await waitFor((event) => event.name === 'ready' || event.name === 'bye', signal)
    if (opened.name === 'bye') throw new Error(opened.text || 'VoiceChat stopped before it was ready.')
    send({ cmd: 'system', text: system })
    const primed = await waitFor((event) => event.name === 'system' || event.name === 'bye' || event.name === 'error', signal)
    if (primed.name !== 'system') throw new Error(primed.text || 'VoiceChat rejected the session prompt.')
  })()
  try {
    await ready
    booted = true
  } catch (error) {
    if (child === proc) closeVoice()
    throw error
  }
}

export async function voiceTurn(
  wav: Buffer,
  onText: (text: string) => void,
  onTool: (task: string) => Promise<string>,
  signal: AbortSignal
): Promise<{ text: string; audio: Buffer }> {
  if (!writeLine || !nextEvent || !ready) throw new Error('Voice is not ready.')
  await ready
  const root = voicechatRoot()
  const stamp = Date.now()
  const input = join(root, `in-${stamp}.wav`)
  const output = join(root, `out-${stamp}.wav`)
  await writeFile(input, wav)
  send({ cmd: 'turn', audio: input, out: output })
  let spoken = ''
  try {
    for (;;) {
      if (signal.aborted) throw new Error('Stopped.')
      const event = await nextEvent()
      if (event.name === 'assistant_text_delta' && event.text) {
        spoken += event.text
        onText(event.text)
      }
      if (event.name === 'tool_call') {
        const reply = await onTool(taskFrom(event.text || event.raw))
        send({ cmd: 'tool_response', text: reply })
      }
      if (event.name === 'error') throw new Error(event.text || 'VoiceChat failed.')
      if (event.name === 'bye') throw new Error(event.text || 'VoiceChat stopped.')
      if (event.name === 'turn_end') break
    }
  } finally {
    await rm(input, { force: true })
  }
  const audio = await readFile(output).catch(() => Buffer.alloc(0))
  await rm(output, { force: true })
  if (audio.length < 44) throw new Error('VoiceChat did not produce a reply.')
  return { text: spoken.trim(), audio }
}

function send(command: Record<string, unknown>): void {
  writeLine?.(JSON.stringify(command))
}

async function waitFor(match: (event: VoiceEvent) => boolean, signal?: AbortSignal): Promise<VoiceEvent> {
  if (!nextEvent) throw new Error('Voice is not ready.')
  for (;;) {
    if (signal?.aborted) throw new Error('Stopped.')
    const event = await nextEvent()
    if (match(event)) return event
  }
}

function parseEvent(line: string): VoiceEvent {
  if (!line.startsWith('{')) return { name: line, text: '', raw: line }
  try {
    const body = JSON.parse(line) as Record<string, unknown>
    const name = stringField(body, 'event') || stringField(body, 'type') || stringField(body, 'name') || stringField(body, 'cmd')
    const text = stringField(body, 'text') || stringField(body, 'delta') || stringField(body, 'content')
    return { name, text, raw: line }
  } catch {
    return { name: '', text: '', raw: line }
  }
}

function taskFrom(raw: string): string {
  const match = raw.match(/\{[\s\S]*\}|\[[\s\S]*\]/)
  if (!match) return raw.replace(/\s+/g, ' ').trim().slice(0, 500)
  try {
    const parsed = JSON.parse(match[0]) as unknown
    const call = Array.isArray(parsed) ? parsed[0] : parsed
    if (!call || typeof call !== 'object') return raw.slice(0, 500)
    const row = call as Record<string, unknown>
    const args = row.arguments ?? row.parameters
    if (typeof args === 'string') {
      try {
        const inner = JSON.parse(args) as Record<string, unknown>
        if (typeof inner.task === 'string') return inner.task.trim()
      } catch {
        return args.trim()
      }
    }
    if (args && typeof args === 'object' && typeof (args as Record<string, unknown>).task === 'string') {
      return String((args as Record<string, unknown>).task).trim()
    }
    if (typeof row.task === 'string') return row.task.trim()
  } catch {
    return raw.slice(0, 500)
  }
  return raw.replace(/\s+/g, ' ').trim().slice(0, 500)
}

function stringField(body: Record<string, unknown>, key: string): string {
  return typeof body[key] === 'string' ? body[key] : ''
}

function statusNote(runtime: VoiceRuntime, weights: boolean): string {
  if (runtime === 'missing') {
    return 'Set up voice downloads Whisper, the worker model, and the voice weights, then compiles the speech program on this computer. A CUDA toolkit makes that program use the GPU. Without one, Smith builds a CPU version and spoken replies are slower.'
  }
  if (!weights) return 'The speech program is installed. Set up voice still needs to download the voice weights.'
  if (runtime === 'cpu') return 'Voice is ready on the CPU, so spoken replies are slower than realtime. Install the CUDA toolkit and run setup again to rebuild for the GPU.'
  if (runtime === 'cuda') return 'Voice is ready and will use the GPU.'
  return 'Voice is ready.'
}

async function runtimeKind(binary: boolean): Promise<VoiceRuntime> {
  if (!binary) return 'missing'
  try {
    const kind = (await readFile(join(voicechatRoot(), KIND_FILE), 'utf8')).trim()
    if (kind === 'cpu' || kind === 'cuda') return kind
  } catch {
    return 'external'
  }
  return 'external'
}

async function ensureRuntime(onProgress: (progress: VoicechatProgress) => void, signal: AbortSignal): Promise<void> {
  const cuda = await findNvcc()
  const existing = await findBinary()
  const kind = await runtimeKind(Boolean(existing))
  if (existing && (kind === 'cuda' || kind === 'external' || (kind === 'cpu' && !cuda))) return
  if (process.platform !== 'linux' || process.arch !== 'x64') {
    throw new Error('This computer needs a llama-voicechat binary. Published builds are for Windows, and automatic compile is set up for Linux.')
  }
  const compiler = await which('g++')
  const git = await which('git')
  if (!git) throw new Error('Git is needed to download the speech program.')
  if (!compiler) throw new Error('A C++ compiler is needed to build the speech program. Install build-essential, then run setup again.')
  const cmake = await ensureCmake(onProgress, signal)
  const root = voicechatRoot()
  const src = join(root, 'src')
  if (!await fileExists(join(src, 'CMakeLists.txt'))) {
    await rm(src, { recursive: true, force: true })
    onProgress({ status: 'Downloading the speech program', completed: 0, total: 0 })
    await runCommand(git, ['clone', '--depth', '1', '--branch', RELEASE, SOURCE, src], root, signal, (line) => {
      onProgress({ status: line, completed: 0, total: 0 })
    })
  }
  const build = join(root, 'build')
  if (cuda && kind === 'cpu') await rm(build, { recursive: true, force: true })
  const configure = ['-S', src, '-B', build, '-DCMAKE_BUILD_TYPE=Release', `-DGGML_CUDA=${cuda ? 'ON' : 'OFF'}`]
  if (cuda) configure.push(`-DCMAKE_CUDA_COMPILER=${cuda}`)
  onProgress({
    status: cuda ? 'Configuring the GPU build' : 'No CUDA toolkit found. Configuring a CPU build',
    completed: 0,
    total: 0
  })
  await runCommand(cmake, configure, root, signal, (line) => onProgress({ status: line, completed: 0, total: 0 }))
  onProgress({ status: 'Compiling the speech program. This takes a while', completed: 0, total: 0 })
  await runCommand(cmake, ['--build', build, '--target', 'llama-voicechat', '-j', String(Math.max(1, availableParallelism() - 1))], root, signal, (line) => {
    onProgress({ status: `Compiling · ${line}`, completed: 0, total: 0 })
  })
  const built = await findNamed(build, 'llama-voicechat')
  if (!built) throw new Error('The build finished without producing llama-voicechat.')
  const destination = join(root, 'llama-voicechat')
  await copyFile(built, destination)
  await chmod(destination, 0o755)
  await writeFile(join(root, KIND_FILE), cuda ? 'cuda' : 'cpu', 'utf8')
}

async function ensureCmake(onProgress: (progress: VoicechatProgress) => void, signal: AbortSignal): Promise<string> {
  const installed = await which('cmake')
  if (installed) return installed
  const root = join(voicechatRoot(), 'cmake')
  const binary = join(root, 'cmake-3.31.8-linux-x86_64', 'bin', 'cmake')
  if (await fileExists(binary)) return binary
  await mkdir(root, { recursive: true })
  const archive = join(root, 'cmake.tar.gz')
  onProgress({ status: 'Downloading CMake', completed: 0, total: 0 })
  await downloadFile(CMAKE_URL, archive, signal, (completed, total) => {
    onProgress({ status: 'Downloading CMake', completed, total })
  })
  await runCommand('tar', ['-xzf', archive, '-C', root], root, signal, () => undefined)
  await rm(archive, { force: true })
  if (!await fileExists(binary)) throw new Error('CMake did not unpack.')
  return binary
}

async function findNvcc(): Promise<string> {
  const fromPath = await which('nvcc')
  if (fromPath) return fromPath
  for (const candidate of ['/usr/local/cuda/bin/nvcc', '/usr/lib/nvidia-cuda-toolkit/bin/nvcc']) {
    if (await fileExists(candidate)) return candidate
  }
  return ''
}

function runCommand(
  command: string,
  args: string[],
  cwd: string,
  signal: AbortSignal,
  onLine: (line: string) => void
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new Error('Download cancelled.'))
      return
    }
    const proc = spawn(command, args, {
      cwd,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe']
    })
    let stderr = ''
    const take = (chunk: Buffer): void => {
      stderr = `${stderr}${chunk.toString('utf8')}`.slice(-4_000)
      const line = stderr.split('\n').map((part) => part.trim()).filter(Boolean).pop()
      if (line) onLine(line.slice(0, 180))
    }
    const stop = (): void => {
      if (proc.pid && process.platform !== 'win32') {
        try { process.kill(-proc.pid, 'SIGTERM') } catch { proc.kill() }
      } else proc.kill()
    }
    signal.addEventListener('abort', stop)
    proc.stdout?.on('data', take)
    proc.stderr?.on('data', take)
    proc.on('error', (error) => {
      signal.removeEventListener('abort', stop)
      reject(error)
    })
    proc.on('exit', (code) => {
      signal.removeEventListener('abort', stop)
      if (signal.aborted) reject(new Error('Download cancelled.'))
      else if (code === 0) resolve()
      else reject(new Error(stderr.trim().split('\n').pop() || `Command failed (${code ?? 'unknown'}).`))
    })
  })
}

async function findNamed(dir: string, name: string): Promise<string> {
  const pending = [dir]
  while (pending.length > 0) {
    const current = pending.pop()
    if (!current) break
    let rows
    try {
      rows = await readdir(current, { withFileTypes: true })
    } catch {
      continue
    }
    for (const row of rows) {
      const full = join(current, row.name)
      if (row.isDirectory()) pending.push(full)
      else if (row.name === name) return full
    }
  }
  return ''
}

async function which(bin: string): Promise<string> {
  try {
    const { stdout } = await execFileAsync('which', [bin])
    return stdout.trim()
  } catch {
    return ''
  }
}

async function findBinary(): Promise<string> {
  const named = process.env.SMITH_VOICECHAT?.trim()
  const candidates = [named, join(voicechatRoot(), 'llama-voicechat'), join(voicechatRoot(), 'llama-voicechat.exe')].filter((item): item is string => Boolean(item))
  for (const candidate of candidates) {
    if (await fileExists(candidate)) return candidate
  }
  try {
    const { stdout } = await execFileAsync('which', ['llama-voicechat'])
    const found = stdout.trim()
    if (found) return found
  } catch {
    return ''
  }
  return ''
}

async function weightsReady(): Promise<boolean> {
  const checks = await Promise.all(WEIGHTS.map((file) => bigEnough(join(voicechatRoot(), file.name), file.minBytes)))
  return checks.every(Boolean)
}

async function bigEnough(file: string, minBytes: number): Promise<boolean> {
  try {
    const info = await stat(file)
    return info.isFile() && info.size >= minBytes
  } catch {
    return false
  }
}

async function fileExists(file: string): Promise<boolean> {
  try {
    await access(file)
    return true
  } catch {
    return false
  }
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
      const chunk = await reader.read()
      if (chunk.done) break
      if (signal.aborted) throw new Error('Download cancelled.')
      await writeChunk(file, Buffer.from(chunk.value))
      completed += chunk.value.byteLength
      onProgress(completed, total)
    }
    await endStream(file)
  } catch (error) {
    file.destroy()
    await rm(partial, { force: true })
    if (signal.aborted) throw new Error('Download cancelled.')
    throw error
  }
  await rename(partial, destination)
  await chmod(destination, 0o644).catch(() => undefined)
}

function writeChunk(file: ReturnType<typeof createWriteStream>, chunk: Buffer): Promise<void> {
  if (file.write(chunk)) return Promise.resolve()
  return new Promise((resolve) => file.once('drain', () => resolve()))
}

function endStream(file: ReturnType<typeof createWriteStream>): Promise<void> {
  return new Promise((resolve, reject) => {
    file.on('error', reject)
    file.end(() => resolve())
  })
}
