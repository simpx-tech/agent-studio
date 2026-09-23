#!/usr/bin/env bash
# Installs or updates the automatic release updater on the production VPS. Copy the repository's
# scripts directory and src-tauri/tauri.conf.json to the server, then run as root:
#
#   bash install.sh <scripts directory> <tauri.conf.json>
#
# The relay service, its data, pairing configuration, releases and downloads stay unchanged.
# See docs/DEPLOYMENT.md.
set -euo pipefail
source="$1"
config="$2"
root=/opt/agent-studio
node="$root/runtimes/node-v24.20.0-linux-x64/bin/node"
updater="$root/updater"
test -x "$node"
test -f "$source/release.ts"
test -f "$source/vps/update.ts"
test -L "$root/current"

# Builds run as this account, which cannot read the relay's private data.
if ! id agent-studio-build >/dev/null 2>&1; then
  useradd --system --user-group --home-dir /var/cache/agent-studio-build --no-create-home \
    --shell /usr/sbin/nologin agent-studio-build
fi
install -d -o agent-studio-build -g agent-studio-build -m 0700 /var/cache/agent-studio-build
install -d -m 0700 /var/lib/agent-studio-update
install -d -m 0755 "$updater" "$updater/vps"
install -m 0644 "$source/release.ts" "$updater/release.ts"
install -m 0644 "$source/vps/update.ts" "$updater/vps/update.ts"
printf '{ "type": "module" }\n' > "$updater/package.json"
chmod 0644 "$updater/package.json"
for unit in agent-studio-update.service agent-studio-update.timer; do
  tr -d '\r' < "$source/vps/$unit" > "/etc/systemd/system/$unit"
  chmod 0644 "/etc/systemd/system/$unit"
done
systemd-analyze verify /etc/systemd/system/agent-studio-update.service \
  /etc/systemd/system/agent-studio-update.timer

# Seed the key installed desktop apps trust; later releases rotate it the same way.
"$node" "$updater/vps/update.ts" trust "$config"
systemctl daemon-reload
systemctl enable --now agent-studio-update.timer
systemctl list-timers agent-studio-update.timer --no-pager
