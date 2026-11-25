#!/usr/bin/env node
/**
 * `dsh-restart` command line: a thin launcher for `lib/agent.js` so the
 * supervisor can also be driven by hand (status, restart, rollback, stop) when
 * no harness process is alive to ask for one.
 */
import { runCli } from '../lib/agent.js'

process.exitCode = await runCli(process.argv.slice(2))
