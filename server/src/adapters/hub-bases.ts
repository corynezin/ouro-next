// Bases through the hub's HTTP API (`/hub/v1/bases`): anyone reads them; publishing and withdrawing take the token of an
// account the hub's operator lets publish. The files travel as a tar.
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { HUB_API_PREFIX, HubBase, HubError, PublishBaseResult, WithdrawBaseResult } from '@ouro/contract'
import type { PublishBaseRequest } from '@ouro/contract'
import { PublishingRefused } from './base-source.ts'
import type { BasePublishTarget, BaseSource, PublishedBase } from './base-source.ts'

interface HubAnswer { status: number; body: Buffer }

async function callHub(hubUrl: string, method: string, path: string, options: { token?: string; body?: unknown } = {}): Promise<HubAnswer> {
  const url = `${hubUrl.replace(/\/+$/, '')}${HUB_API_PREFIX}${path}`
  let response: Response
  try {
    response = await fetch(url, {
      method,
      headers: {
        ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
        ...(options.token === undefined ? {} : { authorization: `Bearer ${options.token}` }),
      },
      body: options.body === undefined ? undefined : JSON.stringify(options.body),
    })
  } catch (error) {
    throw new Error(`couldn't reach the hub at ${hubUrl}: ${(error as Error).message}`)
  }
  return { status: response.status, body: Buffer.from(await response.arrayBuffer()) }
}

/** The hub's refusal, as it words it; null when the answer isn't one. */
function refusalOf(answer: HubAnswer): HubError['error'] | null {
  try {
    const parsed = HubError.safeParse(JSON.parse(answer.body.toString('utf8')))
    return parsed.success ? parsed.data.error : null
  } catch {
    return null
  }
}

function unexpected(what: string, answer: HubAnswer): Error {
  const refusal = refusalOf(answer)
  return new Error(`the hub refused ${what} (${answer.status}): ${refusal ? `${refusal.message} (${refusal.code})` : answer.body.toString('utf8').slice(0, 300)}`)
}

const json = (answer: HubAnswer): unknown => JSON.parse(answer.body.toString('utf8'))

async function latestBase(hubUrl: string): Promise<PublishedBase | null> {
  const answer = await callHub(hubUrl, 'GET', '/bases/latest')
  if (answer.status === 204) return null
  if (answer.status !== 200) throw unexpected('to say which base is offered', answer)
  return HubBase.parse(json(answer))
}

function runTar(args: string[]): void {
  const tar = spawnSync('tar', args, { encoding: 'utf8' })
  if (tar.status !== 0) throw new Error(`tar ${args[0]} failed: ${tar.stderr.trim().slice(-500)}`)
}

/** The bases the hub offers, for a machine that takes them. */
export function hubBaseSource(hubUrl: string): BaseSource {
  return {
    latest: () => latestBase(hubUrl),
    async fetch(n, into) {
      const answer = await callHub(hubUrl, 'GET', `/bases/${n}/files`)
      if (answer.status !== 200) throw unexpected(`base ${n}'s files`, answer)
      const scratch = mkdtempSync(join(tmpdir(), 'ouro-hub-base-'))
      try {
        writeFileSync(join(scratch, 'files.tar'), answer.body)
        runTar(['-xf', join(scratch, 'files.tar'), '-C', into])
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
  }
}

/** Publishing to the hub as the account whose token this is. */
export function hubBasePublishTarget(hubUrl: string, token: string): BasePublishTarget {
  /** An account the hub doesn't know, or doesn't let publish, is this machine not being a publisher. */
  const refuseIfNotPublisher = (answer: HubAnswer) => {
    const refusal = refusalOf(answer)
    if (refusal?.code === 'not_publisher' || refusal?.code === 'unauthenticated') {
      throw new PublishingRefused(`the hub doesn't let this machine's account publish bases: ${refusal.message}`)
    }
  }
  return {
    latest: () => latestBase(hubUrl),
    async publish({ notes, treeHash, treeDir }) {
      const scratch = mkdtempSync(join(tmpdir(), 'ouro-hub-publish-'))
      try {
        const tar = join(scratch, 'files.tar')
        runTar(['-cf', tar, '-C', treeDir, '.'])
        const request: PublishBaseRequest = { notes, treeHash, filesTarBase64: readFileSync(tar).toString('base64') }
        const answer = await callHub(hubUrl, 'POST', '/bases', { token, body: request })
        refuseIfNotPublisher(answer)
        if (answer.status !== 200) throw unexpected('the base', answer)
        return PublishBaseResult.parse(json(answer))
      } finally {
        rmSync(scratch, { recursive: true, force: true })
      }
    },
    async withdraw(n) {
      const answer = await callHub(hubUrl, 'POST', `/bases/${n}/withdraw`, { token })
      refuseIfNotPublisher(answer)
      if (answer.status === 404) return null
      if (answer.status !== 200) throw unexpected(`withdrawing base ${n}`, answer)
      return WithdrawBaseResult.parse(json(answer)).base
    },
  }
}
