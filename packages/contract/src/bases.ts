// Bases: numbered releases of Ouro itself, offered to each machine and merged into the person's own copy of the source.
import { z } from 'zod'

/** The newest base this machine hasn't merged yet. */
export const BaseOffer = z.object({ n: z.number().int().positive(), notes: z.string() })
export type BaseOffer = z.infer<typeof BaseOffer>

/**
 * Taking a base. `conflict`: the base and the person's changes touch the same files; the master agent is resolving them
 * beside the live source, and nothing live has changed. `failed`: the base didn't go in; `why` says what, if anything,
 * changed.
 */
export const BaseUpdate = z.discriminatedUnion('state', [
  z.object({ state: z.literal('idle') }),
  z.object({ state: z.literal('updating'), n: z.number().int().positive() }),
  z.object({ state: z.literal('conflict'), n: z.number().int().positive(), files: z.array(z.string()) }),
  z.object({ state: z.literal('failed'), n: z.number().int().positive(), why: z.string() }),
])
export type BaseUpdate = z.infer<typeof BaseUpdate>

/**
 * `not_taking`: this machine takes no bases, because it is where they are published or it has no copy of the source.
 * `taker`: `integrated` is the base the person's source has merged (0: from before bases).
 */
export const BaseStatus = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('not_taking') }),
  z.object({ kind: z.literal('taker'), integrated: z.number().int().min(0), offered: BaseOffer.nullable(), update: BaseUpdate }),
])
export type BaseStatus = z.infer<typeof BaseStatus>

/**
 * Whether the person's own commits to the source, those on no base, are kept in a private repository of theirs on GitHub.
 * `not_applicable`: there is no source copy here, or it takes no bases. `nothing_to_back_up`: every commit is on a base.
 * `not_backed_up`: some are not, and there is no backup; `github` says whether GitHub is connected, which making one needs.
 * `backed_up`: `repository` is the backup's `owner/name`; `behind` is whether the live version isn't pushed to it yet, and
 * `lastPushError` why its last push failed.
 */
export const SourceBackup = z.discriminatedUnion('state', [
  z.object({ state: z.literal('not_applicable') }),
  z.object({ state: z.literal('nothing_to_back_up') }),
  z.object({ state: z.literal('not_backed_up'), github: z.enum(['connected', 'not_connected']) }),
  z.object({ state: z.literal('backed_up'), repository: z.string(), behind: z.boolean(), lastPushError: z.string().nullable() }),
])
export type SourceBackup = z.infer<typeof SourceBackup>
