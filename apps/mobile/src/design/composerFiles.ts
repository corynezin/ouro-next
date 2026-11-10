// Picking what to attach. A file is held on the phone until the outbox uploads it.
import * as Clipboard from 'expo-clipboard'
import * as DocumentPicker from 'expo-document-picker'
import * as ImagePicker from 'expo-image-picker'
import { File, Paths } from 'expo-file-system'
import { COMPOSER_COPY, pickedAssetFile } from './composerText.ts'
import type { PickSource } from './composerText.ts'

export interface ComposerFile { localId: string; uri: string; fileName: string; byteLength: number; mimeType: string; isImage: boolean }
export type PickResult = { kind: 'picked'; files: ComposerFile[] } | { kind: 'failed'; reason: string }

let attachSeq = 0
const newLocalId = () => `a${++attachSeq}-${Date.now()}`

function fromAsset(a: ImagePicker.ImagePickerAsset): ComposerFile {
  return { localId: newLocalId(), uri: a.uri, byteLength: a.fileSize ?? 0, ...pickedAssetFile(a, Date.now()) }
}

export async function pickAttachments(source: PickSource): Promise<PickResult> {
  try {
    if (source === 'photos') {
      const r = await ImagePicker.launchImageLibraryAsync({ mediaTypes: ['images', 'videos'], allowsMultipleSelection: true, quality: 0.85,
        preferredAssetRepresentationMode: ImagePicker.UIImagePickerPreferredAssetRepresentationMode.Compatible }) // JPEG, not HEIC: agents can read it
      return { kind: 'picked', files: r.canceled ? [] : r.assets.map(fromAsset) }
    }
    if (source === 'camera') {
      const p = await ImagePicker.requestCameraPermissionsAsync()
      if (!p.granted) return { kind: 'failed', reason: COMPOSER_COPY.cameraDenied }
      const r = await ImagePicker.launchCameraAsync({ quality: 0.85 })
      return { kind: 'picked', files: r.canceled ? [] : r.assets.map(fromAsset) }
    }
    if (source === 'files') {
      const r = await DocumentPicker.getDocumentAsync({ multiple: true, copyToCacheDirectory: true })
      return { kind: 'picked', files: r.canceled ? [] : r.assets.map((a) => ({ localId: newLocalId(), uri: a.uri, fileName: a.name, byteLength: a.size ?? 0,
        mimeType: a.mimeType ?? 'application/octet-stream', isImage: !!a.mimeType?.startsWith('image/') })) }
    }
    // paste: an image on the clipboard, written to a file so it uploads like any other
    const img = await Clipboard.getImageAsync({ format: 'png' })
    if (!img?.data) return { kind: 'failed', reason: COMPOSER_COPY.clipboardHasNoImage }
    const b64 = img.data.replace(/^data:image\/\w+;base64,/, '')
    const f = new File(Paths.cache, `pasted-${Date.now()}.png`)
    f.write(b64, { encoding: 'base64' })
    return { kind: 'picked', files: [{ localId: newLocalId(), uri: f.uri, fileName: COMPOSER_COPY.pastedFileName, byteLength: f.size ?? Math.round(b64.length * 0.75), mimeType: 'image/png', isImage: true }] }
  } catch (e) {
    return { kind: 'failed', reason: (e as Error).message }
  }
}
