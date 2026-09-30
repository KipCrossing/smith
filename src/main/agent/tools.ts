import { execFile } from 'child_process'
import { mkdir, readFile, readdir, realpath, rename, rm, stat, writeFile } from 'fs/promises'
import path from 'path'
import { promisify } from 'util'
import type { ToolSchema } from './ollama'
import { ToolError, editFile } from './editFile'

const execFileAsync = promisify(execFile)
const MAX_READ_BYTES = 200_000
const MAX_OUTPUT_CHARS = 20_000
const MAX_LIST = 400
const MAX_FETCH_BYTES = 3_000_000
const SKIP_DIRS = new Set([
  '.git',
  '.agent',
  '__pycache__',
  'node_modules',
  '.venv',
  'venv',
  '.mypy_cache',
  '.pytest_cache',
  '.ruff_cache',
  'dist',
  'build'
])

const DENY: Array<[RegExp, string]> = [
  [/\brm\s+(-[a-zA-Z]*\s+)*-[a-zA-Z]*[rR][a-zA-Z]*f|\brm\s+-[a-zA-Z]*f[a-zA-Z]*[rR]/, 'recursive forced delete'],
  [/:\(\)\s*\{.*\}\s*;?\s*:/, 'fork bomb'],
  [/\bmkfs(\.\w+)?\b/, 'filesystem format'],
  [/\bdd\b.*\bof=\/dev\//, 'raw device write'],
  [/>\s*\/dev\/(sd|nvme|hd)/, 'raw device write'],
  [/\bgit\s+push\b.*(--force|-f)\b/, 'force push'],
  [/\bgit\s+(reset\s+--hard|clean\s+-[a-zA-Z]*f|filter-branch|rebase)\b/, 'destructive git history operation'],
  [/\bshutdown\b|\breboot\b|\bhalt\b|\bpoweroff\b/, 'power state change'],
  [/\bchmod\s+(-[a-zA-Z]+\s+)*777\b/, 'world-writable permissions'],
  [/\b(useradd|userdel|usermod|passwd|visudo)\b/, 'account modification'],
  [/\b(DROP|TRUNCATE)\s+(TABLE|DATABASE|SCHEMA)\b/i, 'destructive SQL'],
  [/\bcurl\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, 'piping a download into a shell'],
  [/\bwget\b[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, 'piping a download into a shell'],
  [/\bsudo\b/, 'privilege escalation'],
  [/\bcrontab\b|\bsystemctl\s+(start|stop|restart|enable|disable)\b/, 'service or scheduler change']
]

const FILE_WRITE: Array<[RegExp, string]> = [
  [/\bsed\s+(-[a-zA-Z]*i|--in-place)/, 'in-place sed'],
  [/\btee\b/, 'tee'],
  [/<<\s*'?EOF/, 'heredoc'],
  [/(?<![0-9<>])>{1,2}(?!&)\s*\S/, 'output redirection into a file']
]

export interface Execution {
  result: Record<string, unknown>
  changed: string[]
}

export class Workspace {
  constructor(readonly root: string) {}

  async resolve(raw: string): Promise<string> {
    const input = raw.trim() || '.'
    const abs = path.isAbsolute(input) ? path.resolve(input) : path.resolve(this.root, input)
    let check = abs
    try {
      check = await realpathSafe(abs)
    } catch {
      const parent = path.dirname(abs)
      try {
        check = path.join(await realpathSafe(parent), path.basename(abs))
      } catch {
        check = path.resolve(abs)
      }
    }
    if (check !== this.root && !check.startsWith(this.root + path.sep)) {
      throw new ToolError(`path is outside the open folder: ${input}`)
    }
    return check
  }

  rel(target: string): string {
    const relative = path.relative(this.root, target)
    if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return target
    return relative
  }
}

export async function openWorkspace(root: string): Promise<Workspace> {
  const resolved = await realpathSafe(root)
  const info = await stat(resolved)
  if (!info.isDirectory()) throw new ToolError('Open a folder before messaging the agent.')
  return new Workspace(resolved)
}

export class Toolset {
  private readonly failed = new Set<string>()
  signal: AbortSignal | undefined

  constructor(readonly workspace: Workspace) {}

  schema(name: string): ToolSchema {
    const tool = TOOLS.find((item) => item.name === name)
    if (!tool) throw new ToolError(`unknown tool: ${name}`)
    return { type: 'function', function: { name: tool.name, description: tool.description, parameters: tool.parameters } }
  }

  schemas(): ToolSchema[] {
    return TOOLS.map((tool) => this.schema(tool.name))
  }

  async execute(name: string, args: Record<string, unknown>): Promise<Execution> {
    const tool = TOOLS.find((item) => item.name === name)
    if (!tool) return { result: { ok: false, error: `unknown tool: ${name}` }, changed: [] }
    const key = `${name}:${JSON.stringify(args)}`
    if (this.failed.has(key)) {
      return { result: { ok: false, error: `${name} already failed with these arguments` }, changed: [] }
    }
    try {
      return await tool.run(this.workspace, args, this.signal)
    } catch (error) {
      this.failed.add(key)
      const message = error instanceof Error ? error.message : String(error)
      return { result: { ok: false, error: message }, changed: [] }
    }
  }
}

interface ToolDef {
  name: string
  description: string
  parameters: Record<string, unknown>
  run: (workspace: Workspace, args: Record<string, unknown>, signal?: AbortSignal) => Promise<Execution>
}

const object = (properties: Record<string, unknown>, required: string[]): Record<string, unknown> => ({
  type: 'object',
  properties,
  required
})

const TOOLS: ToolDef[] = [
  {
    name: 'list_files',
    description:
      "Find files and directories by name or path using a glob. Use this to explore structure or locate files, for example '**/*.test.ts'. To search inside file contents, use grep instead.",
    parameters: object(
      {
        glob: { type: 'string', description: "Glob relative to path, for example '*.py' or '**/*.ts'. Defaults to '*'." },
        path: { type: 'string', description: 'Directory to list. Defaults to the workspace root.' },
        include_hidden: { type: 'boolean', description: 'Include dotfiles. Defaults to false.' }
      },
      []
    ),
    run: listFiles
  },
  {
    name: 'grep',
    description: 'Search file contents for a regular expression. Use this to find where something is defined, used, or configured.',
    parameters: object(
      {
        pattern: { type: 'string', description: 'Regular expression to search for.' },
        path: { type: 'string', description: 'File or directory to search. Defaults to the workspace root.' },
        glob: { type: 'string', description: "Optional filename filter, for example '*.ts'." },
        ignore_case: { type: 'boolean', description: 'Case-insensitive search.' },
        output_mode: {
          type: 'string',
          enum: ['content', 'files', 'count'],
          description: "'content' returns matching lines. 'files' returns paths. 'count' returns per-file counts."
        },
        context_lines: { type: 'integer', description: "Lines of context per match. Only used with output_mode 'content'." }
      },
      ['pattern']
    ),
    run: grep
  },
  {
    name: 'read_file',
    description: "Read a file's contents, optionally a line range. Always read a file before editing it.",
    parameters: object(
      {
        path: { type: 'string', description: 'File to read.' },
        start_line: { type: 'integer', description: 'First line to show, 1-based.' },
        end_line: { type: 'integer', description: 'Last line to show, inclusive.' }
      },
      ['path']
    ),
    run: readText
  },
  {
    name: 'write_file',
    description: 'Write a whole file. Creates it by default; set overwrite to replace an existing one. Prefer edit_file for targeted changes.',
    parameters: object(
      {
        path: { type: 'string', description: 'File to write.' },
        contents: { type: 'string', description: 'Full contents of the file.' },
        overwrite: { type: 'boolean', description: 'Required to replace an existing file.' }
      },
      ['path', 'contents']
    ),
    run: writeText
  },
  {
    name: 'edit_file',
    description: 'Replace exact strings in an existing file. Preferred over shell commands for all file modifications.',
    parameters: object(
      {
        path: { type: 'string', description: 'File to edit.' },
        edits: {
          type: 'array',
          description: 'Edits applied in order, top of file downward.',
          items: {
            type: 'object',
            properties: {
              old_string: {
                type: 'string',
                description:
                  'Text to replace. Copy it from the file including indentation and blank lines. Never include line number prefixes.'
              },
              new_string: { type: 'string', description: 'Replacement text. Use an empty string to delete.' },
              replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' }
            },
            required: ['old_string', 'new_string']
          }
        }
      },
      ['path', 'edits']
    ),
    run: editText
  },
  {
    name: 'move_file',
    description: 'Rename or move a file or directory within the workspace.',
    parameters: object(
      {
        source: { type: 'string', description: 'Existing file or directory.' },
        destination: { type: 'string', description: 'New path. Parent directories are created.' },
        overwrite: { type: 'boolean', description: 'Allow replacing an existing destination.' }
      },
      ['source', 'destination']
    ),
    run: movePath
  },
  {
    name: 'delete_file',
    description: 'Delete a file, or a directory when recursive is set.',
    parameters: object(
      {
        path: { type: 'string', description: 'File or empty directory to delete.' },
        recursive: { type: 'boolean', description: 'Required to delete a directory and everything inside it.' }
      },
      ['path']
    ),
    run: deletePath
  },
  {
    name: 'run_command',
    description:
      'Run a single non-interactive shell command for builds, tests, or git. Never use it to find, read, or modify files.',
    parameters: object(
      {
        command: { type: 'string', description: 'Single non-interactive shell command. Never use this to modify files.' },
        cwd: { type: 'string', description: 'Directory to run in. Defaults to the workspace root.' },
        timeout_seconds: { type: 'integer', description: 'Default 30.' }
      },
      ['command']
    ),
    run: runCommand
  },
  {
    name: 'web_search',
    description: 'Search the public internet for documentation, library versions, or error messages. Returns titles, URLs, and snippets.',
    parameters: object(
      {
        query: { type: 'string', description: 'Search query.' },
        max_results: { type: 'integer', description: '1-10, default 5.' }
      },
      ['query']
    ),
    run: webSearch
  },
  {
    name: 'fetch_url',
    description: 'Fetch a URL and return its readable text. Use it to read a documentation page found via web_search.',
    parameters: object(
      {
        url: { type: 'string', description: 'Absolute http or https URL.' },
        max_chars: { type: 'integer', description: 'Truncate the extracted text. Default 8000.' }
      },
      ['url']
    ),
    run: fetchUrl
  }
]

async function listFiles(workspace: Workspace, args: Record<string, unknown>): Promise<Execution> {
  const pattern = text(args, 'glob') || '*'
  const base = await workspace.resolve(text(args, 'path') || '.')
  const info = await stat(base)
  if (!info.isDirectory()) throw new ToolError(`${workspace.rel(base)} is not a directory`)
  const includeHidden = flag(args, 'include_hidden')
  const entries: string[] = []
  await walk(base, base, pattern, includeHidden, entries)
  const clipped = entries.length > MAX_LIST
  return {
    result: { ok: true, entries: entries.slice(0, MAX_LIST), truncated: clipped },
    changed: []
  }
}

async function walk(root: string, dir: string, pattern: string, includeHidden: boolean, entries: string[]): Promise<void> {
  if (entries.length > MAX_LIST) return
  const recursive = pattern.includes('**')
  const matcher = globToRegExp(pattern)
  const rows = await readdir(dir, { withFileTypes: true })
  for (const row of rows) {
    if (entries.length > MAX_LIST) return
    if (SKIP_DIRS.has(row.name)) continue
    if (!includeHidden && row.name.startsWith('.')) continue
    const full = path.join(dir, row.name)
    const relative = path.relative(root, full)
    if (row.isDirectory()) {
      if (matcher.test(relative) || matcher.test(relative + '/')) entries.push(relative + '/')
      if (recursive || pattern.includes('/')) await walk(root, full, pattern, includeHidden, entries)
    } else if (matcher.test(relative)) {
      entries.push(relative)
    }
  }
}

async function grep(workspace: Workspace, args: Record<string, unknown>): Promise<Execution> {
  const pattern = text(args, 'pattern')
  if (!pattern) throw new ToolError('pattern must not be empty')
  const mode = text(args, 'output_mode') || 'content'
  if (mode !== 'content' && mode !== 'files' && mode !== 'count') {
    throw new ToolError('output_mode must be one of: content, files, count')
  }
  const target = await workspace.resolve(text(args, 'path') || '.')
  const info = await stat(target).catch(() => null)
  if (!info) throw new ToolError(`no such file or directory: ${workspace.rel(target)}`)
  const fileGlob = text(args, 'glob')
  const ignoreCase = flag(args, 'ignore_case')
  const context = Math.min(10, Math.max(0, integer(args, 'context_lines', 0)))
  let output = ''
  const rg = await which('rg')
  if (rg) {
    const cmd = [rg, '--color=never']
    if (mode === 'files') cmd.push('--files-with-matches')
    else if (mode === 'count') cmd.push('--count')
    else {
      cmd.push('--line-number', '--no-heading', '--max-count=50')
      if (context > 0) cmd.push('--context', String(context))
    }
    if (ignoreCase) cmd.push('--ignore-case')
    if (fileGlob) cmd.push('--glob', fileGlob)
    cmd.push('--glob', '!.agent/**', '--regexp', pattern, target)
    output = await runRg(cmd)
  } else {
    output = await grepFallback(target, pattern, fileGlob, ignoreCase, mode, context)
  }
  const [body, clipped] = truncate(output)
  const lines = body
    .split('\n')
    .filter((line) => line)
    .map((line) => line.replace(`${workspace.root}/`, ''))
  const result: Record<string, unknown> = { ok: true, output_mode: mode, truncated: clipped }
  if (mode === 'files') {
    result.file_count = lines.length
    result.files = lines
  } else if (mode === 'count') result.counts = lines
  else {
    result.match_count = lines.length
    result.matches = lines
  }
  return { result, changed: [] }
}

async function readText(workspace: Workspace, args: Record<string, unknown>): Promise<Execution> {
  const target = await workspace.resolve(text(args, 'path'))
  const info = await stat(target).catch(() => null)
  if (!info) throw new ToolError(`no such file: ${workspace.rel(target)}`)
  if (info.isDirectory()) throw new ToolError(`${workspace.rel(target)} is a directory; use grep or list_files`)
  if (info.size > MAX_READ_BYTES) {
    throw new ToolError(
      `${workspace.rel(target)} is ${info.size} bytes, larger than the ${MAX_READ_BYTES} byte limit. Read a line range instead.`
    )
  }
  const lines = (await readFile(target, 'utf8')).split(/\r?\n/)
  if (lines.length && lines[lines.length - 1] === '') lines.pop()
  const total = lines.length
  const first = Math.max(1, integer(args, 'start_line', 1))
  const last = Math.min(total, integer(args, 'end_line', total || 1))
  const selected = lines.slice(first - 1, last)
  const numbered = selected.map((line, index) => `${first + index}|${line}`).join('\n')
  const [body, clipped] = truncate(numbered)
  return {
    result: {
      ok: true,
      path: workspace.rel(target),
      total_lines: total,
      shown_lines: `${first}-${last}`,
      contents: body,
      truncated: clipped,
      note: 'Line number prefixes are metadata. Do not include them in old_string.'
    },
    changed: []
  }
}

async function writeText(workspace: Workspace, args: Record<string, unknown>): Promise<Execution> {
  const target = await workspace.resolve(text(args, 'path'))
  const contents = typeof args.contents === 'string' ? args.contents : ''
  const info = await stat(target).catch(() => null)
  if (info?.isDirectory()) throw new ToolError(`${workspace.rel(target)} is a directory`)
  if (info && !flag(args, 'overwrite')) {
    throw new ToolError(
      `${workspace.rel(target)} already exists. Use edit_file for a targeted change, or set overwrite to true to replace the whole file.`
    )
  }
  const previous = info ? (await readFile(target, 'utf8')).split(/\r?\n/).length : 0
  await mkdir(path.dirname(target), { recursive: true })
  await writeFile(target, contents, 'utf8')
  return {
    result: {
      ok: true,
      path: workspace.rel(target),
      created: !info,
      overwritten: Boolean(info),
      bytes_written: Buffer.byteLength(contents),
      lines: contents.split(/\r?\n/).length,
      lines_before: previous
    },
    changed: [target]
  }
}

async function editText(workspace: Workspace, args: Record<string, unknown>): Promise<Execution> {
  const target = await workspace.resolve(text(args, 'path'))
  const info = await stat(target).catch(() => null)
  if (!info) throw new ToolError(`${workspace.rel(target)} does not exist. Use write_file to make a new file.`)
  if (info.isDirectory()) throw new ToolError(`${workspace.rel(target)} is a directory`)
  const edited = await editFile(target, args.edits)
  return {
    result: {
      ok: true,
      path: workspace.rel(target),
      edits_applied: edited.applied,
      lines_before: edited.linesBefore,
      lines_after: edited.linesAfter
    },
    changed: [target]
  }
}

async function movePath(workspace: Workspace, args: Record<string, unknown>): Promise<Execution> {
  const source = await workspace.resolve(text(args, 'source'))
  const destination = await workspace.resolve(text(args, 'destination'))
  const src = await stat(source).catch(() => null)
  if (!src) throw new ToolError(`no such file or directory: ${workspace.rel(source)}`)
  if (source === destination) throw new ToolError('source and destination are the same path')
  const dst = await stat(destination).catch(() => null)
  if (dst && !flag(args, 'overwrite')) {
    throw new ToolError(`${workspace.rel(destination)} already exists. Set overwrite to true to replace it.`)
  }
  await mkdir(path.dirname(destination), { recursive: true })
  await rename(source, destination)
  return {
    result: { ok: true, moved_from: workspace.rel(source), moved_to: workspace.rel(destination) },
    changed: [source, destination]
  }
}

async function deletePath(workspace: Workspace, args: Record<string, unknown>): Promise<Execution> {
  const target = await workspace.resolve(text(args, 'path'))
  if (target === workspace.root) throw new ToolError('refusing to delete the workspace root')
  const info = await stat(target).catch(() => null)
  if (!info) throw new ToolError(`no such file or directory: ${workspace.rel(target)}`)
  if (info.isDirectory()) {
    if (!flag(args, 'recursive')) {
      throw new ToolError(`${workspace.rel(target)} is a directory. Set recursive to true to delete it and everything inside.`)
    }
    await rm(target, { recursive: true, force: true })
    return { result: { ok: true, deleted: workspace.rel(target), kind: 'directory' }, changed: [target] }
  }
  await rm(target)
  return { result: { ok: true, deleted: workspace.rel(target), kind: 'file' }, changed: [target] }
}

async function runCommand(workspace: Workspace, args: Record<string, unknown>, signal?: AbortSignal): Promise<Execution> {
  const command = text(args, 'command')
  if (!command.trim()) throw new ToolError('command must not be empty')
  checkCommand(command)
  const workdir = await workspace.resolve(text(args, 'cwd') || '.')
  const info = await stat(workdir).catch(() => null)
  if (!info?.isDirectory()) throw new ToolError(`cwd is not a directory: ${workspace.rel(workdir)}`)
  const timeout = Math.min(120, Math.max(1, integer(args, 'timeout_seconds', 30))) * 1000
  let stdout = ''
  let stderr = ''
  let exitCode = 0
  try {
    const result = await execFileAsync(command, {
      shell: true,
      cwd: workdir,
      timeout,
      maxBuffer: 1_000_000,
      signal
    })
    stdout = result.stdout
    stderr = result.stderr
  } catch (error) {
    const failed = error as { code?: number | string; stdout?: string; stderr?: string; killed?: boolean }
    if (failed.killed || failed.code === 'ETIMEDOUT') throw new ToolError(`command timed out after ${timeout / 1000}s: ${command}`)
    stdout = failed.stdout ?? ''
    stderr = failed.stderr ?? ''
    exitCode = typeof failed.code === 'number' ? failed.code : 1
  }
  const [out, outClipped] = truncate(stdout)
  const [err, errClipped] = truncate(stderr, 4000)
  return {
    result: { ok: exitCode === 0, exit_code: exitCode, stdout: out, stderr: err, truncated: outClipped || errClipped },
    changed: []
  }
}

async function webSearch(_workspace: Workspace, args: Record<string, unknown>): Promise<Execution> {
  const found = await searchWeb(text(args, 'query'), integer(args, 'max_results', 5))
  return { result: { ok: true, query: found.query, results: found.results }, changed: [] }
}

export async function searchWeb(
  query: string,
  maxResults = 5,
  signal?: AbortSignal
): Promise<{ query: string; results: Array<{ title: string; url: string; snippet: string }> }> {
  const cleaned = query.trim()
  if (!cleaned) throw new ToolError('query must not be empty')
  const limit = Math.max(1, Math.min(10, maxResults))
  let html = ''
  try {
    const response = await fetch('https://html.duckduckgo.com/html/', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        'User-Agent': 'Mozilla/5.0 (compatible; smith/0.1)'
      },
      body: new URLSearchParams({ q: cleaned }),
      signal: signal ? AbortSignal.any([AbortSignal.timeout(20_000), signal]) : AbortSignal.timeout(20_000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    html = await response.text()
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ToolError(`search failed: ${message}`)
  }
  const titlePattern = /<a rel="nofollow" class="result__a" href="([^"]+)"[\s\S]*?>([\s\S]*?)<\/a>/g
  const snippetPattern = /class="result__snippet"[\s\S]*?>([\s\S]*?)<\/(?:a|td|div)>/g
  const snippets = [...html.matchAll(snippetPattern)].map((match) => cleanHtml(match[1]))
  const results: Array<{ title: string; url: string; snippet: string }> = []
  for (const match of html.matchAll(titlePattern)) {
    if (results.length >= limit) break
    results.push({
      title: cleanHtml(match[2]),
      url: decodeURIComponent(match[1]),
      snippet: snippets[results.length] ?? ''
    })
  }
  if (results.length === 0) {
    throw new ToolError('no results parsed. DuckDuckGo’s HTML layout may have changed; this tool is best-effort and has no API key.')
  }
  return { query: cleaned, results }
}

async function fetchUrl(_workspace: Workspace, args: Record<string, unknown>): Promise<Execution> {
  const page = await fetchPage(text(args, 'url'), integer(args, 'max_chars', 8000))
  return { result: { ok: true, ...page }, changed: [] }
}

export async function fetchPage(
  url: string,
  maxChars = 8000,
  signal?: AbortSignal
): Promise<{ url: string; content_type: string; chars: number; truncated: boolean; text: string }> {
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    throw new ToolError(`malformed URL: ${url}`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new ToolError(`only http and https URLs are supported, got '${parsed.protocol.replace(':', '')}'`)
  }
  let contentType = ''
  let body: Buffer
  try {
    const response = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0 (compatible; smith/0.1)' },
      signal: signal ? AbortSignal.any([AbortSignal.timeout(30_000), signal]) : AbortSignal.timeout(30_000)
    })
    if (!response.ok) throw new Error(`HTTP ${response.status}`)
    contentType = response.headers.get('content-type') ?? ''
    const bytes = Buffer.from(await response.arrayBuffer())
    body = bytes.subarray(0, MAX_FETCH_BYTES)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ToolError(`fetch failed: ${message}`)
  }
  let textBody = body.toString('utf8')
  const head = textBody.trimStart().slice(0, 100).toLowerCase()
  if (contentType.toLowerCase().includes('html') || head.startsWith('<!doctype') || head.startsWith('<html')) {
    textBody = htmlToText(textBody)
  }
  const limit = Math.max(500, Math.min(maxChars, 40_000))
  const [extracted, clipped] = truncate(textBody, limit)
  return { url, content_type: contentType, chars: extracted.length, truncated: clipped, text: extracted }
}

function checkCommand(command: string): void {
  for (const [pattern, reason] of DENY) {
    if (pattern.test(command)) {
      throw new ToolError(
        `refused: ${reason}. This command is blocked by the safety denylist. If the task genuinely requires it, tell the user what you want to run and why.`
      )
    }
  }
  for (const [pattern, reason] of FILE_WRITE) {
    if (pattern.test(command)) {
      throw new ToolError(`refused: ${reason} modifies files through the shell. Use edit_file or write_file instead.`)
    }
  }
}

function text(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function flag(args: Record<string, unknown>, key: string): boolean {
  return args[key] === true
}

function integer(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  return fallback
}

function truncate(value: string, limit = MAX_OUTPUT_CHARS): [string, boolean] {
  if (value.length <= limit) return [value, false]
  return [value.slice(0, limit), true]
}

function realpathSafe(target: string): Promise<string> {
  return realpath(target)
}

async function which(bin: string): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('which', [bin])
    const found = stdout.trim()
    return found || null
  } catch {
    return null
  }
}

async function runRg(cmd: string[]): Promise<string> {
  try {
    const { stdout } = await execFileAsync(cmd[0], cmd.slice(1), { timeout: 30_000, maxBuffer: 2_000_000 })
    return stdout
  } catch (error) {
    const failed = error as { code?: number; stdout?: string; stderr?: string }
    if (failed.code === 1) return failed.stdout ?? ''
    throw new ToolError((failed.stderr || '').trim() || 'ripgrep failed')
  }
}

async function grepFallback(
  target: string,
  pattern: string,
  fileGlob: string,
  ignoreCase: boolean,
  mode: string,
  context: number
): Promise<string> {
  let regex: RegExp
  try {
    regex = new RegExp(pattern, ignoreCase ? 'i' : '')
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    throw new ToolError(`invalid regular expression: ${message}`)
  }
  const files: string[] = []
  const info = await stat(target)
  if (info.isFile()) files.push(target)
  else await collectFiles(target, files)
  const matcher = fileGlob ? globToRegExp(fileGlob) : null
  const out: string[] = []
  for (const file of files) {
    const relative = path.relative(target, file)
    if (matcher && !matcher.test(path.basename(file)) && !matcher.test(relative)) continue
    if (partsSkipped(file)) continue
    let rows: string[]
    try {
      rows = (await readFile(file, 'utf8')).split(/\r?\n/)
    } catch {
      continue
    }
    const hits = rows.flatMap((line, index) => (regex.test(line) ? [index + 1] : []))
    if (hits.length === 0) continue
    if (mode === 'files') out.push(file)
    else if (mode === 'count') out.push(`${file}:${hits.length}`)
    else {
      const wanted = new Set<number>()
      for (const hit of hits) {
        for (let number = Math.max(1, hit - context); number <= Math.min(rows.length, hit + context); number += 1) {
          wanted.add(number)
        }
      }
      for (const number of [...wanted].sort((a, b) => a - b)) out.push(`${file}:${number}:${rows[number - 1]}`)
    }
  }
  return out.join('\n')
}

async function collectFiles(dir: string, files: string[]): Promise<void> {
  if (files.length > 2000) return
  const rows = await readdir(dir, { withFileTypes: true })
  for (const row of rows) {
    if (SKIP_DIRS.has(row.name) || row.name.startsWith('.')) continue
    const full = path.join(dir, row.name)
    if (row.isDirectory()) await collectFiles(full, files)
    else files.push(full)
  }
}

function partsSkipped(file: string): boolean {
  return file.split(path.sep).some((part) => SKIP_DIRS.has(part))
}

function globToRegExp(pattern: string): RegExp {
  let source = '^'
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
  return new RegExp(`${source}$`)
}

function cleanHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function htmlToText(html: string): string {
  let text = html.replace(/<(script|style|nav|footer|header|noscript|svg)\b[^>]*>[\s\S]*?<\/\1>/gi, ' ')
  text = text.replace(/<br\s*\/?>/gi, '\n')
  text = text.replace(/<\/(p|div|li|h[1-6]|tr|pre|section|article)>/gi, '\n')
  text = text.replace(/<[^>]+>/g, '')
  text = text
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line)
    .join('\n')
}
