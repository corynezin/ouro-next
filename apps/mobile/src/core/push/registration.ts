// This phone's APNs registration, from what iOS says about the running build.
import type { PushTokenRegistration } from '@ouro/contract'

/**
 * The build as the binary knows it. Never from expo-constants: under an update from our server its `expoConfig` is
 * built from the update manifest, which doesn't carry the app's config, so it is null there.
 */
export interface NativeBuild {
  /** The bundle identifier in the binary's Info.plist; null only where there is no native app. */
  bundleId: string | null
  /** A TestFlight or App Store build has production APNs tokens; a debug build from Xcode has sandbox ones. */
  productionApns: boolean
}

export function pushTokenRegistrationOf(token: string, build: NativeBuild): PushTokenRegistration {
  if (!build.bundleId) throw new Error('This build has no bundle identifier.')
  return { token, environment: build.productionApns ? 'production' : 'sandbox', bundleId: build.bundleId }
}
