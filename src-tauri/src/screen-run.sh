# Screens (screens/run.rs): runs one action of a screen inside this distribution. What it runs
# arrives on stdin as lines of base64 or digits, never on a command line: the folder, the script,
# the time limit (0 for none), then each parameter's variable and value. The script runs in a
# process group of its own, in the folder, with stdin closed, and ends when it is done, when its
# time is up or when Agent Studio stops it (wsl-cancel.sh, through the marker of this job).
set -u
namespace=$1
job=$2
fail() {
  printf '%s\n' "$1" >&2
  exit 125
}
unreadable='Agent Studio could not read this action.'
decode() { printf '%s' "$1" | base64 -d 2>/dev/null; }
IFS= read -r folder64 || fail "$unreadable"
IFS= read -r script64 || fail "$unreadable"
IFS= read -r limit || fail "$unreadable"
IFS= read -r count || fail "$unreadable"
case $limit in '' | *[!0-9]*) fail "$unreadable" ;; esac
case $count in '' | *[!0-9]*) fail "$unreadable" ;; esac
folder=$(decode "$folder64"; printf x)
folder=${folder%x}
while [ "$count" -gt 0 ]; do
  IFS= read -r name || fail "$unreadable"
  IFS= read -r value64 || fail "$unreadable"
  case $name in PARAM_?*) ;; *) fail "$unreadable" ;; esac
  case ${name#PARAM_} in *[!A-Z0-9_]*) fail "$unreadable" ;; esac
  value=$(decode "$value64"; printf x)
  export "$name=${value%x}"
  count=$((count - 1))
done
umask 077
root="$HOME/.local/share/$namespace"
mkdir -p "$root/runs" || fail 'Agent Studio could not prepare this action.'
script=$(mktemp "${TMPDIR:-/tmp}/agent-studio-screen.XXXXXXXX") || fail 'Agent Studio could not prepare this action.'
decode "$script64" > "$script"
marker="$root/runs/$job"
if ! cd -- "$folder" 2>/dev/null; then
  rm -f -- "$script"
  printf 'Agent Studio did not run this action: its folder is unavailable.\n' >&2
  exit 126
fi
# A login shell, as an agent runs its commands, which returns to the folder after its profile.
setsid bash -l -c 'cd -- "$1" 2>/dev/null || exit 126; exec bash -- "$2"' agent-studio "$folder" "$script" < /dev/null &
child=$!
watchdog=
cleanup() {
  kill -TERM -- "-$child" 2> /dev/null || true
  kill -KILL -- "-$child" 2> /dev/null || true
  if [ -n "$watchdog" ]; then kill -KILL -- "-$watchdog" 2> /dev/null || true; fi
  rm -f -- "$marker" "$marker.cancel" "$script"
}
trap cleanup EXIT
trap 'exit 130' HUP INT TERM
state="$(cat "/proc/$child/stat" 2> /dev/null || true)"
state="${state##*) }"
start="$(printf '%s' "$state" | awk '{print $20}')"
printf '%s %s\n' "$child" "$start" > "$marker"
if [ -f "$marker.cancel" ]; then exit 130; fi
# Should Windows lose this run, its time limit, when it declares one, still ends it here.
if [ "$limit" != 0 ]; then
  setsid sh -c 'sleep "$1"; kill -TERM -- "-$2" 2> /dev/null; sleep 3; kill -KILL -- "-$2" 2> /dev/null' agent-studio "$limit" "$child" < /dev/null > /dev/null 2>&1 &
  watchdog=$!
fi
wait "$child"
