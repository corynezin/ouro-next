import assert from 'node:assert/strict'
import { test } from 'node:test'
import { deferred, FakeLifecycle, settle } from '../platform/fakes.ts'
import { LockGate } from './lockGate.ts'

function setup(required = true) {
  const lifecycle = new FakeLifecycle()
  const prompts: ReturnType<typeof deferred<boolean>>[] = []
  const settings = { required }
  const gate = new LockGate({
    lifecycle,
    required: () => settings.required,
    authenticate: () => {
      const prompt = deferred<boolean>()
      prompts.push(prompt)
      return prompt.promise
    },
  })
  return { lifecycle, prompts, settings, gate }
}

test('covered at launch and prompts by itself; passing uncovers', async () => {
  const ctx = setup()
  assert.equal(ctx.gate.locked, false, 'nothing to cover until the preference is read')
  ctx.gate.start()
  assert.equal(ctx.gate.locked, true)
  assert.equal(ctx.prompts.length, 1)
  ctx.prompts[0]!.resolve(true)
  await settle()
  assert.equal(ctx.gate.locked, false)
  ctx.gate.stop()
})

test('a failed, cancelled or broken prompt leaves the cover, and the button prompts again', async () => {
  const ctx = setup()
  ctx.gate.start()
  ctx.prompts[0]!.resolve(false)
  await settle()
  assert.equal(ctx.gate.locked, true)
  void ctx.gate.unlock()
  ctx.prompts[1]!.reject(new Error('no biometrics'))
  await settle()
  assert.equal(ctx.gate.locked, true)
  void ctx.gate.unlock()
  void ctx.gate.unlock()
  assert.equal(ctx.prompts.length, 3, 'one prompt at a time')
  ctx.gate.stop()
})

test('re-locks in the background and prompts on return', async () => {
  const ctx = setup()
  ctx.gate.start()
  ctx.prompts[0]!.resolve(true)
  await settle()
  ctx.lifecycle.goToBackground()
  assert.equal(ctx.gate.locked, true)
  ctx.lifecycle.comeToForeground()
  assert.equal(ctx.prompts.length, 2)
  ctx.prompts[1]!.resolve(true)
  await settle()
  assert.equal(ctx.gate.locked, false)
  ctx.gate.stop()
})

test('not required: never covers or prompts; turned on later, it locks from the next background', async () => {
  const ctx = setup(false)
  ctx.gate.start()
  ctx.lifecycle.goToBackground()
  ctx.lifecycle.comeToForeground()
  assert.equal(ctx.gate.locked, false)
  assert.equal(ctx.prompts.length, 0)
  ctx.settings.required = true
  ctx.lifecycle.goToBackground()
  assert.equal(ctx.gate.locked, true)
  ctx.gate.stop()
})

test('switching away shields the app without asking for Face ID; coming back removes the shield', async () => {
  const ctx = setup()
  ctx.gate.start()
  ctx.prompts[0]!.resolve(true)
  await settle()
  ctx.lifecycle.switchAway()
  assert.equal(ctx.gate.covered, true, 'hidden from the app-switcher snapshot')
  assert.equal(ctx.gate.locked, false, 'a glance at Notification Centre needs no Face ID')
  ctx.lifecycle.comeToForeground()
  await settle()
  assert.equal(ctx.gate.covered, false)
  assert.equal(ctx.prompts.length, 1, 'no prompt')
  ctx.gate.stop()
})

test('the background locks, and the shield alone never hides a locked app\'s cover', async () => {
  const ctx = setup()
  ctx.gate.start()
  ctx.prompts[0]!.resolve(true)
  await settle()
  ctx.lifecycle.goToBackground()
  assert.equal(ctx.gate.locked, true)
  ctx.lifecycle.comeToForeground()
  assert.equal(ctx.gate.covered, true, 'still covered while the prompt is up')
  ctx.prompts[1]!.resolve(false)
  await settle()
  assert.equal(ctx.gate.covered, true, 'a failed prompt leaves it covered')
  ctx.gate.stop()
})

test('not required: neither switching away nor the background covers anything', () => {
  const ctx = setup(false)
  ctx.gate.start()
  ctx.lifecycle.switchAway()
  ctx.lifecycle.goToBackground()
  assert.equal(ctx.gate.covered, false)
  ctx.gate.stop()
})

test('cancelling the prompt leaves the cover and does not prompt again by itself', async () => {
  const ctx = setup()
  ctx.gate.start()
  // The system prompt makes the app inactive; cancelling it makes it active again, without the background.
  ctx.lifecycle.switchAway()
  ctx.prompts[0]!.resolve(false)
  ctx.lifecycle.returnFromSwitchingAway()
  await settle()
  assert.equal(ctx.gate.locked, true)
  assert.equal(ctx.gate.covered, true)
  assert.equal(ctx.prompts.length, 1, 'no second prompt until the person taps Unlock')
  void ctx.gate.unlock()
  assert.equal(ctx.prompts.length, 2)
  ctx.gate.stop()
})
