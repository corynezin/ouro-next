import { readFileSync } from 'node:fs'
import { CliFailure, runCli } from '../interfaces/cli.ts'

try {
  await runCli(process.argv.slice(2), process.env, () => readFileSync(0, 'utf8'), (text) => process.stdout.write(text))
} catch (error) {
  if (!(error instanceof CliFailure)) throw error
  process.stderr.write(`ouro: ${error.message}\n`)
  process.exitCode = 1
}
