import type { ComposePsRow } from "./compose-ps.js";

export const REQUIRED_COMPOSE_SERVICES = [
  "postgres",
  "api",
  "web",
  "worker",
  "supervisor",
] as const;

export type RequiredComposeService = (typeof REQUIRED_COMPOSE_SERVICES)[number];

export function assessComposeServices(rows: ComposePsRow[]): {
  ok: boolean;
  missing: RequiredComposeService[];
  notRunning: RequiredComposeService[];
  unhealthy: RequiredComposeService[];
  message: string;
} {
  const byService = new Map<string, ComposePsRow>();
  for (const row of rows) {
    if (row.Service) byService.set(row.Service, row);
  }

  const missing: RequiredComposeService[] = [];
  const notRunning: RequiredComposeService[] = [];
  const unhealthy: RequiredComposeService[] = [];

  for (const service of REQUIRED_COMPOSE_SERVICES) {
    const row = byService.get(service);
    if (!row) {
      missing.push(service);
      continue;
    }
    if (row.State !== "running") {
      notRunning.push(service);
      continue;
    }
    if (row.Health && row.Health !== "healthy") {
      unhealthy.push(service);
    }
  }

  const ok = missing.length === 0 && notRunning.length === 0 && unhealthy.length === 0;
  let message = "All essential services are running";
  if (!ok) {
    const parts: string[] = [];
    if (missing.length > 0) parts.push(`missing: ${missing.join(", ")}`);
    if (notRunning.length > 0) parts.push(`not running: ${notRunning.join(", ")}`);
    if (unhealthy.length > 0) parts.push(`unhealthy: ${unhealthy.join(", ")}`);
    message = `Essential services are not healthy (${parts.join("; ")})`;
  }

  return { ok, missing, notRunning, unhealthy, message };
}
