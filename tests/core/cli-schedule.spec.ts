import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { runWorkflowCli } from '../../src/adapters/cli/index.js'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const path of roots.splice(0)) rmSync(path, { force: true, recursive: true })
})

async function fixture(hostModule?: string) {
  const root = mkdtempSync(join(tmpdir(), 'agent-dag-cli-schedule-'))
  roots.push(root)
  const database = join(root, 'workflow.sqlite')
  const flags: string[] = ['--db', database]
  if (hostModule !== undefined) {
    const hostPath = join(root, 'host.mjs')
    writeFileSync(hostPath, hostModule)
    flags.push('--host', hostPath)
  }
  const call = async (...args: string[]) => {
    const lines: string[] = []
    const exitCode = await runWorkflowCli([...args, ...flags], line => { lines.push(line) })
    return { exitCode, envelope: JSON.parse(lines[0]!) }
  }
  const template = resolve('examples/script-transform.workflow.json')
  expect((await call('draft', 'put', template)).exitCode).toBe(0)
  expect((await call('publish', 'script-transform-demo', '--expected', '1')).exitCode).toBe(0)
  const publish = (...extra: string[]) => call('schedule', 'publish', 'orders', '--workflow', 'script-transform-demo@1',
    '--cron', '* * * * *', '--timezone', 'UTC', '--input-json', '{"customer":"personal","orders":[]}', ...extra)
  return { root, call, publish }
}

it('schedules, runs, inspects, and disables a purely local schedule across CLI invocations', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-01T09:00:00Z'))
  const { call, publish } = await fixture()
  expect(await publish()).toMatchObject({ exitCode: 0, envelope: { data: {
    binding: { metadata: { id: 'orders', revision: 1 } }, nextRunAt: Date.parse('2026-09-01T09:01:00Z'),
  } } })
  expect((await call('schedule', 'status', 'orders')).envelope.data.state).toBeUndefined()
  expect(await call('schedule', 'list', '--authority', 'different-principal')).toMatchObject({ exitCode: 0, envelope: { data: { items: [] } } })
  expect(await call('schedule', 'status', 'orders', '--authority', 'different-principal')).toMatchObject({
    exitCode: 4, envelope: { error: { code: 'WORKFLOW_AUTHORITY_DENIED' } },
  })
  expect(await call('schedule', 'tick')).toMatchObject({ exitCode: 0, envelope: { data: {
    schedules: [{ state: { lastTickAt: Date.parse('2026-09-01T09:00:00Z') }, lastRun: { status: 'completed' } }],
    runs: [{ status: 'completed', outputs: { customer: 'PERSONAL' } }],
  } } })
  expect(await call('schedule', 'tick')).toMatchObject({ exitCode: 0, envelope: { data: { runs: [] } } })
  vi.setSystemTime(new Date('2026-09-01T09:00:30Z'))
  const manual = await call('schedule', 'run-now', 'orders')
  expect(manual).toMatchObject({ exitCode: 0, envelope: { data: {
    schedule: { state: { lastTickAt: Date.parse('2026-09-01T09:00:00Z'), last: { manual: true, status: 'launched' } } }, result: { status: 'completed' },
  } } })
  expect(await call('schedule', 'disable', 'orders')).toMatchObject({
    exitCode: 0, envelope: { data: { binding: { spec: { enabled: false } } } },
  })
  vi.setSystemTime(new Date('2026-09-01T09:05:00Z'))
  expect(await call('schedule', 'tick')).toMatchObject({ exitCode: 0, envelope: { data: { runs: [] } } })
  expect(await call('schedule', 'enable', 'orders')).toMatchObject({
    exitCode: 0, envelope: { data: { binding: { spec: { enabled: true }, metadata: { revision: 3 } } } },
  })
})

it('reports a delivery reminder and retries the same invocation under the owning local identity', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  vi.setSystemTime(new Date('2026-09-01T09:00:00Z'))
  const { root, call, publish } = await fixture(`
    import { appendFileSync, existsSync } from 'node:fs'
    const file = value => new URL(value, import.meta.url)
    export default {
      delivery: { async deliver({ invocationId }) {
        appendFileSync(file('invocations'), invocationId + '\\n')
        if (!existsSync(file('ready'))) throw new Error('channel offline')
      } },
      notify(notice) { appendFileSync(file('notices'), JSON.stringify(notice) + '\\n') },
    }
  `)
  expect((await publish('--delivery', 'local:fixture')).exitCode).toBe(0)
  expect(await call('schedule', 'tick')).toMatchObject({ exitCode: 0, envelope: { data: {
    schedules: [{ lastRun: { status: 'completed' } }], pendingDeliveries: [{ status: 'unknown', attempts: 1 }],
    failures: [{ error: 'channel offline' }], notices: [{ type: 'delivery.pending', message: 'channel offline' }],
  } } })
  expect(JSON.parse(readFileSync(join(root, 'notices'), 'utf8'))).toMatchObject({ type: 'delivery.pending' })
  const items = (await call('delivery', 'list')).envelope.data.items as readonly { readonly invocationId: string }[]
  const invocationId = items[0]!.invocationId
  expect(await call('delivery', 'list', '--authority', 'different-principal')).toMatchObject({ exitCode: 0, envelope: { data: { items: [] } } })
  expect(await call('delivery', 'retry-due')).toMatchObject({ exitCode: 0, envelope: { data: { delivered: [], failed: [] } } })
  writeFileSync(join(root, 'ready'), '')
  expect(await call('delivery', 'retry', invocationId)).toMatchObject({ exitCode: 0, envelope: { data: { status: 'delivered', attempts: 2 } } })
  expect(readFileSync(join(root, 'invocations'), 'utf8').trim().split('\n')).toEqual([invocationId, invocationId])
})
