#!/bin/sh
set -eu

PORTABLE_VERSION=22.23.2
SCRIPT_DIR=$(CDPATH= cd -P -- "$(dirname -- "$0")" && pwd)
install_dir=''
workspace=''
config=''
no_panel=0
proxy=''
staging=''
download_dir=''

fail() { printf '\nInstallation failed: %s\n' "$*" >&2; exit 1; }
usage() {
  printf '%s\n' 'Usage: sh install.sh [--install-dir PATH] [--workspace PATH] [--config PATH] [--no-panel] [--proxy URL]'
  printf '%s\n' 'Default: ~/.local/share/webcodex (or $XDG_DATA_HOME/webcodex); workspace: INSTALL_DIR/workspace.'
}
while [ "$#" -gt 0 ]; do
  case "$1" in
    --install-dir) [ "$#" -ge 2 ] || fail 'Missing --install-dir value'; install_dir=$2; shift 2 ;;
    --workspace) [ "$#" -ge 2 ] || fail 'Missing --workspace value'; workspace=$2; shift 2 ;;
    --config) [ "$#" -ge 2 ] || fail 'Missing --config value'; config=$2; shift 2 ;;
    --no-panel|--no-open) no_panel=1; shift ;;
    --proxy) [ "$#" -ge 2 ] || fail 'Missing --proxy value'; proxy=$2; shift 2 ;;
    --help|-h) usage; exit 0 ;;
    *) fail "Unknown argument: $1" ;;
  esac
done

hash_file() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | awk '{print $1}'
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else fail 'Install sha256sum or shasum to verify downloaded files.'; fi
}
verify_sha() {
  [ -f "$2" ] || fail "Checksum manifest missing: $2"
  expected=$(awk -v name="$3" '$2 == name || $2 == "*" name { count++; hash=$1 } END { if (count == 1) print hash; else exit 1 }' "$2") || fail "Expected exactly one checksum for $3"
  [ "${#expected}" -eq 64 ] || fail "Invalid checksum for $3"
  case "$expected" in *[!a-fA-F0-9]*) fail "Invalid checksum for $3" ;; esac
  expected=$(printf '%s' "$expected" | tr 'A-F' 'a-f')
  [ "$(hash_file "$1")" = "$expected" ] || fail "SHA-256 verification failed for $3. Download the complete release again."
  printf '%s' "$expected"
}
cleanup() {
  # Only directories created with mktemp below may be removed.
  if [ -n "$staging" ]; then
    case "$staging" in "$install_dir"/app/.install-*) rm -rf -- "$staging" ;; *) printf '%s\n' 'Unexpected staging path; preserved.' >&2 ;; esac
  fi
  if [ -n "$download_dir" ]; then
    case "$download_dir" in "$install_dir"/runtime/.install-*) rm -rf -- "$download_dir" ;; *) printf '%s\n' 'Unexpected download path; preserved.' >&2 ;; esac
  fi
}
trap cleanup 0
trap 'exit 130' INT
trap 'exit 143' HUP TERM
node_compatible() {
  "$1" -e 'const v=process.versions.node.split(".").map(Number);process.exit(v[0]>22||(v[0]===22&&v[1]>=16)?0:1)' >/dev/null 2>&1
}
quote_sh() { printf "'"; printf '%s' "$1" | sed "s/'/'\\\\''/g"; printf "'"; }

printf '%s\n' 'WebCodex local installer'
set -- "$SCRIPT_DIR"/webcodex-mcp-*.tgz
[ "$#" -eq 1 ] && [ -f "$1" ] || fail 'Extract the full setup ZIP first. It must contain exactly one webcodex-mcp-*.tgz package.'
package=$1
package_name=$(basename -- "$package")
release_version=${package_name#webcodex-mcp-}
release_version=${release_version%.tgz}
printf '%s' "$release_version" | grep -Eq '^[0-9]+\.[0-9]+\.[0-9]+(-[A-Za-z0-9.-]+)?$' || fail 'The package filename does not contain a supported release version.'
package_hash=$(verify_sha "$package" "$SCRIPT_DIR/SHA256SUMS" "$package_name")
printf '[1/4] Package checksum verified: %s\n' "$release_version"
if [ -n "$proxy" ]; then
  printf '%s' "$proxy" | grep -Eq '^https?://[^/@[:space:]?#]+/?$' || fail 'Use an HTTP(S) proxy origin without credentials, path, query or fragment.'
  HTTP_PROXY=$proxy HTTPS_PROXY=$proxy http_proxy=$proxy https_proxy=$proxy npm_config_proxy=$proxy npm_config_https_proxy=$proxy
  export HTTP_PROXY HTTPS_PROXY http_proxy https_proxy npm_config_proxy npm_config_https_proxy
fi

[ -n "$install_dir" ] || install_dir=${XDG_DATA_HOME:-"$HOME/.local/share"}/webcodex
mkdir -p -- "$install_dir"
install_dir=$(CDPATH= cd -P -- "$install_dir" && pwd)
[ "$install_dir" != / ] || fail 'Choose a dedicated installation directory, not the filesystem root.'
if [ -n "$config" ]; then
  case "$config" in /*) ;; *) config=$PWD/$config ;; esac
else
  has_json=0
  has_toml=0
  if [ -e "$install_dir/config.json" ] || [ -L "$install_dir/config.json" ]; then has_json=1; fi
  if [ -e "$install_dir/config.toml" ] || [ -L "$install_dir/config.toml" ]; then has_toml=1; fi
  if [ "$has_json" -eq 1 ] && [ "$has_toml" -eq 1 ]; then fail 'Both config.json and config.toml exist. Run the installer with --config PATH to explicitly select one. Both files have been preserved.'; fi
  if [ "$has_json" -eq 1 ]; then config=$install_dir/config.json; else config=$install_dir/config.toml; fi
fi
if [ -e "$config" ] && [ ! -f "$config" ]; then fail "The selected configuration path is not a file: $config"; fi
[ -n "$workspace" ] || workspace=$install_dir/workspace
mkdir -p -- "$workspace"
workspace=$(CDPATH= cd -P -- "$workspace" && pwd)
node_exe=$(command -v node || true)
npm_exe=$(command -v npm || true)
if [ -z "$node_exe" ] || [ -z "$npm_exe" ] || ! node_compatible "$node_exe"; then
  case $(uname -s) in Linux) system=linux ;; Darwin) system=darwin ;; *) fail 'This installer supports Linux and macOS; on Windows use install.cmd.' ;; esac
  case $(uname -m) in x86_64|amd64) architecture=x64 ;; aarch64|arm64) architecture=arm64 ;; *) fail 'This installer supports x64 and ARM64.' ;; esac
  archive_root=node-v$PORTABLE_VERSION-$system-$architecture
  runtime=$install_dir/runtime/$archive_root
  if [ ! -e "$runtime" ]; then
    command -v curl >/dev/null 2>&1 || fail 'Install curl to download portable Node.js.'
    command -v tar >/dev/null 2>&1 || fail 'Install tar to extract portable Node.js.'
    printf '[2/4] Downloading official portable Node.js %s (%s/%s)...\n' "$PORTABLE_VERSION" "$system" "$architecture"
    mkdir -p -- "$install_dir/runtime"
    download_dir=$(mktemp -d "$install_dir/runtime/.install-XXXXXXXX")
    archive_name=$archive_root.tar.gz
    curl --fail --location --proto '=https' --tlsv1.2 --output "$download_dir/SHASUMS256.txt" "https://nodejs.org/dist/v$PORTABLE_VERSION/SHASUMS256.txt"
    curl --fail --location --proto '=https' --tlsv1.2 --output "$download_dir/$archive_name" "https://nodejs.org/dist/v$PORTABLE_VERSION/$archive_name"
    archive_hash=$(verify_sha "$download_dir/$archive_name" "$download_dir/SHASUMS256.txt" "$archive_name")
    printf '[2/4] Portable Node.js checksum verified: %s\n' "$archive_hash"
    tar -xzf "$download_dir/$archive_name" -C "$download_dir"
    mv -- "$download_dir/$archive_root" "$runtime"
    rm -rf -- "$download_dir"
    download_dir=''
  fi
  node_exe=$runtime/bin/node
  npm_exe=$runtime/bin/npm
  node_compatible "$node_exe" && [ -f "$npm_exe" ] || fail "The portable Node.js installation is incomplete: $runtime"
fi
printf '[2/4] Using Node.js %s\n' "$("$node_exe" --version)"
# This affects only the installer and its children; shell profiles are untouched.
PATH=$(dirname -- "$node_exe"):$PATH
export PATH
app=$install_dir/app/$release_version
cli=$app/node_modules/webcodex-mcp/dist/src/cli.js
marker=$app/.webcodex-package.sha256
if [ -e "$app" ]; then
  [ -f "$marker" ] && [ "$(cat "$marker")" = "$package_hash" ] && [ -f "$cli" ] || fail "This release directory already exists with different or incomplete contents: $app. Use a new InstallDir; existing files have been preserved."
  printf '%s\n' '[3/4] Reusing this verified release; installed application files are unchanged.'
else
  printf '%s\n' '[3/4] Installing WebCodex and its production dependencies...'
  mkdir -p -- "$install_dir/app"
  staging=$(mktemp -d "$install_dir/app/.install-XXXXXXXX")
  "$npm_exe" install --prefix "$staging" "$package" --omit=dev --ignore-scripts --no-audit --no-fund
  [ -f "$staging/node_modules/webcodex-mcp/dist/src/cli.js" ] || fail 'The package does not include the built WebCodex CLI.'
  printf '%s\n' "$package_hash" > "$staging/.webcodex-package.sha256"
  mv -- "$staging" "$app"
  staging=''
fi

launcher=$install_dir/webcodex
{
  printf '%s\n' '#!/bin/sh' 'set -eu'
  printf 'PATH='; quote_sh "$(dirname -- "$node_exe"):"; printf '$PATH\nexport PATH\n'
  printf '%s\n' 'if [ "$#" -eq 0 ]; then set -- setup; fi'
  printf 'exec '; quote_sh "$node_exe"; printf ' '; quote_sh "$cli"; printf ' "$@" --config '; quote_sh "$config"; printf '\n'
} > "$launcher.new.$$"
chmod 700 "$launcher.new.$$"
mv -f -- "$launcher.new.$$" "$launcher"
printf '[4/4] Preparing workspace and configuration: %s\n' "$workspace"
printf '%s\n' 'Existing configuration will be preserved. No system PATH or service settings are changed.'
printf 'Start the management page later: '; quote_sh "$launcher"; printf '\n'
set -- "$cli" setup --workspace "$workspace" --config "$config"
if [ "$no_panel" -eq 1 ]; then set -- "$@" --no-panel; fi
if [ -n "$proxy" ]; then set -- "$@" --proxy "$proxy"; fi
"$node_exe" "$@"
