// Building a release: a clean copy of one commit beside the live one. It never touches the source's working tree or the
// live release, so a failure here changes nothing.
import { execFile } from 'node:child_process'
import { cpSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export class BuildFailure extends Error {}

export interface ReleaseManifest {
  /** The schema this release's code migrates up to. */
  schemaVersion: number
  /** The oldest schema version whose code can still run on this release's data, for going back. */
  dataReadableBySchemaFrom: number
}

async function run(command: string, args: string[], options: { cwd: string; what: string; env?: NodeJS.ProcessEnv }): Promise<string> {
  try {
    const { stdout } = await execFileAsync(command, args, { cwd: options.cwd, maxBuffer: 64 * 1024 * 1024, env: options.env ?? process.env })
    return stdout
  } catch (error) {
    const failure = error as { stdout?: string; stderr?: string; message: string }
    throw new BuildFailure(`${options.what} failed: ${(failure.stdout ?? '').slice(-1500)}${(failure.stderr ?? failure.message).slice(-1500)}`)
  }
}

export async function resolveCommit(sourceDir: string, reference: string): Promise<string> {
  return (await run('git', ['rev-parse', '--verify', `${reference}^{commit}`], { cwd: sourceDir, what: `finding ${reference}` })).trim()
}

function copyRuntimeDependencies(sourceDir: string, targetDir: string, packageJsonPath: string, copied: Set<string>): void {
  const manifest = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as { dependencies?: Record<string, string> }
  for (const name of Object.keys(manifest.dependencies ?? {})) {
    if (name.startsWith('@ouro/') || copied.has(name)) continue
    copied.add(name)
    const from = join(sourceDir, 'node_modules', name)
    if (!existsSync(from)) throw new BuildFailure(`dependency ${name} isn't installed in the source. Run npm install there.`)
    const to = join(targetDir, 'node_modules', name)
    mkdirSync(dirname(to), { recursive: true })
    cpSync(from, to, { recursive: true, dereference: true })
    copyRuntimeDependencies(sourceDir, targetDir, join(from, 'package.json'), copied)
  }
}

/** Builds `commit` as release `releaseId`. On failure, leaves nothing behind. */
export async function buildRelease(input: { sourceDir: string; commit: string; releaseDir: string }): Promise<void> {
  const building = `${input.releaseDir}.building`
  rmSync(building, { recursive: true, force: true })
  mkdirSync(building, { recursive: true })
  try {
    const archive = join(dirname(building), `${Date.now()}-${process.pid}.tar`)
    await run('git', ['archive', '--format=tar', `--output=${archive}`, input.commit, 'server', 'packages/contract'], { cwd: input.sourceDir, what: 'exporting the commit' })
    await run('tar', ['-xf', archive, '-C', building], { cwd: building, what: 'unpacking the commit' })
    rmSync(archive, { force: true })

    writeFileSync(join(building, 'package.json'), JSON.stringify({ name: 'ouro-release', private: true, type: 'module' }))
    const copied = new Set<string>()
    copyRuntimeDependencies(input.sourceDir, building, join(building, 'server/package.json'), copied)
    copyRuntimeDependencies(input.sourceDir, building, join(building, 'packages/contract/package.json'), copied)
    mkdirSync(join(building, 'node_modules/@ouro'), { recursive: true })
    symlinkSync('../../packages/contract', join(building, 'node_modules/@ouro/contract'))

    // Type errors stop a build. The compiler is the source's; what it's told to check is decided here.
    const typescript = join(input.sourceDir, 'node_modules/typescript/bin/tsc')
    if (existsSync(typescript)) {
      writeFileSync(join(building, 'tsconfig.verify.json'), JSON.stringify({
        compilerOptions: {
          target: 'ES2023', lib: ['ES2023'], module: 'NodeNext', moduleResolution: 'NodeNext', strict: true,
          noEmit: true, skipLibCheck: true, allowImportingTsExtensions: true, verbatimModuleSyntax: true, erasableSyntaxOnly: true,
          types: ['node'], typeRoots: [join(input.sourceDir, 'node_modules/@types')],
        },
        include: ['server/src', 'packages/contract/src'],
      }))
      await run(process.execPath, [typescript, '-p', 'tsconfig.verify.json'], { cwd: building, what: 'type checking' })
    }

    readReleaseManifest(building)
    writeFileSync(join(building, RELEASE_COMMIT_FILE), `${input.commit}\n`)
    rmSync(input.releaseDir, { recursive: true, force: true })
    renameSync(building, input.releaseDir)
  } catch (error) {
    rmSync(building, { recursive: true, force: true })
    throw error
  }
}

/** The commit a release was built from, recorded beside it: a release id names it only in part. */
const RELEASE_COMMIT_FILE = 'release-commit'

/** Null for a release built before its commit was recorded. */
export function readReleaseCommit(releaseDir: string): string | null {
  try {
    return readFileSync(join(releaseDir, RELEASE_COMMIT_FILE), 'utf8').trim() || null
  } catch {
    return null
  }
}

export function readReleaseManifest(releaseDir: string): ReleaseManifest {
  const path = join(releaseDir, 'server/release-manifest.json')
  try {
    const manifest = JSON.parse(readFileSync(path, 'utf8')) as ReleaseManifest
    if (!Number.isInteger(manifest.schemaVersion) || !Number.isInteger(manifest.dataReadableBySchemaFrom)) throw new Error('its fields are not whole numbers')
    return manifest
  } catch (error) {
    throw new BuildFailure(`the release has no usable server/release-manifest.json: ${(error as Error).message}`)
  }
}
