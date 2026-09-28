import { readFile, writeFile } from 'fs/promises'

export class ToolError extends Error {}

export interface AppliedEdit {
  edit: number
  occurrences_replaced: number
  matched?: string
}

interface Edit {
  old_string: string
  new_string: string
  replace_all: boolean
}

type Normalise = (line: string) => string

const TOLERANCES: Array<[string, Normalise, boolean]> = [
  ['ignoring trailing whitespace', (line) => line.trimEnd(), false],
  ['ignoring blank lines', (line) => line.trimEnd(), true],
  ['ignoring indentation', (line) => line.trim(), false],
  ['ignoring indentation and blank lines', (line) => line.trim(), true]
]

export async function editFile(
  target: string,
  edits: unknown
): Promise<{ applied: AppliedEdit[]; linesBefore: number; linesAfter: number }> {
  const original = await readFile(target, 'utf8')
  const crlf = original.includes('\r\n')
  let text = crlf ? original.replace(/\r\n/g, '\n') : original
  const planned = normaliseEdits(edits)
  const applied: AppliedEdit[] = []

  planned.forEach((edit, index) => {
    const old = edit.old_string
    const next = edit.new_string
    if (old === next) throw new ToolError(`edit ${index}: old_string and new_string are identical`)
    if (!old) throw new ToolError(`edit ${index}: old_string must not be empty`)
    const occurrences = countOf(text, old)
    if (occurrences > 1 && !edit.replace_all) {
      throw new ToolError(
        `edit ${index}: old_string appears ${occurrences} times. Extend it with surrounding lines until it is unique, or set replace_all to true.`
      )
    }
    let matched = 'exact'
    let replaced = 0
    if (occurrences) {
      text = edit.replace_all ? text.split(old).join(next) : replaceFirst(text, old, next)
      replaced = edit.replace_all ? occurrences : 1
    } else {
      try {
        const tolerant = tolerantReplace(text, old, next, edit.replace_all)
        text = tolerant.text
        matched = tolerant.label
        replaced = tolerant.count
      } catch (error) {
        if (!(error instanceof ToolError) || error.message !== 'no tolerant match') {
          const message = error instanceof Error ? error.message : String(error)
          throw new ToolError(`edit ${index}: ${message}`)
        }
        throw new ToolError(`edit ${index}: old_string not found.${nearMiss(text, old)}`)
      }
    }
    const entry: AppliedEdit = { edit: index, occurrences_replaced: replaced }
    if (matched !== 'exact') entry.matched = matched
    applied.push(entry)
  })

  await writeFile(target, crlf ? text.replace(/\n/g, '\r\n') : text, 'utf8')
  return { applied, linesBefore: splitLines(original).length, linesAfter: splitLines(text).length }
}

function normaliseEdits(edits: unknown): Edit[] {
  let value = edits
  if (typeof value === 'string') {
    try {
      value = JSON.parse(value) as unknown
    } catch {
      throw new ToolError('edits arrived as a string that is not valid JSON. Send edits as an array of objects.')
    }
  }
  if (value && typeof value === 'object' && !Array.isArray(value)) value = [value]
  if (!Array.isArray(value) || value.length === 0) {
    throw new ToolError('edits must be a non-empty array of {old_string, new_string}')
  }
  return value.map((item) => {
    if (!item || typeof item !== 'object') throw new ToolError('each edit must be an object')
    const row = item as Record<string, unknown>
    if (typeof row.old_string !== 'string' || typeof row.new_string !== 'string') {
      throw new ToolError('each edit needs both old_string and new_string')
    }
    return {
      old_string: row.old_string.replace(/\r\n/g, '\n'),
      new_string: row.new_string.replace(/\r\n/g, '\n'),
      replace_all: row.replace_all === true
    }
  })
}

function replaceFirst(text: string, old: string, next: string): string {
  const index = text.indexOf(old)
  if (index < 0) return text
  return text.slice(0, index) + next + text.slice(index + old.length)
}

function countOf(text: string, needle: string): number {
  if (!needle) return 0
  return text.split(needle).length - 1
}

function tolerantReplace(
  text: string,
  old: string,
  next: string,
  replaceAll: boolean
): { text: string; label: string; count: number } {
  const raw = splitKeepEnds(text)
  const plain = raw.map((line) => line.replace(/\n$/, ''))
  const wanted = splitLines(old)

  for (const [label, normalise, skipBlank] of TOLERANCES) {
    const spans: Array<{ begin: number; end: number; pairs: Array<[number, number]> }> = []
    let cursor = 0
    while (cursor < plain.length) {
      const hit = align(plain, cursor, wanted, normalise, skipBlank)
      if (!hit) {
        cursor += 1
        continue
      }
      spans.push({ begin: cursor, end: hit.end, pairs: hit.pairs })
      cursor = hit.end
    }
    if (spans.length === 0) continue
    if (spans.length > 1 && !replaceAll) {
      throw new ToolError(
        `old_string matches ${spans.length} places when ${label}. Extend it with surrounding lines until it is unique, or set replace_all to true.`
      )
    }
    const chosen = replaceAll ? spans : spans.slice(0, 1)
    const out: string[] = []
    let previous = 0
    for (const span of chosen) {
      out.push(raw.slice(previous, span.begin).join(''))
      let block = reindent(next, wanted, plain, span.pairs)
      if (block && raw[span.end - 1]?.endsWith('\n')) block += '\n'
      out.push(block)
      previous = span.end
    }
    out.push(raw.slice(previous).join(''))
    return { text: out.join(''), label, count: chosen.length }
  }
  throw new ToolError('no tolerant match')
}

function align(
  plain: string[],
  start: number,
  wanted: string[],
  normalise: Normalise,
  skipBlank: boolean
): { end: number; pairs: Array<[number, number]> } | null {
  let index = start
  const pairs: Array<[number, number]> = []
  for (let position = 0; position < wanted.length; position += 1) {
    const target = normalise(wanted[position])
    if (!target) {
      if (skipBlank) continue
      if (index < plain.length && !normalise(plain[index])) {
        index += 1
        continue
      }
      return null
    }
    if (pairs.length > 0 && skipBlank) {
      while (index < plain.length && !normalise(plain[index])) index += 1
    }
    if (index >= plain.length || normalise(plain[index]) !== target) return null
    pairs.push([position, index])
    index += 1
  }
  return pairs.length > 0 ? { end: index, pairs } : null
}

function reindent(next: string, wanted: string[], plain: string[], pairs: Array<[number, number]>): string {
  const offsets = new Map<string, string>()
  const order: Array<[string, string]> = []
  for (const [position, index] of pairs) {
    const modelLead = lead(wanted[position])
    const fileLead = lead(plain[index])
    const offset = fileLead.startsWith(modelLead) ? fileLead.slice(modelLead.length) : ''
    const key = wanted[position].trim()
    if (!offsets.has(key)) offsets.set(key, offset)
    order.push([key, offset])
  }
  const out: string[] = []
  let carried = order[0]?.[1] ?? ''
  let cursor = 0
  for (const line of splitLines(next)) {
    const key = line.trim()
    if (!key) {
      out.push(line)
      continue
    }
    const found = order.findIndex((entry, index) => index >= cursor && entry[0] === key)
    if (found !== -1) {
      carried = order[found][1]
      cursor = found + 1
    } else if (cursor < order.length) {
      carried = order[cursor][1]
    } else if (offsets.has(key)) {
      carried = offsets.get(key) ?? carried
    }
    out.push(carried + line)
  }
  return out.join('\n')
}

function lead(line: string): string {
  return line.slice(0, line.length - line.trimStart().length)
}

function nearMiss(text: string, old: string): string {
  const wanted = splitLines(old)
  const lines = splitLines(text)
  const anchors = wanted
    .map((line, index) => [index, line.trim()] as const)
    .filter((pair) => pair[1])
    .sort((a, b) => b[1].length - a[1].length)
    .slice(0, 3)
  for (const [offset, anchor] of anchors) {
    const hit = lines.findIndex((line) => line.includes(anchor))
    if (hit < 0) continue
    const start = Math.max(0, hit - offset)
    let actual = lines.slice(start, start + wanted.length).join('\n')
    if (!actual) continue
    const whitespaceOnly = squash(actual) === squash(old)
    if (!whitespaceOnly) actual = lines.slice(start, start + wanted.length + 1).join('\n')
    const reason = whitespaceOnly
      ? 'The only differences are whitespace: indentation or blank lines.'
      : 'Note the exact indentation and blank lines.'
    return (
      ` ${reason}\nThe file actually contains, at that point:\n` +
      `<<<ACTUAL\n${actual}\nACTUAL\n` +
      'Copy the text between the markers exactly as old_string. Blank lines inside it are real and must be included.'
    )
  }
  return (
    ' It must match the file exactly, including indentation and blank lines. ' +
    'None of the lines you sent were found even ignoring whitespace, so re-read the file before trying again.'
  )
}

function squash(text: string): string {
  return text.replace(/\s+/g, '')
}

function splitLines(text: string): string[] {
  if (!text) return []
  const lines = text.split('\n')
  if (text.endsWith('\n')) lines.pop()
  return lines
}

function splitKeepEnds(text: string): string[] {
  if (!text) return []
  const out: string[] = []
  const pattern = /[^\n]*\n|[^\n]+$/g
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) out.push(match[0])
  return out
}
