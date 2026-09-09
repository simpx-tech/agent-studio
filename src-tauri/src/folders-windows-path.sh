set -eu
# Fixed script; the selected Linux path is a positional argument, never shell source.
cd -- "$1" >/dev/null 2>&1
wslpath -w "$PWD"
