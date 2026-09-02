/**
 * Deterministic mobile system journey. See `README.md` for how to run this and why it
 * needs no phone, emulator, Maestro, Detox, or Expo Go: it drives the real
 * `apps/mobile/lib/*` client helpers against a real API app (scripted runtime, fake
 * sandbox), reading its steps from `bootstrap-flow.yaml` so the spec and the run cannot
 * drift apart.
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dataUri, NodeCapableFormData } from "./form-data-shim.js";
import { loadJourneySpec } from "./spec.js";

/** `apps/mobile/e2e` -> repo root, regardless of the shell's current working directory. */
const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");

/**
 * Never dialed over a real socket: the mobile lib's `fetch` calls to this origin are
 * routed in-process to `handles.app.request()` (the same call
 * `packages/testkit/src/journeys.test.ts` uses), exactly the way `claimInstallation` /
 * `signUp` / `rpc` / `uploadAttachment` already accept a `fetchImpl` seam or read the
 * ambient global `fetch` — no app code changes, no real network, no port to manage.
 */
const FAKE_BASE_URL = "http://127.0.0.1:39917";

const secureStore = new Map<string, string>();

vi.mock("expo-secure-store", () => ({
  getItemAsync: async (key: string) => secureStore.get(key) ?? null,
  setItemAsync: async (key: string, value: string) => {
    secureStore.set(key, value);
  },
  deleteItemAsync: async (key: string) => {
    secureStore.delete(key);
  },
}));

process.env.WAKEUP_DRIVER ??= "memory";
process.env.SANDBOX_PROVIDER ??= "fake";
process.env.AGENT_RUNTIME ??= "scripted";
process.env.BOOTSTRAP_SECRET ??= "mobile-e2e-bootstrap-secret-32chars-min";

const BOOTSTRAP_SECRET = process.env.BOOTSTRAP_SECRET;
const originalDatabaseUrl = process.env.DATABASE_URL;

type App = { request: (input: string, init?: RequestInit) => Promise<Response> };
type Handles = Awaited<ReturnType<typeof import("../../api/src/app.ts").createApp>>;
type MobileMe = { email?: string; isDeploymentOwner?: boolean };
type MobileCredential = { id: string; provider: string; label: string; isDefault: boolean };
type MachineCatalogItem = {
  kind: string;
  needsKey: boolean;
  needsEndpoint: boolean;
  configured?: boolean;
  keyLabel?: string;
  endpointLabel?: string;
  recipe?: unknown;
};
type MachineProbe = { ok: boolean; message: string };

/**
 * `DEFAULT_API` in `apps/mobile/lib/endpoint.ts` falls back to a real ambient
 * `http://127.0.0.1:3100` (whatever `pnpm dev` happens to have listening on this sandbox).
 * If any step forgets to point `currentApiBase()` at `FAKE_BASE_URL` first, this journey
 * must fail loudly instead of quietly succeeding against that real dev server — which
 * would pass here and then fail in CI, where nothing listens on :3100.
 */
const AMBIENT_API_BASE = "http://127.0.0.1:3100";

function looksLikeQuibtApiTraffic(url: string) {
  if (url.startsWith(FAKE_BASE_URL)) return false;
  if (url.startsWith(AMBIENT_API_BASE)) return true;
  return /\/(rpc|api|files)\//.test(url);
}

/**
 * Routes the mobile app's own `fetch` calls to the in-process API instead of a real
 * socket. Fails closed: any URL that looks like Quibt API traffic (the ambient dev
 * server on :3100, or an `/rpc/`, `/api/`, `/files/` path) but isn't `FAKE_BASE_URL`
 * throws instead of silently falling through to a real `fetch` call, so a missed
 * `saveApiBase(FAKE_BASE_URL)` step cannot let this journey talk to a real network.
 */
function installFetchShim(app: App) {
  const realFetch = globalThis.fetch;
  const shim = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === "string" ? input : input.toString();
    if (url.startsWith(FAKE_BASE_URL)) return app.request(url, init);
    if (looksLikeQuibtApiTraffic(url)) {
      throw new Error(
        `mobile e2e fetch shim: refusing to dial real Quibt API traffic at "${url}" ` +
          `(expected it routed to the in-process fake origin "${FAKE_BASE_URL}"). ` +
          "This means some step ran before currentApiBase() was set to the fake origin.",
      );
    }
    return realFetch(input as string, init);
  }) as typeof fetch;
  vi.stubGlobal("fetch", shim);
}

describe("mobile bootstrap system journey", () => {
  const stamp = Date.now();
  const dataDir = mkdtempSync(path.join(tmpdir(), "quibt-mobile-journey-"));
  const executed: string[] = [];
  let handles!: Handles;
  let database: StartedPostgreSqlContainer | undefined;
  let botId = "";
  const email = `mobile-journey-${stamp}@quibt.test`;

  beforeAll(async () => {
    configureContainerRuntime();
    database = await new PostgreSqlContainer("postgres:16-alpine").start();
    process.env.DATABASE_URL = database.getConnectionUri();
    execFileSync("pnpm", ["--filter", "@quibt/db", "exec", "prisma", "migrate", "deploy"], {
      cwd: REPO_ROOT,
      env: process.env,
      stdio: "inherit",
    });

    const { createApp } = await import("../../api/src/app.ts");
    handles = await createApp({
      databaseUrl: process.env.DATABASE_URL!,
      dataDir,
      sandboxProvider: "fake",
      agentRuntime: "scripted",
      bootstrapSecret: BOOTSTRAP_SECRET,
    });
    installFetchShim(handles.app);

    // A freshly installed deploy: no owner, no claimed invite, signups on. This mirrors
    // the "bootstrap pairing journey" setup in packages/testkit/src/journeys.test.ts so
    // the mobile harness stays deterministic no matter what earlier suites left behind
    // in a shared dev database.
    await handles.prisma.bootstrapInvite.deleteMany();
    await handles.prisma.deploymentClaim.update({
      where: { id: "default" },
      data: { claimedAt: null },
    });
    await handles.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { ownerUserId: null, signupsEnabled: true, sandboxProvider: null },
    });
  });

  afterAll(async () => {
    vi.unstubAllGlobals();
    await handles?.stop().catch(() => undefined);
    await database?.stop().catch(() => undefined);
    if (originalDatabaseUrl) process.env.DATABASE_URL = originalDatabaseUrl;
    else delete process.env.DATABASE_URL;
  });

  it("runs every bootstrap-flow.yaml step, in order, against the real mobile lib helpers", async () => {
    const spec = loadJourneySpec();

    const runners: Record<string, () => Promise<void>> = {
      launch_clean_app: launchCleanApp,
      configure_server: configureServer,
      enter_bootstrap_code: enterBootstrapCode,
      create_owner: createOwner,
      add_model: addModel,
      probe_activate_machine: probeActivateMachine,
      create_bot: createBot,
      send_scripted_message: sendScriptedMessage,
      attach_file: attachFile,
    };

    for (const step of spec.steps) {
      const runner = runners[step.id];
      if (!runner) throw new Error(`No harness runner registered for step "${step.id}"`);
      await runner();
      executed.push(step.id);
    }

    expect(executed).toEqual(spec.steps.map((step) => step.id));
  });

  async function launchCleanApp() {
    const { currentApiBase, defaultApiBase, resetApiBase } = await import("../lib/api.js");
    const { clearSessionToken, loadSessionToken } = await import("../lib/session.js");
    const { clearEnrollmentToken, hasEnrollmentToken } = await import(
      "../lib/bootstrap-pairing.js"
    );

    await resetApiBase();
    await clearSessionToken();
    await clearEnrollmentToken();

    expect(currentApiBase()).toBe(defaultApiBase());
    expect(await loadSessionToken()).toBe("");
    expect(await hasEnrollmentToken()).toBe(false);
  }

  async function configureServer() {
    const { INSTALL_SCRIPT_RAW_URL } = await import("@quibt/core");
    const { serverHostGuide, serverHostOptions, bootstrapCommand } = await import(
      "../lib/server-setup.js"
    );
    const { saveApiBase, currentApiBase } = await import("../lib/api.js");

    const options = serverHostOptions();
    expect(options.map((option) => option.kind)).toContain("local");

    const guide = serverHostGuide("local");
    expect(guide.showBootstrapCommand).toBe(true);

    const command = bootstrapCommand("linux");
    expect(command).toContain(INSTALL_SCRIPT_RAW_URL);
    expect(command).toContain("QUIBT_RELEASE=0.2.20");
    expect(command).toContain("QUIBT_SHOW_SENSITIVE=1");
    expect(command).not.toContain("/releases/latest/");
    expect(command).not.toContain('"$tmpdir/quibtbot" install');

    // This is the step where a real user would point the app at the server they just
    // set up. Route it at the in-process fake origin explicitly, through the same
    // `saveApiBase` production helper `claimInstallation` uses, rather than relying on
    // a later step to set it implicitly.
    const saved = await saveApiBase(FAKE_BASE_URL);
    expect(saved).toEqual({ ok: true, url: FAKE_BASE_URL });
    expect(currentApiBase()).toBe(FAKE_BASE_URL);
  }

  async function enterBootstrapCode() {
    const mint = await handles.app.request(
      "http://localhost/api/bootstrap/invites",
      {
        method: "POST",
        headers: {
          "x-quibt-bootstrap-secret": BOOTSTRAP_SECRET,
          "content-type": "application/json",
        },
      },
      { incoming: { socket: { remoteAddress: "127.0.0.1" } } },
    );
    expect(mint.status).toBe(200);
    const { code } = (await mint.json()) as { code: string };
    expect(code).toBeTruthy();

    const { claimInstallation } = await import("../lib/bootstrap-pairing.js");
    const result = await claimInstallation(FAKE_BASE_URL, code);
    expect(result).toEqual({ ok: true, redirectTo: "/sign-up" });

    // `claimInstallation` -> `persistBootstrapClaim` -> `saveApiBase` should have kept
    // `cachedApiBase` pinned at the fake origin. Assert it again, right before
    // `createOwner` starts issuing real `signUp`/`rpc` calls through `currentApiBase()`.
    const { currentApiBase } = await import("../lib/api.js");
    expect(currentApiBase()).toBe(FAKE_BASE_URL);
  }

  async function createOwner() {
    const { signUp, rpc } = await import("../lib/api.js");

    await signUp({ name: "Mobile Journey Owner", email, password: "password12" });
    const me = await rpc<MobileMe>("me");
    expect(me.email).toBe(email);
    expect(me.isDeploymentOwner).toBe(true);
  }

  async function addModel() {
    const { rpc } = await import("../lib/api.js");
    const { usingOwnCredential } = await import("../lib/model-source-core.js");

    await rpc("models/connect", {
      provider: "openrouter",
      apiKey: "sk-or-v1-mobile-journey-fake-key",
      label: "Mobile journey",
      modelId: "scripted",
    });
    await rpc("models/setDefault", { provider: "openrouter", modelId: "scripted" });

    const credentials = await rpc<MobileCredential[]>("models/credentials");
    expect(usingOwnCredential(credentials)).toBe(true);
  }

  async function probeActivateMachine() {
    const { rpc } = await import("../lib/api.js");
    const { machineActivationGate, splitMachineCatalog } = await import(
      "../lib/machine-settings.js"
    );
    const { machineCredentialsReady } = await import("@quibt/core");

    const catalog = await rpc<MachineCatalogItem[]>("computers/catalog");
    const { cards } = splitMachineCatalog(catalog);
    const item = cards.find((entry) => entry.kind === "e2b");
    expect(item).toBeTruthy();

    const apiKey = "e2e-mobile-fake-e2b-key";
    const credentialsReady = machineCredentialsReady(item, { endpoint: "", apiKey });
    expect(credentialsReady).toEqual({ ok: true });

    const probe = await rpc<MachineProbe>("computers/probe", { kind: "e2b", apiKey });
    expect(probe.ok).toBe(true);

    const gate = machineActivationGate({ credentialsReady: credentialsReady.ok, probe });
    expect(gate).toEqual({ ok: true, action: "activate" });

    const settings = await rpc<{ sandboxProvider: string | null }>("computers/activate", {
      kind: "e2b",
      apiKey,
    });
    expect(settings.sandboxProvider).toBe("e2b");

    // Real owners cannot revert the picker to the process env default from the UI either
    // (there is no "fake" catalog entry to select back to); the harness resets the same
    // row the RPC just wrote and invalidates the routing sandbox's cache so the rest of
    // this journey keeps booting the deterministic fake computer, exactly like every
    // other journey in packages/testkit/src/journeys.test.ts.
    await handles.prisma.deploymentSettings.update({
      where: { id: "default" },
      data: { sandboxProvider: null, sandboxCredentialCipher: null },
    });
    (handles.sandbox as unknown as { invalidate?: () => void }).invalidate?.();
  }

  async function createBot() {
    const { rpc } = await import("../lib/api.js");
    const bot = await rpc<{ id: string; name: string }>("bots/create", {
      name: "Chief",
      title: "Chief of staff",
      description: "Mobile journey bot",
      instructions: "",
      notifyOnFinish: true,
    });
    expect(bot.name).toBe("Chief");
    botId = bot.id;
  }

  async function sendScriptedMessage() {
    const { rpc } = await import("../lib/api.js");
    await rpc("threads/send", {
      botId,
      text: "write a file in your home called notes/result.txt that says mobile-journey-ok",
    });
    const snap = await waitForRunToFinish(botId);
    expect(JSON.stringify(snap.messages)).toContain("mobile-journey-ok");
  }

  async function attachFile() {
    const { rpc, authHeaders, currentApiBase } = await import("../lib/api.js");
    const { uploadAttachment, buildSendWithAttachmentsPayload } = await import(
      "../lib/attachments.js"
    );

    vi.stubGlobal("FormData", NodeCapableFormData);
    const bytes = new TextEncoder().encode("mobile journey attachment\n");
    const file = {
      uri: dataUri(bytes, "text/plain"),
      name: "journey-notes.txt",
      mimeType: "text/plain",
      size: bytes.byteLength,
    };
    const stored = await uploadAttachment(botId, file, {
      apiBase: currentApiBase(),
      authHeaders: await authHeaders(),
    });
    expect(stored.name).toBe("journey-notes.txt");

    const payload = buildSendWithAttachmentsPayload({ botId, text: "", attachments: [stored] });
    await rpc("threads/send", payload);
    const snap = await waitForRunToFinish(botId);
    expect(JSON.stringify(snap.messages)).toContain("journey-notes.txt");
  }

  type ThreadRun = { status: string } | null;
  type ThreadSnapshot = { run: ThreadRun; messages: unknown[] };

  async function waitForRunToFinish(bot: string): Promise<ThreadSnapshot> {
    const { rpc } = await import("../lib/api.js");
    const start = Date.now();
    let last: ThreadSnapshot | null = null;
    while (Date.now() - start < 20_000) {
      last = await rpc<ThreadSnapshot>("threads/get", { botId: bot });
      if (!last.run || ["completed", "failed", "cancelled"].includes(last.run.status)) return last;
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    throw new Error(`timeout waiting for thread: ${JSON.stringify(last)}`);
  }
});

function configureContainerRuntime() {
  if (process.env.DOCKER_HOST) return;
  try {
    const dockerHost = execFileSync(
      "docker",
      ["context", "inspect", "--format", "{{ .Endpoints.docker.Host }}"],
      { encoding: "utf8" },
    ).trim();
    if (!dockerHost) return;
    process.env.DOCKER_HOST = dockerHost;
    if (dockerHost.includes("/.colima/")) {
      process.env.TESTCONTAINERS_DOCKER_SOCKET_OVERRIDE ??= "/var/run/docker.sock";
    }
  } catch {
    // Testcontainers will report its normal, actionable runtime discovery error.
  }
}
