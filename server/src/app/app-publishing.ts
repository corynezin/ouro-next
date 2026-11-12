// Exporting the committed app and registering it as a phone update. `ouro publish` does it for an agent; a base update that
// changes the app does it for the person, so the update banner is all they have to tap. Either way it says "published" only
// when the server has the update, and otherwise says why not.
import { execFile } from 'node:child_process'
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import type { RegisterUpdateInput } from './app-updates.ts'

const execFileAsync = promisify(execFile)

export const DEFAULT_EXPORT_COMMAND = 'npx expo export --platform ios --output-dir {out}'

/** The app wasn't published; the message says why. The change itself is saved in the source either way. */
export class NotPublished extends Error {}

export interface PublishedApp {
  updateNumber: number
  runtimeVersion: string
}

/** The runtime an export runs on, as expo-updates computes it from app.json. Only the policies this app uses. */
function runtimeVersionOf(appDir: string): string {
  const config = JSON.parse(readFileSync(join(appDir, 'app.json'), 'utf8')) as { expo?: { version?: string; runtimeVersion?: string | { policy?: string } } }
  const runtime = config.expo?.runtimeVersion
  if (typeof runtime === 'string') return runtime
  if (runtime?.policy === 'appVersion' && config.expo?.version) return config.expo.version
  throw new NotPublished('app.json has no runtimeVersion this command understands (a string, or the appVersion policy)')
}

async function shell(command: string, args: string[], cwd: string): Promise<string> {
  try {
    return (await execFileAsync(command, args, { cwd, maxBuffer: 64 * 1024 * 1024 })).stdout
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string }
    throw new NotPublished(`${command} ${args.join(' ').slice(0, 80)} failed: ${`${failure.stdout ?? ''}${failure.stderr ?? failure.message}`.slice(-1500)}`)
  }
}

/**
 * Exports the app as committed in `appDir` and hands the export to `register`. `exportCommand` has `{out}` for the folder to
 * export into. Throws `NotPublished` for anything that stops the phone from getting it.
 */
export async function publishCommittedApp(
  appDir: string,
  exportCommand: string,
  register: (input: RegisterUpdateInput) => Promise<PublishedApp>,
  progress: (text: string) => void,
): Promise<PublishedApp> {
  if (!existsSync(join(appDir, 'app.json'))) throw new NotPublished(`${appDir} has no app.json`)
  const dirty = (await shell('git', ['status', '--porcelain', '--', '.'], appDir)).trim()
  if (dirty) throw new NotPublished(`the app has uncommitted changes; commit them first, so the update matches a commit:\n${dirty.slice(0, 500)}`)
  const commit = (await shell('git', ['rev-parse', 'HEAD'], appDir)).trim()
  const runtimeVersion = runtimeVersionOf(appDir)

  const exportDir = mkdtempSync(join(tmpdir(), 'ouro-export-'))
  try {
    progress(`exporting the app at ${commit.slice(0, 8)}…\n`)
    try {
      await shell('/bin/sh', ['-c', exportCommand.replaceAll('{out}', exportDir)], appDir)
    } catch (error) {
      throw new NotPublished(`the app didn't build: ${(error as Error).message}`)
    }
    try {
      return await register({ exportDir, runtimeVersion, commit })
    } catch (error) {
      throw new NotPublished((error as Error).message)
    }
  } finally {
    rmSync(exportDir, { recursive: true, force: true })
  }
}
