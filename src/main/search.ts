import { readdir, readFile, stat, writeFile } from 'fs/promises'
import path from 'path'
import { FILE_LIST_LIMIT, MAX_FILE_BYTES, SKIP_NAMES, type FolderBuffer, type FolderHit, type FolderQuery, type FolderReplaceResult, type FolderSearchResult } from '../shared/types'

const HIT_LIMIT = 300

type Prepared = {
  root: string
  pattern: RegExp
  literal: boolean
  preserveCase: boolean
  include: RegExp[]
  exclude: RegExp[]
  buffers: Map<string, FolderBuffer>
}

export async function searchFolder(query: FolderQuery): Promise<FolderSearchResult> {
  const prepared = prepare(query)
  const hits: FolderHit[] = []
  let total = 0
  let files = 0
  let listTruncated = false
  let seen = 0

  async function visit(file: string): Promise<void> {
    if (!fileAllowed(prepared, file)) return
    const text = await textOf(file, prepared.buffers)
    if (text === null) return
    const found = scan(file, text, prepared.pattern, HIT_LIMIT - hits.length)
    if (found.total === 0) return
    files += 1
    total += found.total
    hits.push(...found.hits)
  }

  async function walk(dir: string): Promise<void> {
    if (listTruncated) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (listTruncated) return
      if (SKIP_NAMES.has(entry.name)) continue
      const next = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile()) {
        if (seen >= FILE_LIST_LIMIT) {
          listTruncated = true
          return
        }
        seen += 1
        await visit(next)
      }
    }
  }

  await walk(prepared.root)
  hits.sort((a, b) => a.path.localeCompare(b.path) || a.line - b.line || a.column - b.column)
  return {
    hits,
    total,
    files,
    truncated: total > hits.length,
    listTruncated
  }
}

export async function replaceFolder(query: FolderQuery, replacement: string): Promise<FolderReplaceResult> {
  if (typeof replacement !== 'string') throw new Error('Invalid replacement')
  const prepared = prepare(query)
  let replacements = 0
  let files = 0
  const updates: FolderBuffer[] = []
  let listTruncated = false
  let seen = 0

  async function visit(file: string): Promise<void> {
    if (!fileAllowed(prepared, file)) return
    const buffer = prepared.buffers.get(file)
    const text = await textOf(file, prepared.buffers)
    if (text === null) return
    const next = applyReplace(text, prepared.pattern, replacement, prepared.literal, prepared.preserveCase)
    if (next.count === 0) return
    files += 1
    replacements += next.count
    if (buffer) {
      updates.push({ path: file, text: next.text, dirty: buffer.dirty })
      if (!buffer.dirty) await writeFile(file, next.text, 'utf8')
      return
    }
    await writeFile(file, next.text, 'utf8')
  }

  async function walk(dir: string): Promise<void> {
    if (listTruncated) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (listTruncated) return
      if (SKIP_NAMES.has(entry.name)) continue
      const next = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile()) {
        if (seen >= FILE_LIST_LIMIT) {
          listTruncated = true
          return
        }
        seen += 1
        await visit(next)
      }
    }
  }

  await walk(prepared.root)
  return { replacements, files, updates }
}

function prepare(query: FolderQuery): Prepared {
  if (!query || typeof query.root !== 'string' || !path.isAbsolute(query.root)) throw new Error('Open a folder first.')
  if (typeof query.find !== 'string' || query.find.length === 0) throw new Error('Enter text to find.')
  const root = path.resolve(query.root)
  const buffers = new Map<string, FolderBuffer>()
  for (const buffer of query.buffers ?? []) {
    if (!buffer || typeof buffer.path !== 'string' || typeof buffer.text !== 'string') continue
    if (!inside(root, buffer.path) || buffer.text.length > MAX_FILE_BYTES * 2) continue
    buffers.set(path.resolve(buffer.path), buffer)
  }
  return {
    root,
    pattern: compile(query.find, query.regex === true, query.caseSensitive === true, query.wholeWord === true),
    literal: query.regex !== true,
    preserveCase: query.preserveCase === true,
    include: globs(query.include),
    exclude: globs(query.exclude),
    buffers
  }
}

function compile(find: string, regex: boolean, caseSensitive: boolean, wholeWord: boolean): RegExp {
  let source = regex ? find : find.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  if (wholeWord) source = `(?<!\\w)(?:${source})(?!\\w)`
  let pattern: RegExp
  try {
    pattern = new RegExp(source, caseSensitive ? 'g' : 'gi')
  } catch {
    throw new Error('Invalid regular expression.')
  }
  pattern.lastIndex = 0
  if (pattern.test('')) throw new Error('Pattern matches empty text.')
  pattern.lastIndex = 0
  return pattern
}

async function textOf(file: string, buffers: Map<string, FolderBuffer>): Promise<string | null> {
  const buffer = buffers.get(file)
  if (buffer) return buffer.text.includes('\0') ? null : buffer.text
  try {
    const info = await stat(file)
    if (!info.isFile() || info.size > MAX_FILE_BYTES) return null
    const bytes = await readFile(file)
    if (bytes.includes(0)) return null
    return bytes.toString('utf8')
  } catch {
    return null
  }
}

function scan(file: string, text: string, pattern: RegExp, room: number): { hits: FolderHit[]; total: number } {
  pattern.lastIndex = 0
  const hits: FolderHit[] = []
  let total = 0
  let line = 1
  let lineStart = 0
  for (const match of text.matchAll(pattern)) {
    const index = match.index ?? 0
    if (match[0].length === 0) {
      pattern.lastIndex = index + 1
      continue
    }
    while (lineStart < index) {
      const next = text.indexOf('\n', lineStart)
      if (next === -1 || next >= index) break
      line += 1
      lineStart = next + 1
    }
    total += 1
    if (hits.length < room) {
      const lineEnd = text.indexOf('\n', lineStart)
      const row = text.slice(lineStart, lineEnd === -1 ? text.length : lineEnd)
      hits.push({
        path: file,
        line,
        column: index - lineStart + 1,
        preview: clip(row, index - lineStart, match[0].length)
      })
    }
  }
  pattern.lastIndex = 0
  return { hits, total }
}

function applyReplace(
  text: string,
  pattern: RegExp,
  replacement: string,
  literal: boolean,
  preserveCase: boolean
): { text: string; count: number } {
  pattern.lastIndex = 0
  let count = 0
  const next = text.replace(pattern, (...args: unknown[]) => {
    count += 1
    const match = String(args[0])
    const groups = args.slice(1, -2)
    const inserted = literal ? replacement : expand(replacement, match, groups)
    return preserveCase ? matchCase(match, inserted) : inserted
  })
  pattern.lastIndex = 0
  return { text: next, count }
}

function matchCase(sample: string, replacement: string): string {
  if (sample === sample.toUpperCase()) return replacement.toUpperCase()
  if (sample === sample.toLowerCase()) return replacement.toLowerCase()
  const head = sample.charAt(0)
  if (head && head === head.toUpperCase() && sample.slice(1) === sample.slice(1).toLowerCase()) {
    return replacement.charAt(0).toUpperCase() + replacement.slice(1).toLowerCase()
  }
  return replacement
}

function globs(value: string | undefined): RegExp[] {
  if (!value) return []
  return value
    .split(',')
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
    .map(globToRegExp)
}

function globToRegExp(pattern: string): RegExp {
  let source = ''
  const normalized = pattern.replace(/\\/g, '/')
  let index = 0
  while (index < normalized.length) {
    if (normalized.startsWith('**/', index)) {
      source += '(?:.*/)?'
      index += 3
      continue
    }
    if (normalized.startsWith('**', index)) {
      source += '.*'
      index += 2
      continue
    }
    const char = normalized[index]
    if (char === '*') source += '[^/]*'
    else if (char === '?') source += '[^/]'
    else if ('.+^${}()|[]\\'.includes(char)) source += `\\${char}`
    else source += char
    index += 1
  }
  return new RegExp(`^${source}$`, 'i')
}

function fileAllowed(prepared: Prepared, file: string): boolean {
  const rel = path.relative(prepared.root, file).split(path.sep).join('/')
  const base = path.basename(file)
  if (prepared.exclude.some((pattern) => testGlob(pattern, rel, base))) return false
  if (prepared.include.length === 0) return true
  return prepared.include.some((pattern) => testGlob(pattern, rel, base))
}

function testGlob(pattern: RegExp, rel: string, base: string): boolean {
  pattern.lastIndex = 0
  if (pattern.test(rel)) return true
  pattern.lastIndex = 0
  return pattern.test(base)
}

function expand(replacement: string, match: string, groups: unknown[]): string {
  return replacement.replace(/\$(\$|&|\d{1,2})/g, (token, ref: string) => {
    if (ref === '$') return '$'
    if (ref === '&') return match
    const index = Number(ref) - 1
    const group = groups[index]
    return typeof group === 'string' ? group : token
  })
}

function clip(line: string, column: number, length: number): string {
  const start = Math.max(0, column - 40)
  const end = Math.min(line.length, column + length + 40)
  const slice = line.slice(start, end).replace(/\s+/g, ' ')
  return `${start > 0 ? '…' : ''}${slice}${end < line.length ? '…' : ''}`
}

function inside(root: string, target: string): boolean {
  if (!path.isAbsolute(target)) return false
  const rel = path.relative(root, path.resolve(target))
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))
}
