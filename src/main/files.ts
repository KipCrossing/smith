import { cp, mkdir, readdir, readFile, realpath, rename, rm, stat, unlink, writeFile } from 'fs/promises'
import path from 'path'
import { FILE_LIST_LIMIT, MAX_FILE_BYTES, SKIP_NAMES, type DirEntry, type EntryKind, type ListedFiles } from '../shared/types'

export function asAbsolute(input: unknown): string {
  if (typeof input !== 'string' || input.length === 0 || input.includes('\0')) {
    throw new Error('Invalid path')
  }
  if (!path.isAbsolute(input)) throw new Error('Path must be absolute')
  return path.normalize(input)
}

export async function statKind(target: string): Promise<EntryKind> {
  try {
    const info = await stat(target)
    if (info.isDirectory()) return 'directory'
    if (info.isFile()) return 'file'
    return null
  } catch {
    return null
  }
}

export async function listDir(dir: string): Promise<DirEntry[]> {
  const entries = await readdir(dir, { withFileTypes: true })
  const visible = entries.filter((entry) => !SKIP_NAMES.has(entry.name) && (entry.isDirectory() || entry.isFile()))
  visible.sort((a, b) => {
    if (a.isDirectory() !== b.isDirectory()) return a.isDirectory() ? -1 : 1
    return a.name.localeCompare(b.name)
  })
  return visible.map((entry) => ({
    name: entry.name,
    path: path.join(dir, entry.name),
    kind: entry.isDirectory() ? 'directory' : 'file'
  }))
}

export async function readTextFile(file: string): Promise<string> {
  const info = await stat(file)
  if (!info.isFile()) throw new Error('Not a file')
  if (info.size > MAX_FILE_BYTES) throw new Error('File is larger than 1 MB')
  const buf = await readFile(file)
  if (buf.includes(0)) throw new Error('Not a text file')
  return buf.toString('utf8')
}

export async function createFile(root: string, dir: string, name: string): Promise<string> {
  const parent = assertInside(root, dir, true)
  if ((await statKind(parent)) !== 'directory') throw new Error('Not a folder')
  const target = path.join(parent, entryName(name))
  assertInside(root, target, false)
  try {
    await writeFile(target, '', { encoding: 'utf8', flag: 'wx' })
  } catch (error) {
    if (codeOf(error) === 'EEXIST') throw new Error('Already exists')
    throw error
  }
  return target
}

export async function createDirectory(root: string, dir: string, name: string): Promise<string> {
  const parent = assertInside(root, dir, true)
  if ((await statKind(parent)) !== 'directory') throw new Error('Not a folder')
  const target = path.join(parent, entryName(name))
  assertInside(root, target, false)
  try {
    await mkdir(target)
  } catch (error) {
    if (codeOf(error) === 'EEXIST') throw new Error('Already exists')
    throw error
  }
  return target
}

export async function renamePath(root: string, from: string, name: string): Promise<string> {
  const source = assertInside(root, from, false)
  const dest = path.join(path.dirname(source), entryName(name))
  assertInside(root, dest, false)
  if (dest === source) return source
  if ((await statKind(dest)) !== null) throw new Error('Already exists')
  await rename(source, dest)
  return dest
}

export async function removePath(root: string, target: string): Promise<void> {
  const abs = assertInside(root, target, false)
  const kind = await statKind(abs)
  if (kind === 'directory') await rm(abs, { recursive: true })
  else if (kind === 'file') await unlink(abs)
  else throw new Error('Nothing to delete')
}

export async function copyInto(root: string, from: string, toDir: string): Promise<string> {
  const source = assertInside(root, from, false)
  const destDir = assertInside(root, toDir, true)
  const kind = await statKind(source)
  if ((await statKind(destDir)) !== 'directory') throw new Error('Not a folder')
  if (!kind) throw new Error('Nothing to copy')
  refuseNested(source, destDir, kind)
  const dest = await freePath(destDir, path.basename(source))
  await cp(source, dest, { recursive: kind === 'directory' })
  return dest
}

export async function moveInto(root: string, from: string, toDir: string): Promise<string> {
  const source = assertInside(root, from, false)
  const destDir = assertInside(root, toDir, true)
  if (path.dirname(source) === path.resolve(destDir)) return source
  const kind = await statKind(source)
  if ((await statKind(destDir)) !== 'directory') throw new Error('Not a folder')
  if (!kind) throw new Error('Nothing to move')
  refuseNested(source, destDir, kind)
  const dest = await freePath(destDir, path.basename(source))
  try {
    await rename(source, dest)
  } catch (error) {
    if (codeOf(error) !== 'EXDEV') throw error
    await cp(source, dest, { recursive: kind === 'directory' })
    await rm(source, { recursive: true })
  }
  return dest
}

export async function duplicatePath(root: string, target: string): Promise<string> {
  const source = assertInside(root, target, false)
  return copyInto(root, source, path.dirname(source))
}

export async function writeTextFile(file: string, contents: string): Promise<void> {
  if (typeof contents !== 'string') throw new Error('Invalid contents')
  const info = await stat(file)
  if (!info.isFile()) throw new Error('Not a file')
  await writeFile(file, contents, 'utf8')
}

export async function saveTextFile(file: string, contents: string): Promise<void> {
  if (typeof contents !== 'string') throw new Error('Invalid contents')
  const info = await stat(file).catch(() => null)
  if (info?.isDirectory()) throw new Error('Not a file')
  await mkdir(path.dirname(file), { recursive: true })
  await writeFile(file, contents, 'utf8')
}

export async function listFiles(root: string): Promise<ListedFiles> {
  const resolvedRoot = await realpath(root)
  const paths: string[] = []
  let truncated = false

  async function walk(dir: string): Promise<void> {
    if (truncated) return
    const entries = await readdir(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (paths.length >= FILE_LIST_LIMIT) {
        truncated = true
        return
      }
      if (SKIP_NAMES.has(entry.name)) continue
      const next = path.join(dir, entry.name)
      if (entry.isDirectory()) await walk(next)
      else if (entry.isFile()) paths.push(next)
    }
  }

  await walk(resolvedRoot)
  paths.sort((a, b) => a.localeCompare(b))
  return { paths, truncated }
}

function entryName(name: unknown): string {
  if (typeof name !== 'string') throw new Error('Invalid name')
  const trimmed = name.trim()
  if (!trimmed || trimmed === '.' || trimmed === '..' || /[/\\\0]/.test(trimmed)) throw new Error('Invalid name')
  return trimmed
}

function assertInside(rootInput: string, targetInput: string, allowRoot: boolean): string {
  const root = path.resolve(asAbsolute(rootInput))
  const target = path.resolve(asAbsolute(targetInput))
  if (target === root) {
    if (allowRoot) return target
    throw new Error('Choose a file or folder inside the project')
  }
  const rel = path.relative(root, target)
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('Path is outside the folder')
  return target
}

function refuseNested(source: string, destDir: string, kind: EntryKind): void {
  if (kind !== 'directory') return
  const rel = path.relative(source, destDir)
  if (rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel))) {
    throw new Error('Cannot put a folder inside itself')
  }
}

async function freePath(dir: string, name: string): Promise<string> {
  const parsed = path.parse(name)
  for (let index = 0; index < 1000; index++) {
    const suffix = index === 0 ? '' : index === 1 ? ' copy' : ` copy ${index}`
    const candidate = parsed.ext ? `${parsed.name}${suffix}${parsed.ext}` : `${parsed.name}${suffix}`
    const full = path.join(dir, candidate)
    if ((await statKind(full)) === null) return full
  }
  throw new Error('Could not find a free name')
}

function codeOf(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code
  return ''
}
