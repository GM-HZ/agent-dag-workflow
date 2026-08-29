import { readFile } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { defineConfig } from 'tsdown'

const PACKAGE_ID = '@gm-hz/agent-dag-workflow'
const CSS_PREFIX = '\0agent-dag-workflow-css:'
const CSS_SUFFIX = '.mjs'
const require = createRequire(import.meta.url)
const sharedModules = new Set([
  'react',
  'react/jsx-runtime',
  'react-dom',
  'react-dom/client',
  '@deepseek-ai/cordis',
  '@deepseek-ai/dsh-client-runtime/client',
  '@deepseek-ai/dsh-client-ui-slots',
  '@deepseek-ai/dsh-client-ui-primitives',
])

export default defineConfig({
  name: `${PACKAGE_ID}/client`,
  entry: { client: 'lib/canvas/client/index.js' },
  outDir: 'lib/canvas',
  format: 'cjs',
  platform: 'browser',
  target: 'es2023',
  clean: false,
  dts: false,
  sourcemap: true,
  deps: {
    neverBundle: specifier => sharedModules.has(specifier),
    alwaysBundle: specifier => !sharedModules.has(specifier),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  plugins: [{
    name: 'agent-dag-workflow-global-css',
    resolveId(source: string) {
      if (!source.endsWith('.css')) return null
      return `${CSS_PREFIX}${require.resolve(source)}${CSS_SUFFIX}`
    },
    async load(id: string) {
      if (!id.startsWith(CSS_PREFIX)) return null
      const filename = id.slice(CSS_PREFIX.length, -CSS_SUFFIX.length)
      this.addWatchFile(filename)
      const css = await readFile(filename, 'utf8')
      return [
        `const css = ${JSON.stringify(css)};`,
        `const tagId = ${JSON.stringify(PACKAGE_ID)};`,
        "if (typeof document !== 'undefined' && document.querySelector('style[data-plugin-css=' + JSON.stringify(tagId) + ']') === null) {",
        "  const tag = document.createElement('style');",
        '  tag.dataset.pluginCss = tagId;',
        '  tag.textContent = css;',
        '  document.head.appendChild(tag);',
        '}',
        'export {};',
      ].join('\n')
    },
  }],
  outputOptions: {
    entryFileNames: 'client.js',
    exports: 'named',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PACKAGE_ID)}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})
