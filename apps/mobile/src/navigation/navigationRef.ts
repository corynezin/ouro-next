import { createNavigationContainerRef } from '@react-navigation/native'
import type { Routes } from './routes.ts'

/** The one navigator on screen, for saving its state before an update restart. */
export const navigationRef = createNavigationContainerRef<Routes>()
