# Lists the processes of Agent Studio's launches in this distribution (reservations/programs.rs):
# every process carrying one of the asked launches' jobs in its environment (AGENT_STUDIO_JOB,
# which a launch gives its CLI and its commands inherit), and each launch's CLI from its marker.
# Reads /proc twice, a second apart, so the app can tell each process's share of the CPU.
# Prints `meta <ticks a second> <cores> <page bytes> <elapsed ns>`, `cli <job> <pid>` for each
# launch still running, `p <job> <pid> <parent> <start> <ticks before> <ticks after> <rss
# pages> <name>` for each process, ticks before being -1 for one that began between readings,
# and after each `c <job> <pid> <start> <ticks before> <ticks after>` with the ticks of its
# children that ended and it waited for, which tell the work of short processes.
set -u
namespace=$1
shift
declare -A asked=() before=() children=()
for job in "$@"; do
  asked[$job]=1
  if read -r pid _ 2>/dev/null < "$HOME/.local/share/$namespace/runs/$job"; then
    printf 'cli %s %s\n' "$job" "$pid"
  fi
done
sample() {
  local environ pid entry job stat rest
  local -a fields
  for environ in /proc/[0-9]*/environ; do
    pid=${environ#/proc/}
    pid=${pid%/environ}
    job=''
    {
      while IFS= read -r -d '' entry; do
        case $entry in
          AGENT_STUDIO_JOB=*)
            job=${entry#AGENT_STUDIO_JOB=}
            break
            ;;
        esac
      done
    } 2>/dev/null < "$environ" || continue
    [ -n "$job" ] && [ -n "${asked[$job]-}" ] || continue
    { read -r stat || [ -n "$stat" ]; } 2>/dev/null < "/proc/$pid/stat" || continue
    # The name may hold spaces and parentheses: fields resume after its last ')'.
    rest=${stat##*) }
    read -r -a fields <<< "$rest"
    case ${fields[0]} in Z | X) continue ;; esac
    name=${stat#*(}
    name=${name%)*}
    if [ "$1" = first ]; then
      before[$pid]="${fields[19]} $((fields[11] + fields[12]))"
      children[$pid]="${fields[19]} $((fields[13] + fields[14]))"
    else
      local earlier=-1 prior=${before[$pid]-} waited=-1 reaped=${children[$pid]-}
      if [ -n "$prior" ] && [ "${prior%% *}" = "${fields[19]}" ]; then earlier=${prior#* }; fi
      if [ -n "$reaped" ] && [ "${reaped%% *}" = "${fields[19]}" ]; then waited=${reaped#* }; fi
      printf 'p %s %s %s %s %s %s %s %s\n' "$job" "$pid" "${fields[1]}" "${fields[19]}" \
        "$earlier" "$((fields[11] + fields[12]))" "${fields[21]}" "$name"
      printf 'c %s %s %s %s %s\n' "$job" "$pid" "${fields[19]}" "$waited" \
        "$((fields[13] + fields[14]))"
    fi
  done
}
started=$(date +%s%N)
sample first
sleep 1
ended=$(date +%s%N)
printf 'meta %s %s %s %s\n' "$(getconf CLK_TCK 2>/dev/null || echo 100)" \
  "$(nproc 2>/dev/null || echo 1)" "$(getconf PAGESIZE 2>/dev/null || echo 4096)" \
  "$((ended - started))"
sample second
