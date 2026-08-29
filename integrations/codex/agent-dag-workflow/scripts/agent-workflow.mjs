#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync } from 'node:fs'
import { delimiter, dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = dirname(fileURLToPath(import.meta.url))
const localCli = [
  // Repository/package root wrapper: scripts/agent-workflow.mjs.
  resolve(scriptDirectory, '..', 'lib', 'cli.js'),
  // npm-packaged Codex Plugin wrapper:
  // integrations/codex/agent-dag-workflow/scripts/agent-workflow.mjs.
  resolve(scriptDirectory, '..', '..', '..', '..', 'lib', 'cli.js'),
].find(candidate => existsSync(candidate))
const pathCli = findExecutable('agent-workflow')
const command = localCli !== undefined
  ? { executable: process.execPath, args: [localCli, ...process.argv.slice(2)] }
  : pathCli === undefined ? undefined : { executable: pathCli, args: process.argv.slice(2) }

if (command === undefined) {
  console.log(JSON.stringify({
    protocolVersion: 'agent-workflow.cli/v1',
    ok: false,
    error: {
      code: 'WORKFLOW_ACCESS_NOT_INSTALLED',
      message: 'Install @gm-hz/agent-dag-workflow so the agent-workflow executable is available.',
    },
    meta: { command: 'bootstrap', durationMs: 0 },
  }))
  process.exitCode = 6
} else {
  const child = spawn(command.executable, command.args, { stdio: 'inherit' })
  child.once('error', error => {
    console.error(error.message)
    process.exitCode = 6
  })
  child.once('exit', (code, signal) => {
    if (signal !== null) process.kill(process.pid, signal)
    else process.exitCode = code ?? 6
  })
}

function findExecutable(name) {
  const pathValue = process.env.PATH
  if (pathValue === undefined) return undefined
  const extensions = process.platform === 'win32' ? (process.env.PATHEXT ?? '.EXE;.CMD;.BAT').split(';') : ['']
  for (const directory of pathValue.split(delimiter)) {
    for (const extension of extensions) {
      const candidate = join(directory, `${name}${extension}`)
      if (existsSync(candidate)) return candidate
    }
  }
  return undefined
}
