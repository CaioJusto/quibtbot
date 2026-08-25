import { existsSync } from "node:fs";
import path from "node:path";

export const COMPOSE_MANIFEST_NAME = "docker-compose.desktop.yml";

export function resolveComposeFile(
  exePath: string,
): { ok: true; path: string } | { ok: false; message: string } {
  const fromEnv = process.env.QUIBT_COMPOSE_FILE?.trim();
  if (fromEnv) {
    if (!existsSync(fromEnv)) {
      return {
        ok: false,
        message: `QUIBT_COMPOSE_FILE points to a missing file: ${fromEnv}`,
      };
    }
    return { ok: true, path: path.resolve(fromEnv) };
  }

  const exeDir = path.dirname(path.resolve(exePath));
  const candidates = [
    path.join(exeDir, "compose", COMPOSE_MANIFEST_NAME),
    path.join(exeDir, COMPOSE_MANIFEST_NAME),
    path.join(exeDir, "..", "compose", COMPOSE_MANIFEST_NAME),
    path.join(exeDir, "..", "resources", "compose", COMPOSE_MANIFEST_NAME),
  ];

  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return { ok: true, path: path.resolve(candidate) };
    }
  }

  return {
    ok: false,
    message:
      "Compose manifest not found next to the quibtbot binary. Set QUIBT_COMPOSE_FILE to the packaged docker-compose.desktop.yml path.",
  };
}
