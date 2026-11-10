#!/bin/zsh
# Signs an archive's app for App Store distribution and packages it: ios-sign.sh <path to .xcarchive>
# Prints IPA=<path>. Apple's codesign only finds identities on the keychain search list, which this shared Mac's other
# builds rely on, so rcodesign signs with a key exported briefly from the dedicated keychain instead.
set -euo pipefail
repo=${0:A:h:h}
archive=${1:?usage: ios-sign.sh <xcarchive>}
signing=$repo/.signing
keychain=$signing/ouro-next-signing.keychain-db
profile=$signing/OuroNext_AppStore.mobileprovision
rcodesign=$repo/.tools/bin/rcodesign

work=$(mktemp -d "$signing/sign.XXXXXX")
trap 'rm -rf "$work"' EXIT
umask 077

source_app=$archive/Products/Applications/OuroNext.app
build_number=$(/usr/libexec/PlistBuddy -c 'Print :CFBundleVersion' "$source_app/Info.plist")
mkdir -p "$work/Payload"
ditto "$source_app" "$work/Payload/OuroNext.app"
app=$work/Payload/OuroNext.app
cp "$profile" "$app/embedded.mobileprovision"

security cms -D -i "$profile" > "$work/profile.plist"
/usr/libexec/PlistBuddy -x -c 'Print :Entitlements' "$work/profile.plist" > "$work/entitlements.plist"
# A distribution build must not claim every group the wildcard profile allows.
/usr/libexec/PlistBuddy -c 'Delete :keychain-access-groups' "$work/entitlements.plist"
/usr/libexec/PlistBuddy -c 'Add :keychain-access-groups array' -c "Add :keychain-access-groups:0 string U2Q2D6ZQP2.dev.claudeinbox.ouronext" "$work/entitlements.plist"

openssl rand -hex 24 > "$work/p12-password"
security unlock-keychain -p "$(cat "$signing/keychain-password")" "$keychain"
security export -k "$keychain" -t identities -f pkcs12 -P "$(cat "$work/p12-password")" -o "$work/identity.p12"

"$rcodesign" sign --p12-file "$work/identity.p12" --p12-password-file "$work/p12-password" \
  --entitlements-xml-file "$work/entitlements.plist" "$app" 2>&1 | tail -3
rm -f "$work/identity.p12" "$work/p12-password"

codesign --verify --deep --strict "$app"
codesign -dvv "$app" 2>&1 | grep -E '^(Identifier|TeamIdentifier|Authority=Apple Distribution)'

mkdir -p "$repo/.tools/ipas"
ipa=$repo/.tools/ipas/OuroNext-$build_number.ipa
(cd "$work" && ditto -c -k --sequesterRsrc --keepParent Payload "$ipa")
echo "IPA=$ipa"
