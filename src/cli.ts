#!/usr/bin/env node
import { runWorkflowCli } from './adapters/cli/index.js'

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
    signal: controller.signal,
  })
} finally {
  process.off('SIGINT', abort)
  process.off('SIGTERM', abort)
}
