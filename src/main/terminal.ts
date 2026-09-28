import { spawn, type ChildProcess } from 'child_process'
import { app } from 'electron'
import { basename } from 'path'
import type { TerminalSession } from '../shared/types'
import { statKind, asAbsolute } from './files'

const sessions = new Map<number, ChildProcess>()

export async function startTerminal(id: number, cwd: unknown, send: (data: string) => void): Promise<TerminalSession> {
  stopTerminal(id)
  const directory = await workingDirectory(cwd)
  const shell = process.env.SHELL || '/bin/bash'
  const proc = spawn('script', ['-q', '-f', '-c', shell, '/dev/null'], {
    cwd: directory,
    detached: true,
    env: {
      ...process.env,
      TERM: 'xterm-256color'
    }
  })
  sessions.set(id, proc)

  const write = (chunk: Buffer) => send(chunk.toString('utf8'))
  proc.stdout?.on('data', write)
  proc.stderr?.on('data', write)
  proc.on('error', (error) => {
    send(`\r\nCould not start terminal: ${error.message}\r\n`)
  })
  proc.on('exit', (code) => {
    if (sessions.get(id) === proc) sessions.delete(id)
    send(`\r\n[process exited with code ${code}]\r\n`)
  })
  return { directory, shell: basename(shell) }
}

export function writeTerminal(id: number, data: unknown): void {
  if (typeof data !== 'string' || data.length > 1024 * 1024) return
  const proc = sessions.get(id)
  if (proc?.stdin?.writable) proc.stdin.write(data)
}

export function stopTerminal(id: number): void {
  const proc = sessions.get(id)
  if (!proc) return
  sessions.delete(id)
  killSession(proc)
}

export function stopAllTerminals(): void {
  for (const id of sessions.keys()) stopTerminal(id)
}

async function workingDirectory(cwd: unknown): Promise<string> {
  if (typeof cwd === 'string' && cwd.length > 0) {
    const absolute = asAbsolute(cwd)
    if ((await statKind(absolute)) === 'directory') return absolute
  }
  return app.getPath('home')
}

function killSession(proc: ChildProcess): void {
  if (proc.pid) {
    try {
      process.kill(-proc.pid, 'SIGTERM')
      return
    } catch {
      // The process group is already gone.
    }
  }
  proc.kill()
}
