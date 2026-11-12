// New servers the open server makes on a cloud account it is connected to: an EC2 instance on AWS, or a Sprite. Each is
// made one step at a time, as the hub makes hosted ones, and ends ready for this phone to pair with, its state shaped as
// a hosted server's so the phone follows it the same way. Paired, the phone links it with the others.
//
// Routes, for the owner and this server's agents:
//   GET    /v2/machines        MachineList: every server it made and hasn't destroyed
//   POST   /v2/machines        CreateMachineBody -> NewMachine; it starts at once
//   GET    /v2/machines/<id>   NewMachine: poll this while it is made; once ready it carries a pairing code
//   POST   /v2/machines/<id>/link   a ready one joins this server: its home network, or as a fully trusted computer when
//                                   this server has none -> MachineLinked. How an agent puts a server it made to work.
// Owner only:
//   DELETE /v2/machines/<id>   destroys the machine and forgets it -> {}
//   GET    /v2/integrations/sprites, POST sprites/token (SpritesTokenBody), POST sprites/disconnect -> SpritesActionResult
import { z } from 'zod'
import { NetworkKind } from './computers.ts'
import { HostedServerState } from './hub.ts'

/**
 * Where a server can be made. `id` is open-ended (`aws`, `sprite`, later others): an app shows what it is given. `detail`
 * says what is made (`EC2 t3.medium in us-east-1`), or, when `available` is false, what to set up first. `setup` names
 * the integration that makes it available, for the app to open.
 */
export const MachineProvider = z.object({
  id: z.string(),
  name: z.string(),
  available: z.boolean(),
  detail: z.string(),
  setup: z.string().nullable(),
})
export type MachineProvider = z.infer<typeof MachineProvider>

/** A server this one is making, has made, or failed to make. `paired`: a phone of the owner's has paired with it, so it is
 * an ordinary server now; it stays listed so its machine can be destroyed from here. */
export const NewMachine = z.object({
  id: z.string(),
  label: z.string(),
  provider: z.string(),
  createdAt: z.number().int(),
  status: HostedServerState,
  paired: z.boolean(),
})
export type NewMachine = z.infer<typeof NewMachine>

/** How a made server joins the one that made it: with an invite into its home network, taken as its own home, or, when
 * that one has none, an invite to become one of its computers. `networkKind` is what the joiner tells join_network it
 * expects, so it must be the home network's own. */
export const MadeServerInvite = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('network'), networkKind: NetworkKind, address: z.string(), code: z.string() }),
  z.object({ kind: z.literal('computer'), address: z.string(), code: z.string() }),
])
export type MadeServerInvite = z.infer<typeof MadeServerInvite>

/** A made server joined this one: `computerName` is what this server's computers list calls it. */
export const MachineLinked = z.object({ computerName: z.string() })
export type MachineLinked = z.infer<typeof MachineLinked>

export const MachineList = z.object({ providers: z.array(MachineProvider), machines: z.array(NewMachine) })
export type MachineList = z.infer<typeof MachineList>

export const CreateMachineBody = z.object({ provider: z.string().min(1).max(40), label: z.string().trim().min(1).max(40) })
export type CreateMachineBody = z.infer<typeof CreateMachineBody>

/** The Sprites API token (from sprites.dev), kept by the server to make Sprites with. */
export const SpritesIntegrationState = z.discriminatedUnion('status', [
  z.object({ status: z.literal('not_connected') }),
  /** `token`: shortened to show. `problem`: the Sprites API refused it, or couldn't be reached, fit to show. */
  z.object({ status: z.literal('connected'), token: z.string(), problem: z.string().nullable() }),
])
export type SpritesIntegrationState = z.infer<typeof SpritesIntegrationState>

export const SpritesActionResult = z.discriminatedUnion('accepted', [
  z.object({ accepted: z.literal(true), state: SpritesIntegrationState }),
  z.object({ accepted: z.literal(false), why: z.string() }),
])
export type SpritesActionResult = z.infer<typeof SpritesActionResult>

export const SpritesTokenBody = z.object({ token: z.string().min(1).max(500) })
export type SpritesTokenBody = z.infer<typeof SpritesTokenBody>
