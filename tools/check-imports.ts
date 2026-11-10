// Enforces the import direction in docs/architecture.md: interfaces -> app -> domain, app -> store and adapters.
// The domain imports only contract types, so it stays pure. The guardian imports nothing of ours and no packages.
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'

const repoRoot = resolve(import.meta.dirname, '..')
const serverSource = join(repoRoot, 'server/src')

const allowedLayerImports: Record<string, readonly string[]> = {
  domain: [],
  store: ['domain'],
  adapters: ['domain'],
  runner: ['adapters', 'domain'],
  app: ['domain', 'store', 'adapters'],
  interfaces: ['app', 'domain'],
  bin: ['app', 'interfaces', 'runner', 'store', 'adapters', 'domain'],
}

function sourceFiles(dir: string, extensions: readonly string[] = ['.ts']): string[] {
  if (!statSafe(dir)) return []
  return readdirSync(dir).flatMap((entry) => {
    const path = join(dir, entry)
    if (statSync(path).isDirectory()) return entry === 'node_modules' ? [] : sourceFiles(path, extensions)
    return extensions.some((extension) => path.endsWith(extension)) ? [path] : []
  })
}

function statSafe(path: string): boolean {
  try { statSync(path); return true } catch { return false }
}

function importSpecifiers(source: string): string[] {
  const specifiers: string[] = []
  for (const match of source.matchAll(/(?:^|\n)\s*(?:import|export)\s[^'"\n]*?from\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1]!)
  for (const match of source.matchAll(/(?:^|\n)\s*import\s+['"]([^'"]+)['"]/g)) specifiers.push(match[1]!)
  for (const match of source.matchAll(/\bimport\(\s*['"]([^'"]+)['"]\s*\)/g)) specifiers.push(match[1]!)
  return specifiers
}

const violations: string[] = []

for (const file of sourceFiles(serverSource).filter((path) => !path.endsWith('.test.ts'))) {
  const layer = relative(serverSource, file).split('/')[0]!
  const allowed = allowedLayerImports[layer]
  if (!allowed) {
    violations.push(`${relative(repoRoot, file)}: unknown layer "${layer}"`)
    continue
  }
  for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
    if (layer === 'domain' && !specifier.startsWith('.') && specifier !== '@ouro/contract') {
      violations.push(`${relative(repoRoot, file)}: the domain may import only @ouro/contract, found "${specifier}"`)
    }
    if (!specifier.startsWith('.')) continue
    const target = relative(serverSource, resolve(dirname(file), specifier)).split('/')[0]!
    if (target !== layer && !allowed.includes(target)) {
      violations.push(`${relative(repoRoot, file)}: ${layer} may not import ${target} ("${specifier}")`)
    }
  }
}

for (const file of sourceFiles(join(repoRoot, 'guardian/src'))) {
  for (const specifier of importSpecifiers(readFileSync(file, 'utf8'))) {
    if (!specifier.startsWith('.') && !specifier.startsWith('node:')) {
      violations.push(`${relative(repoRoot, file)}: the guardian may import only the Node standard library, found "${specifier}"`)
    }
    if (specifier.startsWith('.') && relative(join(repoRoot, 'guardian'), resolve(dirname(file), specifier)).startsWith('..')) {
      violations.push(`${relative(repoRoot, file)}: the guardian may not import outside itself ("${specifier}")`)
    }
  }
}

// Under an update from our server, expo-constants' `expoConfig` comes from the update manifest, not the build, and is
// null. The app's own facts come from the binary (expo-application) instead.
for (const file of sourceFiles(join(repoRoot, 'apps/mobile/src'), ['.ts', '.tsx'])) {
  if (importSpecifiers(readFileSync(file, 'utf8')).includes('expo-constants')) {
    violations.push(`${relative(repoRoot, file)}: the app may not import expo-constants; its config is the update manifest's, null under our updates`)
  }
}

if (violations.length > 0) {
  console.error(violations.join('\n'))
  process.exit(1)
}
