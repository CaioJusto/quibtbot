import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  canRevealPairingSecrets,
  ensureInstallEnvironment,
  INSTALL_RELEASE,
  PAIRING_OUTPUT_REFUSED_MESSAGE,
} from "@quibt/installer";
import { afterEach, describe, expect, it, vi } from "vitest";
import { CliUsageError, parseCli, persistEmbeddedComposeManifest, runCliAsync } from "./main.js";

const COMPOSE_FILE = path.resolve("infra/compose/docker-compose.desktop.yml");

describe("parseCli", () => {
  it("uses install as the explicit public command", () => {
    expect(parseCli(["install"])).toEqual({
      command: "install",
      nonInteractive: false,
      showSensitive: false,
      keepData: false,
      keepImages: false,
      local: false,
    });
    expect(parseCli(["install", "--non-interactive"])).toEqual({
      command: "install",
      nonInteractive: true,
      showSensitive: false,
      keepData: false,
      keepImages: false,
      local: false,
    });
    expect(parseCli(["pair", "--show-sensitive"])).toEqual({
      command: "pair",
      nonInteractive: false,
      showSensitive: true,
      keepData: false,
      keepImages: false,
      local: false,
    });
  });
  it("uninstall accepts what to keep, and only uninstall does", () => {
    expect(parseCli(["uninstall", "--keep-data", "--keep-images"])).toMatchObject({
      command: "uninstall",
      keepData: true,
      keepImages: true,
    });
    expect(() => parseCli(["install", "--keep-data"])).toThrow(/unknown option/);
  });
  it("maps --version to the version command", () => {
    expect(parseCli(["--version"]).command).toBe("version");
  });

  it("accepts mcp as a command without extra CLI flags", () => {
    expect(parseCli(["mcp"])).toMatchObject({ command: "mcp" });
  });
});

describe("cli version output", () => {
  it("prints exactly INSTALL_RELEASE", async () => {
    const logs: string[] = [];
    const code = await runCliAsync(["--version"], {
      log: (line) => logs.push(line),
      error: () => {},
    });
    expect(code).toBe(0);
    expect(logs).toEqual([INSTALL_RELEASE]);
  });
});

describe("embedded Compose extraction", () => {
  const pinnedCompose = `services:
  api:
    image: ghcr.io/quibt/quibt-stack@sha256:${"a".repeat(64)}
  supervisor:
    image: ghcr.io/quibt/quibt-supervisor@sha256:${"b".repeat(64)}
  computer:
    image: ghcr.io/quibt/quibt-computer@sha256:${"c".repeat(64)}
`;

  it("atomically replaces a stale mutable Compose from an older CLI", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-cli-compose-upgrade-"));
    const target = path.join(dataDir, "compose", "docker-compose.desktop.yml");
    persistEmbeddedComposeManifest(dataDir, pinnedCompose);
    writeFileSync(
      target,
      "services:\n  api:\n    image: ghcr.io/quibt/quibt-stack:" +
        "${" +
        "QUIBT_STACK_VERSION:?}\n",
      "utf8",
    );

    expect(persistEmbeddedComposeManifest(dataDir, pinnedCompose)).toBe(target);
    expect(readFileSync(target, "utf8")).toBe(pinnedCompose);
    expect(readFileSync(target, "utf8")).not.toContain("QUIBT_STACK_VERSION");
  });

  it("fails closed when the embedded Compose contains mutable image references", () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-cli-compose-mutable-"));
    const mutable = pinnedCompose.replace(
      `ghcr.io/quibt/quibt-stack@sha256:${"a".repeat(64)}`,
      "ghcr.io/quibt/quibt-stack:0.2.6",
    );

    expect(() => persistEmbeddedComposeManifest(dataDir, mutable)).toThrow(CliUsageError);
  });
});

describe("pairing output policy", () => {
  const originalIsTty = process.stdout.isTTY;

  afterEach(() => {
    Object.defineProperty(process.stdout, "isTTY", { value: originalIsTty, configurable: true });
  });

  it("defaults TTY detection to process.stdout.isTTY when no override is injected", () => {
    Object.defineProperty(process.stdout, "isTTY", { value: true, configurable: true });
    expect(canRevealPairingSecrets({})).toBe(true);
    Object.defineProperty(process.stdout, "isTTY", { value: false, configurable: true });
    expect(canRevealPairingSecrets({})).toBe(false);
  });

  it("refuses non-tty stdout without --show-sensitive", () => {
    expect(canRevealPairingSecrets({ isTty: false, showSensitive: false })).toBe(false);
    expect(PAIRING_OUTPUT_REFUSED_MESSAGE).toMatch(/--show-sensitive/i);
  });
});

describe("runCliAsync", () => {
  const logs: string[] = [];
  const errors: string[] = [];

  afterEach(() => {
    logs.length = 0;
    errors.length = 0;
  });

  it("mentions mcp in help", async () => {
    const code = await runCliAsync(["--help"], {
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });
    expect(code).toBe(0);
    expect(logs.join("\n")).toMatch(/mcp\s+Run the bounded stdio MCP/i);
  });

  it("starts mcp without printing Usage or any other CLI text to stdout", async () => {
    const runMcp = vi.fn(async () => {});
    const code = await runCliAsync(["mcp"], {
      runMcp,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });
    expect(code).toBe(0);
    expect(runMcp).toHaveBeenCalledOnce();
    expect(logs).toEqual([]);
    expect(errors).toEqual([]);
  });

  it("runs pair via local mint without printing bootstrap secret", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-cli-pair-"));
    const env = ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");
    const bootstrapSecret = env.values.BOOTSTRAP_SECRET!;

    const fetchImpl = vi.fn(async (input: string, init?: RequestInit) => {
      const url = String(input);
      if (url.endsWith("/rpc/health")) {
        return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: true } }), {
          status: 200,
        });
      }
      if (url.endsWith("/api/bootstrap/invites")) {
        const headers = new Headers(init?.headers);
        expect(headers.get("x-quibt-bootstrap-secret")).toBe(bootstrapSecret);
        return new Response(
          JSON.stringify({
            code: "ABCD1234",
            token: "pair-token",
            expiresAt: "2026-08-17T01:00:00.000Z",
          }),
          { status: 200 },
        );
      }
      return new Response("not found", { status: 404 });
    }) as unknown as typeof fetch;

    const code = await runCliAsync(["pair"], {
      dataDir,
      publicUrl: "http://127.0.0.1:5173",
      composeFile: COMPOSE_FILE,
      fetch: fetchImpl,
      isTty: true,
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    expect(code).toBe(0);
    const output = [...logs, ...errors].join("\n");
    expect(output).toContain("ABCD1234");
    expect(output).toContain("pair-token");
    expect(output).not.toContain(bootstrapSecret);
    expect(output).not.toContain("BOOTSTRAP_SECRET");
  });

  it("refuses pair secrets on redirected stdout without opt-in", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-cli-pair-nontty-"));
    ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");

    const code = await runCliAsync(["pair"], {
      dataDir,
      publicUrl: "http://127.0.0.1:5173",
      composeFile: COMPOSE_FILE,
      isTty: false,
      fetch: async (input, init) => {
        if (String(input).endsWith("/rpc/health")) {
          return new Response(JSON.stringify({ json: { needsFirstOwner: true } }), { status: 200 });
        }
        if (String(input).endsWith("/api/bootstrap/invites") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              code: "SECRET1234",
              token: "hidden-token",
              expiresAt: "2026-08-17T01:00:00.000Z",
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    const output = [...logs, ...errors].join("\n");
    expect(output).not.toContain("SECRET1234");
    expect(output).not.toContain("hidden-token");
    expect(errors.join("\n")).toMatch(/--show-sensitive/i);
  });

  it("uses fake TTY override without injecting other CLI deps", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-cli-pair-fake-tty-"));
    ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");

    const code = await runCliAsync(["pair"], {
      dataDir,
      publicUrl: "http://127.0.0.1:5173",
      composeFile: COMPOSE_FILE,
      isTty: true,
      fetch: async (input, init) => {
        if (String(input).endsWith("/rpc/health")) {
          return new Response(JSON.stringify({ json: { needsFirstOwner: true } }), { status: 200 });
        }
        if (String(input).endsWith("/api/bootstrap/invites") && init?.method === "POST") {
          return new Response(
            JSON.stringify({
              code: "TTY1234",
              token: "tty-token",
              expiresAt: "2026-08-17T01:00:00.000Z",
            }),
            { status: 200 },
          );
        }
        return new Response("not found", { status: 404 });
      },
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    expect(code).toBe(0);
    expect(logs.join("\n")).toContain("TTY1234");
  });

  it("refuses pair when deployment already has an owner", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-cli-pair-claimed-"));
    ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");

    const code = await runCliAsync(["pair"], {
      dataDir,
      publicUrl: "http://127.0.0.1:5173",
      composeFile: COMPOSE_FILE,
      isTty: true,
      fetch: async (input) => {
        if (String(input).endsWith("/rpc/health")) {
          return new Response(JSON.stringify({ json: { ok: true, needsFirstOwner: false } }), {
            status: 200,
          });
        }
        return new Response("not found", { status: 404 });
      },
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toMatch(/authenticated client/i);
  });

  it("uses sudo -n docker for status compose ps on sudo-only hosts", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-cli-status-sudo-"));
    ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");
    const commands: string[] = [];
    const originalGetUid = process.getuid;
    process.getuid = () => 1000;

    try {
      const code = await runCliAsync(["status"], {
        dataDir,
        publicUrl: "http://127.0.0.1:5173",
        composeFile: COMPOSE_FILE,
        fetch: async (url) =>
          String(url).endsWith("/ready")
            ? new Response(JSON.stringify({ ok: true }), { status: 200 })
            : new Response("down", { status: 503 }),
        run: {
          async run(command, args) {
            commands.push([command, ...args].join(" "));
            if (command === "docker" && args[0] === "info") {
              return { code: 1, stdout: "", stderr: "permission denied" };
            }
            if (
              command === "sudo" &&
              args[0] === "-n" &&
              args[1] === "docker" &&
              args[2] === "info"
            ) {
              return { code: 0, stdout: "", stderr: "" };
            }
            if (command.includes("docker")) {
              return { code: 1, stdout: "", stderr: "permission denied" };
            }
            return { code: 0, stdout: "", stderr: "" };
          },
        },
        log: (line) => logs.push(line),
        error: (line) => errors.push(line),
      });

      expect(code).toBe(0);
      expect(commands.some((entry) => entry.includes("sudo -n docker info"))).toBe(true);
      expect(
        commands.some(
          (entry) => entry.startsWith("sudo -n docker compose") && entry.includes(" ps "),
        ),
      ).toBe(true);
    } finally {
      process.getuid = originalGetUid;
    }
  });

  it("install com o estado completo religa o stack e diz que já está no ar", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-cli-install-again-"));
    ensureInstallEnvironment(dataDir, "http://127.0.0.1:5173");
    writeFileSync(
      path.join(dataDir, "install-state.json"),
      `${JSON.stringify({
        version: 1,
        release: INSTALL_RELEASE,
        completed: [
          "requirements",
          "environment",
          "images",
          "services",
          "database",
          "health",
          "pairing",
        ],
        updatedAt: "2026-08-17T00:00:00.000Z",
      })}\n`,
      { mode: 0o600 },
    );
    const commands: string[] = [];

    const code = await runCliAsync(["install"], {
      dataDir,
      publicUrl: "http://127.0.0.1:5173",
      composeFile: COMPOSE_FILE,
      isTty: true,
      platform: "linux",
      clock: { now: () => new Date("2026-08-17T00:30:00.000Z"), sleep: async () => undefined },
      fetch: async (url) =>
        String(url).endsWith("/ready")
          ? new Response("{}", { status: 200 })
          : new Response("not found", { status: 404 }),
      run: {
        async run(command, args) {
          const joined = [command, ...args].join(" ");
          commands.push(joined);
          // As imagens continuam no disco desde a instalação: nada para baixar.
          if (joined.includes("image inspect")) {
            return { code: 0, stdout: "sha256:local\n", stderr: "" };
          }
          return { code: 0, stdout: "", stderr: "" };
        },
      },
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    expect(code).toBe(0);
    expect(errors).toEqual([]);
    expect(logs.at(-1)).toBe(
      `Quibt Bot ${INSTALL_RELEASE} já instalado e no ar em http://127.0.0.1:5173. Para conectar o celular: quibtbot pair`,
    );
    expect(logs.join("\n")).toContain("[services] running: Ligando o Quibt Bot…");
    expect(
      commands.some((entry) => entry.includes(" up -d supervisor api worker web computer")),
    ).toBe(true);
    expect(commands.some((entry) => entry.startsWith("docker pull"))).toBe(false);
  });

  it("--non-interactive não abre o prompt de senha do Mac: falha dizendo o que instalar", async () => {
    const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-cli-non-interactive-"));
    const commands: string[] = [];

    const code = await runCliAsync(["install", "--non-interactive"], {
      dataDir,
      publicUrl: "http://127.0.0.1:5173",
      composeFile: COMPOSE_FILE,
      isTty: false,
      platform: "darwin",
      clock: { now: () => new Date("2026-08-17T00:30:00.000Z"), sleep: async () => undefined },
      fetch: async () => new Response("not found", { status: 404 }),
      run: {
        async run(command, args) {
          commands.push([command, ...args].join(" "));
          return { code: 1, stdout: "", stderr: "missing" };
        },
      },
      log: (line) => logs.push(line),
      error: (line) => errors.push(line),
    });

    expect(code).toBe(1);
    expect(errors.join("\n")).toContain("--non-interactive");
    expect(errors.join("\n")).toContain("Instale o Docker Desktop");
    expect(commands.some((entry) => entry.startsWith("/usr/bin/osascript"))).toBe(false);
    expect(commands.some((entry) => entry.startsWith("/usr/bin/curl"))).toBe(false);
  });
});
