import { closeBrackets, closeBracketsKeymap } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap, indentWithTab } from '@codemirror/commands'
import { bracketMatching, indentOnInput, LanguageDescription } from '@codemirror/language'
import { languages } from '@codemirror/language-data'
import { openSearchPanel, search, searchKeymap } from '@codemirror/search'
import { Compartment, EditorState, RangeSetBuilder } from '@codemirror/state'
import type { GitMark } from '../../shared/types'
import { referenceFromState, type TextReference } from './references'
import { oneDark } from '@codemirror/theme-one-dark'
import {
  drawSelection,
  dropCursor,
  EditorView,
  gutter,
  GutterMarker,
  highlightActiveLine,
  highlightActiveLineGutter,
  keymap,
  lineNumbers
} from '@codemirror/view'

export type CursorStatus = {
  line: number
  column: number
}

export type EditorController = {
  createState: (text: string, filename: string) => Promise<{ state: EditorState; language: string }>
  load: (state: EditorState) => void
  getState: () => EditorState
  getText: () => string
  openFind: () => void
  focus: () => void
  cursor: () => CursorStatus
  selectionReference: (file: { name: string; path: string; absolute?: string } | null) => TextReference | null
  goToLine: (line: number, column?: number) => void
  setGitGutter: (marks: GitMark[]) => void
  replaceDocument: (text: string) => void
  toggleWrap: () => boolean
  wrapping: () => boolean
}

const WRAP_KEY = 'smith.wrap'
const wrapCompartment = new Compartment()
const gitCompartment = new Compartment()
let wrapping = localStorage.getItem(WRAP_KEY) === '1'
let gitMarks: GitMark[] = []

const editorTheme = EditorView.theme({
  '&': { height: '100%', fontSize: '14px' },
  '.cm-scroller': {
    fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
    overflow: 'auto'
  },
  '.cm-content': { padding: '8px 0' },
  '.cm-git-gutter': { width: '8px' },
  '.git-mark': { width: '3px', height: '100%', minHeight: '1.2em', marginLeft: '2px' },
  '.git-add': { background: '#98c379' },
  '.git-change': { background: '#61afef' },
  '.git-delete-before': { boxShadow: 'inset 0 3px 0 #e06c75' },
  '.git-delete-after': { boxShadow: 'inset 0 -3px 0 #e06c75' }
})

export function createEditor(
  parent: HTMLElement,
  onDocChanged: () => void,
  onCursor: (cursor: CursorStatus) => void
): EditorController {
  let suppress = false

  const view = new EditorView({
    parent,
    state: EditorState.create({
      doc: '',
      extensions: extensions(onDocChanged, onCursor, () => suppress)
    })
  })

  return {
    async createState(text, filename) {
      const description = LanguageDescription.matchFilename(languages, filename)
      const language = description ? await description.load() : null
      return {
        language: description?.name ?? 'Plain Text',
        state: EditorState.create({
          doc: text,
          extensions: [...extensions(onDocChanged, onCursor, () => suppress), language ?? []]
        })
      }
    },
    load(state) {
      suppress = true
      view.setState(state)
      view.dispatch({
        effects: [wrapCompartment.reconfigure(wrapExtension()), gitCompartment.reconfigure(gitGutter())]
      })
      suppress = false
      onCursor(cursorOf(view.state))
    },
    getState: () => view.state,
    getText: () => view.state.doc.toString(),
    openFind() {
      openSearchPanel(view)
      view.focus()
    },
    focus() {
      view.focus()
    },
    cursor: () => cursorOf(view.state),
    selectionReference(file) {
      if (!file) return null
      return referenceFromState(view.state, file)
    },
    goToLine(line, column = 1) {
      const clamped = Math.min(Math.max(1, Math.floor(line)), view.state.doc.lines)
      const row = view.state.doc.line(clamped)
      const col = Math.min(Math.max(1, Math.floor(column)), row.length + 1)
      view.dispatch({ selection: { anchor: row.from + col - 1 }, scrollIntoView: true })
      view.focus()
    },
    setGitGutter(marks) {
      gitMarks = marks
      view.dispatch({ effects: gitCompartment.reconfigure(gitGutter()) })
    },
    replaceDocument(text) {
      if (view.state.doc.toString() === text) return
      view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text } })
    },
    toggleWrap() {
      wrapping = !wrapping
      localStorage.setItem(WRAP_KEY, wrapping ? '1' : '0')
      view.dispatch({ effects: wrapCompartment.reconfigure(wrapExtension()) })
      return wrapping
    },
    wrapping: () => wrapping
  }
}

function extensions(
  onDocChanged: () => void,
  onCursor: (cursor: CursorStatus) => void,
  suppressed: () => boolean
) {
  return [
    gitCompartment.of(gitGutter()),
    lineNumbers(),
    highlightActiveLineGutter(),
    highlightActiveLine(),
    drawSelection(),
    dropCursor(),
    EditorState.allowMultipleSelections.of(true),
    history(),
    bracketMatching(),
    closeBrackets(),
    indentOnInput(),
    search({ top: true }),
    keymap.of([...closeBracketsKeymap, ...defaultKeymap, ...searchKeymap, ...historyKeymap, indentWithTab]),
    oneDark,
    editorTheme,
    wrapCompartment.of(wrapExtension()),
    EditorView.updateListener.of((update) => {
      if (suppressed()) return
      if (update.docChanged) onDocChanged()
      if (update.docChanged || update.selectionSet) onCursor(cursorOf(update.state))
    })
  ]
}

function wrapExtension(): [] | typeof EditorView.lineWrapping {
  return wrapping ? EditorView.lineWrapping : []
}

class GitLineMarker extends GutterMarker {
  constructor(readonly cls: string) {
    super()
  }

  eq(other: GutterMarker): boolean {
    return other instanceof GitLineMarker && other.cls === this.cls
  }

  toDOM(): HTMLElement {
    const el = document.createElement('div')
    el.className = `git-mark ${this.cls}`
    return el
  }
}

const gitSpacer = new GitLineMarker('')
const gitMarkerCache = new Map<string, GitLineMarker>()

function gitMarker(cls: string): GitLineMarker {
  const cached = gitMarkerCache.get(cls)
  if (cached) return cached
  const created = new GitLineMarker(cls)
  gitMarkerCache.set(cls, created)
  return created
}

function gitGutter() {
  return gutter({
    class: 'cm-git-gutter',
    markers(view) {
      const byLine = new Map<number, GitMark>()
      for (const mark of gitMarks) {
        const line = Math.min(Math.max(1, mark.line), view.state.doc.lines)
        const current = byLine.get(line) ?? { line, add: false, change: false, deleteBefore: false, deleteAfter: false }
        current.add = current.add || mark.add
        current.change = current.change || mark.change
        current.deleteBefore = current.deleteBefore || mark.deleteBefore
        current.deleteAfter = current.deleteAfter || mark.deleteAfter || (mark.line > view.state.doc.lines)
        byLine.set(line, current)
      }
      const builder = new RangeSetBuilder<GutterMarker>()
      for (let line = 1; line <= view.state.doc.lines; line += 1) {
        const mark = byLine.get(line)
        if (!mark) continue
        const classes = [
          mark.change ? 'git-change' : mark.add ? 'git-add' : '',
          mark.deleteBefore ? 'git-delete-before' : '',
          mark.deleteAfter ? 'git-delete-after' : ''
        ].filter(Boolean)
        if (classes.length === 0) continue
        const pos = view.state.doc.line(line).from
        builder.add(pos, pos, gitMarker(classes.join(' ')))
      }
      return builder.finish()
    },
    initialSpacer: () => gitSpacer
  })
}

function cursorOf(state: EditorState): CursorStatus {
  const head = state.selection.main.head
  const line = state.doc.lineAt(head)
  return { line: line.number, column: head - line.from + 1 }
}
