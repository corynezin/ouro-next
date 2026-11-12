/** GitHub-style identicon: a 5x5 grid mirrored left to right, in a pastel colour derived from the seed. */

/**
 * 32-bit FNV-1a, salted so the cells and the hue come from independent hashes of the same seed, then MurmurHash3's
 * finalizer: FNV alone leaves the low bits nearly unchanged for names that differ only at the end (helper-1, helper-2).
 */
function hash(seed: string, salt: number): number {
  let h = (0x811c9dc5 ^ Math.imul(salt, 0x9e3779b1)) >>> 0
  for (let i = 0; i < seed.length; i++) h = Math.imul(h ^ seed.charCodeAt(i), 0x01000193)
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b)
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35)
  return (h ^ (h >>> 16)) >>> 0
}

/** Five rows of five cells. Columns 0-2 come from two hash bits each (on 3 times in 4, so icons are dense); 3-4 mirror 1-0. */
export function identiconCells(seed: string): boolean[][] {
  const bits = hash(seed, 0)
  const on = (i: number) => ((bits >>> (i * 2)) & 3) !== 0
  return Array.from({ length: 5 }, (_, r) => {
    const left = [0, 1, 2].map((c) => on(r * 3 + c))
    return [...left, left[1]!, left[0]!]
  })
}

/** A light, low-saturation colour that reads on both the light and the dark avatar background. */
export function identiconColor(seed: string): string {
  return `hsl(${hash(seed, 1) % 360}, 55%, 72%)`
}

/** An SVG with one square of margin around the grid; `background` is a hex colour without `#`, or none for transparent. */
export function identiconSvg(seed: string, background?: string): string {
  let rects = ''
  identiconCells(seed).forEach((row, r) => row.forEach((on, c) => {
    if (on) rects += `<rect x="${c + 1}" y="${r + 1}" width="1" height="1"/>`
  }))
  const fill = background ? `<rect width="7" height="7" fill="#${background}"/>` : ''
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 7 7" shape-rendering="crispEdges">${fill}<g fill="${identiconColor(seed)}">${rects}</g></svg>`
}
