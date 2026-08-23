import { mkdirSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(import.meta.dirname, '../../..')
const packageDir = resolve(root, 'packages/canvas')
const [artifact] = new WorkspaceTypertGenerator(root).generate(
  ['@gm-hz/dsh-dag-workflow-canvas'],
  ['host'],
)
if (artifact === undefined || artifact.remote === undefined) {
  throw new Error('workflow canvas Typert Remote artifacts were not generated')
}
mkdirSync(resolve(packageDir, 'lib'), { recursive: true })
writeFileSync(resolve(packageDir, 'lib/typert.host.js'), artifact.js)
writeFileSync(resolve(packageDir, 'lib/typert.host.d.ts'), artifact.dts)
writeFileSync(resolve(packageDir, 'lib/typert.remote-client.js'), artifact.remote.js)
writeFileSync(resolve(packageDir, 'lib/typert.remote-client.d.ts'), artifact.remote.dts)
writeFileSync(resolve(packageDir, 'lib/typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
