#!/bin/zsh
# Builds an unsigned Release device archive of the current checkout into .tools/archives/<build number>.xcarchive.
# Signing is a separate step (ios-sign.sh) because the signing identity lives in a keychain outside the search list.
set -euo pipefail
repo=${0:A:h:h}
export LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 CI=1 EXPO_NO_TELEMETRY=1

build_number=$(date -u +%Y%m%d%H%M)
archive=$repo/.tools/archives/$build_number.xcarchive

cd "$repo/apps/mobile"
npx expo prebuild --platform ios --clean --no-install
cd ios
pod install
# -jobs is capped because this Mac is shared with other builds.
xcodebuild archive -workspace OuroNext.xcworkspace -scheme OuroNext -configuration Release \
  -destination generic/platform=iOS -archivePath "$archive" \
  -derivedDataPath "$repo/.tools/derived-device" -jobs 4 \
  CODE_SIGNING_ALLOWED=NO
/usr/libexec/PlistBuddy -c "Set :CFBundleVersion $build_number" "$archive/Products/Applications/OuroNext.app/Info.plist"
echo "ARCHIVE=$archive"
