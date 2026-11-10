import assert from 'node:assert/strict'
import { test } from 'node:test'
import type { HttpResponse, Network } from '../platform/ports.ts'
import { pairWithServer } from './pairing.ts'

const answering = (response: HttpResponse | Error): Network => ({
  request: async () => { if (response instanceof Error) throw response; return response },
  openStream: async () => { throw new Error('unused') },
  uploadFile: async () => { throw new Error('unused') },
})

test("a refused pairing shows the server's reason, else the status", async () => {
  const refusal = { error: { code: 'forbidden', message: 'That code has been used.', retryable: false } }
  assert.deepEqual(await pairWithServer(answering({ status: 403, text: JSON.stringify(refusal) }), 'https://mac', 'abc'), { ok: false, reason: 'That code has been used.' })
  assert.deepEqual(await pairWithServer(answering({ status: 502, text: '<html>bad gateway</html>' }), 'https://mac', 'abc'), { ok: false, reason: 'pairing failed (502)' })
})
