import { defineConfig } from 'tsdown'

/**
 * Two independent artifacts:
 * - `lib/index.js` — the cordis host plugin (imports `@deepseek-ai/*`).
 * - `lib/agent.js` — the standalone restart agent, bundled with NO harness
 *   imports so it can run while the harness tree itself is broken.
 */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    agent: 'lib/types/agent/main.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
