#!/bin/zsh
# Runs the current checkout in a simulator as a Release build: ouro-rebirth-sim, or OURO_SIM (such as ouro-rebirth-sim-2).
#   ios-sim.sh          embed this checkout's JS into the last native simulator build (seconds; JS-only changes)
#   ios-sim.sh --native rebuild the native app first (needed after native dependency or app.json changes)
# The app is signed ad hoc: an unsigned app gets no keychain entitlement, and SecureStore then fails (-34018).
set -euo pipefail
repo=${0:A:h:h}
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 CI=1 EXPO_NO_TELEMETRY=1
simulator=${OURO_SIM:-ouro-rebirth-sim}
bundle_id=dev.claudeinbox.ouronext
native_app=$repo/.tools/derived-sim/Build/Products/Release-iphonesimulator/OuroNext.app
udid=$(xcrun simctl list devices | awk -F'[()]' -v name="$simulator" '$0 ~ "^ +"name" " {print $2; exit}')
[[ -n $udid ]] || { echo "no simulator named $simulator" >&2; exit 1; }

if [[ ${1:-} == --native || ! -d $native_app ]]; then
  if pgrep -qf "xcodebuild.*$repo"; then echo "another native build of this repo is running; one at a time" >&2; exit 1; fi
  (cd "$repo/apps/mobile" && npx expo prebuild --platform ios --no-install >/dev/null)
  (cd "$repo/apps/mobile/ios" && pod install >/dev/null)
  # -jobs is capped because this Mac is shared with other builds.
  xcodebuild -workspace "$repo/apps/mobile/ios/OuroNext.xcworkspace" -scheme OuroNext -configuration Release \
    -sdk iphonesimulator -destination "platform=iOS Simulator,id=$udid" -derivedDataPath "$repo/.tools/derived-sim" -jobs 4 \
    CODE_SIGN_IDENTITY=- CODE_SIGNING_ALLOWED=YES CODE_SIGNING_REQUIRED=YES DEVELOPMENT_TEAM=U2Q2D6ZQP2 build \
    > "$repo/.tools/logs/sim-native.log" 2>&1 || { tail -30 "$repo/.tools/logs/sim-native.log"; exit 1; }
fi

# Staged per simulator, so runs on the two simulators can't overwrite each other's app.
staging=$repo/.tools/sim-app/$simulator
app=$staging/OuroNext.app
rm -rf "$staging"; mkdir -p "$staging"
ditto "$native_app" "$app"
(cd "$repo/apps/mobile" && npx expo export:embed --platform ios --dev false --minify true --bytecode --entry-file index.ts \
  --bundle-output "$app/main.jsbundle" --assets-dest "$app" >/dev/null)
# Re-sealing keeps the entitlements, which Xcode stores in the binary for simulator builds.
codesign --force --sign - --timestamp=none "$app" 2>/dev/null

xcrun simctl boot "$udid" 2>/dev/null || true
xcrun simctl bootstatus "$udid" -b >/dev/null
xcrun simctl terminate "$udid" "$bundle_id" 2>/dev/null || true
xcrun simctl install "$udid" "$app"
xcrun simctl launch "$udid" "$bundle_id" >/dev/null
echo "running $(git -C "$repo" rev-parse --short HEAD)$(git -C "$repo" diff --quiet || echo '-dirty') in $simulator"
