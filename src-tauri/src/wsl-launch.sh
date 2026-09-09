set -eu
namespace=$1
profile=$2
job=$3
provider=$4
binary=$5
shift 5
working_directory=''
if [ "${1-}" = --agent-studio-cwd ]; then
  working_directory=$2
  shift 2
fi
umask 077
root="$HOME/.local/share/$namespace"
mkdir -p "$root/runtime" "$root/runs"
if [ -n "$working_directory" ]; then
  case "$working_directory" in /*) ;; *) printf '%s\n' 'Selected folder is unavailable: absolute Linux path required' >&2; exit 1;; esac
  cd -- "$working_directory" || { printf '%s\n' 'Selected folder is unavailable' >&2; exit 1; }
else
  cd "$root/runtime"
fi
marker="$root/runs/$job"
if [ -f "$marker.cancel" ]; then rm -f -- "$marker.cancel"; exit 130; fi
if [ "$profile" != existing ]; then
  config="$root/profiles/$provider/$profile"
  mkdir -p "$config"
  unset OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
  unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_MANTLE
  if [ "$provider" = codex ]; then
    export CODEX_HOME="$config"
    set -- -c 'cli_auth_credentials_store="file"' "$@"
  else
    export CLAUDE_CONFIG_DIR="$config"
  fi
fi
# A distinct Linux process group allows Stop to terminate CLI descendants as well.
setsid "$binary" "$@" <&0 &
child=$!
cleanup() {
  kill -TERM -- "-$child" 2>/dev/null || true
  kill -KILL -- "-$child" 2>/dev/null || true
  rm -f -- "$marker" "$marker.cancel"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
state="$(cat "/proc/$child/stat" 2>/dev/null || true)"
state="${state##*) }"
start="$(printf '%s' "$state" | awk '{print $20}')"
printf '%s %s\n' "$child" "$start" > "$marker"
if [ -f "$marker.cancel" ]; then exit 130; fi
wait "$child"
