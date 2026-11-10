// The guardian's control socket, as ourod uses it: deploy a commit, and follow the deployment.
import { request } from 'node:http'

/** The guardian's record of a deployment; `phase` is its own vocabulary, read by `deploymentOutcome`. */
export interface Deployment { id: string; phase: string; reason: string | null; commit: string | null }

export type DeploymentOutcome =
  | { kind: 'in_progress' }
  | { kind: 'live' }
  /** `changedLive`: it went live before failing, and was rolled back. */
  | { kind: 'failed'; why: string; changedLive: boolean }

const FAILED_BEFORE_LIVE = ['build_failed', 'verification_failed', 'refused', 'superseded']
const FAILED_ONCE_LIVE = ['rolled_back', 'rollback_unverified']

export function deploymentOutcome(deployment: Deployment): DeploymentOutcome {
  if (deployment.phase === 'live') return { kind: 'live' }
  const why = `${deployment.phase.replaceAll('_', ' ')}: ${deployment.reason ?? 'no reason recorded'}`
  if (FAILED_BEFORE_LIVE.includes(deployment.phase)) return { kind: 'failed', why, changedLive: false }
  if (FAILED_ONCE_LIVE.includes(deployment.phase)) return { kind: 'failed', why, changedLive: true }
  return { kind: 'in_progress' }
}

export interface GuardianClient {
  /**
   * The commit the live release was built from, once the guardian has confirmed it steady; null while a switch is still
   * being confirmed, before the first release, or for a release that didn't record its commit.
   */
  confirmedLiveCommit(): Promise<string | null>
  deploy(commit: string): Promise<Deployment>
  /** Null when the guardian doesn't know it: it restarted since, and keeps deployments only in memory. */
  deployment(id: string): Promise<Deployment | null>
}

export function guardianClient(socketPath: string): GuardianClient {
  const call = (method: string, path: string, body: object | null) => new Promise<{ status: number; body: unknown }>((resolve, reject) => {
    const outgoing = request({ socketPath, method, path, headers: { 'content-type': 'application/json' } }, (response) => {
      const chunks: Buffer[] = []
      response.on('data', (chunk: Buffer) => chunks.push(chunk))
      response.on('end', () => {
        try {
          resolve({ status: response.statusCode ?? 0, body: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
        } catch (error) {
          reject(error)
        }
      })
    })
    outgoing.on('error', reject)
    outgoing.end(body ? JSON.stringify(body) : undefined)
  })
  return {
    async confirmedLiveCommit() {
      const answer = await call('GET', '/status', null)
      if (answer.status !== 200) throw new Error(`the guardian answered ${answer.status}`)
      const status = answer.body as { active: string | null; lastGood: string | null; activeCommit: string | null }
      // The last good release is the last one confirmed; the active one differs from it only while it is being confirmed.
      return status.active !== null && status.active === status.lastGood ? status.activeCommit : null
    },
    async deploy(commit) {
      const answer = await call('POST', '/deploy', { reference: commit, requestedBy: null })
      if (answer.status !== 200) throw new Error(`the guardian refused the deploy: ${JSON.stringify(answer.body)}`)
      return answer.body as Deployment
    },
    async deployment(id) {
      const answer = await call('GET', `/deployments/${id}`, null)
      if (answer.status === 404) return null
      if (answer.status !== 200) throw new Error(`the guardian answered ${answer.status}`)
      return answer.body as Deployment
    },
  }
}
