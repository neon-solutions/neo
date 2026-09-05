#!/bin/bash
set -euo pipefail

err() {
  printf 'error: %s\n' "$*" >&2
  exit 1
}

NEO_INSTALL_DIR="${NEO_INSTALL_DIR:-$HOME/.local/bin}"
NEO_RELEASE_URL="${NEO_RELEASE_URL:-https://github.com/neon-solutions/neo/releases/download/latest}"
NEO_RELEASE_URL="${NEO_RELEASE_URL%/}"

case "$NEO_INSTALL_DIR" in
  ~) NEO_INSTALL_DIR="$HOME" ;;
  ~/*) NEO_INSTALL_DIR="$HOME/${NEO_INSTALL_DIR#~/}" ;;
esac

if [ "${NEO_INSTALL_DIR#/}" = "$NEO_INSTALL_DIR" ]; then
  err "NEO_INSTALL_DIR must be an absolute path"
fi

case "$NEO_INSTALL_DIR" in
  *..*) err "NEO_INSTALL_DIR must be an absolute path" ;;
esac

if ! printf '%s' "$NEO_INSTALL_DIR" | grep -q '^/[-A-Za-z0-9._/]*$'; then
  err "NEO_INSTALL_DIR must be an absolute path"
fi

detect_platform() {
  local os arch
  os="$(uname -s | tr '[:upper:]' '[:lower:]')"
  arch="$(uname -m)"
  case "${os}-${arch}" in
    darwin-arm64 | linux-x86_64) printf '%s-%s\n' "$os" "$arch" ;;
    *) err "unsupported platform: ${os}-${arch} (neo ships neo-darwin-arm64 and neo-linux-x86_64)" ;;
  esac
}

download() {
  local url="$1" dest="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL "$url" -o "$dest" || err "download failed: $url"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$dest" "$url" || err "download failed: $url"
  else
    err "curl or wget is required"
  fi
}

append_path_line() {
  local rc="$1"
  local line="$2"
  local parent last
  parent="$(dirname "$rc")"
  mkdir -p "$parent" || return 1
  if [ -f "$rc" ] && grep -qxF "$line" "$rc"; then
    return 0
  fi
  if [ -f "$rc" ] && [ -s "$rc" ]; then
    last="$(tail -c 1 "$rc")"
    if [ "$last" != "$(printf '\n')" ]; then
      printf '\n' >>"$rc" || return 1
    fi
  fi
  {
    printf '\n'
    printf '# neo\n'
    printf '%s\n' "$line"
  } >>"$rc"
}

persist_path() {
  local dir="$1"
  local shell_name line
  shell_name="$(basename "${SHELL:-/bin/sh}")"
  case "$shell_name" in
    zsh)
      line="export PATH=\"${dir}:\$PATH\""
      append_path_line "$HOME/.zshrc" "$line" || printf 'warning: could not update %s\n' "$HOME/.zshrc" >&2
      ;;
    bash)
      line="export PATH=\"${dir}:\$PATH\""
      append_path_line "$HOME/.bashrc" "$line" || printf 'warning: could not update %s\n' "$HOME/.bashrc" >&2
      append_path_line "$HOME/.bash_profile" "$line" || printf 'warning: could not update %s\n' "$HOME/.bash_profile" >&2
      ;;
    fish)
      line="set -gx PATH ${dir} \$PATH"
      append_path_line "$HOME/.config/fish/config.fish" "$line" || printf 'warning: could not update %s\n' "$HOME/.config/fish/config.fish" >&2
      ;;
  esac
}

hint_path() {
  local dir="$1"
  local shell_name line
  shell_name="$(basename "${SHELL:-/bin/sh}")"
  case "$shell_name" in
    fish) line="set -gx PATH ${dir} \$PATH" ;;
    *) line="export PATH=\"${dir}:\$PATH\"" ;;
  esac
  if ! printf '%s\n' "$PATH" | tr ':' '\n' | grep -qx "$dir"; then
    printf 'restart your shell or run: %s\n' "$line" >&2
  fi
}

TMP_DIR=""
INSTALL_TMP=""
cleanup() {
  if [ -n "$TMP_DIR" ]; then
    rm -rf "$TMP_DIR"
  fi
  if [ -n "$INSTALL_TMP" ]; then
    rm -f "$INSTALL_TMP"
  fi
}
trap cleanup EXIT

main() {
  local platform dest
  platform="$(detect_platform)"
  dest="${NEO_INSTALL_DIR}/neo"

  TMP_DIR="$(mktemp -d)"
  download "${NEO_RELEASE_URL}/neo-${platform}" "$TMP_DIR/neo"
  chmod +x "$TMP_DIR/neo"

  mkdir -p "$NEO_INSTALL_DIR"
  # mktemp is often a different filesystem than the install dir, so the
  # final rename has to happen inside NEO_INSTALL_DIR.
  INSTALL_TMP="${NEO_INSTALL_DIR}/.neo.tmp.$$"
  mv -f "$TMP_DIR/neo" "$INSTALL_TMP"
  mv -f "$INSTALL_TMP" "$dest"
  INSTALL_TMP=""

  persist_path "$NEO_INSTALL_DIR"
  printf 'installed neo to %s\n' "$dest" >&2
  hint_path "$NEO_INSTALL_DIR"

  if [ ! -t 0 ]; then
    printf '%s\n' "$dest"
  fi
}

main "$@"
