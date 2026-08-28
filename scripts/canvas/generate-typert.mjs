import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { resolve } from 'node:path'
import { WorkspaceTypertGenerator } from '@deepseek-ai/dsh-typert-generator'

const root = resolve(import.meta.dirname, '../..')
const workRoot = mkdtempSync(resolve(root, '.typert-work-'))
try {
  const packageRoot = resolve(workRoot, 'packages/agent-dag-workflow')
  mkdirSync(packageRoot, { recursive: true })
  cpSync(resolve(root, 'src'), resolve(packageRoot, 'src'), { recursive: true })
  cpSync(resolve(root, 'types/typert-protocol.d.ts'), resolve(workRoot, 'typert-protocol.d.ts'))
  cpSync(resolve(root, 'tsconfig.base.json'), resolve(workRoot, 'tsconfig.base.json'))
  const manifest = JSON.parse(readFileSync(resolve(root, 'package.json'), 'utf8'))
  manifest.exports = {
    '.': manifest.exports['./canvas'],
    './canvas/types': manifest.exports['./canvas/types'],
    './client': manifest.exports['./client'],
    './typert': manifest.exports['./typert'],
    './remote': manifest.exports['./remote'],
    './package.json': './package.json',
  }
  manifest.files = [
    'lib/typert.host.js',
    'lib/typert.host.d.ts',
    'lib/typert.remote-client.js',
    'lib/typert.remote-client.d.ts',
  ]
  writeJson(resolve(packageRoot, 'package.json'), manifest)
  writeJson(resolve(workRoot, 'tsconfig.host.json'), {
    extends: './tsconfig.base.json',
    compilerOptions: {
      baseUrl: '.',
      paths: {
        '@deepseek-ai/dsh-typert-protocol': ['./typert-protocol.d.ts'],
      },
    },
    files: [],
    references: [{ path: './packages/agent-dag-workflow/tsconfig.host.json' }],
  })
  writeJson(resolve(packageRoot, 'tsconfig.host.json'), {
    extends: '../../tsconfig.base.json',
    compilerOptions: {
      composite: true,
      rootDir: 'src',
      outDir: 'lib',
      emitDeclarationOnly: true,
      types: ['node'],
    },
    include: ['src/**/*.ts', 'src/**/*.tsx'],
    exclude: ['src/canvas/client/**'],
  })
  const [artifact] = new WorkspaceTypertGenerator(workRoot).generate(
    ['@gm-hz/agent-dag-workflow'],
    ['host'],
  )
  if (artifact === undefined || artifact.remote === undefined) {
    throw new Error('workflow canvas Typert Remote artifacts were not generated')
  }
  const outputDir = resolve(root, 'lib')
  mkdirSync(outputDir, { recursive: true })
  writeFileSync(resolve(outputDir, 'typert.host.js'), artifact.js)
  writeFileSync(resolve(outputDir, 'typert.host.d.ts'), artifact.dts)
  writeFileSync(resolve(outputDir, 'typert.remote-client.js'), artifact.remote.js)
  writeFileSync(resolve(outputDir, 'typert.remote-client.d.ts'), artifact.remote.dts)
  writeFileSync(resolve(outputDir, 'typert.remote-client.d.ts.map'), artifact.remote.dtsMap)
} finally {
  rmSync(workRoot, { recursive: true, force: true })
}

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`)
}
