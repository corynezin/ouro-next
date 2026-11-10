import { readFileSync } from 'node:fs'
import type { RunnerConfig } from '../adapters/runner-protocol.ts'
import { runRunner } from '../runner/runner.ts'

const configPath = process.argv[2]
if (!configPath) throw new Error('usage: ouro-runner <config.json>')
runRunner(JSON.parse(readFileSync(configPath, 'utf8')) as RunnerConfig)
