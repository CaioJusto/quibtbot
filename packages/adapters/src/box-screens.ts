/** Per-bot graphical sessions on one Box VM — Quibt Bot's "own screen, shared computer". */

export function boxSessionPorts(display: number): { display: number; vnc: number; novnc: number } {
  if (display < 1 || display > 32) throw new Error(`display must be 1..32, got ${display}`);
  return {
    display,
    vnc: 5899 + display,
    novnc: 6079 + display,
  };
}

export function parseHostedScreenUrl(stdout: string): string | null {
  const jsonUrl = stdout.match(/"url"\s*:\s*"(https:\/\/[^"]+)"/);
  if (jsonUrl?.[1]) return jsonUrl[1];
  const line = stdout.match(/https:\/\/[^\s"'<>]+on\.ascii\.dev[^\s"'<>]*/);
  return line?.[0] ?? null;
}

/** Idempotent script: extra X display + noVNC, then `host` publishes a private URL. */
export function boxScreenStartCommand(botId: string, display: number): string {
  const ports = boxSessionPorts(display);
  const safeBot = botId.replace(/[^a-zA-Z0-9._-]/g, "").slice(0, 80) || "bot";
  return `set -euo pipefail
BOT=${JSON.stringify(safeBot)}
DISPLAY_NUM=${ports.display}
VNC_PORT=${ports.vnc}
NOVNC_PORT=${ports.novnc}
ROOT="$HOME/.local/share/quibt/desktops/$BOT"
mkdir -p "$ROOT" /tmp/.X11-unix /workspace
if ! command -v Xvfb >/dev/null 2>&1; then
  sudo DEBIAN_FRONTEND=noninteractive apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq xvfb x11vnc novnc websockify openbox xdotool >/dev/null
fi
if [[ -f "$ROOT/session.pid" ]] && kill -0 "$(cat "$ROOT/session.pid")" 2>/dev/null; then
  host url "$NOVNC_PORT" --private 2>/dev/null || host "$NOVNC_PORT" --private --title "Quibt $BOT"
  exit 0
fi
export DISPLAY=":$DISPLAY_NUM"
rm -f "/tmp/.X\${DISPLAY_NUM}-lock" "/tmp/.X11-unix/X\${DISPLAY_NUM}"
Xvfb ":$DISPLAY_NUM" -screen 0 1280x800x24 -ac +extension RANDR +render -noreset >"$ROOT/xvfb.log" 2>&1 &
echo $! > "$ROOT/session.pid"
for i in $(seq 1 50); do
  xdpyinfo -display ":$DISPLAY_NUM" >/dev/null 2>&1 && break
  sleep 0.1
done
openbox --display ":$DISPLAY_NUM" >"$ROOT/wm.log" 2>&1 &
x11vnc -display ":$DISPLAY_NUM" -forever -shared -nopw -listen 0.0.0.0 -rfbport "$VNC_PORT" -xkb -ncache 0 >"$ROOT/vnc.log" 2>&1 &
NOVNC_ROOT=/usr/share/novnc
websockify --web="$NOVNC_ROOT" "0.0.0.0:$NOVNC_PORT" "127.0.0.1:$VNC_PORT" >"$ROOT/novnc.log" 2>&1 &
host "$NOVNC_PORT" --private --title "Quibt $BOT" >/tmp/quibt-host-$BOT.txt 2>&1 || true
host url "$NOVNC_PORT" --private
`;
}
