import { execFile } from 'child_process'
import { mkdtemp, readFile, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import path from 'path'
import type { GitChange, GitDiff, GitDiffLine, GitEntry, GitMark, GitSnapshot } from '../shared/types'

const MAX_TEXT = 2_000_000

type Mark = GitMark

const emptySnapshot = (): GitSnapshot => ({ repo: false, branch: '', entries: [], changes: [] })

export async function gitStatus(root: string): Promise<GitSnapshot> {
  try {
    if (!(await isRepo(root))) return emptySnapshot()
    const { code, stdout } = await runGit(root, ['status', '--porcelain=v1', '-z'])
    const branch = await branchName(root)
    if (code !== 0) return { repo: true, branch, entries: [], changes: [] }
    const parsed = parseStatus(root, stdout)
    return { repo: true, branch, entries: parsed.entries, changes: parsed.changes }
  } catch {
    return emptySnapshot()
  }
}

export async function gitStage(root: string, paths: string[] | null): Promise<void> {
  await mutateIndex(root, paths, async (rels) => {
    const { code, stderr, stdout } = await runGit(root, ['add', '-A', '--', ...rels], 60_000)
    if (code !== 0) throw new Error((stderr || stdout).trim() || 'Could not stage changes.')
  })
}

export async function gitUnstage(root: string, paths: string[] | null): Promise<void> {
  await mutateIndex(root, paths, async (rels) => {
    const restored = await runGit(root, ['restore', '--staged', '--', ...rels], 60_000)
    const result = restored.code === 0 ? restored : await runGit(root, ['reset', '-q', '--', ...rels], 60_000)
    if (result.code !== 0) throw new Error((result.stderr || result.stdout).trim() || 'Could not unstage changes.')
  })
}

export async function gitCommit(root: string, message: string, stageAll: boolean): Promise<void> {
  const text = message.trim()
  if (!text) throw new Error('Enter a commit message.')
  if (text.length > 20_000) throw new Error('Commit message is too long.')
  if (!(await isRepo(root))) throw new Error('This folder is not a git repository.')
  if (stageAll) await gitStage(root, null)
  const { code, stderr, stdout } = await runGit(root, ['commit', '-m', text], 120_000)
  if (code !== 0) throw new Error((stderr || stdout).trim() || 'Could not commit.')
}

export async function gitChangeDiff(root: string, file: string, staged: boolean): Promise<GitDiff> {
  try {
    const rel = relInside(root, file)
    if (!rel || !(await isRepo(root))) return { binary: false, lines: [] }
    const args = ['diff', '--unified=3', '--no-color']
    if (staged) args.push('--cached')
    args.push('--', rel)
    const { stdout } = await runGit(root, args)
    if (stdout.includes('Binary files')) return { binary: true, lines: [] }
    const lines = parseInlineDiff(stdout)
    if (lines.length > 0 || staged) return { binary: false, lines }
    return gitDiff(root, file, null)
  } catch {
    return { binary: false, lines: [] }
  }
}

export async function gitGutter(root: string, file: string, text: string): Promise<GitMark[]> {
  try {
    if (text.includes('\0') || text.length > MAX_TEXT) return []
    const repo = path.resolve(root)
    const target = path.resolve(file)
    const rel = path.relative(repo, target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return []
    if (!(await isRepo(repo))) return []
    const gitRel = rel.split(path.sep).join('/')
    const head = await headBlob(repo, gitRel)
    if (head === 'binary') return []
    if (head === 'missing') return allAdded(text)
    if (head === text) return []
    return await diffTexts(head, text)
  } catch {
    return []
  }
}

export async function gitDiff(root: string, file: string, text: string | null): Promise<GitDiff> {
  try {
    const repo = path.resolve(root)
    const target = path.resolve(file)
    const rel = path.relative(repo, target)
    if (rel.startsWith('..') || path.isAbsolute(rel)) return { binary: false, lines: [] }
    if (!(await isRepo(repo))) return { binary: false, lines: [] }
    const gitRel = rel.split(path.sep).join('/')
    const head = await headBlob(repo, gitRel)
    if (head === 'binary') return { binary: true, lines: [] }
    const current = text === null ? await readWorking(target) : workingText(text)
    if (current === 'binary') return { binary: true, lines: [] }
    if (head === 'missing') {
      if (current === null) return { binary: false, lines: [] }
      return { binary: false, lines: tagged(current, 'add') }
    }
    if (current === null) return { binary: false, lines: tagged(head, 'del') }
    if (head === current) return { binary: false, lines: tagged(current, 'same') }
    const diff = await diffTextsRaw(head, current, '3')
    return { binary: false, lines: parseInlineDiff(diff) }
  } catch {
    return { binary: false, lines: [] }
  }
}

export function parseInlineDiff(diff: string): GitDiffLine[] {
  const out: GitDiffLine[] = []
  let inHunk = false
  for (const raw of diff.split('\n')) {
    const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw
    if (line.startsWith('@@')) {
      inHunk = true
      continue
    }
    if (!inHunk || line.startsWith('\\')) continue
    if (line.startsWith('+')) out.push({ kind: 'add', text: line.slice(1) })
    else if (line.startsWith('-')) out.push({ kind: 'del', text: line.slice(1) })
    else if (line.startsWith(' ')) out.push({ kind: 'same', text: line.slice(1) })
  }
  return out
}

function tagged(text: string, kind: GitDiffLine['kind']): GitDiffLine[] {
  return linesOf(text).map((line) => ({ kind, text: line }))
}

function linesOf(text: string): string[] {
  if (text.length === 0) return []
  const parts = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n')
  if (parts[parts.length - 1] === '') parts.pop()
  return parts
}

function workingText(text: string): string | 'binary' {
  if (text.includes('\0') || text.length > MAX_TEXT) return 'binary'
  return text
}

async function readWorking(file: string): Promise<string | null | 'binary'> {
  try {
    const data = await readFile(file)
    if (data.includes(0) || data.length > MAX_TEXT) return 'binary'
    return data.toString('utf8')
  } catch {
    return null
  }
}

export function parseStatus(root: string, stdout: string): { entries: GitEntry[]; changes: GitChange[] } {
  const parts = stdout.split('\0').filter((part) => part.length > 0)
  const entries: GitEntry[] = []
  const changes: GitChange[] = []
  for (let index = 0; index < parts.length; index += 1) {
    const entry = parts[index]
    if (entry.length < 4) continue
    const xy = entry.slice(0, 2)
    const filePath = entry.slice(3).replace(/\/+$/, '')
    if (!filePath) continue
    const abs = path.resolve(root, filePath)
    if (xy[0] === 'R' || xy[0] === 'C') {
      const previous = parts[index + 1]
      index += 1
      entries.push({ path: abs, code: 'R' })
      if (previous) entries.push({ path: path.resolve(root, previous), code: 'D' })
    } else {
      entries.push({ path: abs, code: badge(xy) })
    }
    pushChanges(changes, abs, xy)
  }
  return { entries, changes }
}

function pushChanges(changes: GitChange[], file: string, xy: string): void {
  if (xy === '??') {
    changes.push({ path: file, code: '?', staged: false })
    return
  }
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') {
    changes.push({ path: file, code: 'U', staged: false })
    return
  }
  const index = xy[0]
  const work = xy[1]
  if (index && index !== ' ' && index !== '?') changes.push({ path: file, code: letter(index), staged: true })
  if (work && work !== ' ') changes.push({ path: file, code: letter(work), staged: false })
}

function letter(char: string): string {
  if (char === 'A') return 'A'
  if (char === 'D') return 'D'
  if (char === 'R' || char === 'C') return 'R'
  if (char === '?') return '?'
  return 'M'
}

export function parseUnifiedDiff(diff: string): GitMark[] {
  const marks = new Map<number, Mark>()
  const lines = diff.split('\n')
  let index = 0
  while (index < lines.length) {
    const header = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/.exec(lines[index])
    if (!header) {
      index += 1
      continue
    }
    const newStart = Number(header[3])
    index += 1
    const body: string[] = []
    while (index < lines.length && !lines[index].startsWith('@@')) {
      body.push(lines[index])
      index += 1
    }
    consumeHunk(body, newStart, marks)
  }
  return [...marks.values()].sort((a, b) => a.line - b.line)
}

function consumeHunk(body: string[], newStart: number, marks: Map<number, Mark>): void {
  const events: Array<{ type: 'add' | 'del'; line: number }> = []
  let line = newStart
  for (const raw of body) {
    if (raw.startsWith('\\')) continue
    if (raw.startsWith('+')) {
      events.push({ type: 'add', line })
      line += 1
    } else if (raw.startsWith('-')) {
      events.push({ type: 'del', line: 0 })
    }
  }
  let cursor = 0
  while (cursor < events.length) {
    let deleted = 0
    while (cursor < events.length && events[cursor].type === 'del') {
      deleted += 1
      cursor += 1
    }
    const added: number[] = []
    while (cursor < events.length && events[cursor].type === 'add') {
      added.push(events[cursor].line)
      cursor += 1
    }
    const paired = Math.min(deleted, added.length)
    for (let item = 0; item < paired; item += 1) touch(marks, added[item]).change = true
    for (let item = paired; item < added.length; item += 1) touch(marks, added[item]).add = true
    const extra = deleted - paired
    if (extra <= 0) continue
    if (added.length > 0) touch(marks, added[0]).deleteBefore = true
    else if (newStart <= 0) touch(marks, 1).deleteBefore = true
    else touch(marks, newStart).deleteAfter = true
  }
}

function touch(marks: Map<number, Mark>, line: number): Mark {
  const current = marks.get(line)
  if (current) return current
  const created: Mark = { line, add: false, change: false, deleteBefore: false, deleteAfter: false }
  marks.set(line, created)
  return created
}

function badge(xy: string): string {
  if (xy === '??') return '?'
  if (xy.includes('U') || xy === 'AA' || xy === 'DD') return 'U'
  if (xy[0] === 'A' || xy[1] === 'A') return 'A'
  if (xy[0] === 'D' || xy[1] === 'D') return 'D'
  if (xy[0] === 'R' || xy[0] === 'C') return 'R'
  return 'M'
}

function allAdded(text: string): GitMark[] {
  const count = text.split('\n').length
  const marks: GitMark[] = []
  for (let line = 1; line <= count; line += 1) {
    marks.push({ line, add: true, change: false, deleteBefore: false, deleteAfter: false })
  }
  return marks
}

async function diffTexts(head: string, text: string): Promise<GitMark[]> {
  const stdout = await diffTextsRaw(head, text, '0')
  return stdout ? parseUnifiedDiff(stdout) : []
}

async function diffTextsRaw(head: string, text: string, context: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), 'smith-git-'))
  try {
    await writeFile(path.join(dir, 'head'), head)
    await writeFile(path.join(dir, 'now'), text)
    const { code, stdout } = await runGit(dir, [
      '-c',
      'core.autocrlf=false',
      'diff',
      '--no-index',
      `--unified=${context}`,
      '--no-color',
      '--text',
      '--',
      'head',
      'now'
    ])
    if (code !== 0 && code !== 1) return ''
    return stdout
  } finally {
    await rm(dir, { recursive: true, force: true })
  }
}

async function headBlob(root: string, rel: string): Promise<string | 'missing' | 'binary'> {
  const { code, stdout } = await runGit(root, ['show', `HEAD:${rel}`])
  if (code !== 0) return 'missing'
  if (stdout.includes('\0')) return 'binary'
  return stdout
}

async function isRepo(cwd: string): Promise<boolean> {
  const { code, stdout } = await runGit(cwd, ['rev-parse', '--is-inside-work-tree'])
  return code === 0 && stdout.trim() === 'true'
}

async function branchName(cwd: string): Promise<string> {
  const { code, stdout } = await runGit(cwd, ['rev-parse', '--abbrev-ref', 'HEAD'])
  if (code !== 0) return ''
  const name = stdout.trim()
  return name === 'HEAD' ? '' : name
}

function relInside(root: string, file: string): string | null {
  const repo = path.resolve(root)
  const target = path.resolve(file)
  const rel = path.relative(repo, target)
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel.split(path.sep).join('/')
}

async function mutateIndex(
  root: string,
  paths: string[] | null,
  run: (rels: string[]) => Promise<void>
): Promise<void> {
  if (!(await isRepo(root))) throw new Error('This folder is not a git repository.')
  const rels = paths === null ? ['.'] : paths.map((file) => {
    const rel = relInside(root, file)
    if (!rel) throw new Error('That file is outside the open folder.')
    return rel
  })
  if (rels.length === 0) throw new Error('Nothing to change.')
  await run(rels)
}

function runGit(
  cwd: string,
  args: string[],
  timeout = 20_000
): Promise<{ code: number; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    execFile(
      'git',
      ['--no-pager', ...args],
      { cwd, timeout, maxBuffer: 12_000_000, windowsHide: true },
      (error, stdout, stderr) => {
        const failed = error as (NodeJS.ErrnoException & { killed?: boolean }) | null
        if (failed && (failed.code === 'ENOENT' || failed.killed)) {
          reject(failed)
          return
        }
        const code = typeof failed?.code === 'number' ? failed.code : failed ? 1 : 0
        resolve({ code, stdout: stdout ?? '', stderr: stderr ?? '' })
      }
    )
  })
}
