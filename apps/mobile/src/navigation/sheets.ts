// Sheets are presented by UIKit above the root view, so a view in the root can't cover them. While the Face ID lock is
// on they are closed, and the same stack is reopened after unlocking.
import type { NavigationState } from '@react-navigation/native'
import type { Routes } from './routes.ts'

/** The routes in AppRoot's `presentation: 'modal'` group. */
export const SHEET_ROUTES: ReadonlySet<string> = new Set<keyof Routes>(['New', 'NewGroup', 'AddToChat', 'SelectText', 'Settings', 'Servers', 'Computers', 'Claude', 'ChatGPT', 'OpenRouter', 'GitHub', 'Pair'])

/** The stack below its first sheet, or null when no sheet is open. */
export function withoutSheets(state: NavigationState): NavigationState | null {
  const firstSheet = state.routes.findIndex((route) => SHEET_ROUTES.has(route.name))
  if (firstSheet === -1) return null
  const routes = state.routes.slice(0, firstSheet)
  return { ...state, routes, index: Math.min(state.index, routes.length - 1) }
}
