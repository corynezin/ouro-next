// An agent started in a git project's main checkout works in its own worktree, on its own branch, so its commits stay
// off everyone else's branch and out of anyone's uncommitted changes. Its branch merges back when it finishes or is
// archived.
import type { BranchMerge } from '@ouro/contract'

export interface AgentWorktree {
  /** The main checkout, whose refs the merge moves. */
  repo: string
  /** The agent's own checkout, beside the main one. */
  dir: string
  /** The branch the agent commits on: `agent/<name>`. */
  branch: string
  /** The branch it started from and merges back into; a commit when the main checkout was detached. */
  base: string
}

/** What the agent's parent is told about a branch that didn't merge. Null when there is nothing to tell. */
export function unmergedBranchReport(agentName: string, merge: BranchMerge): string | null {
  if (merge.kind !== 'not_merged') return null
  return `${agentName}'s branch ${merge.branch} was not merged into ${merge.base}: ${merge.why}. It is left as it is: resolve it by hand, then ouro merge ${agentName}.`
}
