// GitHub's API, as far as backing up a person's changes goes: making a private repository on their account. The token is
// theirs, read from the connected account when needed and sent only in the request header.

export interface CreatedRepository {
  /** `owner/name`. */
  fullName: string
  /** Where git pushes to. */
  cloneUrl: string
}

export class GitHubRefused extends Error {}

export type CreateRepository = { kind: 'created'; repository: CreatedRepository } | { kind: 'name_taken' }

export interface GitHubApi {
  /** Makes a private repository named `name` on the token's account. A name the account already has is `name_taken`, never reused. */
  createPrivateRepository(token: string, name: string): Promise<CreateRepository>
}

export function httpGitHubApi(apiUrl: string): GitHubApi {
  return {
    async createPrivateRepository(token, name) {
      let response: Response
      try {
        response = await fetch(`${apiUrl}/user/repos`, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, accept: 'application/vnd.github+json', 'x-github-api-version': '2022-11-28', 'user-agent': 'ouro', 'content-type': 'application/json' },
          body: JSON.stringify({ name, private: true, description: 'Private copy of my Ouro source', auto_init: false }),
          signal: AbortSignal.timeout(30_000),
        })
      } catch {
        throw new GitHubRefused("couldn't reach GitHub to make the private copy; try again")
      }
      if (response.status === 422) return { kind: 'name_taken' }
      if (response.status !== 201) {
        throw new GitHubRefused(response.status === 401 || response.status === 403 ? 'GitHub refused the connected account\'s token' : `GitHub answered ${response.status} when making the private copy`)
      }
      const body = await response.json() as { full_name?: unknown; clone_url?: unknown; private?: unknown }
      if (typeof body.full_name !== 'string' || typeof body.clone_url !== 'string') throw new GitHubRefused("GitHub's answer didn't name the repository")
      // The changes are private to the person: nothing goes to a repository GitHub made public.
      if (body.private !== true) throw new GitHubRefused('GitHub made the repository public, so nothing was pushed to it')
      return { kind: 'created', repository: { fullName: body.full_name, cloneUrl: body.clone_url } }
    },
  }
}
