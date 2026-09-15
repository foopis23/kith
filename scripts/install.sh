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
#
# Note: checksum verification protects against corrupted downloads only. The
# checksum file is hosted on the same release as the binary, so it cannot
# protect against a compromised release.

set -eu

REPO="foopis23/kith"

log() { printf '%s\n' "$*" >&2; }
fail() {
	log "kith-install: error: $*"
	exit 1
}

command -v curl >/dev/null 2>&1 || fail "missing required tool: curl"
command -v uname >/dev/null 2>&1 || fail "missing required tool: uname"
if ! command -v sha256sum >/dev/null 2>&1 && ! command -v shasum >/dev/null 2>&1; then
	fail "missing required tool: sha256sum or shasum"
fi

os=$(uname -s | tr '[:upper:]' '[:lower:]')
case "$os" in
linux | darwin) ;;
*) fail "unsupported operating system: $os (want linux or darwin)" ;;
esac

raw_arch=$(uname -m)
# Under Rosetta 2, uname reports x86_64 even on Apple Silicon. Prefer the
# native arm64 binary when this process is being translated.
if [ "$os" = "darwin" ] && [ "$raw_arch" = "x86_64" ] &&
	[ "$(sysctl -in proc_translated 2>/dev/null)" = "1" ]; then
	raw_arch="arm64"
fi
case "$raw_arch" in
x86_64 | amd64) arch="x64" ;;
arm64 | aarch64) arch="arm64" ;;
*) fail "unsupported architecture: $raw_arch" ;;
esac

target="$os-$arch"

valid_version() {
	printf '%s' "$1" | grep -qE '^v?[0-9]+\.[0-9]+\.[0-9]+([-+][0-9A-Za-z.-]+)?$'
}

if [ -z "${KITH_VERSION:-}" ]; then
	log "Resolving latest release..."
	# Follow the /releases/latest redirect instead of calling the API: no
	# rate limit and no JSON parsing.
	KITH_VERSION=$(curl -fsSL -o /dev/null -w '%{url_effective}' \
		"https://github.com/$REPO/releases/latest" | sed 's:.*/::') ||
		fail "could not resolve latest release; set KITH_VERSION explicitly"
fi
valid_version "$KITH_VERSION" ||
	fail "invalid release tag: '$KITH_VERSION' (expected something like v1.2.3)"

base_url="https://github.com/$REPO/releases/download/$KITH_VERSION"
log "Installing kith $KITH_VERSION ($target)"

tmpdir=$(mktemp -d)
cleanup() {
	rm -rf -- "$tmpdir"
	# Best-effort removal of a staged-but-not-yet-installed binary.
	[ -z "${stage:-}" ] || rm -f -- "$stage" 2>/dev/null || true
}
trap cleanup EXIT

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

# Set permissions before staging so a failed chmod can't leave an installed
# but non-executable binary behind (mv preserves the mode).
chmod 0755 "$tmpdir/kith"

if [ -n "${KITH_INSTALL_DIR:-}" ]; then
	install_dir=$KITH_INSTALL_DIR
elif [ -w /usr/local/bin ]; then
	install_dir="/usr/local/bin"
else
	install_dir="$HOME/.local/bin"
fi

# Strip trailing slashes so the PATH check below compares cleanly.
while [ "$install_dir" != "/" ] && [ "${install_dir%/}" != "$install_dir" ]; do
	install_dir=${install_dir%/}
done

# Run a command as root, with actionable errors when we can't prompt for a
# password (no tty) or sudo isn't available at all.
as_root() {
	command -v sudo >/dev/null 2>&1 ||
		fail "installing to $install_dir requires root and sudo is not installed; re-run as root or set KITH_INSTALL_DIR to a writable directory"
	[ -r /dev/tty ] && [ -w /dev/tty ] ||
		fail "installing to $install_dir requires root but there is no terminal to prompt for a password; re-run with sudo or set KITH_INSTALL_DIR to a writable directory"
	# Redirect from /dev/tty so sudo can prompt for a password even when
	# this script is piped into sh from curl.
	sudo "$@" </dev/tty
}

if [ ! -d "$install_dir" ]; then
	mkdir -p -- "$install_dir" 2>/dev/null || as_root mkdir -p -- "$install_dir" ||
		fail "cannot create $install_dir"
fi

# Stage via a temp file in the destination directory so the final mv is an
# atomic rename on the same filesystem. An interrupted cross-device copy can
# only ever leave a partial staging file (cleaned up by the trap), never a
# partial kith.
stage="$install_dir/.kith.tmp.$$"

if [ -w "$install_dir" ]; then
	mv -- "$tmpdir/kith" "$stage" || fail "failed to stage kith in $install_dir"
	mv -- "$stage" "$install_dir/kith" || fail "failed to install kith to $install_dir"
else
	log "Installing to $install_dir requires sudo."
	as_root mv -- "$tmpdir/kith" "$stage"
	as_root mv -- "$stage" "$install_dir/kith"
fi
stage=""

log "kith $KITH_VERSION installed to $install_dir/kith"

case ":$PATH:" in
*":$install_dir:"*) ;;
*) log "note: $install_dir is not on your PATH; add it to your shell profile." ;;
esac
