import type { EditorState } from '@codemirror/state'

export type TextReference = {
  text: string
  raw: string
  file: string
  path: string
  start: number
  end: number
  kind: 'file' | 'terminal'
  absolute?: string
}

let lastCopy: TextReference | null = null

export function rememberReference(info: TextReference): void {
  lastCopy = info
}

export function referenceFromState(
  state: EditorState,
  file: { name: string; path: string; absolute?: string }
): TextReference | null {
  const range = state.selection.main
  if (range.empty) return null
  const raw = state.sliceDoc(range.from, range.to)
  if (!raw.trim()) return null
  const startLine = state.doc.lineAt(range.from)
  const endLine = state.doc.lineAt(range.to)
  let start = startLine.number
  let end = endLine.number
  if (range.to === endLine.from && end > start) end -= 1
  if (end < start) end = start
  return {
    text: normalize(raw),
    raw,
    file: file.name,
    path: file.path,
    start,
    end,
    kind: 'file',
    absolute: file.absolute
  }
}

export function referenceForPaste(pasted: string, extras: Array<TextReference | null>): TextReference | null {
  const normalized = normalize(pasted || '')
  if (!normalized) return null
  if (lastCopy && lastCopy.text === normalized) return lastCopy
  for (const extra of extras) {
    if (extra && extra.text === normalized) return extra
  }
  return null
}

export function lineSpan(info: Pick<TextReference, 'start' | 'end'>): string {
  return info.start === info.end ? String(info.start) : `${info.start}-${info.end}`
}

export function referenceLabel(info: TextReference): string {
  return `${info.file} (${lineSpan(info)})`
}

export function referenceDetail(info: TextReference): string {
  return `${info.path || info.file} (${lineSpan(info)})`
}

function normalize(text: string): string {
  return text.replace(/\r\n/g, '\n').replace(/\s+$/, '')
}
