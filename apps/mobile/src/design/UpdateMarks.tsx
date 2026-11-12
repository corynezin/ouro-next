// What an agent's update mark reads as in this app. The root provides it, since it knows what the app is running; the
// drawing kit only draws what it is told, and so needs nothing of the update machinery.
import { createContext, useContext } from 'react'

/** `unsure`: the app can't say (another computer's update, or nothing to compare with). */
export type UpdateMarkTone = 'in_app' | 'not_yet' | 'unsure'
/** `text`: the mark on a line of its own, a sentence. `inlineText`: inside a sentence. */
export interface UpdateMarkView { text: string; inlineText: string; tone: UpdateMarkTone }
export type UpdateMarkReader = (mark: { updateNumber: number; machineId: string }) => UpdateMarkView

const UpdateMarkContext = createContext<UpdateMarkReader | null>(null)
export const UpdateMarkProvider = UpdateMarkContext.Provider

/** The mark as this app reads it. With no provider (a screen drawn on its own), it is just named. */
export function useUpdateMark(updateNumber: number, machineId: string): UpdateMarkView {
  const read = useContext(UpdateMarkContext)
  return read ? read({ updateNumber, machineId }) : { text: `Update ${updateNumber}`, inlineText: `update ${updateNumber}`, tone: 'unsure' }
}
