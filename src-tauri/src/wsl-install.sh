# Fixed installer launcher: the provider is a positional argument, never shell source. It runs
# that provider's own installer, which verifies the build it downloads, for this user.
set -eu
case "$1" in
  claude) url='https://claude.ai/install.sh' runner=bash ;;
  codex) url='https://chatgpt.com/codex/install.sh' runner=sh ;;
  *) echo 'Agent Studio installs Claude Code and Codex only.' >&2; exit 2 ;;
esac
if ! command -v curl >/dev/null 2>&1; then
  echo 'curl is not installed in this distribution. Install it with its package manager, then try again.' >&2
  exit 3
fi
installer="$(mktemp)"
trap 'rm -f "$installer"' EXIT
# The whole installer arrives before any of it runs.
curl -fsSL --retry 2 "$url" -o "$installer"
CODEX_NON_INTERACTIVE=1 "$runner" "$installer" </dev/null
installed="$(command -v -- "$1" || printf '%s' "$HOME/.local/bin/$1")"
printf 'agent-studio-installed %s\n' "$("$installed" --version 2>/dev/null | head -n 1)"
