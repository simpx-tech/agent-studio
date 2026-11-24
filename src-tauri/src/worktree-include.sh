set -eu
# Copies the files a repository's .worktreeinclude names into new worktrees, as Claude Code does
# for its own: the repository's top folder comes first, then the worktrees' top folders, and the
# files' paths, relative to the top, arrive NUL-separated on stdin. Only regular files are copied;
# links and paths that leave the repository are skipped.
top=$1
shift
cd -- "$top"
while IFS= read -r -d '' file; do
  case $file in
    /* | .. | ../* | */.. | */../*) continue ;;
  esac
  if [ ! -f "$file" ] || [ -L "$file" ]; then continue; fi
  for root in "$@"; do
    mkdir -p -- "$root/$(dirname -- "$file")"
    cp -p -- "$file" "$root/$file"
  done
done
