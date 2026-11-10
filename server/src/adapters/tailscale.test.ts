import assert from 'node:assert/strict'
import { test } from 'node:test'
import { tailscaleHostnameOf } from './tailscale.ts'

test("this server's Tailscale name is made of what Tailscale allows in a host name", () => {
  assert.equal(tailscaleHostnameOf('journey'), 'ouro-journey')
  assert.equal(tailscaleHostnameOf("Ada's MacBook Pro"), 'ouro-ada-s-macbook-pro')
  assert.equal(tailscaleHostnameOf('---'), 'ouro-server')
  assert.equal(tailscaleHostnameOf('x'.repeat(100)).length, 63)
})
