import assert from 'node:assert/strict'
import { test } from 'node:test'
import { privateTransport } from './peers.ts'

test("a network's key travels only over HTTPS, Tailscale or this machine itself", () => {
  for (const address of ['https://a.example', 'http://100.64.0.1:7777', 'http://100.127.255.254', 'http://mac.tail1234.ts.net:7777', 'http://localhost:7777', 'http://127.0.0.1', 'http://[::1]:7777']) {
    assert.equal(privateTransport(address), true, address)
  }
  for (const address of ['http://a.example', 'http://100.128.0.1', 'http://100.63.255.255', 'http://100.64.0.1.evil.example', 'http://192.168.1.2', 'http://ts.net.evil.example', 'not a url', '']) {
    assert.equal(privateTransport(address), false, address)
  }
})
