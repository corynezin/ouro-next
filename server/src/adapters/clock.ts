// Time is an input. Under test, a file holds the offset to add to real time, so long backoffs pass instantly.
import { readFileSync } from 'node:fs'

export const systemClock = { now: () => Date.now() }

export function fileClock(offsetPath: string) {
  return {
    now(): number {
      let offsetMs = 0
      try {
        offsetMs = Number(readFileSync(offsetPath, 'utf8').trim()) || 0
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
      }
      return Date.now() + offsetMs
    },
  }
}
