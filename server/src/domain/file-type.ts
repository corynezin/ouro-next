// What kind of file an upload is: the media type it was sent with, or else one from its name, as the reference does.
// `ouro reply --file` sends no type of its own, and the app shows an image inline only when the type says image.
const TYPE_BY_EXTENSION: Record<string, string> = {
  jpg: 'image/jpeg', jpeg: 'image/jpeg', png: 'image/png', gif: 'image/gif', webp: 'image/webp', heic: 'image/heic',
  pdf: 'application/pdf', txt: 'text/plain', md: 'text/markdown', json: 'application/json', csv: 'text/csv',
  zip: 'application/zip', mov: 'video/quicktime', mp4: 'video/mp4',
}

const UNKNOWN = 'application/octet-stream'

export function fileTypeOf(sentType: string | undefined, fileName: string): string {
  const sent = (sentType ?? '').split(';')[0]!.trim().toLowerCase()
  if (/^[a-z0-9.+-]+\/[a-z0-9.+-]+$/.test(sent) && sent !== UNKNOWN) return sent
  const dot = fileName.lastIndexOf('.')
  const extension = dot > 0 ? fileName.slice(dot + 1).toLowerCase() : ''
  return TYPE_BY_EXTENSION[extension] ?? UNKNOWN
}
