# Run in console (console.rs): keeps one run's launcher and code in a private temporary folder
# of this distribution and prints that folder. The launcher arrives as an argument and the
# code on stdin, bounded, so neither is part of a command line that a shell interprets.
set -eu
umask 077
directory=$(mktemp -d "${TMPDIR:-/tmp}/agent-studio-console.XXXXXXXX")
printf '%s' "$1" > "$directory/launch"
head -c 65537 > "$directory/code"
printf '%s' "$directory"
