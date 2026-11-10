// How times, amounts and text read everywhere in the app.

/** "now", "5m", "3h", "2d", "6w" (ago). */
export function ago(ms: number, now: number): string {
  const s = Math.max(0, (now - ms) / 1000)
  if (s < 60) return 'now'
  if (s < 3600) return `${Math.floor(s / 60)}m`
  if (s < 86400) return `${Math.floor(s / 3600)}h`
  if (s < 86400 * 14) return `${Math.floor(s / 86400)}d`
  return `${Math.floor(s / (86400 * 7))}w`
}

export const oneLine = (s: string) => s.split(/\r?\n/).filter(Boolean).join(' ')
export const money = (usd: number) => `$${usd.toFixed(2)}`
export const tokensText = (n: number) => (n >= 1000 ? `${Math.floor(n / 1000)}k` : `${n}`)

/** A fraction of a plan cap: 0.42 → "42%", 0.004 → "0.4%". */
export function capPct(fraction: number) {
  const p = fraction * 100
  if (p <= 0) return '0%'
  if (p < 1) return `${p < 0.1 ? '<0.1' : p.toFixed(1)}%`
  return `${Math.round(p)}%`
}

export const formatSize = (n: number) => (n < 1024 ? `${n} B` : n < 1024 ** 2 ? `${(n / 1024).toFixed(0)} KB` : `${(n / 1024 ** 2).toFixed(1)} MB`)

/** "9:41 AM" (the phone's locale). */
export function timeOfDay(ms: number) {
  try {
    return new Date(ms).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })
  } catch {
    const d = new Date(ms)
    return `${d.getHours()}:${String(d.getMinutes()).padStart(2, '0')}`
  }
}

/** "Nov 3, 9:41 AM" (the phone's locale). */
export function dateTimeOf(ms: number): string {
  try {
    return new Date(ms).toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' })
  } catch {
    return new Date(ms).toISOString().slice(0, 16).replace('T', ' ')
  }
}

/** "2026-11-09 16:23", in this phone's time zone: the reference's form for when an agent started. */
export function dateStampOf(ms: number): string {
  const d = new Date(ms)
  const two = (n: number) => String(n).padStart(2, '0')
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ${two(d.getHours())}:${two(d.getMinutes())}`
}

/** "9:41 AM" today, or "Nov 4, 9:00 AM" on another day. */
export const untilText = (ms: number, now: number) => (new Date(ms).toDateString() === new Date(now).toDateString() ? timeOfDay(ms) : dateTimeOf(ms))

/** "1:05", a running timer. */
export function timerText(elapsedMs: number) {
  const s = Math.max(0, Math.floor(elapsedMs / 1000))
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`
}

/** Lowercased without accents (search is case- and diacritic-insensitive). */
export const foldForSearch = (s: string) => s.normalize('NFD').replace(/\p{M}/gu, '').toLowerCase()
