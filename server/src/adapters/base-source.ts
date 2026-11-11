// Where bases come from: a git repository (git-bases.ts), where a release is an annotated tag. Bases are made there, not on a server.

/** A base as it was released: `commit` is what its tag points to, `notes` the tag's message. */
export interface BaseRelease {
  n: number
  notes: string
  commit: string
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
