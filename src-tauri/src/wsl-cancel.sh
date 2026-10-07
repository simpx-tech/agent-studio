umask 077
case $2 in ''|*[!0-9a-f-]*) exit 1 ;; esac
mkdir -p "$HOME/.local/share/$1/runs"
file="$HOME/.local/share/$1/runs/$2"
touch "$file.cancel"
cli=''
if [ -f "$file" ]; then
  read -r pid expected < "$file"
  case "$pid:$expected" in *[!0-9:]*|:*|*:) exit 1;; esac
  state="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
  state="${state##*) }"
  actual="$(printf '%s' "$state" | awk '{print $20}')"
  # Never signal a reused PID left in a stale marker after a crash.
  if [ "$actual" = "$expected" ]; then
    cli=$pid
  fi
  rm -f -- "$file"
fi
# What the launch's job still runs ends even when its CLI already has.
studio_kill "$2" "$cli"
