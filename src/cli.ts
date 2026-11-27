#!/usr/bin/env node
import { runWorkflowCli } from './adapters/cli/index.js'
import { createInterface } from 'node:readline/promises'

const controller = new AbortController()
const abort = () => controller.abort('CLI interrupted')
process.once('SIGINT', abort)
process.once('SIGTERM', abort)
try {
  process.exitCode = await runWorkflowCli(process.argv.slice(2), {
    stdout: line => console.log(line),
    stderr: line => console.error(line),
    async readStdin() {
      const chunks: Buffer[] = []
      for await (const chunk of process.stdin) chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
      return Buffer.concat(chunks).toString('utf8')
    },
    ...(process.stdin.isTTY && process.stderr.isTTY ? {
      async confirmLiveReplay(runId: string) {
        const terminal = createInterface({ input: process.stdin, output: process.stderr })
        try { return /^y(?:es)?$/i.test((await terminal.question(`Run ${runId} again with real host calls? [y/N] `, { signal: controller.signal })).trim()) }
        finally { terminal.close() }
      },
    } : {}),
    signal: controller.signal,
  })
} finally {
  process.off('SIGINT', abort)
  process.off('SIGTERM', abort)
}
