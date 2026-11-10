// What the composer decides, apart from the pickers and the field that it drives. Pure.

export type PickSource = 'photos' | 'camera' | 'files' | 'paste'

export const COMPOSER_COPY = {
  cameraDenied: 'Ouro may not use the camera (Settings → Ouro).',
  clipboardHasNoImage: 'The clipboard has no image.',
  pastedFileName: 'pasted.png',
} as const

/** The attach sheet: Paste image only while the clipboard holds one. */
export function attachOptions(clipboardHasImage: boolean): { source: PickSource; title: string }[] {
  const options: { source: PickSource; title: string }[] = [
    { source: 'photos', title: 'Photo Library' },
    { source: 'camera', title: 'Camera' },
    { source: 'files', title: 'Files' },
  ]
  return clipboardHasImage ? [...options, { source: 'paste', title: 'Paste image' }] : options
}

/** A photo or video from the library or camera: its own name, else one made from the time, with the usual extension. */
export function pickedAssetFile(asset: { fileName?: string | null; type?: string | null; mimeType?: string | null }, now: number): { fileName: string; mimeType: string; isImage: boolean } {
  const isImage = asset.type !== 'video'
  const mimeType = asset.mimeType ?? (isImage ? 'image/jpeg' : 'video/quicktime')
  const subtype = mimeType.split('/')[1] ?? ''
  const ext = ({ jpeg: 'jpg', quicktime: 'mov' } as Record<string, string>)[subtype] ?? (subtype || (isImage ? 'jpg' : 'mov'))
  return { fileName: asset.fileName ?? `${isImage ? 'photo' : 'video'}-${now}.${ext}`, mimeType, isImage }
}

/** A failed send taken back by Edit joins what is already being written, on a new line. */
export const draftWithTakenBack = (draft: string, takenBack: string) => (draft ? `${draft}\n${takenBack}` : takenBack)

/** What Send sends: the text trimmed, and only when there is text or a file. */
export function composedSend(text: string, fileCount: number): { sendable: boolean; text: string } {
  const trimmed = text.trim()
  return { sendable: trimmed !== '' || fileCount > 0, text: trimmed }
}
