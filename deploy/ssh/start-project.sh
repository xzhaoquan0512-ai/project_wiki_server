#!/usr/bin/env bash
set -euo pipefail
service_root="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/../.." && pwd)"
node_bin="${PROJECT_WIKI_NODE:-node}"
config="${PROJECT_WIKI_CONFIG:-$service_root/config/projects.json}"
state="${PROJECT_WIKI_STATE:-}"
# Non-interactive SSH does not load profiles, so the session directory is stated here explicitly.
if [ -n "$state" ]; then
  export PROJECT_WIKI_STATE="$state"
fi
exec "$node_bin" "$service_root/bin/project-wiki-server.mjs" project "$config"
