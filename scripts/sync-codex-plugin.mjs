import { copyFile, mkdir } from 'node:fs/promises'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const source = resolve(root, 'skills/workflow-builder')
const target = resolve(root, 'integrations/codex/agent-dag-workflow/skills/workflow-builder')

await mkdir(resolve(target, 'agents'), { recursive: true })
await mkdir(resolve(root, 'integrations/codex/agent-dag-workflow/scripts'), { recursive: true })
await copyFile(resolve(source, 'SKILL.md'), resolve(target, 'SKILL.md'))
await copyFile(resolve(source, 'agents/openai.yaml'), resolve(target, 'agents/openai.yaml'))
await copyFile(resolve(root, 'scripts/agent-workflow.mjs'), resolve(root, 'integrations/codex/agent-dag-workflow/scripts/agent-workflow.mjs'))
