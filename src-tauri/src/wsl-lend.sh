# Writes the login a Windows account lends to its separate profile in this distribution.
# Arguments are data; the credentials arrive on stdin and never on a command line.
set -eu
namespace=$1
profile=$2
case "$namespace" in '' | *[!A-Za-z0-9._-]*)
  printf '%s\n' 'Invalid namespace' >&2
  exit 1
  ;;
esac
# Host-generated canonical UUID only; never interpret a caller's path.
if ! printf '%s\n' "$profile" | LC_ALL=C grep -Eq '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'; then
  printf '%s\n' 'Invalid profile id' >&2
  exit 1
fi
umask 077
config="$HOME/.local/share/$namespace/profiles/claude/$profile"
mkdir -p "$config"
part="$config/.credentials.json.lent.$$"
trap 'rm -f -- "$part"' EXIT
head -c 65536 > "$part"
# A rename replaces the file whole, so the CLI never reads a partial login.
mv -f -- "$part" "$config/.credentials.json"
trap - EXIT
