import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { ComputerEntity, TailscaleState } from '@ouro/contract'
import {
  computerRows, computerStateText, inviteFooter, isTailscaleChanging, offersTailscaleRemove, removeConfirm, someOffline, tailscaleBlocksComputers,
  tailscaleConnectedFooter, tailscaleGateOf, tailscalePlacementOf,
} from './model.ts'

const computer = (partial: Partial<ComputerEntity> & { name: string }): ComputerEntity => ({
  id: `id-${partial.name}`, trust: 'full', status: 'online', lastSeenAt: 1, release: 'r1', agentsRunning: 0, agentCount: 0,
  incompatibility: null, joinedAt: 1, ...partial,
})

test('a computer reads as online or offline, with how many of its agents are running', () => {
  assert.equal(computerStateText(computer({ name: 'mac', agentsRunning: 1, agentCount: 3 })), 'Online · 1 of 3 agents running')
  assert.equal(computerStateText(computer({ name: 'mac', status: 'reconnecting', agentCount: 0 })), 'Online')
  assert.equal(computerStateText(computer({ name: 'mac', status: 'offline', agentsRunning: null, agentCount: null })), 'Offline')
})

test('computers are listed by name, and an offline one brings the note', () => {
  const list = [computer({ name: 'zed' }), computer({ name: 'alpha', trust: 'limited' })]
  assert.deepEqual(computerRows(list).map((row) => [row.name, row.trust]), [['alpha', 'limited'], ['zed', 'full']])
  assert.equal(someOffline(list), false)
  assert.equal(someOffline([...list, computer({ name: 'gone', status: 'offline' })]), true)
})

test('removing warns when agents are running there', () => {
  assert.deepEqual(removeConfirm({ name: 'mac', agentsRunning: 2 }), {
    title: 'Remove mac?', message: "2 agents are running there. They keep running on it, but you won't see them here any more.",
  })
  assert.equal(removeConfirm({ name: 'mac', agentsRunning: null }).message, 'Ouro stops reaching it. Nothing on the computer is deleted.')
})

test('the invite says how many whole minutes it still works, never under one', () => {
  assert.match(inviteFooter(30 * 60_000, 0), /for the next 30 minutes\.$/)
  assert.match(inviteFooter(10_000, 0), /for the next 1 minutes\.$/)
})

test('Tailscale comes first on a hosted server: connect, its progress, the login to approve; connected or not needed lets computers be added', () => {
  assert.deepEqual(tailscaleGateOf({ state: 'not_connected' }), { kind: 'connect' })
  assert.deepEqual(tailscaleGateOf({ state: 'installing' }), { kind: 'working', text: 'Setting up Tailscale…' })
  assert.deepEqual(tailscaleGateOf({ state: 'removing' }), { kind: 'working', text: 'Removing Tailscale…' })
  assert.deepEqual(tailscaleGateOf({ state: 'logging_in', loginUrl: 'https://login.tailscale.test/a/1' }), { kind: 'approve', loginUrl: 'https://login.tailscale.test/a/1' })
  assert.equal(tailscaleGateOf({ state: 'connected', ip: '100.64.0.7' }), null)
  assert.equal(tailscaleGateOf({ state: 'not_needed' }), null)
  assert.deepEqual(['not_needed', 'not_connected', 'installing', 'removing', 'connected'].filter((state) => isTailscaleChanging({ state } as TailscaleState)), ['installing', 'removing'])
  assert.equal(isTailscaleChanging({ state: 'logging_in', loginUrl: 'x' }), true)
  assert.equal(tailscaleConnectedFooter('100.64.0.7'), 'Connected as 100.64.0.7.')
  assert.equal(tailscaleConnectedFooter(null), 'Connected as this server.')
})

test('Tailscale holds up linking a computer only on a server that reaches computers through it alone', () => {
  assert.equal(tailscaleBlocksComputers({ tailscale: { state: 'not_connected' }, lastFailure: null, neededForComputers: true }), true)
  assert.equal(tailscaleBlocksComputers({ tailscale: { state: 'not_connected' }, lastFailure: null, neededForComputers: false }), false)
  assert.equal(tailscaleBlocksComputers({ tailscale: { state: 'connected', ip: null }, lastFailure: null, neededForComputers: true }), false)
})

test('Tailscale comes before adding a computer where computers need it, and after where it is optional', () => {
  assert.equal(tailscalePlacementOf({ tailscale: { state: 'not_connected' }, lastFailure: null, neededForComputers: true }), 'before_add')
  assert.equal(tailscalePlacementOf({ tailscale: { state: 'not_connected' }, lastFailure: null, neededForComputers: false }), 'after_add')
})

test('a connected Tailscale can be removed unless linked computers are reached through it', () => {
  const connected = { state: 'connected', ip: '100.64.0.7' } as const
  assert.equal(offersTailscaleRemove({ tailscale: connected, lastFailure: null, neededForComputers: true }, 0), true)
  assert.equal(offersTailscaleRemove({ tailscale: connected, lastFailure: null, neededForComputers: true }, 2), false, 'it would cut them off')
  assert.equal(offersTailscaleRemove({ tailscale: connected, lastFailure: null, neededForComputers: false }, 2), true)
  assert.equal(offersTailscaleRemove({ tailscale: { state: 'not_connected' }, lastFailure: null, neededForComputers: false }, 0), false)
})
