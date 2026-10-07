#!/usr/bin/env bash
set -euo pipefail
service_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
node_bin="${PROJECT_WIKI_NODE:-node}"
vault="${PROJECT_WIKI_VAULT:-$service_root/data/vault}"
host="${PROJECT_WIKI_PANEL_HOST:-127.0.0.1}"
port="${PROJECT_WIKI_PANEL_PORT:-8790}"
# Non-interactive SSH does not load profiles, so the optional runtime paths are stated here explicitly.
args=(panel "$vault" "--host=$host" "--port=$port")
# Reaching the panel beyond loopback needs a deliberate opt-in: it serves vault contents without
# authentication. Keep this unset and use an SSH tunnel instead of exposing the port.
if [ "${PROJECT_WIKI_PANEL_ALLOW_REMOTE:-}" = "1" ]; then
  args+=(--allow-remote)
fi
exec "$node_bin" "$service_root/bin/project-wiki-server.mjs" "${args[@]}"
