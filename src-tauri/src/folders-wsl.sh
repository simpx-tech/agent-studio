set -eu
folder=${1:-$HOME}
cd -- "$folder"
printf '%s\0' "$PWD"
printf '@home:%s\0' "$HOME"
printf '@root:/\0'
for place in Desktop Documents Downloads Projects Developer src; do
  if [ -d "$HOME/$place" ]; then
    printf '@folder:%s\0' "$HOME/$place"
  fi
done
for mount in /mnt/*; do
  case ${mount##*/} in
    [a-z]) if [ -d "$mount" ]; then printf '@mount:%s\0' "$mount"; fi ;;
  esac
done
shopt -s nullglob dotglob
count=0
for child in *; do
  [ -d "$child" ] || continue
  flags=
  case $child in
    .*) flags=h ;;
  esac
  if [ -e "$child/.git" ]; then
    flags="${flags}g"
  fi
  printf '%s:%s\0' "$flags" "$child"
  count=$((count + 1))
  [ "$count" -lt 1001 ] || break
done
