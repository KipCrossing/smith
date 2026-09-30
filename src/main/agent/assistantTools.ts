import { readFile, writeFile } from 'fs/promises'
import path from 'path'
import type { ToolSchema } from './ollama'
import { editFile, ToolError } from './editFile'
import { fetchPage, searchWeb } from './tools'

const DOCUMENT = 'document.md'

type ToolDef = {
  name: string
  description: string
  parameters: Record<string, unknown>
  run: (args: Record<string, unknown>) => Promise<Record<string, unknown>>
}

export class AssistantTools {
  signal: AbortSignal | undefined
  private readonly failed = new Set<string>()

  constructor(
    private readonly dir: string,
    private readonly allowReplace: boolean
  ) {}

  schemas(): ToolSchema[] {
    return this.defs().map((tool) => ({
      type: 'function',
      function: { name: tool.name, description: tool.description, parameters: tool.parameters }
    }))
  }

  async execute(name: string, args: Record<string, unknown>): Promise<{ result: Record<string, unknown>; changed: boolean }> {
    const tool = this.defs().find((item) => item.name === name)
    if (!tool) return { result: { ok: false, error: `unknown tool: ${name}` }, changed: false }
    const key = `${name}:${JSON.stringify(args)}`
    if (this.failed.has(key)) return { result: { ok: false, error: `${name} already failed with these arguments` }, changed: false }
    try {
      const result = await tool.run(args)
      return { result, changed: result.changed === true }
    } catch (error) {
      this.failed.add(key)
      const message = error instanceof Error ? error.message : String(error)
      return { result: { ok: false, error: message }, changed: false }
    }
  }

  private file(): string {
    return path.join(this.dir, DOCUMENT)
  }

  private defs(): ToolDef[] {
    const tools: ToolDef[] = [
      {
        name: 'web_search',
        description: 'Search the public internet. Returns titles, URLs, and snippets.',
        parameters: object({
          query: { type: 'string', description: 'Search query.' },
          max_results: { type: 'integer', description: '1-10, default 5.' }
        }, ['query']),
        run: async (args) => {
          const found = await searchWeb(str(args, 'query'), integer(args, 'max_results', 5), this.signal)
          return { ok: true, query: found.query, results: found.results }
        }
      },
      {
        name: 'fetch_url',
        description: 'Fetch a URL and return its readable text.',
        parameters: object({
          url: { type: 'string', description: 'Absolute http or https URL.' },
          max_chars: { type: 'integer', description: 'Truncate the extracted text. Default 8000.' }
        }, ['url']),
        run: async (args) => {
          const page = await fetchPage(str(args, 'url'), integer(args, 'max_chars', 8000), this.signal)
          return { ok: true, ...page }
        }
      },
      {
        name: 'read_document',
        description: 'Read the working document, optionally a line range. Always read it before editing.',
        parameters: object({
          start_line: { type: 'integer', description: 'First line to show, 1-based.' },
          end_line: { type: 'integer', description: 'Last line to show, inclusive.' }
        }, []),
        run: async (args) => readDocument(this.file(), integer(args, 'start_line', 0), integer(args, 'end_line', 0))
      },
      {
        name: 'edit_document',
        description: 'Replace exact text in the working document. Read it first. old_string must match, including blank lines.',
        parameters: object({
          edits: {
            type: 'array',
            description: 'Edits applied in order, top of the document downward.',
            items: {
              type: 'object',
              properties: {
                old_string: { type: 'string', description: 'Text to replace, copied from the document.' },
                new_string: { type: 'string', description: 'Replacement text. Use an empty string to delete.' },
                replace_all: { type: 'boolean', description: 'Replace every occurrence instead of requiring uniqueness.' }
              },
              required: ['old_string', 'new_string']
            }
          }
        }, ['edits']),
        run: async (args) => {
          const applied = await editFile(this.file(), args.edits)
          return { ok: true, changed: true, ...applied }
        }
      },
      {
        name: 'append_document',
        description: 'Add markdown at the end of the working document. Existing text stays as it is.',
        parameters: object({
          text: { type: 'string', description: 'Markdown to add.' }
        }, ['text']),
        run: async (args) => {
          const addition = str(args, 'text')
          if (!addition.trim()) throw new ToolError('text must not be empty')
          const current = await readFile(this.file(), 'utf8').catch(() => '')
          const gap = current.trim() && !current.endsWith('\n') ? '\n\n' : current.endsWith('\n\n') || !current ? '' : '\n'
          await writeFile(this.file(), `${current}${gap}${addition.trim()}\n`, 'utf8')
          return { ok: true, changed: true }
        }
      }
    ]
    if (this.allowReplace) {
      tools.push({
        name: 'replace_document',
        description: 'Overwrite the whole working document. Use this only when the user asked for a full rewrite.',
        parameters: object({
          contents: { type: 'string', description: 'The full new document.' }
        }, ['contents']),
        run: async (args) => {
          await writeFile(this.file(), str(args, 'contents'), 'utf8')
          return { ok: true, changed: true }
        }
      })
    }
    return tools
  }
}

async function readDocument(file: string, start: number, end: number): Promise<Record<string, unknown>> {
  let text = ''
  try {
    text = await readFile(file, 'utf8')
  } catch {
    text = ''
  }
  const lines = text.split('\n')
  const from = start > 0 ? start : 1
  const to = end > 0 ? end : lines.length
  const slice = lines.slice(from - 1, Math.max(from, to))
  const numbered = slice.map((line, index) => `${from + index}|${line}`).join('\n')
  return { ok: true, start_line: from, end_line: from + slice.length - 1, text: numbered }
}

function object(properties: Record<string, unknown>, required: string[]): Record<string, unknown> {
  return { type: 'object', properties, required }
}

function str(args: Record<string, unknown>, key: string): string {
  const value = args[key]
  return typeof value === 'string' ? value : ''
}

function integer(args: Record<string, unknown>, key: string, fallback: number): number {
  const value = args[key]
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value)
  if (typeof value === 'string' && /^-?\d+$/.test(value)) return Number(value)
  return fallback
}
