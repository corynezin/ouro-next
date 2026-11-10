import assert from 'node:assert/strict'
import { test } from 'node:test'
import { fileTypeOf } from './file-type.ts'

test("an upload's type: as sent, else from its name, else unknown", () => {
  assert.equal(fileTypeOf('image/jpeg; charset=binary', 'x'), 'image/jpeg')
  assert.equal(fileTypeOf('application/octet-stream', 'pic.PNG'), 'image/png', "ouro reply --file sends no type; the name says image")
  assert.equal(fileTypeOf(undefined, 'notes.txt'), 'text/plain')
  assert.equal(fileTypeOf('not a type', 'data.bin'), 'application/octet-stream')
})
