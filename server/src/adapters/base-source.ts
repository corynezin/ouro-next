// Where bases come from: a git repository (git-bases.ts), where a release is an annotated tag. Bases are made there, not on a server.

/** A base as it was released: `commit` is what its tag points to, `notes` the tag's message, `version` the Ouro version in
 * its server/package.json (null before versions). */
export interface BaseRelease {
  n: number
  notes: string
  commit: string
  version: string | null
}

/** The version a package.json says, or null when it has none worth showing (absent, or the placeholder 0.0.0). */
export function versionOf(packageJson: string): string | null {
  try {
    const { version } = JSON.parse(packageJson) as { version?: unknown }
    return typeof version === 'string' && version !== '' && version !== '0.0.0' ? version : null
  } catch {
    return null
  }
}

export interface BaseSource {
  /** The newest base not withdrawn, or null before the first. */
  latest(): Promise<BaseRelease | null>
  /**
   * Fetches every base tag, and the commits they point to, into the repository at `root`, so the base's history is there
   * to merge. A withdrawn base's tag is fetched as well: an update already under way can finish.
   */
  fetchTagsInto(root: string): Promise<void>
}
