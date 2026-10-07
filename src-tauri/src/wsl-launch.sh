set -eu
namespace=$1
profile=$2
job=$3
provider=$4
binary=$5
shift 5
shared=''
if [ "${1-}" = --agent-studio-shared ]; then
  shared=1
  shift
fi
working_directory=''
standalone=''
if [ "${1-}" = --agent-studio-cwd ]; then
  working_directory=$2
    shift 2
elif [ "${1-}" = --agent-studio-standalone ]; then
    standalone=$2
    # Host-generated canonical UUID only; never interpret a caller's path.
    if ! printf '%s\n' "$standalone" | LC_ALL=C grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
        printf '%s\n' 'Invalid standalone conversation id' >&2
        exit 1
    fi
    shift 2
fi
# The app's own folders and markers are private; the CLI, the commands it runs and the shared
# Claude directory keep the user's own file modes.
user_umask=$(umask)
umask 077
root="$HOME/.local/share/$namespace"
mkdir -p "$root/runtime" "$root/runs"
if [ -n "$working_directory" ]; then
  case "$working_directory" in /*) ;; *) printf '%s\n' 'Selected folder is unavailable: absolute Linux path required' >&2; exit 1;; esac
  cd -- "$working_directory" || { printf '%s\n' 'Selected folder is unavailable' >&2; exit 1; }
elif [ -n "$standalone" ]; then
    mkdir -p "$root/standalone/$standalone"
    cd "$root/standalone/$standalone"
else
  cd "$root/runtime"
fi
marker="$root/runs/$job"
if [ -f "$marker.cancel" ]; then rm -f -- "$marker.cancel"; exit 130; fi
if [ "$profile" != existing ]; then
  config="$root/profiles/$provider/$profile"
  mkdir -p "$config"
  if [ -n "$shared" ] && [ "$provider" = claude ]; then
    shared_directory=${CLAUDE_CONFIG_DIR:-$HOME/.claude}
    umask "$user_umask"
    exec 9>"$config/.agent-studio-share.lock"
    if command -v flock >/dev/null 2>&1; then flock -w 60 9 || true; fi
    if ! share_link "$config" "$shared_directory"; then
      printf '%s\n' "Could not share $shared_directory with this account; its files were left in place." >&2
      exit 1
    fi
    share_retain "$shared_directory" || true
    exec 9>&-
    umask 077
  fi
  unset OPENAI_API_KEY CODEX_API_KEY ANTHROPIC_API_KEY ANTHROPIC_AUTH_TOKEN CLAUDE_CODE_OAUTH_TOKEN
  unset CLAUDE_CODE_USE_BEDROCK CLAUDE_CODE_USE_VERTEX CLAUDE_CODE_USE_FOUNDRY CLAUDE_CODE_USE_MANTLE
  if [ "$provider" = codex ]; then
    export CODEX_HOME="$config"
    set -- -c 'cli_auth_credentials_store="file"' "$@"
  else
    export CLAUDE_CONFIG_DIR="$config"
  fi
fi
umask "$user_umask"
# The CLI login keeps its transcripts in the directory the Claude app and the terminal use.
if [ "$profile" = existing ] && [ "$provider" = claude ]; then
  share_retain "${CLAUDE_CONFIG_DIR:-$HOME/.claude}" || true
fi
# Its own process group and the job in its environment, which its commands inherit, let a stop
# end everything the CLI started (`studio_kill`).
AGENT_STUDIO_JOB=$job setsid "$binary" "$@" <&0 &
child=$!
cleanup() {
  studio_kill "$job" "$child" || true
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
