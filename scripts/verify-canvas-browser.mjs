import { spawn, spawnSync } from 'node:child_process'
import { createServer } from 'node:net'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const pnpm = process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm'
const port = await availablePort()
const url = `http://127.0.0.1:${port}/`
const session = `agent-dag-canvas-${process.pid}`
const server = spawn(pnpm, ['exec', 'vite', 'tests/canvas/visual', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
  cwd: root,
  detached: process.platform !== 'win32',
  stdio: ['ignore', 'pipe', 'pipe'],
})
let serverOutput = ''
server.stdout.on('data', chunk => { serverOutput += chunk.toString() })
server.stderr.on('data', chunk => { serverOutput += chunk.toString() })

try {
  await waitForServer(url, server)
  runCli('open', url)
  runCli('run-code', String.raw`async page => {
    const consoleErrors = []
    page.on('console', message => { if (message.type() === 'error') consoleErrors.push(message.text()) })
    page.on('pageerror', error => consoleErrors.push(error.message))
    await page.setViewportSize({ width: 1440, height: 1000 })
    await page.reload()
    const studio = page.locator('[data-workflow-studio]')
    await studio.waitFor()
    if (await studio.count() !== 1) throw new Error('Canvas Studio did not mount exactly once')

    await page.emulateMedia({ colorScheme: 'dark' })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-workflow-studio]')).colorScheme === 'dark')
    await page.emulateMedia({ colorScheme: 'light' })
    await page.waitForFunction(() => getComputedStyle(document.querySelector('[data-workflow-studio]')).colorScheme === 'light')

    const name = page.getByRole('textbox', { name: '工作流名称' })
    await name.fill('Browser smoke draft')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('[data-state="saved"]').waitFor()
    await name.fill('Browser smoke updated')
    await page.getByRole('button', { name: '保存', exact: true }).click()
    await page.locator('[data-state="saved"]').waitFor()

    await page.getByRole('button', { name: '校验', exact: true }).click()
    await page.locator('[data-state="validated"]').waitFor()
    await page.getByText('当前模板没有发现结构、依赖或 Schema 问题。', { exact: true }).waitFor()

    await page.getByRole('button', { name: '▶ 试运行', exact: true }).click()
    await page.locator('.wf-run-state.wf-completed').waitFor()
    await page.getByText('运行完成', { exact: true }).first().waitFor()
    if (await page.locator('.wf-graph-node[data-status="succeeded"]').count() < 4) {
      throw new Error('Trace did not project completed node state back onto the graph')
    }

    const smoke = await page.evaluate(() => window.__canvasSmoke)
    const expectedCalls = { createDraft: 1, updateDraft: 1, validate: 1, runDraft: 1, trace: 1 }
    for (const [operation, expected] of Object.entries(expectedCalls)) {
      if (smoke?.calls?.[operation] !== expected) throw new Error(operation + ' call count was ' + smoke?.calls?.[operation])
    }
    if (smoke.savedName !== 'Browser smoke updated') throw new Error('updated draft did not reach the Canvas API')
    if (consoleErrors.length > 0) throw new Error('browser console errors: ' + consoleErrors.join(' | '))
  }`)
  process.stdout.write('Canvas browser smoke passed: load, theme, create/update, validate, run, and Trace.\n')
} finally {
  try { runCli('close') } catch { /* preserve the original failure */ }
  stopServer(server)
}

function runCli(...args) {
  const result = spawnSync(pnpm, ['exec', 'playwright-cli', '--session', session, ...args], {
    cwd: root,
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
    timeout: 60_000,
  })
  if (result.status !== 0) {
    throw new Error(`playwright-cli ${args[0]} failed\n${result.stdout ?? ''}${result.stderr ?? ''}`)
  }
}

function availablePort() {
  return new Promise((resolve, reject) => {
    const candidate = createServer()
    candidate.once('error', reject)
    candidate.listen(0, '127.0.0.1', () => {
      const address = candidate.address()
      if (typeof address === 'string' || address === null) {
        candidate.close(() => reject(new Error('could not allocate a Canvas fixture port')))
        return
      }
      candidate.close(error => error === undefined ? resolve(address.port) : reject(error))
    })
  })
}

async function waitForServer(target, child) {
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Canvas fixture server exited early\n${serverOutput}`)
    try {
      const response = await fetch(target)
      if (response.ok) return
    } catch { /* server is still starting */ }
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  throw new Error(`Canvas fixture server did not become ready\n${serverOutput}`)
}

function stopServer(child) {
  if (child.exitCode !== null || child.pid === undefined) return
  try {
    if (process.platform === 'win32') child.kill('SIGTERM')
    else process.kill(-child.pid, 'SIGTERM')
  } catch { /* already stopped */ }
}
