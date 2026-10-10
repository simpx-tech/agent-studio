# Run in console (console.rs): keeps one run's launcher and code in a private temporary folder
# of this distribution and prints that folder. The launcher arrives as an argument and the
# code on stdin, whole, so neither is part of a command line that a shell interprets.
set -eu
umask 077
directory=$(mktemp -d "${TMPDIR:-/tmp}/agent-studio-console.XXXXXXXX")
printf '%s' "$1" > "$directory/launch"
cat > "$directory/code"
printf '%s' "$directory"
