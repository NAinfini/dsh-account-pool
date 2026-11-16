import { defineConfig } from 'tsdown'

/** Host half: ESM, every harness package external. `typert` and `remote` are the manifests the harness loads by package export. */
const host = defineConfig({
  entry: ['src/index.ts', 'src/typert.ts', 'src/remote.ts'],
  format: ['esm'],
  target: 'node22',
  outDir: 'lib',
  clean: true,
  sourcemap: true,
  dts: true,
  outExtensions: () => ({ js: '.js', dts: '.d.ts' }),
  deps: {
    neverBundle: [
      '@deepseek-ai/cordis',
      '@deepseek-ai/schemastery',
      '@deepseek-ai/dsh-llm',
      '@deepseek-ai/dsh-llm-pi-ai',
      '@deepseek-ai/dsh-credentials',
      '@deepseek-ai/dsh-launch-environment',
      '@deepseek-ai/dsh-settings',
      '@deepseek-ai/dsh-home-paths',
      '@deepseek-ai/dsh-attachment',
      '@earendil-works/pi-ai',
      '@earendil-works/pi-ai/providers/all',
      '@earendil-works/pi-ai/api/openai-completions.lazy',
    ],
  },
})

/**
 * Browser half: one self-contained CJS file handed to the client loader, which
 * resolves only the externals below from its module table.
 */
const client = defineConfig({
  entry: { client: 'src/client/index.ts' },
  outDir: 'lib',
  format: 'cjs',
  platform: 'browser',
  target: 'es2022',
  sourcemap: true,
  dts: false,
  clean: false,
  deps: {
    neverBundle: ['@deepseek-ai/cordis', 'react', 'react/jsx-runtime', '@deepseek-ai/dsh-client-ui-primitives'],
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify('dsh-account-pool')}, factory: (require) => {`,
    footer: 'return module.exports; } });',
    intro: 'var module = { exports: {} }; var exports = module.exports;',
  },
})

export default [host, client]
