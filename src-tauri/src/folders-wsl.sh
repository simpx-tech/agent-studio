set -eu
folder=${1:-$HOME}
cd -- "$folder"
printf '%s\0' "$PWD"
shopt -s nullglob dotglob
count=0
for child in *; do
  [ -d "$child" ] || continue
  printf '%s\0' "$child"
  count=$((count + 1))
  [ "$count" -lt 1001 ] || break
done
