import { rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const projectRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const output = resolve(projectRoot, 'lib')
if (dirname(output) !== projectRoot) throw new Error(`refusing to clean unexpected output path: ${output}`)
rmSync(output, { recursive: true, force: true })
