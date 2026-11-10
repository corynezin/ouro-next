// A file sent in a chat, opened on its own screen: what the screen and its share button need beyond the attachment.

/** The name a shared copy is saved under in the cache: the file's own name, never a path. */
export function sharedFileName(fileName: string): string {
  return fileName.replace(/[/\\]/g, '_') || 'file'
}

export const FILE_COPY = {
  shareFailed: "Couldn't share it",
  httpError: (status: number) => `HTTP ${status}`,
}
