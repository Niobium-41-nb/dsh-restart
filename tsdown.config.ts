import { defineConfig } from 'tsdown'

/**
 * Three independent artifacts:
 * - `lib/index.js` — the cordis host plugin (imports `@deepseek-ai/*`).
 * - `lib/agent.js` — the standalone restart agent, bundled with NO harness
 *   imports so it can run while the harness tree itself is broken.
 * - `lib/watchdog.js` — the resurrection watchdog armed just before a graceful
 *   restart exits; same no-harness-import rule, because it may be the only
 *   thing left alive when the restart goes wrong.
 */
export default defineConfig({
  entry: {
    index: 'lib/types/index.js',
    agent: 'lib/types/agent/main.js',
    watchdog: 'lib/types/watchdog.js',
  },
  outDir: 'lib',
  format: ['esm'],
  platform: 'node',
  target: 'es2024',
  fixedExtension: false,
  dts: false,
  clean: false,
})
