import { readFile, stat } from 'fs/promises'
import type { AgentContextFile } from '../../shared/types'
import type { Workspace } from './tools'

const MAX_FILE_BYTES = 200_000

export async function contextPrompt(workspace: Workspace, files: AgentContextFile[]): Promise<string> {
  if (files.length === 0) return ''
  const blocks = [
    '## Files in context',
    '',
    'The user loaded these files for this session. Use them as the current contents.',
    'Line prefixes such as 12| are metadata. Do not include them in old_string.'
  ]
  for (const file of files) {
    blocks.push('', `### ${file.path}`, '')
    blocks.push(await readContextFile(workspace, file.path))
  }
  return blocks.join('\n')
}

async function readContextFile(workspace: Workspace, location: string): Promise<string> {
  try {
    const target = await workspace.resolve(location)
    const info = await stat(target)
    if (!info.isFile()) return '(not a file)'
    if (info.size > MAX_FILE_BYTES) return `(too large to load: ${info.size} bytes)`
    const data = await readFile(target)
    if (data.includes(0)) return '(binary file)'
    const lines = data.toString('utf8').split(/\r?\n/)
    if (lines.length > 0 && lines[lines.length - 1] === '') lines.pop()
    if (lines.length === 0) return '(empty file)'
    return lines.map((line, index) => `${index + 1}|${line}`).join('\n')
  } catch {
    return '(could not read this file)'
  }
}
