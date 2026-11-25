# Ends processes a launch of Agent Studio left running in this distribution (reservations/
# programs.rs), each given as `<pid>:<start>` so that a process that took another's id is never
# touched: TERM, up to ten seconds' grace, then KILL. Prints `<pid> gone|ended|failed` for each.
set -u
declare -A wanted=()
for entry in "$@"; do
  wanted[${entry%%:*}]=${entry#*:}
done
# Whether a process still runs as the one that began at the given start.
running() {
  local stat rest
  local -a fields
  { read -r stat || [ -n "$stat" ]; } 2>/dev/null < "/proc/$1/stat" || return 1
  rest=${stat##*) }
  read -r -a fields <<< "$rest"
  case ${fields[0]} in Z | X) return 1 ;; esac
  [ "${fields[19]}" = "$2" ]
}
declare -A asked=()
for pid in "${!wanted[@]}"; do
  if running "$pid" "${wanted[$pid]}"; then
    asked[$pid]=1
    kill -TERM "$pid" 2>/dev/null || true
  fi
done
round=0
while [ "$round" -lt 50 ]; do
  left=''
  for pid in "${!asked[@]}"; do
    if running "$pid" "${wanted[$pid]}"; then left=1; fi
  done
  [ -n "$left" ] || break
  sleep 0.2
  round=$((round + 1))
done
for pid in "${!asked[@]}"; do
  if running "$pid" "${wanted[$pid]}"; then kill -KILL "$pid" 2>/dev/null || true; fi
done
[ "${#asked[@]}" -eq 0 ] || sleep 0.2
for pid in "${!wanted[@]}"; do
  if [ -z "${asked[$pid]-}" ]; then
    printf '%s gone\n' "$pid"
  elif running "$pid" "${wanted[$pid]}"; then
    printf '%s failed\n' "$pid"
  else
    printf '%s ended\n' "$pid"
  fi
done
