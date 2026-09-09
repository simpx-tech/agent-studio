umask 077
mkdir -p "$HOME/.local/share/$1/runs"
file="$HOME/.local/share/$1/runs/$2"
touch "$file.cancel"
if [ -f "$file" ]; then
  read -r pid expected < "$file"
  case "$pid:$expected" in *[!0-9:]*|:*|*:) exit 1;; esac
  state="$(cat "/proc/$pid/stat" 2>/dev/null || true)"
  state="${state##*) }"
  actual="$(printf '%s' "$state" | awk '{print $20}')"
  # Never signal a reused PID left in a stale marker after a crash.
  if [ "$actual" = "$expected" ]; then
    kill -TERM -- "-$pid" 2>/dev/null || true
    kill -KILL -- "-$pid" 2>/dev/null || true
  fi
  rm -f -- "$file"
fi
