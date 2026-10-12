#!/usr/bin/env bash
# Sets up Agent Studio on a new Debian server the way the production VPS runs it: the relay and
# web viewer behind HTTPS (Caddy), the automatic release updater, and the server host, the desktop
# app running chats here for the workspace's devices. Copy the repository's scripts directory and
# src-tauri/tauri.conf.json to the server, keeping their places, then run as root:
#
#   bash scripts/vps/setup.sh [--domain <name>] [--host-user <user>] [--no-sudo] [--name <name>]
#                             [--no-host]
#
#   --domain     The HTTPS address; its DNS must point here, with ports 80 and 443 open. Without
#                it, studio.<public IPv4 address>.sslip.io, which needs no DNS record.
#   --host-user  The user that runs the host and its agents, created when missing (claude).
#   --no-sudo    That user does not get passwordless sudo, which production's has.
#   --name       The host's computer name the first time it starts (VPS).
#   --no-host    Set up the relay alone.
#
# The updater then installs the latest release, built and tested from source after checking its
# signature, and the host, and keeps both current. Running this again keeps what is already set
# up. See docs/DEPLOYMENT.md.
set -euo pipefail

domain=''
host=on
host_user=claude
sudo_rule=on
name=VPS
while [ $# -gt 0 ]; do
  case "$1" in
    --domain | --host-user | --name)
      if [ $# -lt 2 ] || [ -z "$2" ]; then
        echo "$1 needs a value." >&2
        exit 2
      fi
      case "$1" in
        --domain) domain="${2,,}" ;;
        --host-user) host_user="$2" ;;
        --name) name="$2" ;;
      esac
      shift 2
      ;;
    --no-sudo) sudo_rule=off && shift ;;
    --no-host) host=off && shift ;;
    *)
      echo "Unknown option: $1" >&2
      exit 2
      ;;
  esac
done

label='[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?'
if [ -n "$domain" ] && [[ ! "$domain" =~ ^($label\.)+$label$ ]]; then
  echo "$domain is not a domain name." >&2
  exit 2
fi
if [[ ! "$host_user" =~ ^[a-z_][a-z0-9_-]*$ ]] || [ "$host_user" = root ]; then
  echo "$host_user cannot run the host: use a lowercase user name other than root." >&2
  exit 2
fi
if [[ ! "$name" =~ ^[A-Za-z0-9][A-Za-z0-9\ ._-]*$ ]]; then
  echo 'The name may hold letters, digits, spaces, dots, dashes and underscores.' >&2
  exit 2
fi
if [ "$(id -u)" != 0 ]; then
  echo 'Run setup.sh as root.' >&2
  exit 1
fi
if [ "$(uname -m)" != x86_64 ] || [ ! -d /run/systemd/system ] || ! command -v apt-get >/dev/null; then
  echo 'setup.sh needs an x86-64 Debian (or Debian-based) server running systemd.' >&2
  exit 1
fi
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
scripts="$(dirname "$here")"
config="$(dirname "$scripts")/src-tauri/tauri.conf.json"
for file in "$scripts/release.ts" "$here/update.ts" "$here/install.sh" "$here/agent-studio.service" "$config"; do
  if [ ! -f "$file" ]; then
    echo "$file is missing: copy the repository's scripts directory and src-tauri/tauri.conf.json." >&2
    exit 1
  fi
done
# The host's service hands the app its pairing key as a systemd credential, which some
# containers cannot pass on.
if [ "$host" = on ]; then
  probe="$(mktemp)"
  echo ok >"$probe"
  answer="$(systemd-run --quiet --wait --pipe --collect --property="LoadCredential=probe:$probe" \
    /bin/sh -c 'cat "$CREDENTIALS_DIRECTORY/probe"' 2>/dev/null || true)"
  rm -f "$probe"
  if [ "$answer" != ok ]; then
    echo "This server's systemd cannot pass credentials to services, which the host needs for its pairing key. Use --no-host to set up the relay alone." >&2
    exit 1
  fi
fi

# An address of this server that the internet reaches, for sslip.io.
public() {
  local a b
  [[ "$1" =~ ^[0-9]{1,3}(\.[0-9]{1,3}){3}$ ]] || return 1
  IFS=. read -r a b _ <<<"$1"
  case "$a" in
    0 | 10 | 127) return 1 ;;
    100) [ "$b" -lt 64 ] || [ "$b" -gt 127 ] ;;
    169) [ "$b" != 254 ] ;;
    172) [ "$b" -lt 16 ] || [ "$b" -gt 31 ] ;;
    192) [ "$b" != 168 ] ;;
    *) [ "$a" -lt 224 ] ;;
  esac
}
if [ -z "$domain" ]; then
  for address in $(hostname -I 2>/dev/null); do
    if public "$address"; then
      domain="studio.$address.sslip.io"
      break
    fi
  done
  if [ -z "$domain" ]; then
    echo 'This server has no public IPv4 address of its own: pass --domain with a name pointing here.' >&2
    exit 1
  fi
fi

say() { printf '\n== %s\n' "$*"; }
root=/opt/agent-studio
data=/var/lib/agent-studio
node_version=24.20.0
node_sha256=2f2c0da162318f0de47665410c7c8c2ed3d36c8f3105de4bbc61176c70a7cbf2
runtime="$root/runtimes/node-v$node_version-linux-x64"
node="$runtime/bin/node"
port=4317

missing=()
command -v curl >/dev/null || missing+=(curl)
command -v xz >/dev/null || missing+=(xz-utils)
[ -f /etc/ssl/certs/ca-certificates.crt ] || missing+=(ca-certificates)
new_caddy=''
if ! command -v caddy >/dev/null; then
  missing+=(caddy)
  new_caddy=1
fi
if [ "${#missing[@]}" -gt 0 ]; then
  say "Installing ${missing[*]}"
  DEBIAN_FRONTEND=noninteractive apt-get update -q
  DEBIAN_FRONTEND=noninteractive apt-get install -y -q --no-install-recommends "${missing[@]}"
fi

# The runtime both services and the updater run, checked against the official release's digest.
if [ ! -x "$node" ]; then
  say "Installing Node.js $node_version"
  install -d -m 0755 "$root" "$root/runtimes"
  staging="$(mktemp -d "$root/runtimes/.node-XXXXXX")"
  trap 'rm -rf "$staging"' EXIT
  curl -fsSL --retry 2 -o "$staging/node.tar.xz" \
    "https://nodejs.org/dist/v$node_version/node-v$node_version-linux-x64.tar.xz"
  echo "$node_sha256  $staging/node.tar.xz" | sha256sum --check --quiet -
  tar -xJf "$staging/node.tar.xz" -C "$staging" --no-same-owner
  rm -rf "$runtime"
  mv "$staging/node-v$node_version-linux-x64" "$runtime"
  rm -rf "$staging"
  trap - EXIT
fi

say 'Preparing the relay'
if ! id agent-studio >/dev/null 2>&1; then
  useradd --system --user-group --home-dir "$data" --no-create-home --shell /usr/sbin/nologin \
    agent-studio
fi
install -d -o agent-studio -g agent-studio -m 0700 "$data"
install -d -m 0755 "$root" "$root/releases" "$root/downloads"
install -d -m 0700 /etc/agent-studio
# The pairing key devices sign in with; it never appears in this script's output.
if [ ! -e /etc/agent-studio/relay.env ]; then
  (
    umask 077
    printf 'AGENT_STUDIO_RELAY_TOKEN=%s\n' "$(head -c 32 /dev/urandom | od -An -vtx1 | tr -d ' \n')" \
      >/etc/agent-studio/.relay.env.new
  )
  mv -n /etc/agent-studio/.relay.env.new /etc/agent-studio/relay.env
fi
unit=/etc/systemd/system/agent-studio.service
if [ ! -e "$unit" ]; then
  tr -d '\r' <"$here/agent-studio.service" >"$unit"
  chmod 0644 "$unit"
  install -d -m 0755 "$unit.d"
  # Node otherwise stops its heap at a few gigabytes, whatever the machine has.
  memory=$(($(awk '/^MemTotal:/ { print $2 }' /proc/meminfo) / 1024))
  printf '[Service]\nEnvironment=NODE_OPTIONS=--max-old-space-size=%s\n' "$memory" >"$unit.d/memory.conf"
  chmod 0644 "$unit.d/memory.conf"
  systemctl daemon-reload
fi
systemctl enable --quiet agent-studio

say "Serving https://$domain"
caddyfile=/etc/caddy/Caddyfile
site=/etc/caddy/sites-enabled/agent-studio.caddy
import='import /etc/caddy/sites-enabled/*.caddy'
install -d -m 0755 /etc/caddy/sites-enabled
next="$(mktemp)"
previous="$(mktemp)"
printf '%s {\n    encode zstd gzip\n    reverse_proxy 127.0.0.1:%s {\n        header_up Host {http.request.host}\n    }\n}\n' \
  "$domain" "$port" >"$next"
changed=''
had_site=''
if ! cmp -s "$next" "$site"; then
  [ -f "$site" ] && had_site=1 && cp -p "$site" "$previous"
  install -m 0644 "$next" "$site"
  changed=1
fi
rm -f "$next"
backup=''
if [ -n "$new_caddy" ] || [ ! -f "$caddyfile" ]; then
  # The package's own Caddyfile only serves its welcome page.
  [ -f "$caddyfile" ] && backup="$caddyfile.pre-agent-studio" && cp -p "$caddyfile" "$backup"
  printf '%s\n' "$import" >"$caddyfile"
  changed=1
elif ! grep -qxF "$import" "$caddyfile"; then
  backup="$caddyfile.pre-agent-studio-$(date -u +%Y%m%dT%H%M%SZ)"
  cp -p "$caddyfile" "$backup"
  printf '\n%s\n' "$import" >>"$caddyfile"
  changed=1
fi
if ! problem="$(caddy validate --config "$caddyfile" --adapter caddyfile 2>&1)"; then
  printf '%s\n' "$problem" | tail -5 >&2
  [ -n "$backup" ] && cp -p "$backup" "$caddyfile"
  if [ -n "$had_site" ]; then cp -p "$previous" "$site"; elif [ -n "$changed" ]; then rm -f "$site"; fi
  rm -f "$previous"
  echo 'Caddy refused its configuration; its earlier one was put back.' >&2
  exit 1
fi
rm -f "$previous"
systemctl enable --quiet caddy
if [ -n "$changed" ] || ! systemctl is-active --quiet caddy; then systemctl reload-or-restart caddy; fi

say 'Installing the updater'
# Its timer may start the first run as soon as it is enabled.
since="@$(date +%s)"
AGENT_STUDIO_HOST="$host" AGENT_STUDIO_HOST_USER="$host_user" AGENT_STUDIO_HOST_SUDO="$sudo_rule" \
  AGENT_STUDIO_HOST_NAME="$name" bash "$here/install.sh" "$scripts" "$config" >/dev/null

state() {
  "$node" -e '
    const state = JSON.parse(require("node:fs").readFileSync(process.argv[1], "utf8"));
    const value = process.argv[2].split(".").reduce((item, key) => item?.[key], state);
    process.stdout.write(String(value ?? ""));
  ' /var/lib/agent-studio-update/state.json "$1" 2>/dev/null || true
}
# Says what the updater could not finish, and how that goes on.
unfinished() {
  local phase error
  phase="$(state "$1.phase")"
  error="$(state "$1.error")"
  echo "$2${error:+: $error}" >&2
  case "$phase" in
    failed) echo 'Running setup.sh again tries it again.' >&2 ;;
    unsupported) ;;
    *) echo 'The updater goes on by itself; follow it with journalctl -u agent-studio-update.' >&2 ;;
  esac
  exit 1
}
for part in release host; do
  if [ "$(state "$part.phase")" = failed ]; then "$node" "$root/updater/vps/update.ts" retry; fi
done

# The updater installs the latest release, then the host, as it later installs every new one.
say 'Installing the latest release (this takes a while)'
journalctl --unit agent-studio-update.service --follow --output cat --since "$since" &
follower=$!
systemctl start agent-studio-update.service || true
sleep 2
kill "$follower" 2>/dev/null || true
wait "$follower" 2>/dev/null || true
[ "$(state release.phase)" = active ] || unfinished release 'The release is not installed'
[ "$host" = off ] || [ "$(state host.phase)" = active ] || unfinished host 'The host is not running'

if [ "$host" = on ]; then
  say 'Waiting for the host to join the relay'
  # The host is in the workspace once its computer reaches the relay's copy of it.
  if ! "$node" - "$name" "$port" <<'JS'; then
const [name, port] = process.argv.slice(2);
const text = require('node:fs').readFileSync('/etc/agent-studio/relay.env', 'utf8');
const key = /^\s*AGENT_STUDIO_RELAY_TOKEN\s*=\s*["']?([^"'\s]+)/m.exec(text)?.[1];
const deadline = Date.now() + 3 * 60 * 1000;
const headers = { Authorization: `Bearer ${key}`, 'X-Environment-Id': crypto.randomUUID() };
(async () => {
  while (Date.now() < deadline) {
    try {
      const response = await fetch(`http://127.0.0.1:${port}/v1/state/meta`, { headers });
      const { meta } = response.ok ? await response.json() : {};
      if (meta?.fleet?.computers?.some((computer) => computer.name === name)) return;
    } catch {}
    await new Promise((done) => setTimeout(done, 3000));
  }
  process.exitCode = 1;
})();
JS
    echo "The host runs but has not joined the relay; see journalctl -u agent-studio-host." >&2
    exit 1
  fi
fi

reachable=''
for attempt in $(seq 1 12); do
  if curl -fsS -o /dev/null --max-time 10 "https://$domain/manifest.webmanifest" 2>/dev/null; then
    reachable=1
    break
  fi
  sleep 5
done

say 'Agent Studio is set up'
echo "Address: https://$domain"
[ -n "$reachable" ] ||
  echo "Not answering over HTTPS yet: its DNS must point here, with ports 80 and 443 open. Caddy keeps trying."
echo "Pairing key: sed -n 's/^AGENT_STUDIO_RELAY_TOKEN=//p' /etc/agent-studio/relay.env"
if [ "$host" = on ]; then
  echo "Host: $name, run by $host_user$([ "$sudo_rule" = on ] && echo ', with passwordless sudo')"
fi
