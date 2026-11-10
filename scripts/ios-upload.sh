#!/bin/zsh
# Uploads a signed package to App Store Connect, where it becomes a TestFlight build: ios-upload.sh <path to .ipa>
# Key material stays in ~/ci-keys; the issuer ID is read from the helper there rather than committed.
set -euo pipefail
ipa=${1:?usage: ios-upload.sh <ipa>}
issuer=$(sed -nE 's/.*"iss":"([^"]+)".*/\1/p' ~/ci-keys/bin/asc.py)
API_PRIVATE_KEYS_DIR=$HOME/ci-keys xcrun altool --upload-app -f "$ipa" -t ios --apiKey NNBTYP6SSR --apiIssuer "$issuer"
