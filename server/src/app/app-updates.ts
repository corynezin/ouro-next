// Phone updates: immutable and numbered. `ouro publish` exports the app and hands the result to `registerUpdate`, which
// copies it into the data directory, records it, and checks that a valid manifest can be built from it before anyone can
// fetch it. Manifests are built per request, because asset URLs use the address the phone itself used.
import { createHash, randomUUID } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, statSync } from 'node:fs'
import { basename, extname, join, resolve, sep } from 'node:path'
import { buildUpdateManifest, UPDATE_ASSETS_PATH } from '@ouro/contract'
import type { PublishedUpdate, UpdateManifest } from '@ouro/contract'
import type { Store, AppUpdateRow } from '../store/store.ts'
import { CommandRefused } from './failure.ts'

export const UPDATE_PLATFORM = 'ios'

/** What `expo export` writes to dist/metadata.json, as much of it as we read. */
interface ExportMetadata {
  version: number
  fileMetadata: Record<string, { bundle: string; assets: { path: string; ext: string }[] }>
}

const MIME_BY_EXTENSION: Record<string, string> = {
  png: 'image/png', jpg: 'image/jpeg', jpeg: 'image/jpeg', gif: 'image/gif', webp: 'image/webp', svg: 'image/svg+xml',
  ttf: 'font/ttf', otf: 'font/otf', json: 'application/json', mp4: 'video/mp4', wav: 'audio/wav', mp3: 'audio/mpeg',
}

function hashOf(path: string): string {
  return createHash('sha256').update(readFileSync(path)).digest('base64url')
}

export interface RegisterUpdateInput {
  exportDir: string
  runtimeVersion: string
  commit: string | null
}

export class AppUpdates {
  private readonly store: Store
  private readonly updatesDir: string
  private readonly now: () => number

  constructor(store: Store, updatesDir: string, now: () => number) {
    this.store = store
    this.updatesDir = updatesDir
    this.now = now
    mkdirSync(updatesDir, { recursive: true })
  }

  private updateDir(updateNumber: number): string {
    return join(this.updatesDir, String(updateNumber))
  }

  register(input: RegisterUpdateInput): AppUpdateRow {
    const metadataPath = join(input.exportDir, 'metadata.json')
    if (!existsSync(metadataPath)) throw new CommandRefused('invalid_request', `no metadata.json in ${input.exportDir}: is it the output of expo export?`)
    const metadata = JSON.parse(readFileSync(metadataPath, 'utf8')) as ExportMetadata
    const platform = metadata.fileMetadata?.[UPDATE_PLATFORM]
    if (!platform) throw new CommandRefused('invalid_request', `the export has no ${UPDATE_PLATFORM} bundle`)
    const bundlePath = join(input.exportDir, platform.bundle)
    if (!existsSync(bundlePath) || statSync(bundlePath).size === 0) throw new CommandRefused('invalid_request', 'the exported bundle is missing or empty')

    // Staged under a temporary name and renamed into place, so a half-copied update is never visible.
    const staging = join(this.updatesDir, `staging-${randomUUID()}`)
    mkdirSync(staging, { recursive: true })
    try {
      const bundleFile = `bundle${extname(platform.bundle) || '.js'}`
      copyFileSync(bundlePath, join(staging, bundleFile))
      const assets = platform.assets.map((asset) => {
        const source = join(input.exportDir, asset.path)
        const fileName = `${basename(asset.path)}.${asset.ext}`
        copyFileSync(source, join(staging, fileName))
        return { fileName, contentType: MIME_BY_EXTENSION[asset.ext.toLowerCase()] ?? 'application/octet-stream', fileExtension: `.${asset.ext}`, hash: hashOf(source) }
      })
      return this.store.transaction(() => {
        const row = this.store.insertAppUpdate({
          id: randomUUID(),
          platform: UPDATE_PLATFORM,
          runtimeVersion: input.runtimeVersion,
          commit: input.commit,
          createdAt: this.now(),
          launchAsset: { fileName: bundleFile, hash: hashOf(bundlePath) },
          assets,
        })
        // Proves a valid manifest can be built before the update exists for anyone. Throws, and rolls back, if not.
        this.manifestOf(row, 'http://validation.invalid')
        renameSync(staging, this.updateDir(row.updateNumber))
        return row
      })
    } catch (error) {
      rmSync(staging, { recursive: true, force: true })
      throw error
    }
  }

  latest(runtimeVersion: string): AppUpdateRow | null {
    return this.store.latestAppUpdate(UPDATE_PLATFORM, runtimeVersion)
  }

  newest(): PublishedUpdate | null {
    const row = this.store.newestAppUpdate(UPDATE_PLATFORM)
    return row ? { updateNumber: row.updateNumber, runtimeVersion: row.runtimeVersion } : null
  }

  manifestOf(row: AppUpdateRow, baseUrl: string): UpdateManifest {
    const assetUrl = (fileName: string) => `${baseUrl}${UPDATE_ASSETS_PATH}/${row.updateNumber}/${encodeURIComponent(fileName)}`
    return buildUpdateManifest({
      id: row.id,
      createdAt: new Date(row.createdAt),
      runtimeVersion: row.runtimeVersion,
      updateNumber: row.updateNumber,
      commit: row.commit,
      launchAsset: { hash: row.launchAsset.hash, url: assetUrl(row.launchAsset.fileName) },
      assets: row.assets.map((asset) => ({ contentType: asset.contentType, fileExtension: asset.fileExtension, hash: asset.hash, url: assetUrl(asset.fileName) })),
    })
  }

  /** The file to serve for an asset URL, or null. Names come from the URL, so they're kept inside the update's folder. */
  assetFile(updateNumber: number, fileName: string): { path: string; contentType: string } | null {
    const row = this.store.appUpdateByNumber(updateNumber)
    if (!row) return null
    const known = row.launchAsset.fileName === fileName
      ? { contentType: 'application/javascript' }
      : row.assets.find((asset) => asset.fileName === fileName)
    if (!known) return null
    const directory = this.updateDir(updateNumber)
    const path = resolve(directory, fileName)
    if (!path.startsWith(`${directory}${sep}`)) return null
    return { path, contentType: known.contentType }
  }
}
