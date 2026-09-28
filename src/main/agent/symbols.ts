export type SymbolKind = 'function' | 'class' | 'type' | 'const' | 'method' | 'heading'

export type SourceSymbol = {
  name: string
  kind: SymbolKind
  line: number
  signature: string
}

const MAX_SYMBOLS = 40
const MAX_SIGNATURE = 140

type Hit = { name: string; kind: SymbolKind }

export function extractSymbols(filePath: string, text: string): SourceSymbol[] {
  if (looksMinified(text)) return []
  const match = matcherFor(filePath)
  if (!match) return []
  const symbols: SourceSymbol[] = []
  const lines = text.split(/\r?\n/)
  for (let index = 0; index < lines.length; index += 1) {
    if (symbols.length >= MAX_SYMBOLS) break
    const raw = lines[index]
    if (raw.length > 300) continue
    const hit = match(raw)
    if (!hit || !hit.name.trim()) continue
    symbols.push({
      name: clip(hit.name.trim(), 80),
      kind: hit.kind,
      line: index + 1,
      signature: clip(raw.trim().replace(/\s+/g, ' '), MAX_SIGNATURE)
    })
  }
  return symbols
}

function matcherFor(filePath: string): ((line: string) => Hit | null) | null {
  const ext = extension(filePath)
  if (ext === 'md' || ext === 'mdx') return markdown
  if (ext === 'py' || ext === 'pyi') return python
  if (ext === 'go') return go
  if (ext === 'rs') return rust
  if (ext === 'java' || ext === 'kt' || ext === 'kts' || ext === 'scala' || ext === 'cs') return jvm
  if (ext === 'rb') return ruby
  if (ext === 'php') return php
  if (ext === 'swift') return swift
  if (ext === 'c' || ext === 'h' || ext === 'cc' || ext === 'cpp' || ext === 'hpp' || ext === 'hh') return cFamily
  if (ext === 'sh' || ext === 'bash' || ext === 'zsh') return shell
  if (isScript(ext)) return script
  return null
}

function isScript(ext: string): boolean {
  return ['ts', 'tsx', 'js', 'jsx', 'mjs', 'cjs', 'mts', 'cts', 'vue', 'svelte'].includes(ext)
}

function script(line: string): Hit | null {
  if (isComment(line) || /^\s/.test(line)) return null
  return (
    named(line, /^(?:export\s+)?(?:default\s+)?(?:async\s+)?function\s*\*?\s+(\w+)/, 'function')
    ?? named(line, /^(?:export\s+)?(?:default\s+)?(?:abstract\s+)?class\s+(\w+)/, 'class')
    ?? named(line, /^(?:export\s+)?(?:interface|type|enum)\s+(\w+)/, 'type')
    ?? named(line, /^export\s+(?:const|let|var)\s+(\w+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z_$][\w$]*\s*=>)/, 'function')
    ?? named(line, /^export\s+(?:const|let|var|function)\s+(\w+)/, 'const')
  )
}

function python(line: string): Hit | null {
  if (/^\s/.test(line) || line.trim().startsWith('#')) return null
  return named(line, /^class\s+(\w+)/, 'class') ?? named(line, /^(?:async\s+)?def\s+(\w+)/, 'function')
}

function go(line: string): Hit | null {
  if (/^\s/.test(line) || isComment(line)) return null
  const method = /^func\s+\([^)]*\)\s+(\w+)/.exec(line)
  if (method) return { name: method[1], kind: 'method' }
  return named(line, /^func\s+(\w+)/, 'function') ?? named(line, /^type\s+(\w+)\s+(?:struct|interface)\b/, 'type')
}

function rust(line: string): Hit | null {
  if (/^\s/.test(line) || isComment(line)) return null
  const prefix = '^(?:pub(?:\\([^)]*\\))?\\s+)?'
  return (
    named(line, new RegExp(`${prefix}(?:async\\s+)?fn\\s+(\\w+)`), 'function')
    ?? named(line, new RegExp(`${prefix}(?:struct|enum|trait|type|mod)\\s+(\\w+)`), 'type')
    ?? named(line, /^impl(?:<[^>]+>)?\s+(\w+)/, 'type')
  )
}

function jvm(line: string): Hit | null {
  if (/^\s/.test(line) || isComment(line)) return null
  return (
    named(line, /^(?:(?:public|private|protected|internal|open|abstract|data|sealed|final|static)\s+)*(?:class|interface|enum|object|trait)\s+(\w+)/, 'class')
    ?? named(line, /^(?:(?:public|private|protected|internal|open|abstract|suspend|inline)\s+)*fun\s+(\w+)/, 'function')
  )
}

function ruby(line: string): Hit | null {
  if (/^\s/.test(line) || line.trim().startsWith('#')) return null
  return named(line, /^(?:class|module)\s+(\w+)/, 'class') ?? named(line, /^def\s+(?:self\.)?(\w+[?!]?)/, 'function')
}

function php(line: string): Hit | null {
  if (/^\s/.test(line) || isComment(line)) return null
  return (
    named(line, /^(?:(?:abstract|final)\s+)?(?:class|interface|trait|enum)\s+(\w+)/, 'class')
    ?? named(line, /^(?:(?:public|private|protected|static|final)\s+)*function\s+(\w+)/, 'function')
  )
}

function swift(line: string): Hit | null {
  if (/^\s/.test(line) || isComment(line)) return null
  const prefix = '^(?:(?:public|private|internal|open|fileprivate|final|static|class)\\s+)*'
  return (
    named(line, new RegExp(`${prefix}func\\s+(\\w+)`), 'function')
    ?? named(line, new RegExp(`${prefix}(?:class|struct|enum|protocol|actor)\\s+(\\w+)`), 'type')
  )
}

function cFamily(line: string): Hit | null {
  if (/^\s/.test(line) || isComment(line)) return null
  return named(line, /^(?:typedef\s+)?(?:struct|class|enum|union|namespace)\s+(\w+)/, 'type')
}

function shell(line: string): Hit | null {
  if (/^\s/.test(line) || line.trim().startsWith('#')) return null
  return named(line, /^(\w+)\s*\(\s*\)\s*\{?\s*$/, 'function') ?? named(line, /^function\s+(\w+)/, 'function')
}

function markdown(line: string): Hit | null {
  const match = /^(#{1,3})\s+(\S.*)$/.exec(line)
  if (!match) return null
  return { name: match[2].trim(), kind: 'heading' }
}

function named(line: string, pattern: RegExp, kind: SymbolKind): Hit | null {
  const match = pattern.exec(line)
  if (!match?.[1]) return null
  return { name: match[1], kind }
}

function isComment(line: string): boolean {
  const trimmed = line.trim()
  return trimmed.startsWith('//') || trimmed.startsWith('/*') || trimmed.startsWith('*') || trimmed.startsWith('#')
}

function looksMinified(text: string): boolean {
  if (text.length < 1000) return false
  const lines = text.split(/\r?\n/).length
  return lines < text.length / 400
}

function extension(filePath: string): string {
  const base = filePath.split(/[\\/]/).pop() ?? ''
  const dot = base.lastIndexOf('.')
  if (dot <= 0) return ''
  return base.slice(dot + 1).toLowerCase()
}

function clip(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max - 1)}…` : text
}
