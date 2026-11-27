import { createReadStream } from 'node:fs'
import { chmod, link, mkdtemp, open, rm } from 'node:fs/promises'
import { basename, dirname, join, resolve } from 'node:path'
import { createInterface } from 'node:readline'
import { isJsonObject, type JsonObject } from '../../core/index.js'

/** Leave an existing destination intact and publish only a completed file. */
export async function writeWorkflowFileWith(path: string, produce: (temporary: string) => Promise<void> | void): Promise<string> {
  const destination = resolve(path)
  const directory = await mkdtemp(join(dirname(destination), '.adw-export-'))
  const temporary = join(directory, basename(destination))
  try {
    await produce(temporary)
    await chmod(temporary, 0o600)
    await link(temporary, destination)
    return destination
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
}

export async function writeWorkflowLines(path: string, produce: (write: (line: string) => Promise<void>) => Promise<void>): Promise<string> {
  return writeWorkflowFileWith(path, async temporary => {
    const file = await open(temporary, 'wx', 0o600)
    try {
      await produce(async line => { await file.writeFile(`${line}\n`, 'utf8') })
      await file.sync()
    } finally {
      await file.close()
    }
  })
}

export async function verifyWorkflowJournal(path: string) {
  const reader = createInterface({ input: createReadStream(path, { encoding: 'utf8' }), crlfDelay: Infinity })
  let summary: JsonObject | undefined
  let lastEvent: JsonObject | undefined
  let seq = 0
  for await (const line of reader) {
    const row: unknown = JSON.parse(line)
    if (!isJsonObject(row)) throw new Error('Journal lines must be JSON objects')
    if (summary === undefined) {
      if (row.format !== 'agent-dag-workflow.journal/v1' || row.type !== 'run.snapshot'
        || typeof row.runId !== 'string' || row.runId.length === 0 || typeof row.ref !== 'string'
        || typeof row.semanticHash !== 'string' || !/^[a-f0-9]{64}$/.test(row.semanticHash)
        || typeof row.checkpointSeq !== 'number' || !Number.isSafeInteger(row.checkpointSeq) || row.checkpointSeq < 0) {
        throw new Error('Journal snapshot is invalid')
      }
      summary = row
      continue
    }
    seq++
    if (row.seq !== seq || row.runId !== summary.runId || row.eventId !== `${summary.runId}:${seq}`
      || typeof row.type !== 'string' || !isJsonObject(row.workflow) || row.workflow.semanticHash !== summary.semanticHash) {
      throw new Error(`Journal event ${seq} does not match the snapshot or sequence`)
    }
    lastEvent = row
  }
  if (summary === undefined || seq !== summary.checkpointSeq) throw new Error('Journal ended before or after the declared checkpoint')
  if (seq > 0 && (lastEvent?.type !== 'checkpoint.committed' || !isJsonObject(lastEvent.payload) || lastEvent.payload.checkpointSeq !== seq)) {
    throw new Error('Journal did not end on the recorded checkpoint commit')
  }
  return { runId: summary.runId, ref: summary.ref, checkpointSeq: seq, semanticHash: summary.semanticHash }
}
