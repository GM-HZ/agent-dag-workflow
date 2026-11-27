import { lstat, mkdir, readFile, rmdir, unlink } from 'node:fs/promises'
import { join, resolve } from 'node:path'
import { WorkflowAccessError } from '../../access/index.js'
import { writeWorkflowLines } from './files.js'

const skill = 'workflow-builder'

export async function installProjectWorkflowSkill() {
  const project = resolve(process.cwd())
  const agents = join(project, '.agents')
  const skills = join(agents, 'skills')
  const directory = join(skills, skill)
  const source = new URL(`../../../skills/${skill}/`, import.meta.url)
  const [markdown, metadata] = await Promise.all([
    readFile(new URL('SKILL.md', source), 'utf8'),
    readFile(new URL('agents/openai.yaml', source), 'utf8'),
  ])

  await ensureDirectory(agents)
  await ensureDirectory(skills)
  const uiDirectory = join(directory, 'agents')
  const path = join(directory, 'SKILL.md')
  const metadataPath = join(uiDirectory, 'openai.yaml')
  if (!await ensureDirectory(directory)) {
    if (!await matchesRegularFile(path, markdown, directory) || !await matchesRegularFile(metadataPath, metadata, uiDirectory)) {
      throw invalid(`A different ${skill} Skill already exists at ${directory}. Review the existing files before replacing them.`)
    }
    return { skill, path, created: false }
  }

  const written: string[] = []
  try {
    await mkdir(uiDirectory)
    written.push(await writeWorkflowLines(path, emit => emit(markdown.trimEnd())))
    written.push(await writeWorkflowLines(metadataPath, emit => emit(metadata.trimEnd())))
  } catch (error: unknown) {
    for (const file of written) await unlink(file).catch(() => {})
    await rmdir(uiDirectory).catch(() => {})
    await rmdir(directory).catch(() => {})
    throw error
  }
  return { skill, path, created: true }
}

async function ensureDirectory(path: string): Promise<boolean> {
  try { await mkdir(path); return true }
  catch (error: unknown) {
    if (hasCode(error, 'EEXIST') && (await lstat(path)).isDirectory()) return false
    if (hasCode(error, 'EEXIST')) throw invalid(`Skill installation requires a regular directory at ${path}`)
    throw error
  }
}

async function matchesRegularFile(path: string, expected: string, parent: string): Promise<boolean> {
  try {
    return (await lstat(parent)).isDirectory() && (await lstat(path)).isFile()
      && (await readFile(path, 'utf8')).trimEnd() === expected.trimEnd()
  } catch (error: unknown) {
    if (hasCode(error, 'ENOENT')) return false
    throw error
  }
}

function hasCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code
}

function invalid(message: string): WorkflowAccessError { return new WorkflowAccessError('WORKFLOW_REQUEST_INVALID', message) }
