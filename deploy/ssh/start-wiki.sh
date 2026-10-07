#!/usr/bin/env bash
set -euo pipefail
service_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
node_bin="${PROJECT_WIKI_NODE:-node}"
vault="${PROJECT_WIKI_VAULT:-$service_root/data/vault}"
soffice="${PROJECT_WIKI_LIBREOFFICE:-}"
# Non-interactive SSH does not load profiles, so optional runtime paths are stated here explicitly.
if [ -n "$soffice" ]; then
  export PROJECT_WIKI_LIBREOFFICE="$soffice"
fi
exec "$node_bin" "$service_root/bin/project-wiki-server.mjs" wiki "$vault"
