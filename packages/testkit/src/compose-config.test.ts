import { execFileSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { allQuibtImages, INSTALL_RELEASE } from "../../installer/src/compose.js";
import { composeServices, parseComposeYaml, readComposeFile } from "./compose-config.js";

const composeFile = path.resolve("infra/compose/docker-compose.yml");
const desktopComposeFile = path.resolve("infra/compose/docker-compose.desktop.yml");
const services = composeServices(readComposeFile(composeFile));
const desktopServices = composeServices(readComposeFile(desktopComposeFile));

/** Services that must come back by themselves; `computer` is a one-shot image builder. */
const LONG_RUNNING = ["postgres", "supervisor", "api", "worker", "web"];

/**
 * Serviços que rodam código do produto e leem o `.env` da máquina. Um `NODE_ENV=development`
 * herdado dali religa os placeholders de segredo, faz o token do supervisor voltar a ser
 * derivado do segredo de sessão e faz o CORS aceitar requisição sem `Origin` e qualquer
 * `localhost` com credenciais. Em compose, `environment:` ganha do `env_file:`.
 */
const STACK_SERVICES = ["supervisor", "api", "worker", "web"];

describe("compose yaml reader", () => {
  it("reads nested maps, scalar lists and flow sequences", () => {
    const parsed = parseComposeYaml(
      [
        "# comment",
        "services:",
        "  app:",
        '    command: ["bash", "-lc", "echo hi"]',
        "    restart: unless-stopped",
        "    ports:",
        '      - "127.0.0.1:1:2"',
        "    depends_on:",
        "      db:",
        "        condition: service_healthy",
        "    labels:",
        '      quibt.screen-proxy: "true"',
        "volumes:",
        "  pgdata:",
      ].join("\n"),
    );
    expect(parsed).toEqual({
      services: {
        app: {
          command: ["bash", "-lc", "echo hi"],
          restart: "unless-stopped",
          ports: ["127.0.0.1:1:2"],
          depends_on: { db: { condition: "service_healthy" } },
          labels: { "quibt.screen-proxy": "true" },
        },
      },
      volumes: { pgdata: null },
    });
  });
});

describe("compose service policies", () => {
  it("restarts every long-running service and leaves the one-shot builder alone", () => {
    for (const name of LONG_RUNNING) {
      expect(services[name]?.restart, `${name} must restart`).toBe("unless-stopped");
    }
    expect(services.computer?.restart).toBe("no");
  });

  it("starts the worker only after the api applied the migrations", () => {
    const api = services.api ?? {};
    const command = String(api.command);
    expect(command.indexOf("prisma migrate deploy")).toBeGreaterThan(-1);
    expect(command.indexOf("prisma migrate deploy")).toBeLessThan(
      command.indexOf("@quibt/api start"),
    );
    const health = api.healthcheck as Record<string, unknown> | undefined;
    expect(String(health?.test)).toContain("/ready");
    expect(Number(health?.retries)).toBeGreaterThan(0);

    const worker = services.worker?.depends_on as Record<string, { condition?: string }>;
    expect(worker.postgres?.condition).toBe("service_healthy");
    expect(worker.api?.condition).toBe("service_healthy");
    const web = services.web?.depends_on as Record<string, { condition?: string }>;
    expect(web.api?.condition).toBe("service_healthy");
  });

  it("runs the dedicated production web server and checks its own health endpoint", () => {
    expect(services.web?.command).toEqual(["pnpm", "--filter", "@quibt/web", "start"]);
    expect(String(services.web?.healthcheck?.test)).toContain("127.0.0.1:5173/health");
    expect(services.web?.environment?.WEB_HOST).toBe("0.0.0.0");
    expect(String(services.web?.environment?.WEB_PORT)).toBe("5173");
    expect(services.web?.env_file).toEqual(["../../.env"]);
    expect(services.web?.environment?.BETTER_AUTH_SECRET).toBeUndefined();
  });

  it("keeps the network posture: postgres on loopback and no port for the supervisor", () => {
    expect(services.postgres?.ports).toEqual(["127.0.0.1:5433:5432"]);
    expect(services.supervisor?.ports).toBeUndefined();
    expect(services.api?.ports).toEqual(["127.0.0.1:3100:3100"]);
    expect(services.web?.ports).toEqual(["127.0.0.1:5173:5173"]);
  });

  it("pins NODE_ENV=production on every service that reads the machine's .env", () => {
    for (const name of STACK_SERVICES) {
      expect(String(services[name]?.environment?.NODE_ENV), `${name} must run in production`).toBe(
        "production",
      );
    }
  });

  it("keeps production even when an old .env still carries NODE_ENV=development", () => {
    const rendered = renderWithDocker("NODE_ENV=development\n");
    if (!rendered) return;
    for (const name of STACK_SERVICES) {
      expect(rendered.services[name]?.environment?.NODE_ENV, `${name} must ignore the .env`).toBe(
        "production",
      );
    }
  });

  it("passes the real source-install authentication secret through to the web server", () => {
    const rendered = renderWithDocker(
      "BETTER_AUTH_SECRET=source-compose-test-secret-0123456789abcdef\n",
    );
    if (!rendered) return;
    expect(rendered.services.web?.environment?.BETTER_AUTH_SECRET).toBe(
      "source-compose-test-secret-0123456789abcdef",
    );
  });

  it("matches what docker itself resolves from the file", () => {
    const rendered = renderWithDocker();
    if (!rendered) return;
    for (const name of LONG_RUNNING)
      expect(rendered.services[name]?.restart).toBe("unless-stopped");
    expect(rendered.services.computer?.restart).toBe("no");
    expect(rendered.services.worker?.depends_on?.api?.condition).toBe("service_healthy");
    expect(rendered.services.postgres?.ports?.[0]?.host_ip).toBe("127.0.0.1");
    expect(rendered.services.supervisor?.ports ?? []).toEqual([]);
  });
});

describe("desktop compose service policies", () => {
  it("uses a stable project name isolated from source development compose", () => {
    expect(readComposeFile(desktopComposeFile).name).toBe("quibt-desktop");
  });

  it("uses pinned postgres and image-only Quibt services", () => {
    const manifest = readComposeFile(desktopComposeFile);
    expect(manifest.services.postgres.image).toMatch(/^postgres:16@sha256:/);
    expect(desktopServices.api?.build).toBeUndefined();
    expect(desktopServices.worker?.build).toBeUndefined();
    expect(desktopServices.web?.build).toBeUndefined();
    expect(desktopServices.supervisor?.build).toBeUndefined();
    expect(desktopServices.computer?.build).toBeUndefined();
    expect(allQuibtImages(manifest)).toEqual([
      `ghcr.io/quibt/quibt-stack:${INSTALL_RELEASE}`,
      `ghcr.io/quibt/quibt-supervisor:${INSTALL_RELEASE}`,
      `ghcr.io/quibt/quibt-computer:${INSTALL_RELEASE}`,
    ]);
  });

  it("bind-mounts postgres data under DATA_DIR", () => {
    expect(desktopServices.postgres?.volumes).toEqual([
      `\${DATA_DIR}/postgres:/var/lib/postgresql/data`,
    ]);
    expect(readComposeFile(desktopComposeFile).volumes).toBeUndefined();
  });

  it("starts api without implicit migration in the service command", () => {
    const command = desktopServices.api?.command;
    expect(command).toEqual(["pnpm", "--filter", "@quibt/api", "start"]);
    expect(JSON.stringify(command)).not.toContain("migrate deploy");
  });

  it("runs the dedicated production web server before exposing Caddy", () => {
    expect(desktopServices.web?.command).toEqual(["pnpm", "--filter", "@quibt/web", "start"]);
    expect(String(desktopServices.web?.healthcheck?.test)).toContain("127.0.0.1:5173/health");
    expect(desktopServices.web?.environment?.WEB_HOST).toBe("0.0.0.0");
    const caddy = desktopServices.caddy?.depends_on as Record<string, { condition?: string }>;
    expect(caddy.web?.condition).toBe("service_healthy");
  });

  it("restarts long-running services and mounts the generated env file", () => {
    for (const name of LONG_RUNNING) {
      expect(desktopServices[name]?.restart, `${name} must restart`).toBe("unless-stopped");
    }
    expect(desktopServices.computer?.restart).toBe("no");
    expect(desktopServices.api?.env_file).toEqual([`\${INSTALL_ENV_FILE:?}`]);
    expect(desktopServices.web?.env_file).toEqual([`\${INSTALL_ENV_FILE:?}`]);
    expect(String(desktopServices.postgres?.environment?.POSTGRES_PASSWORD)).toBe(
      `\${DATABASE_PASSWORD:?}`,
    );
    expect(String(desktopServices.web?.environment?.BETTER_AUTH_SECRET)).toBe(
      `\${BETTER_AUTH_SECRET:?}`,
    );
  });

  it("keeps postgres private and exposes the API to the phone on the local network", () => {
    expect(desktopServices.postgres?.ports).toBeUndefined();
    expect(desktopServices.supervisor?.ports).toBeUndefined();
    expect(desktopServices.api?.ports).toEqual([`\${QUIBT_API_BIND_HOST:-0.0.0.0}:3100:3100`]);
    expect(desktopServices.web?.ports).toEqual([`\${QUIBT_WEB_BIND_HOST:-127.0.0.1}:5173:5173`]);
  });

  it("pins NODE_ENV=production on every service that reads quibt.env", () => {
    for (const name of STACK_SERVICES) {
      expect(
        String(desktopServices[name]?.environment?.NODE_ENV),
        `${name} must run in production`,
      ).toBe("production");
    }
  });

  it("keeps production even when an old quibt.env still carries NODE_ENV=development", () => {
    const rendered = renderDesktopWithDocker(["NODE_ENV=development"]);
    if (!rendered) return;
    for (const name of STACK_SERVICES) {
      expect(rendered.services[name]?.environment?.NODE_ENV, `${name} must ignore quibt.env`).toBe(
        "production",
      );
    }
  });

  it("matches what docker itself resolves from the desktop file", () => {
    const rendered = renderDesktopWithDocker();
    if (!rendered) {
      expect(desktopServices.api?.env_file).toEqual([`\${INSTALL_ENV_FILE:?}`]);
      return;
    }
    for (const name of LONG_RUNNING)
      expect(rendered.services[name]?.restart).toBe("unless-stopped");
    expect(rendered.services.computer?.restart).toBe("no");
    expect(rendered.services.worker?.depends_on?.api?.condition).toBe("service_healthy");
    expect(rendered.services.postgres?.ports ?? []).toEqual([]);
    expect(rendered.services.supervisor?.ports ?? []).toEqual([]);
    expect(rendered.services.api?.ports?.[0]?.host_ip).toBe("0.0.0.0");
    expect(rendered.services.web?.ports?.[0]?.host_ip).toBe("127.0.0.1");
    expect(rendered.services.web?.environment?.BETTER_AUTH_SECRET).toBeTruthy();
  });
});

type RenderedCompose = {
  services: Record<
    string,
    {
      restart?: string;
      depends_on?: Record<string, { condition?: string }>;
      environment?: Record<string, string | undefined>;
      ports?: { host_ip?: string }[];
    }
  >;
};

/**
 * `docker compose config` also proves the file is schema-valid. It runs from a throwaway
 * root with an empty `.env` so it does not depend on the developer's own environment.
 */
function renderWithDocker(rootEnv = ""): RenderedCompose | undefined {
  return renderComposeWithDocker(composeFile, "", rootEnv);
}

function renderDesktopWithDocker(extraEnv: string[] = []): RenderedCompose | undefined {
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-desktop-data-"));
  const envFile = path.join(dataDir, "quibt.env");
  writeFileSync(
    envFile,
    [
      "DATABASE_PASSWORD=desktop-test-password",
      `DATA_DIR=${dataDir}`,
      "QUIBT_STACK_VERSION=0.2.6",
      `INSTALL_ENV_FILE=${envFile}`,
      "BETTER_AUTH_SECRET=desktop-test-secret",
      "WEB_ORIGIN=http://127.0.0.1:5173",
      "BETTER_AUTH_URL=http://127.0.0.1:5173",
      ...extraEnv,
    ].join("\n"),
  );
  return renderComposeWithDocker(desktopComposeFile, envFile);
}

function renderComposeWithDocker(
  file: string,
  envFile: string,
  rootEnv = "",
): RenderedCompose | undefined {
  let root: string | undefined;
  try {
    root = mkdtempSync(path.join(tmpdir(), "quibt-compose-"));
    mkdirSync(path.join(root, "infra", "compose"), { recursive: true });
    const target = path.join(root, "infra", "compose", path.basename(file));
    copyFileSync(file, target);
    const args = ["compose", "-f", path.relative(root, target), "config", "--format", "json"];
    if (envFile) args.splice(3, 0, "--env-file", envFile);
    else writeFileSync(path.join(root, ".env"), rootEnv);
    const json = execFileSync("docker", args, {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "pipe"],
      timeout: 20_000,
    });
    return JSON.parse(json) as RenderedCompose;
  } catch (error) {
    // `docker` ausente na máquina é motivo legítimo para pular o caso. Qualquer outra
    // falha é o compose quebrado de verdade: engolir aqui já deixou um `${VAR:?}`
    // obrigatório passar despercebido, porque o teste ficava verde sem renderizar nada.
    if (isDockerMissing(error)) return undefined;
    const detail =
      error instanceof Error && "stderr" in error
        ? String((error as { stderr?: unknown }).stderr ?? "").trim()
        : String(error);
    throw new Error(`docker compose config failed for ${path.basename(file)}: ${detail}`);
  } finally {
    if (root) rmSync(root, { recursive: true, force: true });
  }
}

function isDockerMissing(error: unknown): boolean {
  if (!error || typeof error !== "object") return false;
  const code = (error as { code?: unknown }).code;
  return code === "ENOENT" || code === "EACCES";
}
