// Finding messages: `GET /v2/search?q=<words>&limit=<n>`.
import { z } from 'zod'
import { Address } from './address.ts'

export const SEARCH_DEFAULT_LIMIT = 50
export const SEARCH_MAX_LIMIT = 200

/** A message holding every word of the query, anywhere in its text, in any case. */
export const SearchHit = z.object({
  chatId: z.string(),
  messageId: z.string(),
  seq: z.number().int(),
  at: z.number().int(),
  from: Address,
  /** About 200 characters of the text around the first matched word, on one line, with `…` where cut. */
  excerpt: z.string(),
  /** The query word found first in the text, as written there, for highlighting. */
  match: z.string(),
})
export type SearchHit = z.infer<typeof SearchHit>

export const SearchPage = z.object({
  /** Newest first. */
  hits: z.array(SearchHit),
  /** More messages matched than the limit. */
  more: z.boolean(),
})
export type SearchPage = z.infer<typeof SearchPage>
