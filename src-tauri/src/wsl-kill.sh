# Ends what one launch started, as a stop on Windows ends a CLI's whole process tree: the CLI,
# every process descended from it, and every process still carrying the launch's job in its
# environment (AGENT_STUDIO_JOB, which the launch gives the CLI and its commands inherit). The
# job finds what left the tree: Claude Code runs each shell command in a session of its own, and a
# command the CLI left running is adopted by init once the CLI ends. Everything gets TERM, a
# short grace to exit, then KILL, together with whatever started meanwhile.
studio_pids() {
  local job=$1 cli=$2 stat pid rest entry changed
  local -A parent=() chosen=()
  local -a all=()
  for stat in /proc/[0-9]*/stat; do
    pid=${stat#/proc/}
    pid=${pid%/stat}
    { read -r rest || [ -n "$rest" ]; } 2>/dev/null < "$stat" || continue
    # The command name may hold spaces and parentheses: fields resume after its last ')'.
    rest=${rest##*) }
    rest=${rest#* }
    parent[$pid]=${rest%% *}
    all+=("$pid")
  done
  if [ -n "$cli" ] && [ -n "${parent[$cli]-}" ]; then chosen[$cli]=1; fi
  changed=1
  while [ -n "$changed" ]; do
    changed=''
    for pid in "${all[@]}"; do
      if [ -z "${chosen[$pid]-}" ] && [ -n "${chosen[${parent[$pid]}]-}" ]; then
        chosen[$pid]=1
        changed=1
      fi
    done
  done
  for pid in "${all[@]}"; do
    [ -z "${chosen[$pid]-}" ] || continue
    {
      while IFS= read -r -d '' entry; do
        if [ "$entry" = "AGENT_STUDIO_JOB=$job" ]; then
          chosen[$pid]=1
          break
        fi
      done
    } 2>/dev/null < "/proc/$pid/environ" || true
  done
  unset "chosen[$$]" "chosen[$BASHPID]"
  if [ "${#chosen[@]}" -gt 0 ]; then printf '%s\n' "${!chosen[@]}"; fi
}
# Whether a process still runs: an exited one waiting for its parent to collect it does not.
studio_running() {
  local rest
  { read -r rest || [ -n "$rest" ]; } 2>/dev/null < "/proc/$1/stat" || return 1
  rest=${rest##*) }
  case $rest in Z*|X*) return 1 ;; esac
}
studio_kill() {
  local job=$1 cli=$2 pids pid round=0 left
  pids=$(studio_pids "$job" "$cli")
  # shellcheck disable=SC2086
  if [ -n "$pids" ]; then kill -TERM $pids 2>/dev/null || true; fi
  if [ -n "$cli" ]; then kill -TERM -- "-$cli" 2>/dev/null || true; fi
  while [ "$round" -lt 30 ]; do
    left=''
    for pid in $pids; do
      if studio_running "$pid"; then left=1; break; fi
    done
    [ -n "$left" ] || break
    sleep 0.1
    round=$((round + 1))
  done
  pids=$(studio_pids "$job" "$cli")
  # shellcheck disable=SC2086
  if [ -n "$pids" ]; then kill -KILL $pids 2>/dev/null || true; fi
  if [ -n "$cli" ]; then kill -KILL -- "-$cli" 2>/dev/null || true; fi
  return 0
}
