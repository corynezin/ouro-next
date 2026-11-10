import { Guardian } from './guardian.ts'
import { loadConfig } from './config.ts'

const configPath = process.argv[2]
if (!configPath) throw new Error('usage: ouro-guardian <config.json>')
const guardian = new Guardian(loadConfig(configPath))
await guardian.start()

// ourod is its child and stops with it. Runners keep running.
process.on('SIGTERM', () => void guardian.stop().then(() => process.exit(0)))
process.on('SIGINT', () => void guardian.stop().then(() => process.exit(0)))
