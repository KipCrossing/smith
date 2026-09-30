export function renderMarkdown(parent: HTMLElement, source: string): void {
  parent.classList.add('agent-md')
  const chunks: Array<{ type: 'md'; text: string } | { type: 'code'; lang: string; text: string }> = []
  const pattern = /```([^\n]*)\n([\s\S]*?)```/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(source))) {
    if (match.index > last) chunks.push({ type: 'md', text: source.slice(last, match.index) })
    chunks.push({ type: 'code', lang: match[1].trim(), text: match[2].replace(/\n$/, '') })
    last = match.index + match[0].length
  }
  if (last < source.length) chunks.push({ type: 'md', text: source.slice(last) })
  for (const chunk of chunks) {
    if (chunk.type === 'md') renderBlocks(parent, chunk.text)
    else parent.append(codeBlock(chunk.lang, chunk.text))
  }
}

function renderBlocks(parent: HTMLElement, source: string): void {
  const lines = source.replace(/\r\n/g, '\n').split('\n')
  let index = 0
  while (index < lines.length) {
    const line = lines[index]
    if (!line.trim()) {
      index += 1
      continue
    }
    if (/^(-{3,}|\*{3,})$/.test(line.trim())) {
      parent.append(document.createElement('hr'))
      index += 1
      continue
    }
    const heading = /^(#{1,4})\s+(.*)$/.exec(line)
    if (heading) {
      const title = document.createElement('div')
      title.className = `agent-md-h agent-md-h${heading[1].length}`
      appendInline(title, heading[2])
      parent.append(title)
      index += 1
      continue
    }
    if (/^[-*]\s+/.test(line)) {
      parent.append(list(lines, index, 'ul', /^[-*]\s+/))
      while (index < lines.length && /^[-*]\s+/.test(lines[index])) index += 1
      continue
    }
    if (/^\d+\.\s+/.test(line)) {
      parent.append(list(lines, index, 'ol', /^\d+\.\s+/))
      while (index < lines.length && /^\d+\.\s+/.test(lines[index])) index += 1
      continue
    }
    if (line.startsWith('>')) {
      const quote = document.createElement('blockquote')
      const quoted: string[] = []
      while (index < lines.length && lines[index].startsWith('>')) {
        quoted.push(lines[index].replace(/^>\s?/, ''))
        index += 1
      }
      appendInline(quote, quoted.join(' '))
      parent.append(quote)
      continue
    }
    const paragraph: string[] = []
    while (index < lines.length && lines[index].trim() && !blockStart(lines[index])) {
      paragraph.push(lines[index])
      index += 1
    }
    const block = document.createElement('p')
    appendInline(block, paragraph.join(' '))
    parent.append(block)
  }
}

function list(lines: string[], index: number, tag: 'ul' | 'ol', marker: RegExp): HTMLElement {
  const node = document.createElement(tag)
  let cursor = index
  while (cursor < lines.length && marker.test(lines[cursor])) {
    const item = document.createElement('li')
    appendInline(item, lines[cursor].replace(marker, ''))
    node.append(item)
    cursor += 1
  }
  return node
}

function blockStart(line: string): boolean {
  return /^#{1,4}\s+/.test(line) || /^[-*]\s+/.test(line) || /^\d+\.\s+/.test(line) || line.startsWith('>') || /^(-{3,}|\*{3,})$/.test(line.trim())
}

function codeBlock(lang: string, text: string): HTMLElement {
  const pre = document.createElement('pre')
  pre.className = 'agent-md-code'
  if (lang) {
    const badge = document.createElement('span')
    badge.className = 'agent-md-lang'
    badge.textContent = lang
    pre.append(badge)
  }
  const code = document.createElement('code')
  code.textContent = text
  pre.append(code)
  return pre
}

function appendInline(parent: HTMLElement, text: string): void {
  const pattern = /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)|(`+)([\s\S]*?)\3|\*\*([^*]+)\*\*|\*([^*]+)\*/g
  let last = 0
  let match: RegExpExecArray | null
  while ((match = pattern.exec(text))) {
    if (match.index > last) parent.append(document.createTextNode(text.slice(last, match.index)))
    if (match[1] && match[2]) parent.append(link(match[1], match[2]))
    else if (match[3]) {
      const code = document.createElement('code')
      code.textContent = match[4]
      parent.append(code)
    } else if (match[5]) {
      const strong = document.createElement('strong')
      strong.textContent = match[5]
      parent.append(strong)
    } else {
      const em = document.createElement('em')
      em.textContent = match[6]
      parent.append(em)
    }
    last = match.index + match[0].length
  }
  if (last < text.length) parent.append(document.createTextNode(text.slice(last)))
}

function link(label: string, href: string): HTMLAnchorElement {
  const anchor = document.createElement('a')
  anchor.href = href
  anchor.textContent = label
  anchor.target = '_blank'
  anchor.rel = 'noopener noreferrer'
  return anchor
}
