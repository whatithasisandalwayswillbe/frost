#!/bin/sh
# Installs the latest Frost release.
#
# Supported OS: macOS, Linux (including WSL), and Windows through Git Bash, MSYS2, or Cygwin.
#
# This script:
# - Detects platform architecture and downloads the matching package.
# - Verifies 'checksums.txt' against the official Frost release key.
# - Validates the downloaded package integrity against the checksum.
# - Installs the launcher alongside its bundled runtime.
set -eu

REPO="whatithasisandalwayswillbe/frost"

# Public key
RELEASE_KEY="ssh-ed25519 AAAAC3NzaC1lZDI1NTE5AAAAIHO/g64dTbRW3poi7pdiPKgljYdHXG+TZeZQg4cfzAsV"

say() { printf '%s\n' "$*"; }
die() { printf 'install.sh: %s\n' "$*" >&2; exit 1; }
has() { command -v "$1" >/dev/null 2>&1; }

fetch() { # url dest
  if has curl; then
    curl -fsSL --retry 3 -o "$2" "$1"
  elif has wget; then
    wget -q -O "$2" "$1"
  else
    die "need curl or wget"
  fi
}

latest_version() {
  url="https://github.com/$REPO/releases/latest"
  if has curl; then
    final=$(curl -fsSLI -o /dev/null -w '%{url_effective}' "$url")
  else
    final=$(wget -S --spider "$url" 2>&1 | sed -n 's/^ *Location: *//p' | tail -n 1)
  fi
  v="${final##*/}"
  case "$v" in
    v*) printf '%s' "$v" ;;
    *) die "could not determine latest release version (set FROST_VERSION environment variable to select manually)" ;;
  esac
}

sha256() {
  if has sha256sum; then
    sha256sum "$1" | cut -d ' ' -f 1
  elif has shasum; then
    shasum -a 256 "$1" | cut -d ' ' -f 1
  else
    die "need sha256sum or shasum to verify the download"
  fi
}

case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  MINGW* | MSYS* | CYGWIN*) os=windows ;;
  *) die "unsupported OS: $(uname -s)" ;;
esac

case "$(uname -m)" in
  x86_64 | amd64) arch=amd64 ;;
  arm64 | aarch64) arch=arm64 ;;
  armv7* | armv6*) die "32-bit ARM isn't supported by the bundled runtime" ;;
  *) die "unsupported CPU architecture: $(uname -m)" ;;
esac

# On Apple Silicon, uname -m says x86_64 under Rosetta. Prefer native.
if [ "$os" = darwin ] && [ "$arch" = amd64 ] && [ "$(sysctl -n hw.optional.arm64 2>/dev/null || echo 0)" = 1 ]; then
  arch=arm64
fi

version="${FROST_VERSION:-}"
[ -n "$version" ] || version=$(latest_version)
num="${version#v}"
printf '%s\n' "$version" | LC_ALL=C awk '/^v(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(-[0-9A-Za-z.-]+)?$/ { valid=1 } END { exit !valid }' || die "invalid release version"

ext=tar.gz
bin=frost
if [ "$os" = windows ]; then
  ext=zip
  bin=frost.cmd
fi
archive="frost_${num}_${os}_${arch}.${ext}"
base="${FROST_BASE_URL:-https://github.com/$REPO/releases/download/$version}"
has ssh-keygen || die "need OpenSSH 8.1+ to verify the Frost release signature"

# Download and verify.
tmp=$(mktemp -d 2>/dev/null || mktemp -d -t frost)
trap 'rm -rf "$tmp"' EXIT INT TERM

say "Downloading Frost $version for $os/$arch"
fetch "$base/$archive" "$tmp/$archive" || die "download failed: $base/$archive"
fetch "$base/checksums.txt" "$tmp/checksums.txt" || die "download failed: $base/checksums.txt"

[ -n "$RELEASE_KEY" ] || die "the release signing key is missing"
fetch "$base/checksums.txt.sig" "$tmp/checksums.txt.sig" || die "download failed: $base/checksums.txt.sig"
printf 'frost-release %s\n' "$RELEASE_KEY" >"$tmp/allowed_signers"
if out=$(ssh-keygen -Y verify -f "$tmp/allowed_signers" -I frost-release -n file \
  -s "$tmp/checksums.txt.sig" <"$tmp/checksums.txt" 2>&1); then
  say "Signature ok"
else
  case "$out" in
    *"illegal option"* | *"unknown option"* | *"usage:"*) die "need OpenSSH 8.1+ to verify the Frost release signature" ;;
    *) die "checksums.txt signature does not match official Frost release key; installation aborted" ;;
  esac
fi

want=$(awk -v f="$archive" '$2 == f || $2 == "*"f { count++; value=$1 } END { if (count == 1) print value; else exit 1 }' "$tmp/checksums.txt") || die "$archive needs one entry in checksums.txt"
[ "${#want}" -eq 64 ] || die "invalid SHA-256 checksum for $archive"
case "$want" in *[!0-9a-fA-F]*) die "invalid SHA-256 checksum for $archive" ;; esac
got=$(sha256 "$tmp/$archive")
[ "$want" = "$got" ] || die "checksum mismatch for $archive (expected $want, got $got)"
say "Checksum ok"

mkdir "$tmp/x"
if [ "$ext" = zip ]; then
  if has unzip; then
    unzip -q "$tmp/$archive" -d "$tmp/x"
  elif has powershell.exe; then
    FROST_ARCHIVE_PATH=$(cygpath -w "$tmp/$archive" 2>/dev/null || echo "$tmp/$archive")
    FROST_EXTRACT_PATH=$(cygpath -w "$tmp/x" 2>/dev/null || echo "$tmp/x")
    export FROST_ARCHIVE_PATH FROST_EXTRACT_PATH
    powershell.exe -NoProfile -Command 'Expand-Archive -LiteralPath $env:FROST_ARCHIVE_PATH -DestinationPath $env:FROST_EXTRACT_PATH'
  else
    die "need unzip to extract $archive"
  fi
else
  tar -xzf "$tmp/$archive" -C "$tmp/x"
fi
[ -f "$tmp/x/manifest.json" ] || die "package manifest not found in $archive"
[ -f "$tmp/x/$bin" ] || die "$bin not found in $archive"

# Pick where to install.
on_path() { case ":$PATH:" in *":$1:"*) return 0 ;; *) return 1 ;; esac; }

dir="${FROST_INSTALL_DIR:-}"
if [ -z "$dir" ]; then
  if [ "$os" != windows ] && [ -d /usr/local/bin ] && [ -w /usr/local/bin ]; then
    dir=/usr/local/bin
  elif [ "$os" = windows ]; then
    dir="$HOME/bin"
  else
    dir="$HOME/.local/bin"
  fi
fi

mkdir -p "$dir"
runtime="$tmp/x/runtime/bin/node"
[ "$os" = windows ] && runtime="$runtime.exe"
[ -f "$runtime" ] || die "runtime not found in $archive"
[ -f "$tmp/x/install.mjs" ] || die "package installer not found in $archive"
package="$tmp/x"
launcher_dir="$dir"
if [ "$os" = windows ]; then
  has cygpath || die "need cygpath to install from a Windows shell"
  package=$(cygpath -w "$package")
  launcher_dir=$(cygpath -w "$launcher_dir")
fi
"$runtime" "$tmp/x/install.mjs" "$package" "$launcher_dir" || die "package install failed"

if ! on_path "$dir"; then
  say ""
  say "$dir isn't on your PATH yet. Add it with:"
  case "${SHELL:-}" in
    */zsh) say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.zshrc && exec zsh" ;;
    */fish) say "  fish_add_path $dir" ;;
    *) say "  echo 'export PATH=\"$dir:\$PATH\"' >> ~/.bashrc && exec bash" ;;
  esac
fi

say ""
say "Next: run 'frost init' to set up your first backup."
