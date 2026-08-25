/**
 * A metade de "ensinar uma tarefa" que só o servidor roda: os comandos que marcam o
 * começo e colhem o resultado dentro do computador do bot. O texto do pedido e o tipo
 * do resumo vivem em `@quibt/core`, porque o app também os usa.
 */
import type { LessonCapture } from "@quibt/core";

/** Onde o marcador do início da lição fica dentro do computador do bot. */
export const LESSON_MARKER = "/home/quibt/.quibt/lesson-start.json";

/** Teto de cada lista no resumo: o suficiente para reconstruir o método, sem despejo. */
export const LESSON_MAX_ITEMS = 40;

export function lessonStartCommand(): string[] {
  return [
    "bash",
    "-lc",
    [
      "set -e",
      "mkdir -p /home/quibt/.quibt",
      "HIST=$(wc -l < /home/quibt/.bash_history 2>/dev/null || echo 0)",
      'printf \'{"at":"%s","epoch":%s,"histLines":%s}\\n\' "$(date -Iseconds)" "$(date +%s)" "$HIST" > ' +
        LESSON_MARKER,
      `cat ${LESSON_MARKER}`,
    ].join("; "),
  ];
}

/**
 * Colhe o que mudou desde o marcador. Roda em python porque o histórico do Chromium é
 * um SQLite e a stdlib já traz o leitor — e porque uma falha em qualquer fonte não pode
 * derrubar as outras: cada bloco falha sozinho e o resto do resumo continua de pé.
 */
export function lessonCaptureCommand(): string[] {
  const script = `
import json, os, shutil, sqlite3, subprocess, sys, tempfile, time

HOME = "/home/quibt"
MARKER = ${JSON.stringify(LESSON_MARKER)}
MAX = ${LESSON_MAX_ITEMS}
out = {"urls": [], "commands": [], "files": [], "windows": []}

try:
    with open(MARKER) as fh:
        marker = json.load(fh)
except Exception:
    marker = {}
epoch = int(marker.get("epoch") or (time.time() - 3600))
hist_lines = int(marker.get("histLines") or 0)
if marker.get("at"):
    out["startedAt"] = marker["at"]

# Chromium guarda o tempo em microssegundos desde 1601-01-01.
try:
    history = os.path.join(HOME, ".config/chromium/Default/History")
    if os.path.exists(history):
        with tempfile.TemporaryDirectory() as tmp:
            copy = os.path.join(tmp, "History")
            shutil.copy2(history, copy)
            since = (epoch + 11644473600) * 1000000
            db = sqlite3.connect(copy)
            rows = db.execute(
                "select url, title from urls where last_visit_time > ? order by last_visit_time",
                (since,),
            ).fetchall()
            db.close()
            seen = set()
            for url, title in rows:
                if url in seen or url.startswith("chrome://"):
                    continue
                seen.add(url)
                out["urls"].append(f"{title} — {url}" if title else url)
except Exception as error:
    out["urls"].append(f"(histórico do navegador indisponível: {error})")

try:
    path = os.path.join(HOME, ".bash_history")
    if os.path.exists(path):
        with open(path, errors="replace") as fh:
            lines = [line.strip() for line in fh.read().splitlines() if line.strip()]
        out["commands"] = [line for line in lines[hist_lines:] if not line.startswith("#")]
except Exception:
    pass

try:
    found = subprocess.run(
        ["find", HOME, "-newermt", "@%d" % epoch, "-type", "f",
         "-not", "-path", "*/.cache/*", "-not", "-path", "*/.config/*",
         "-not", "-path", "*/.quibt/*", "-not", "-path", "*/.mozilla/*"],
        capture_output=True, text=True, timeout=20,
    )
    out["files"] = [line for line in found.stdout.splitlines() if line.strip()]
except Exception:
    pass

try:
    listed = subprocess.run(
        ["xdotool", "search", "--onlyvisible", "--name", ".*", "getwindowname", "%@"],
        capture_output=True, text=True, timeout=10,
        env=dict(os.environ, DISPLAY=os.environ.get("DISPLAY", ":1")),
    )
    out["windows"] = [line for line in listed.stdout.splitlines() if line.strip()]
except Exception:
    pass

for key in ("urls", "commands", "files", "windows"):
    out[key] = out[key][:MAX]

print(json.dumps(out))
`;
  return [
    "bash",
    "-lc",
    `cat <<'QUIBT_LESSON_PY' > /tmp/quibt-lesson.py\n${script}\nQUIBT_LESSON_PY\npython3 /tmp/quibt-lesson.py`,
  ];
}

export function parseLessonCapture(stdout: string): LessonCapture {
  const line = stdout
    .split("\n")
    .map((row) => row.trim())
    .filter((row) => row.startsWith("{"))
    .at(-1);
  if (!line) return { urls: [], commands: [], files: [], windows: [], error: "sem resposta" };
  try {
    const parsed = JSON.parse(line) as Partial<LessonCapture>;
    return {
      urls: parsed.urls ?? [],
      commands: parsed.commands ?? [],
      files: parsed.files ?? [],
      windows: parsed.windows ?? [],
      startedAt: parsed.startedAt,
    };
  } catch {
    return { urls: [], commands: [], files: [], windows: [], error: "resposta ilegível" };
  }
}
