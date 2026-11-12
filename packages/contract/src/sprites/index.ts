// The Sprites API client and the way jobs run on a Sprite, shared by the hub (hosted computers) and the server (Servers →
// New server → Sprite), so there is one copy to fix.
//
// Why here, as `@ouro/contract/sprites`, and not a package of its own: a server's guardian builds each release from
// `git archive <commit> server packages/contract` only, and runs from a stable copy that only a re-install replaces. A
// server importing a new package would fail every existing guardian's build. It is a subpath on purpose, never exported
// from the contract's index: the domain and the app import `@ouro/contract` and must not pull in an HTTP client.
export { namePrefixProblem, SPRITES_API_BASE, SpriteNameOutOfScope, SpritesApiError, SpritesHttpApi } from './api.ts'
export type { SpriteInfo, SpritesApi, SpriteUrlAuth } from './api.ts'
export { HOLD_RENEW_SECONDS, runSpriteJob, SPRITE_TASKS_SOCKET, spriteLauncher } from './jobs.ts'
export type { SpriteJobOutcome } from './jobs.ts'
