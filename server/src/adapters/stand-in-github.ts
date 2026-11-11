// For tests and journeys: the part of GitHub's API that backing up uses, answered locally. A private repository made by
// POST /user/repos is a bare repository under `dir`, and its clone URL is that folder, so pushes to it are local.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdirSync } from 'node:fs'
import { createServer } from 'node:http'
import type { Server } from 'node:http'
import { join } from 'node:path'

export interface StandInGitHub {
  apiUrl: string
  /** Where the stand-in account's repository `name` is, once made. */
  repositoryPath(name: string): string
  /** Names the stand-in account already has, as repositories it didn't make here. */
  takeName(name: string): void
  /** The authorization headers it saw, most recent last. */
  authorizations: string[]
  /** The `private` flag of each repository creation it saw, most recent last. */
  requestedPrivate: unknown[]
  close(): Promise<void>
}

export const STAND_IN_GITHUB_USER = 'stand-in'

export async function startStandInGitHub(dir: string): Promise<StandInGitHub> {
  const repositoryPath = (name: string) => join(dir, 'repositories', STAND_IN_GITHUB_USER, `${name}.git`)
  const taken = new Set<string>()
  const authorizations: string[] = []
  const requestedPrivate: unknown[] = []
  const server: Server = createServer((request, response) => {
    const answer = (status: number, body: object) => {
      response.writeHead(status, { 'content-type': 'application/json' })
      response.end(JSON.stringify(body))
    }
    authorizations.push(request.headers.authorization ?? '')
    if (!request.headers.authorization?.startsWith('Bearer ')) return answer(401, { message: 'Bad credentials' })
    if (request.method !== 'POST' || request.url !== '/user/repos') return answer(404, { message: 'Not Found' })
    let text = ''
    request.on('data', (chunk) => { text += chunk })
    request.on('end', () => {
      const body = JSON.parse(text) as { name?: string; private?: unknown }
      requestedPrivate.push(body.private)
      const name = body.name ?? ''
      if (!/^[A-Za-z0-9._-]+$/.test(name)) return answer(422, { message: 'Repository creation failed.' })
      const path = repositoryPath(name)
      if (taken.has(name) || existsSync(path)) return answer(422, { message: 'name already exists on this account' })
      mkdirSync(join(path, '..'), { recursive: true })
      const made = spawnSync('git', ['init', '--bare', '--quiet', path], { encoding: 'utf8' })
      if (made.status !== 0) return answer(500, { message: made.stderr })
      answer(201, { full_name: `${STAND_IN_GITHUB_USER}/${name}`, clone_url: path, private: body.private === true })
    })
  })
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = (server.address() as { port: number }).port
  return {
    apiUrl: `http://127.0.0.1:${port}`,
    repositoryPath,
    takeName: (name) => { taken.add(name) },
    authorizations,
    requestedPrivate,
    close: () => new Promise<void>((resolve) => { server.close(() => resolve()); server.closeAllConnections() }),
  }
}
