import { execFile } from 'child_process'
import { createHash } from 'crypto'
import { readdir, readFile, realpath, stat, writeFile } from 'fs/promises'
import path from 'path'
import { promisify } from 'util'
import { FILE_LIST_LIMIT } from '../../shared/types'
import { ensureAgentDir } from './history'
import { extractSymbols, type SourceSymbol } from './symbols'

const execFileAsync = promisify(execFile)

const INDEX_VERSION = 1
const INDEX_NAME = 'index.json'
const MAX_SCAN_BYTES = 200_000
const PROMPT_CHARS = 12_000
const TREE_CHARS = 3_500
const MAX_TREE_LINES = 60

const SKIP_DIRS = new Set([
  '.git',
  '.agent',
  'node_modules',
  'dist',
  'out',
  'build',
  'coverage',
  '.next',
  '.cache',
  'target',
  'vendor',
  '__pycache__',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache'
])

const BINARY_EXT = new Set([
  'png', 'jpg', 'jpeg', 'gif', 'webp', 'ico', 'bmp', 'pdf', 'zip', 'gz', 'tgz', 'bz2',
  '7z', 'rar', 'wasm', 'so', 'dll', 'dylib', 'exe', 'bin', 'o', 'a', 'class', 'jar',
  'mp3', 'mp4', 'mov', 'avi', 'webm', 'woff', 'woff2', 'ttf', 'eot', 'otf', 'lockb'
])

const SKIP_FILES = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'cargo.lock'])

type IndexedFile = {
  path: string
  bytes: number
  mtimeMs: number
  hash: string
  symbols: SourceSymbol[]
}

type ProjectIndex = {
  version: 1
  truncated: boolean
  files: IndexedFile[]
}

const chains = new Map<string, Promise<unknown>>()

export async function refreshProjectIndex(root: string): Promise<void> {
  const resolved = await realpath(root)
  await exclusive(resolved, () => rebuild(resolved))
}

export async function projectPrompt(root: string, focus: Array<string | null | undefined> = []): Promise<string> {
  const resolved = await realpath(root)
  return exclusive(resolved, async () => {
    const index = await readIndex(resolved)
    return renderPrompt(index, focusPaths(resolved, focus))
  })
}

async function rebuild(root: string): Promise<void> {
  const previous = await readIndex(root)
  const prior = new Map(previous.files.map((file) => [file.path, file]))
  const discovered = await discover(root)
  const files: IndexedFile[] = []
  for (const relative of discovered.paths) {
    const kept = await indexFile(root, relative, prior.get(relative))
    if (kept) files.push(kept)
  }
  files.sort((a, b) => a.path.localeCompare(b.path))
  const next: ProjectIndex = { version: INDEX_VERSION, truncated: discovered.truncated, files }
  const dir = await ensureAgentDir(root)
  const body = `${JSON.stringify(next)}\n`
  const current = await readFile(path.join(dir, INDEX_NAME), 'utf8').catch(() => '')
  if (current !== body) await writeFile(path.join(dir, INDEX_NAME), body, 'utf8')
}

async function indexFile(root: string, relative: string, previous: IndexedFile | undefined): Promise<IndexedFile | null> {
  const absolute = path.join(root, ...relative.split('/'))
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(absolute)
  } catch {
    return null
  }
  if (!info.isFile()) return null
  const bytes = info.size
  const mtimeMs = Math.round(info.mtimeMs)
  if (previous && previous.bytes === bytes && previous.mtimeMs === mtimeMs) return previous
  if (bytes > MAX_SCAN_BYTES) {
    return { path: relative, bytes, mtimeMs, hash: '', symbols: [] }
  }
  let data: Buffer
  try {
    data = await readFile(absolute)
  } catch {
    return null
  }
  if (data.includes(0)) return null
  const hash = createHash('sha1').update(data).digest('hex')
  if (previous && previous.hash === hash) return { ...previous, bytes, mtimeMs, hash }
  const text = data.toString('utf8')
  return { path: relative, bytes, mtimeMs, hash, symbols: extractSymbols(relative, text) }
}

async function discover(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  const fromGit = await gitFiles(root)
  const walked = fromGit ? { paths: fromGit, truncated: false } : await walkFiles(root)
  const kept = walked.paths.filter((item) => keepPath(item))
  kept.sort((a, b) => a.split('/').length - b.split('/').length || a.localeCompare(b))
  const truncated = walked.truncated || kept.length > FILE_LIST_LIMIT
  return { paths: kept.slice(0, FILE_LIST_LIMIT), truncated }
}

async function gitFiles(root: string): Promise<string[] | null> {
  try {
    const { stdout } = await execFileAsync('git', ['-C', root, 'rev-parse', '--is-inside-work-tree'], {
      timeout: 10_000
    })
    if (stdout.trim() !== 'true') return null
    const listed = await execFileAsync('git', ['-C', root, 'ls-files', '-z', '-co', '--exclude-standard'], {
      timeout: 30_000,
      maxBuffer: 16 * 1024 * 1024
    })
    return listed.stdout.split('\0').map(normalizeRelative).filter((item): item is string => item !== null)
  } catch {
    return null
  }
}

async function walkFiles(root: string): Promise<{ paths: string[]; truncated: boolean }> {
  const found: string[] = []
  let truncated = false
  async function walk(dir: string): Promise<void> {
    if (truncated) return
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => [])
    for (const entry of entries) {
      if (truncated) return
      if (entry.name.startsWith('.') || SKIP_DIRS.has(entry.name)) continue
      const next = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile()) {
        const relative = normalizeRelative(path.relative(root, next))
        if (!relative) continue
        if (found.length >= FILE_LIST_LIMIT) {
          truncated = true
          return
        }
        found.push(relative)
      }
    }
  }
  await walk(root)
  return { paths: found, truncated }
}

function keepPath(relative: string): boolean {
  const parts = relative.split('/')
  if (parts.some((part) => part.startsWith('.') || SKIP_DIRS.has(part))) return false
  const base = parts[parts.length - 1]?.toLowerCase() ?? ''
  if (!base || SKIP_FILES.has(base) || sensitive(base)) return false
  const dot = base.lastIndexOf('.')
  const ext = dot > 0 ? base.slice(dot + 1) : ''
  return !BINARY_EXT.has(ext)
}

function sensitive(base: string): boolean {
  return base === '.env'
    || base.startsWith('.env.')
    || base.endsWith('.pem')
    || base.endsWith('.key')
    || base === 'id_rsa'
    || base === 'credentials.json'
}

function normalizeRelative(value: string): string | null {
  if (!value) return null
  const posix = value.replace(/\\/g, '/').replace(/^\.\//, '')
  if (!posix || posix.startsWith('/') || posix.split('/').includes('..')) return null
  return posix
}

async function readIndex(root: string): Promise<ProjectIndex> {
  try {
    const text = await readFile(path.join(root, '.agent', INDEX_NAME), 'utf8')
    const parsed = JSON.parse(text) as Partial<ProjectIndex>
    if (parsed.version !== INDEX_VERSION || !Array.isArray(parsed.files)) return emptyIndex()
    const files: IndexedFile[] = []
    for (const item of parsed.files) files.push(...validFile(item))
    return { version: INDEX_VERSION, truncated: parsed.truncated === true, files }
  } catch {
    return emptyIndex()
  }
}

function validFile(item: unknown): IndexedFile[] {
  if (!item || typeof item !== 'object') return []
  const row = item as Partial<IndexedFile>
  const relative = typeof row.path === 'string' ? normalizeRelative(row.path) : null
  if (!relative) return []
  const symbols = Array.isArray(row.symbols) ? row.symbols.flatMap(validSymbol) : []
  return [{
    path: relative,
    bytes: typeof row.bytes === 'number' ? row.bytes : 0,
    mtimeMs: typeof row.mtimeMs === 'number' ? row.mtimeMs : 0,
    hash: typeof row.hash === 'string' ? row.hash : '',
    symbols
  }]
}

function validSymbol(item: unknown): SourceSymbol[] {
  if (!item || typeof item !== 'object') return []
  const row = item as Partial<SourceSymbol>
  if (typeof row.name !== 'string' || typeof row.line !== 'number') return []
  if (row.kind !== 'function' && row.kind !== 'class' && row.kind !== 'type' && row.kind !== 'const' && row.kind !== 'method' && row.kind !== 'heading') {
    return []
  }
  return [{
    name: row.name,
    kind: row.kind,
    line: row.line,
    signature: typeof row.signature === 'string' ? row.signature : row.name
  }]
}

function emptyIndex(): ProjectIndex {
  return { version: INDEX_VERSION, truncated: false, files: [] }
}

function renderPrompt(index: ProjectIndex, focus: string[]): string {
  const intro = [
    '## Project',
    '',
    'Map of this folder. It lists the structure, then the names defined in the files closest to what is open.',
    'Each name is followed by its kind, line number, and the source line. This is not the file contents.',
    'Read a file before editing it. Do not invent paths that are absent from this map.'
  ]
  if (index.truncated) intro.push(`Only the first ${FILE_LIST_LIMIT} files are included.`)
  if (index.files.length === 0) {
    intro.push('', 'No text files were indexed.')
    return intro.join('\n')
  }
  const tree = clipLines(treeLines(index.files), TREE_CHARS)
  const parts = [intro.join('\n'), '', '### Structure', '', tree]
  let used = parts.join('\n').length
  const ranked = [...index.files].sort((a, b) => score(b, focus) - score(a, focus) || a.path.localeCompare(b.path))
  const shown = new Set<string>()
  const blocks: string[] = []
  for (const file of ranked) {
    if (file.symbols.length === 0 && !focus.includes(file.path)) continue
    const block = renderFile(file)
    if (used + block.length + 2 > PROMPT_CHARS && shown.size > 0) break
    blocks.push(block)
    shown.add(file.path)
    used += block.length + 2
  }
  if (blocks.length > 0) parts.push('', '### Names', '', blocks.join('\n\n'))
  const hidden = ranked.filter((file) => file.symbols.length > 0 && !shown.has(file.path)).length
  if (hidden > 0) parts.push('', `${hidden} more files have names in the index. Use list_files or grep to look past this map.`)
  return parts.join('\n')
}

function renderFile(file: IndexedFile): string {
  if (file.symbols.length === 0) {
    const note = file.bytes > MAX_SCAN_BYTES ? 'too large to scan' : 'no named definitions'
    return `${file.path}\n  (${note})`
  }
  const lines = file.symbols.map((symbol) => `  ${symbol.name} (${symbol.kind}, ${symbol.line}) ${symbol.signature}`)
  return [`${file.path}`, ...lines].join('\n')
}

type Dir = { files: string[]; dirs: Map<string, Dir> }

function treeLines(files: IndexedFile[]): string {
  const root: Dir = { files: [], dirs: new Map() }
  for (const file of files) {
    const parts = file.path.split('/')
    let node = root
    for (let index = 0; index < parts.length - 1; index += 1) {
      const name = parts[index]
      let child = node.dirs.get(name)
      if (!child) {
        child = { files: [], dirs: new Map() }
        node.dirs.set(name, child)
      }
      node = child
    }
    node.files.push(parts[parts.length - 1] ?? file.path)
  }
  const lines: string[] = []
  for (const name of root.files.sort()) lines.push(name)
  const walk = (node: Dir, depth: number): void => {
    if (lines.length >= MAX_TREE_LINES || depth > 4) return
    for (const name of [...node.dirs.keys()].sort()) {
      if (lines.length >= MAX_TREE_LINES) return
      const child = node.dirs.get(name)
      if (!child) continue
      const count = countFiles(child)
      lines.push(`${'  '.repeat(depth)}${name}/ — ${count} file${count === 1 ? '' : 's'}`)
      walk(child, depth + 1)
    }
  }
  walk(root, 0)
  if (lines.length >= MAX_TREE_LINES) lines.push('…')
  return lines.join('\n')
}

function countFiles(node: Dir): number {
  let count = node.files.length
  for (const child of node.dirs.values()) count += countFiles(child)
  return count
}

function clipLines(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max).trimEnd()}\n…`
}

function score(file: IndexedFile, focus: string[]): number {
  let value = file.mtimeMs / 1e15
  if (file.symbols.length > 0) value += 100
  if (!file.path.includes('/')) value += 5_000
  for (const target of focus) {
    if (file.path === target) value += 1_000_000
    else if (path.posix.dirname(file.path) === path.posix.dirname(target)) value += 100_000
    else if (sharesDirectory(file.path, target)) value += 10_000
  }
  return value
}

function sharesDirectory(file: string, target: string): boolean {
  const left = file.split('/').slice(0, -1)
  const right = target.split('/').slice(0, -1)
  const limit = Math.min(left.length, right.length)
  if (limit === 0) return false
  for (let index = 0; index < limit; index += 1) {
    if (left[index] !== right[index]) return false
  }
  return true
}

function focusPaths(root: string, focus: Array<string | null | undefined>): string[] {
  const paths: string[] = []
  for (const item of focus) {
    if (!item || !item.trim()) continue
    const absolute = path.isAbsolute(item) ? path.resolve(item) : path.resolve(root, item)
    const relative = normalizeRelative(path.relative(root, absolute))
    if (relative && !paths.includes(relative)) paths.push(relative)
  }
  return paths
}

function exclusive<T>(root: string, job: () => Promise<T>): Promise<T> {
  const previous = chains.get(root) ?? Promise.resolve()
  const run = previous.then(job, job)
  chains.set(root, run.then(() => undefined, () => undefined))
  return run
}
