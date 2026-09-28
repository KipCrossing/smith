import { LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { EditorState, RangeSetBuilder } from '@codemirror/state'
import { oneDark } from '@codemirror/theme-one-dark'
import {
  Decoration,
  EditorView,
  gutter,
  GutterMarker,
  ViewPlugin,
  type DecorationSet
} from '@codemirror/view'
import type { GitDiffLine } from '../../shared/types'

export type DiffViewController = {
  show: (file: string, label: string, lines: GitDiffLine[], canOpen: boolean) => Promise<void>
  showMessage: (file: string, label: string, message: string, canOpen: boolean) => void
  hide: () => void
}

export function mountDiffView(host: HTMLElement, onOpen: (file: string) => void): DiffViewController {
  host.innerHTML = `
    <div class="diff-bar">
      <span class="diff-title"></span>
      <button type="button" class="diff-open">Open file</button>
      <button type="button" class="diff-close" title="Close">×</button>
    </div>
    <div class="diff-body"></div>
  `
  const title = host.querySelector('.diff-title')
  const openButton = host.querySelector('.diff-open')
  const closeButton = host.querySelector('.diff-close')
  const body = host.querySelector('.diff-body')
  if (!(title instanceof HTMLElement) || !(openButton instanceof HTMLButtonElement)) {
    throw new Error('Missing diff bar')
  }
  if (!(closeButton instanceof HTMLButtonElement) || !(body instanceof HTMLElement)) {
    throw new Error('Missing diff body')
  }
  const titleEl = title
  const openEl = openButton
  const bodyEl = body

  let current = ''
  let view: EditorView | null = null

  openButton.addEventListener('click', () => {
    if (current) onOpen(current)
  })
  closeButton.addEventListener('click', () => hide())

  function hide(): void {
    host.hidden = true
    current = ''
    view?.destroy()
    view = null
    bodyEl.replaceChildren()
  }

  function prepare(file: string, label: string, canOpen: boolean): void {
    current = file
    titleEl.textContent = label
    openEl.hidden = !canOpen
    host.hidden = false
    view?.destroy()
    view = null
    bodyEl.replaceChildren()
  }

  return {
    async show(file, label, lines, canOpen) {
      prepare(file, label, canOpen)
      if (lines.length === 0) {
        bodyEl.append(note('No differences.'))
        return
      }
      const description = LanguageDescription.matchFilename(languages, file)
      const language = description ? await description.load() : null
      if (current !== file) return
      const doc = lines.map((line) => line.text).join('\n')
      view = new EditorView({
        parent: bodyEl,
        state: EditorState.create({
          doc,
          extensions: [
            diffGutter(lines),
            lineDecorations(lines),
            EditorState.readOnly.of(true),
            EditorView.editable.of(false),
            oneDark,
            diffTheme,
            language ?? []
          ]
        })
      })
      const first = lines.findIndex((line) => line.kind !== 'same')
      if (first > 0) {
        const pos = view.state.doc.line(first + 1).from
        view.dispatch({ effects: EditorView.scrollIntoView(pos, { y: 'center' }) })
      }
    },
    showMessage(file, label, message, canOpen) {
      prepare(file, label, canOpen)
      bodyEl.append(note(message))
    },
    hide
  }
}

function note(text: string): HTMLElement {
  const el = document.createElement('div')
  el.className = 'diff-note'
  el.textContent = text
  return el
}

class NumMarker extends GutterMarker {
  constructor(
    readonly label: string,
    readonly kind: GitDiffLine['kind']
  ) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof NumMarker && other.label === this.label && other.kind === this.kind
  }

  toDOM(): HTMLElement {
    const el = document.createElement('span')
    el.className = `diff-num diff-num-${this.kind}`
    el.textContent = this.label
    return el
  }
}

function diffGutter(lines: GitDiffLine[]) {
  return gutter({
    class: 'cm-diff-gutter',
    lineMarker(view, line) {
      const number = view.state.doc.lineAt(line.from).number
      const kind = lines[number - 1]?.kind ?? 'same'
      return new NumMarker(String(number), kind)
    },
    initialSpacer: () => new NumMarker('000', 'same')
  })
}

const addLine = Decoration.line({ class: 'diff-add' })
const delLine = Decoration.line({ class: 'diff-del' })

function lineDecorations(lines: GitDiffLine[]) {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet
      constructor(view: EditorView) {
        const builder = new RangeSetBuilder<Decoration>()
        const count = Math.min(lines.length, view.state.doc.lines)
        for (let index = 0; index < count; index += 1) {
          const kind = lines[index].kind
          if (kind === 'same') continue
          const from = view.state.doc.line(index + 1).from
          builder.add(from, from, kind === 'add' ? addLine : delLine)
        }
        this.decorations = builder.finish()
      }
    },
    { decorations: (value) => value.decorations }
  )
}

const diffTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    overflow: 'auto'
  },
  '.cm-gutters': { background: 'transparent', border: 'none' },
  '.cm-diff-gutter': { width: '3.4em' },
  '.cm-diff-gutter .cm-gutterElement': { padding: '0 10px 0 8px' }
})
