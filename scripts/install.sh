#!/bin/sh
# kith installer — downloads a prebuilt single-file binary from GitHub Releases.
#
# Usage:
#   curl -fsSL https://raw.githubusercontent.com/foopis23/kith/main/scripts/install.sh | sh
#
# Environment overrides:
#   KITH_VERSION      Release tag to install (default: latest)
#   KITH_INSTALL_DIR  Install location (default: /usr/local/bin if writable,
#                     else ~/.local/bin). Use sudo for system-wide installs:
#                       KITH_INSTALL_DIR=/usr/local/bin sh install.sh

set -eu

REPO="foopis23/kith"

log() { printf '%s\n' "$*" >&2; }
fail() {
	log "kith-install: error: $*"
	exit 1
}

command -v curl >/dev/null 2>&1 || fail "missing required tool: curl"
command -v uname >/dev/null 2>&1 || fail "missing required tool: uname"

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
linux | darwin) ;;
*) fail "unsupported operating system: $os (want linux or darwin)" ;;
esac

arch=$(uname -m)
case "$arch" in
x86_64 | amd64) arch="x64" ;;
arm64 | aarch64) arch="arm64" ;;
*) fail "unsupported architecture: $(uname -m)" ;;
esac

target="$os-$arch"

if [ -z "${KITH_VERSION:-}" ]; then
	log "Resolving latest release..."
	KITH_VERSION=$(curl -fsSL "https://api.github.com/repos/$REPO/releases/latest" |
		sed -n 's/.*"tag_name": *"\([^"]*\)".*/\1/p')
	[ -n "$KITH_VERSION" ] || fail "could not determine latest release; set KITH_VERSION explicitly"
fi

base_url="https://github.com/$REPO/releases/download/$KITH_VERSION"
log "Installing kith $KITH_VERSION ($target)"

tmpdir=$(mktemp -d)
trap 'rm -rf "$tmpdir"' EXIT

curl -fsSL -o "$tmpdir/kith" "$base_url/kith-$target" ||
	fail "download failed: $base_url/kith-$target (does the release have a binary for $target?)"
curl -fsSL -o "$tmpdir/checksums.txt" "$base_url/checksums.txt" ||
	fail "download failed: $base_url/checksums.txt"

log "Verifying checksum..."
expected=$(awk -v f="kith-$target" '$2 == f { print $1 }' "$tmpdir/checksums.txt")
[ -n "$expected" ] || fail "no checksum found for kith-$target"
if command -v sha256sum >/dev/null 2>&1; then
	actual=$(sha256sum "$tmpdir/kith" | awk '{ print $1 }')
else
	actual=$(shasum -a 256 "$tmpdir/kith" | awk '{ print $1 }')
fi
[ "$expected" = "$actual" ] ||
	fail "checksum mismatch for kith-$target (expected $expected, got $actual)"

if [ -n "${KITH_INSTALL_DIR:-}" ]; then
	install_dir="$KITH_INSTALL_DIR"
elif [ -w /usr/local/bin ]; then
	install_dir="/usr/local/bin"
else
	install_dir="$HOME/.local/bin"
fi

if [ ! -d "$install_dir" ]; then
	mkdir -p "$install_dir" 2>/dev/null || sudo mkdir -p "$install_dir" </dev/tty ||
		fail "cannot create $install_dir"
fi

if [ -w "$install_dir" ]; then
	mv "$tmpdir/kith" "$install_dir/kith"
	chmod 0755 "$install_dir/kith"
else
	# Redirect from /dev/tty so sudo can prompt for a password even when
	# this script is piped into sh from curl.
	log "Installing to $install_dir requires sudo."
	sudo mv "$tmpdir/kith" "$install_dir/kith" </dev/tty
	sudo chmod 0755 "$install_dir/kith" </dev/tty
fi

log "kith $KITH_VERSION installed to $install_dir/kith"

case ":$PATH:" in
*":$install_dir:"*) ;;
*) log "note: $install_dir is not on your PATH; add it to your shell profile." ;;
esac
