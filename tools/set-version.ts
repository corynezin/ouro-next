// Ouro's version: one semantic version (`0.6.0`) for all of it, kept in the root package.json and in server/package.json
// (the server shows it in the app and reads it from its own package), and their entries in package-lock.json.
// `node tools/set-version.ts major|minor|patch` steps it; `node tools/set-version.ts 1.2.3` sets it. Prints the new version.
// The release workflow runs it before tagging each base.
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/** The version after `current`, stepped by `step`, or `step` itself when it is a version. */
export function nextVersion(current: string, step: string): string {
  if (SEMVER.test(step)) return step
  const parts = SEMVER.exec(current)
  if (!parts) throw new Error(`the current version, ${current}, isn't major.minor.patch`)
  const [major, minor, patch] = parts.slice(1).map(Number) as [number, number, number]
  switch (step) {
    case 'major': return `${major + 1}.0.0`
    case 'minor': return `${major}.${minor + 1}.0`
    case 'patch': return `${major}.${minor}.${patch + 1}`
    default: throw new Error(`say major, minor, patch or a version like 1.2.3, not ${step}`)
  }
}

export function setVersion(root: string, step: string): string {
  const path = (file: string) => join(root, file)
  const current = (JSON.parse(readFileSync(path('package.json'), 'utf8')) as { version?: string }).version ?? '0.0.0'
  const version = nextVersion(current, step)
  // Edited as text, so each file keeps its own layout: the version goes beside the name it belongs to.
  const edit = (file: string, names: { name: string; indent: string }[]) => {
    let text = readFileSync(path(file), 'utf8')
    for (const { name, indent } of names) text = withVersion(text, name, indent, version)
    writeFileSync(path(file), text)
  }
  edit('package.json', [{ name: 'ouro-rebirth', indent: '  ' }])
  edit('server/package.json', [{ name: '@ouro/server', indent: '  ' }])
  edit('package-lock.json', [{ name: 'ouro-rebirth', indent: '  ' }, { name: 'ouro-rebirth', indent: '      ' }, { name: '@ouro/server', indent: '      ' }])
  return version
}

/** `text` with `version` on the line after `"name": "<name>"` at `indent`: the line there replaced, or one added. */
export function withVersion(text: string, name: string, indent: string, version: string): string {
  const escaped = (value: string) => value.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')
  const at = new RegExp(`(\\n${indent}"name": "${escaped(name)}",\\n)(${indent}"version": "[^"]*",\\n)?`)
  if (!at.test(text)) throw new Error(`no "name": "${name}" at that depth`)
  return text.replace(at, `$1${indent}"version": "${version}",\n`)
}

if (import.meta.main) {
  const step = process.argv[2]
  if (!step) {
    console.error('usage: node tools/set-version.ts major|minor|patch|<x.y.z>')
    process.exit(2)
  }
  console.log(setVersion(resolve(import.meta.dirname, '..'), step))
}
