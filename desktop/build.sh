#!/bin/bash
set -euo pipefail

desktop="$(cd -- "$(dirname -- "$0")" && pwd)"
root="$(cd -- "$desktop/.." && pwd)"
dist="$root/dist"
name="宇伴"
executable="YubanConsole"

if [[ $# -gt 1 || ( $# -eq 1 && "$1" != "--dmg" ) ]]; then
    printf 'Usage: %s [--dmg]\n' "$0" >&2
    exit 2
fi
if [[ "$(uname -s)" != Darwin ]]; then
    printf 'This build requires macOS and the Xcode command line tools.\n' >&2
    exit 1
fi

shopt -s nullglob
sources=("$desktop"/Sources/*.swift)
if [[ ${#sources[@]} -eq 0 ]]; then
    printf 'No Swift sources found under %s/Sources.\n' "$desktop" >&2
    exit 1
fi

mkdir -p "$dist"
stage="$(mktemp -d "$dist/.build-app.XXXXXX")"
trap 'find "$stage" -depth -delete' EXIT

app="$stage/$name.app"
contents="$app/Contents"
resources="$contents/Resources"
mkdir -p "$contents/MacOS" "$resources"

plutil -lint "$desktop/Info.plist"
min_version="$(plutil -extract LSMinimumSystemVersion raw "$desktop/Info.plist")"
sdk="$(xcrun --sdk macosx --show-sdk-path)"
for arch in arm64 x86_64; do
    xcrun swiftc -parse-as-library -O -whole-module-optimization \
        -module-name "$executable" -target "$arch-apple-macosx$min_version" -sdk "$sdk" \
        -framework AppKit -framework SwiftUI -framework WebKit -framework Security \
        "${sources[@]}" -o "$stage/$executable.$arch"
done
xcrun lipo -create "$stage/$executable.arm64" "$stage/$executable.x86_64" \
    -output "$contents/MacOS/$executable"
chmod 755 "$contents/MacOS/$executable"

install -m 644 "$desktop/Info.plist" "$contents/Info.plist"

codesign --force --sign - "$app"
codesign --verify --strict "$app"
for arch in arm64 x86_64; do
    xcrun lipo "$contents/MacOS/$executable" -verify_arch "$arch"
done

destination="$dist/$name.app"
if [[ -e "$destination" || -L "$destination" ]]; then
    mv "$destination" "$stage/previous.app"
fi
if ! mv "$app" "$destination"; then
    if [[ -e "$stage/previous.app" || -L "$stage/previous.app" ]]; then
        mv "$stage/previous.app" "$destination"
    fi
    exit 1
fi
printf '\n%s\n' "$destination"

if [[ ${1:-} == --dmg ]]; then
    disk="$stage/disk"
    mkdir "$disk"
    ditto "$destination" "$disk/$name.app"
    ln -s /Applications "$disk/Applications"
    hdiutil create -volname "$name" -srcfolder "$disk" -format UDZO "$stage/$name.dmg"
    hdiutil verify "$stage/$name.dmg"
    mv -f "$stage/$name.dmg" "$dist/$name.dmg"
    printf '%s\n' "$dist/$name.dmg"
fi
