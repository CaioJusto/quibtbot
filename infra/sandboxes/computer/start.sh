#!/usr/bin/env bash
set -uo pipefail
export HOME="${HOME:-/home/quibt}"
AGENT_HOME="$HOME"
mkdir -p "$AGENT_HOME" "$AGENT_HOME/.local/bin" "$AGENT_HOME/.config" /tmp/quibt /tmp/.X11-unix /workspace
chmod 1777 /tmp/.X11-unix
if [[ ! -d /workspace ]]; then
  ln -sfn "$AGENT_HOME" /workspace
fi
export PATH="$AGENT_HOME/.local/bin:/usr/local/bin:$PATH"
export NPM_CONFIG_PREFIX="$AGENT_HOME/.local"
export PIP_USER=1
cd "$AGENT_HOME"
# Shared workspace computer. Sessions are started by quibt-session.
while true; do
  sleep 3600
done
