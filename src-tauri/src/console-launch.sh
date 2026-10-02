# Run in console (console.rs): runs the code of a reply's fenced block in the user's own shell,
# in the chat's folder, and leaves that shell open afterwards. The code is data: it is read
# from a file and handed to the shell as one argument, never written into a command line.
# $1: the file holding the code. $2: the folder to run it in, empty to stay where this started.
# $3: a temporary folder to remove, which a WSL run keeps this script and the code in.
file=$1
folder=${2-}
code=$(cat -- "$file") || code=
rm -f -- "$file"
if [ -n "${3-}" ]; then rm -rf -- "$3"; fi
# The user's own shell when it reads POSIX commands as a console would, else bash, else sh.
shell=${SHELL-}
case ${shell##*/} in
  bash | zsh) ;;
  *) shell=$(command -v bash 2>/dev/null) || shell=/bin/sh ;;
esac
# Code never runs anywhere but in its chat's folder.
if [ -n "$folder" ] && ! cd -- "$folder"; then
  printf 'Agent Studio did not run the code: the folder of this chat is unavailable.\n\n'
  exec "$shell" -l -i
fi
if [ -z "$code" ]; then
  printf 'Agent Studio could not read the code to run.\n\n'
  exec "$shell" -l -i
fi
# What runs, as far as its first lines, then a blank line before its output.
lines=$(($(printf '%s\n' "$code" | wc -l)))
printf '\033[2m%s\033[0m\n' "$(printf '%s\n' "$code" | head -n 12)"
if [ "$lines" -gt 12 ]; then printf '\033[2m... %s more lines\033[0m\n' "$((lines - 12))"; fi
printf '\n'
# The code runs in an interactive login shell, which reads the user's settings as their console
# does, so their aliases, functions and PATH apply. Those settings may change folder, so the
# shell returns to the chat's folder before the code. When the code ends, however it ends, the
# shell starts again for the user: `exit` and `set -e` end the code, not the window. The folder
# the code changed to and the variables it exported carry over.
run='studio_shell=$0
studio_code=$1
studio_folder=$2
set --
trap '\''trap - EXIT; exec "$studio_shell" -l -i'\'' EXIT
if [ -n "$studio_folder" ] && ! cd -- "$studio_folder"; then
  printf "Agent Studio did not run the code: the folder of this chat is unavailable.\n\n"
  exit 1
fi
eval "$studio_code"'
exec "$shell" -l -i -c "$run" "$shell" "$code" "$folder"
