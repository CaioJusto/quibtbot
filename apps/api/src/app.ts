import { createHmac } from "node:crypto";
import { onError } from "@orpc/server";
import { RPCHandler } from "@orpc/server/fetch";
import type { SandboxProvider, WakeupDriver } from "@quibt/adapter-kit";
import {
  type ComposioConnector,
  createConnectorStack,
  createRoutingSandboxProvider,
  createRunExecutor,
  type DestinationEmulator,
  EncryptedSecretStore,
  ExpoPushProvider,
  failRunsWithoutWorker,
  GraphileWakeupDriver,
  InMemoryWakeupDriver,
  isComposioEnabled,
  LocalAgentHomeStore,
  loadFolderGrantsByUser,
  PiAgentRuntime,
  PiOAuthLogins,
  revokeControlScreenOrSchedule,
  ScriptedAgentRuntime,
  sandboxOptionsFromSettings,
  sleepComputerIfIdle,
  storedComposioKeyLoader,
} from "@quibt/adapters";
import { blockedAuthPaths, createAuth, mailerEnabled, takeLocalResetLink } from "@quibt/auth";
import {
  editionGate,
  emailAllowed,
  normalizeRemoteConnectApi,
  parseAllowlist,
  QUEUED_RUN_RECONCILE_MS,
  reapControl,
  signupsOpen,
} from "@quibt/core";
import { isAuthorizedBootstrapSecret } from "@quibt/core/bootstrap-invite-server";
import {
  assertWorkspaceWithinPlan,
  closeThreadNotifier,
  createDb,
  createWebhookService,
  isImage,
  MAX_ARTIFACT_BYTES,
  type Prisma,
  type PrismaClient,
  putArtifact,
  readArtifact,
  requireMembership,
  type WebhookService,
} from "@quibt/db";
import { MarkdownMemoryStore } from "@quibt/memory";
import { type Context, Hono } from "hono";
import { bodyLimit } from "hono/body-limit";
import { cors } from "hono/cors";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import { createBilling, createStripeGateway } from "./billing.js";
import {
  claimBootstrapInvite,
  claimBootstrapInviteToken,
  deploymentNeedsFirstOwner,
  mintBootstrapInvite,
  prepareFirstOwnerEnrollment,
} from "./bootstrap.js";
import { checkPersistentBootstrapRateLimit } from "./bootstrap-rate-limit.js";
import {
  claimDeviceCode,
  issueDeviceCode,
  pollDeviceRequest,
  purgeStaleDeviceCodes,
} from "./device-code-store.js";
import { type AppEnv, loadEnv } from "./env.js";
import {
  commitFirstOwnerSignup,
  type FirstOwnerSignupHooks,
  generatedOwnerEmail,
  generatedOwnerPassword,
  mapFirstOwnerSignupError,
} from "./first-owner-signup.js";
import { isTrustedOrigin, withPublicConnectOrigin } from "./origins.js";
import {
  allowRequest,
  allowWebhookRequest,
  authRateLimit,
  clientIp,
  clientKey,
  rpcMutationRateLimit,
} from "./rate-limit.js";
import { createRouter, logRpcError } from "./router.js";
import { screenProxyOrigin } from "./screen-origin.js";
import { withStreamingHeaders } from "./streaming-response.js";
import {
  parseWebhookPayload,
  readWebhookDeliveryId,
  readWebhookEventName,
  readWebhookSecret,
  WEBHOOK_MAX_BODY_BYTES,
  WebhookPayloadError,
  webhookPrompt,
} from "./webhooks.js";
import { createWorkerPresenceReader } from "./worker-presence.js";

export { isTrustedOrigin } from "./origins.js";

export interface AppHandles {
  app: Hono;
  prisma: PrismaClient;
  wakeup: WakeupDriver;
  sandbox: SandboxProvider;
  connector: DestinationEmulator;
  composio?: ComposioConnector;
  executor: ReturnType<typeof createRunExecutor>;
  /** Exposed mainly for tests: administration goes through `/rpc/webhooks/*`, but
   * driving the real ingress routes needs a way to mint an endpoint/secret first. */
  webhookService: WebhookService;
  stop: () => Promise<void>;
}

export interface CreateAppOverrides extends Partial<AppEnv> {
  prisma?: PrismaClient;
  /** Test-only hooks for first-owner signup failure injection. */
  firstOwnerSignupHooks?: FirstOwnerSignupHooks;
}

export async function createApp(overrides: CreateAppOverrides = {}): Promise<AppHandles> {
  // An explicit database override must be visible while validating the environment,
  // before the remaining test/runtime overrides are merged. This keeps injected-Prisma
  // tests from mutating process.env merely to satisfy loadEnv's required field.
  const source = overrides.databaseUrl
    ? { ...process.env, DATABASE_URL: overrides.databaseUrl }
    : process.env;
  const env = { ...loadEnv(source), ...overrides };
  if (
    env.billingEnabled &&
    (!env.stripeSecretKey ||
      !env.stripeWebhookSecret ||
      !env.stripePriceStarter ||
      !env.stripePricePro)
  ) {
    throw new Error(
      "BILLING_ENABLED requires STRIPE_SECRET_KEY, STRIPE_WEBHOOK_SECRET, STRIPE_PRICE_STARTER, and STRIPE_PRICE_PRO.",
    );
  }
  const created = overrides.prisma
    ? { prisma: overrides.prisma, pool: undefined }
    : createDb(env.databaseUrl);
  const { prisma } = created;
  created.pool?.on("error", () => undefined);
  // O interruptor de cadastro mora em `deployment_settings` e nasce fechado; mas quem instala
  // mexe no .env, não no banco. Com SIGNUPS_ENABLED definido, o .env manda nos dois portões a
  // cada subida (é assim que se abre — ou fecha — sem tela); sem ele, vale o que está salvo.
  const signupsFromEnv =
    env.signupsEnabled === undefined ? undefined : signupsOpen(env.signupsEnabled);
  const signupsPatch = signupsFromEnv === undefined ? {} : { signupsEnabled: signupsFromEnv };
  await prisma.deploymentSettings.upsert({
    where: { id: "default" },
    create: { id: "default", ...signupsPatch },
    update: signupsPatch,
  });
  await prisma.deploymentClaim.upsert({
    where: { id: "default" },
    create: { id: "default" },
    update: {},
  });

  // Ler isto é conveniência (o endereço público do QR): um banco tropeçando aqui
  // não pode impedir a API de subir — sem ela, nem a tela de erro aparece.
  const savedPublicUrl = (
    await prisma.deploymentSettings
      .findUnique({
        where: { id: "default" },
        select: { webhookPublicUrl: true },
      })
      .catch(() => null)
  )?.webhookPublicUrl;
  let phoneConnectOrigin = normalizeRemoteConnectApi(savedPublicUrl);

  const auth = createAuth(prisma, {
    secret: env.authSecret,
    baseURL: env.authUrl,
    webOrigin: env.webOrigin,
    signupsEnabled: env.signupsEnabled,
    signupAllowlist: env.signupAllowlist,
    extraOrigins: [
      env.apiUrl,
      "quibt://",
      "exp://",
      "exp://*",
      ...env.trustedWebOrigins,
      ...(phoneConnectOrigin ? [phoneConnectOrigin] : []),
      ...(env.nodeEnv === "production"
        ? []
        : [
            "http://localhost:8081",
            "http://127.0.0.1:8081",
            "http://localhost:19006",
            "http://127.0.0.1:19006",
          ]),
    ],
    nodeEnv: env.nodeEnv,
    resendApiKey: env.resendApiKey,
    emailFrom: env.authEmailFrom,
    emailDisabled: env.authEmailDisabled,
  });
  const wakeupKind = env.wakeupDriver;
  const wakeup =
    wakeupKind === "memory"
      ? new InMemoryWakeupDriver()
      : new GraphileWakeupDriver(env.databaseUrl);
  const desktopGrantsByUser = await loadFolderGrantsByUser(env.dataDir);
  const secrets = new EncryptedSecretStore(env.encryptionKey);
  const sandboxOptions = {
    supervisorUrl: env.sandboxSupervisorUrl,
    supervisorToken: env.sandboxSupervisorToken,
    e2bApiKey: env.e2bApiKey,
    boxApiKey: env.boxApiKey,
    dataDir: env.dataDir,
    desktopGrantsByUser,
  };
  // The machine picker writes `deployment_settings.sandboxProvider`; this provider is what makes
  // that column mean something. `SANDBOX_PROVIDER` stays the fallback.
  const sandbox = createRoutingSandboxProvider({
    fallbackKind: env.sandboxProvider,
    options: sandboxOptions,
    readSelection: async () => ({
      saved: (
        await prisma.deploymentSettings.findUnique({
          where: { id: "default" },
          select: { sandboxProvider: true },
        })
      )?.sandboxProvider,
      canChooseMachine: editionGate({
        edition: env.edition,
        billingEnabled: env.billingEnabled,
      }).canChooseMachine,
    }),
    readOptions: async () =>
      sandboxOptionsFromSettings(
        await prisma.deploymentSettings.findUnique({
          where: { id: "default" },
        }),
        secrets,
        sandboxOptions,
      ),
    readComputerKind: async (botId) =>
      (
        await prisma.desktopSession.findUnique({
          where: { botId },
          select: { computer: { select: { kind: true } } },
        })
      )?.computer.kind ?? null,
    onError: (error) => console.error("sandbox routing", error),
  });
  const oauthLogins = new PiOAuthLogins();
  const home = new LocalAgentHomeStore(env.dataDir);
  const memory = new MarkdownMemoryStore(prisma);
  const stack = createConnectorStack({
    envApiKey: isComposioEnabled(env.composioApiKey) ? env.composioApiKey : undefined,
    loadStoredKey: storedComposioKeyLoader(prisma, secrets),
  });
  const connector = stack.destination;
  await connector.start();
  void stack.composio?.warmDirectory().catch(() => undefined);
  const runtime =
    env.agentRuntime === "scripted" ? new ScriptedAgentRuntime() : new PiAgentRuntime();
  const notifications = new ExpoPushProvider(prisma);
  const billingPolicy = env.billingEnabled
    ? {
        assertWithinPlan: (
          workspaceId: string,
          check: "tokens" | "computer" | "bots" | "subscription",
          tx?: Prisma.TransactionClient,
        ) => assertWorkspaceWithinPlan(tx ?? prisma, workspaceId, check),
      }
    : undefined;
  const executor = createRunExecutor({
    prisma,
    runtime,
    sandbox,
    memory,
    home,
    connector: stack.connector,
    secrets: [env.openRouterKey ?? "", env.composioApiKey ?? ""].filter(Boolean),
    secretStore: secrets,
    deploymentModelKey: env.openRouterKey,
    dataDir: env.dataDir,
    notifications,
    wakeup,
    billing: billingPolicy,
  });

  if (wakeupKind !== "graphile") {
    await wakeup.start({
      "run.continue": async (payload) => {
        await executor.continueRun(String(payload.runId), "api");
      },
      "routine.wakeup": async (payload) => {
        await executor.wakeRoutine(String(payload.routineId), "api");
      },
      "computer.sleep": async (payload) => {
        await sleepComputerIfIdle({ prisma, sandbox, wakeup }, String(payload.botId));
      },
      "control.reap": async (payload) => {
        const botId = payload.botId ? String(payload.botId) : undefined;
        const released = await reapControl({ db: prisma, wakeup }, botId ? { botId } : {});
        for (const releasedBotId of released) {
          await revokeControlScreenOrSchedule({ prisma, sandbox, wakeup }, releasedBotId);
        }
      },
      "control.screen.revoke": async (payload) => {
        const botId = String(payload.botId ?? "");
        if (!botId) return;
        const attempt = Number(payload.attempt ?? 1);
        await revokeControlScreenOrSchedule(
          { prisma, sandbox, wakeup },
          botId,
          Number.isFinite(attempt) ? attempt : 1,
        );
      },
    });
  }

  // Com Graphile, quem executa os runs é o processo do worker: a API só o enxerga pelo
  // batimento. Com o driver em memória, a própria API é o worker. `startedAt` é a carência do
  // reinício: no Compose o worker só parte depois do healthcheck da API.
  const workerPresence = createWorkerPresenceReader({
    prisma,
    inProcess: wakeupKind !== "graphile",
  });
  // Reconciliador leve: um run parado na fila — ou abandonado no meio, com o worker morto —
  // vira erro legível em vez de silêncio, com a frase no fio e o push no celular. O reaper de
  // leases não serve para isso: ele roda dentro do worker que não subiu.
  const queueReconciler =
    wakeupKind === "graphile"
      ? setInterval(() => {
          void failRunsWithoutWorker({
            prisma,
            workerSeenAt: () => workerPresence.seenAt(),
            apiStartedAt: workerPresence.startedAt,
            notifications,
          }).catch((error) => console.error("stranded run reconcile", error));
        }, QUEUED_RUN_RECONCILE_MS)
      : undefined;
  queueReconciler?.unref();

  const billing = env.billingEnabled
    ? createBilling({
        prisma,
        stripe: createStripeGateway(env.stripeSecretKey!),
        webOrigin: env.webOrigin,
        webhookSecret: env.stripeWebhookSecret,
        priceEnv: {
          STRIPE_PRICE_STARTER: env.stripePriceStarter,
          STRIPE_PRICE_PRO: env.stripePricePro,
        },
      })
    : undefined;

  const webhookService = createWebhookService({
    prisma,
    wakeup,
    buildPrompt: (input) =>
      webhookPrompt({
        configuredPrompt: input.webhook.prompt,
        payload: input.event.payload,
        receivedAt: input.receivedAt,
        deliveryId: input.deliveryId,
        eventName: input.event.eventName,
      }),
  });

  const router = createRouter({
    prisma,
    auth,
    billing,
    wakeup,
    sandbox,
    memory,
    home,
    secrets,
    oauthLogins,
    composio: stack.composio,
    webhookService,
    dataDir: env.dataDir,
    pool: created.pool,
    workerPresence,
    notifications,
    onDeploymentSettingsChanged: () => {
      sandbox.invalidate();
      stack.composio?.invalidateKey();
      void prisma.deploymentSettings
        .findUnique({
          where: { id: "default" },
          select: { webhookPublicUrl: true },
        })
        .then((row) => {
          phoneConnectOrigin = normalizeRemoteConnectApi(row?.webhookPublicUrl);
        })
        .catch(() => undefined);
    },
    env: {
      release: env.release,
      defaultProvider: env.defaultProvider,
      defaultModel: env.defaultModel,
      openRouterKey: env.openRouterKey,
      composioApiKey: isComposioEnabled(env.composioApiKey) ? env.composioApiKey : undefined,
      edition: env.edition,
      billingEnabled: env.billingEnabled,
      sandboxProvider: env.sandboxProvider,
      availableMachines: env.availableMachines,
      sandboxSupervisorUrl: env.sandboxSupervisorUrl,
      sandboxSupervisorToken: env.sandboxSupervisorToken,
      e2bApiKey: env.e2bApiKey,
      boxApiKey: env.boxApiKey,
      webOrigin: env.webOrigin,
      apiUrl: env.apiUrl,
      authUrl: env.authUrl,
      trustedWebOrigins: env.trustedWebOrigins,
      nodeEnv: env.nodeEnv,
      // Chave própria da tela: o segredo de sessão não assina capacidade de tela.
      screenProxySecret: screenCapabilityKey(env.authSecret),
      agentRuntime: env.agentRuntime,
      signupsEnabled: env.signupsEnabled,
    },
  });
  // Um handler que quebra tem de deixar rastro no servidor; o log diz o procedimento e o
  // erro, sem cabeçalho, cookie, corpo nem segredo.
  const rpc = new RPCHandler(router, {
    clientInterceptors: [onError((error, { path }) => logRpcError(path, error))],
  });
  /** Nonces já gastos da capacidade do desktop: vivem com esta instância da API. */
  const desktopCapabilityNonces = new Map<string, number>();
  const app = new Hono();
  app.use(
    "*",
    cors({
      origin: (origin) => {
        const trusted = withPublicConnectOrigin(env, phoneConnectOrigin);
        if (!origin) return env.nodeEnv === "production" ? "" : env.webOrigin;
        return isTrustedOrigin(origin, trusted) ? origin : "";
      },
      credentials: true,
    }),
  );
  app.on(["GET", "POST"], "/api/auth/*", async (c) => {
    const path = new URL(c.req.url).pathname.replace("/api/auth", "");
    const ip = requestClientIp(c, env.trustedProxyIps);
    const authLimit = authRateLimit(path);
    if (!allowRequest(clientKey(ip, authLimit.key), authLimit.limit, 60_000)) {
      return c.json({ message: "Muitas tentativas. Espere um minuto." }, 429);
    }
    if (blockedAuthPaths.some((blocked) => path.startsWith(blocked))) {
      return c.json({ error: "Not available in version 1" }, 404);
    }
    // The owner's signup switch lives in `deployment_settings`, but better-auth was configured
    // once at boot from SIGNUPS_ENABLED. Closing signups in the deployment screen did nothing.
    if (path.includes("sign-up")) {
      const denial = await signupDenial(prisma, c.req.raw);
      if (denial) return c.json({ message: denial.message }, denial.status);

      const prepared = await prepareFirstOwnerEnrollment(
        prisma,
        c.req.header("x-quibt-enrollment"),
      );
      // First-owner enrollment always needs the explicit installer capability. A loopback-looking
      // Host header is not physical-presence proof once a reverse proxy is involved.
      const enrollment = prepared.ok ? prepared.enrollment : undefined;
      if (!prepared.ok && !enrollment) {
        return c.json({ message: prepared.message }, 403);
      }

      if (enrollment) {
        const body = (await c.req.json().catch(() => null)) as {
          email?: unknown;
          password?: unknown;
          name?: unknown;
          image?: unknown;
          rememberMe?: unknown;
        } | null;
        if (!body || typeof body !== "object") {
          return c.json({ message: "Corpo inválido." }, 400);
        }
        // Sem e-mail e sem senha: o código da instalação já provou o controle da máquina.
        const email =
          typeof body.email === "string" && body.email.trim() ? body.email : generatedOwnerEmail();
        const password =
          typeof body.password === "string" && body.password
            ? body.password
            : generatedOwnerPassword();
        const name = typeof body.name === "string" ? body.name : "";
        const image = typeof body.image === "string" ? body.image : undefined;
        const rememberMe = body.rememberMe !== false;
        const allowlist = parseAllowlist(env.signupAllowlist);
        if (email && !emailAllowed(email, allowlist)) {
          return c.json({ message: "Este e-mail não pode criar conta" }, 400);
        }

        try {
          const committed = await commitFirstOwnerSignup(
            prisma,
            enrollment,
            { email, password, name, image },
            overrides.firstOwnerSignupHooks ?? {},
          );
          return await auth.api.signInEmail({
            body: { email: committed.email, password, rememberMe },
            headers: c.req.raw.headers,
            asResponse: true,
          });
        } catch (error) {
          const mapped = mapFirstOwnerSignupError(error);
          return c.json({ message: mapped.message }, mapped.status);
        }
      }

      return auth.handler(c.req.raw);
    }
    return auth.handler(c.req.raw);
  });

  app.post("/api/bootstrap/invites", async (c) => {
    const peer = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    if (!isLoopbackMintPeer(peer)) {
      return c.json({ error: "Not found" }, 404);
    }
    const ip = peer ?? "unknown";
    if (!(await checkPersistentBootstrapRateLimit(prisma, "mint", ip, env.encryptionKey, 10, 60))) {
      return c.json({ message: "Muitas tentativas. Espere um minuto." }, 429);
    }
    const supplied = c.req.header("x-quibt-bootstrap-secret");
    if (!isAuthorizedBootstrapSecret(supplied ?? "", env.bootstrapSecret)) {
      return c.json({ error: "Unauthorized" }, 401);
    }
    const minted = await mintBootstrapInvite(prisma);
    return c.json(minted);
  });

  app.post("/api/bootstrap/claim", async (c) => {
    const ip = requestBootstrapClaimClientIp(c, env.trustedProxyIps);
    if (
      !(await checkPersistentBootstrapRateLimit(prisma, "claim", ip, env.encryptionKey, 10, 60))
    ) {
      return c.json({ message: "Muitas tentativas. Espere um minuto." }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      code?: unknown;
      token?: unknown;
    };
    const code = typeof body.code === "string" ? body.code : "";
    const token = typeof body.token === "string" ? body.token : "";
    const result = token
      ? await claimBootstrapInviteToken(prisma, token)
      : await claimBootstrapInvite(prisma, code);
    if (!result.ok) {
      return c.json({ message: result.message }, 400);
    }
    return c.json({
      enrollmentToken: result.enrollmentToken,
      expiresAt: result.expiresAt,
    });
  });
  /**
   * Entrar em outro aparelho sem e-mail nem senha.
   *
   * Quem já está dentro pede um código; quem chega digita. A conta mora nesta
   * máquina, então provar acesso a um aparelho que já entrou é a prova que vale.
   * O código dura cinco minutos, serve uma vez e conta tentativas — ver
   * packages/core/src/device-code.ts.
   */
  /**
   * Abrir o app na máquina onde o Quibt roda já é entrar.
   *
   * A conta vive aqui dentro, e quem alcança `127.0.0.1` está no teclado desta
   * máquina — a mesma prova que criou a conta. Pedir login de novo a cada vez só
   * inventava uma senha para esquecer. De fora (VPS, celular, outra máquina na
   * rede), nada disso vale: lá a entrada é por código, com aprovação.
   *
   * Três travas, nesta ordem (ver `requestClaimsLocalBrowser`):
   * 1. a porta só existe quando `WEB_ORIGIN` e `BETTER_AUTH_URL` são loopback —
   *    configuração do servidor, que nenhum cliente escolhe;
   * 2. `x-forwarded-host` não é lido: o cliente o escolhe quando o proxy da frente
   *    não o sobrescreve, e era com ele que a LAN inteira virava dono;
   * 3. atrás do proxy do próprio web, a prova HMAC mais uma cadeia de encaminhamento
   *    só de loopback. Faixa privada não vale: pela ponte do Docker o vizinho do
   *    Wi-Fi chega com o mesmo endereço do dono.
   */
  app.post("/api/local/session", async (c) => {
    // Dois caminhos, e só dois: rede (loopback estrito) ou posse do segredo local, que é
    // como o app do desktop entra quando a stack roda em Docker. Ver `desktopSessionKey`.
    const capability = c.req.header(DESKTOP_CAPABILITY_HEADER);
    const provenDesktop = capability
      ? consumeDesktopSessionCapability(capability, {
          authSecret: env.authSecret,
          method: c.req.method,
          path: requestPathname(c.req.url),
          used: desktopCapabilityNonces,
        })
      : false;
    if (!provenDesktop && !clientReachedLoopback(c, env))
      return c.json({ error: "Not found" }, 404);
    const existing = await auth.api.getSession({
      headers: sessionHeaders(c.req.raw),
    });
    if (existing?.user) return c.json({ ok: true, name: existing.user.name ?? "" });
    const settings = await prisma.deploymentSettings
      .findUnique({ where: { id: "default" }, select: { ownerUserId: true } })
      .catch(() => null);
    const ownerId = settings?.ownerUserId;
    if (!ownerId) return c.json({ message: "Esta instalação ainda não tem dono." }, 409);
    const owner = await prisma.user.findUnique({
      where: { id: ownerId },
      select: { name: true },
    });
    if (!owner) return c.json({ message: "Esta instalação ainda não tem dono." }, 409);
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createSession(ownerId, false);
    // O navegador entra pelo cookie; o app do celular usa o mesmo token como Bearer.
    c.header(
      "set-cookie",
      await sessionSetCookie(auth, created.token, new Date(created.expiresAt)),
    );
    return c.json({ ok: true, token: created.token, name: owner.name ?? "" });
  });

  app.post("/api/pairing/code", async (c) => {
    const session = await auth.api.getSession({
      headers: sessionHeaders(c.req.raw),
    });
    if (!session?.user) return c.json({ message: "Entre primeiro." }, 401);
    const issued = await issueDeviceCode(prisma, session.user.id);
    void purgeStaleDeviceCodes(prisma);
    return c.json({
      code: issued.code,
      expiresAt: issued.expiresAt.toISOString(),
    });
  });

  app.post("/api/pairing/claim", async (c) => {
    const ip = requestClientIp(c, env.trustedProxyIps);
    // Oito caracteres só são seguros com limite: aqui, e por código no banco.
    if (
      !(await checkPersistentBootstrapRateLimit(prisma, "pairing", ip, env.encryptionKey, 10, 60))
    ) {
      return c.json({ message: "Muitas tentativas. Espere um minuto." }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      code?: unknown;
      device?: unknown;
    };
    const claimed = await claimDeviceCode(
      prisma,
      typeof body.code === "string" ? body.code : "",
      typeof body.device === "string" ? body.device : "",
    );
    if (!claimed.ok) return c.json({ message: claimed.message }, 400);
    // Acertar o código não entra: devolve o pedido, e a sessão só sai depois do sim.
    return c.json({ requestId: claimed.requestId, secret: claimed.secret });
  });

  /**
   * O celular pergunta se já aprovaram. O token de sessão nasce aqui, uma vez só, e
   * somente quando quem está no computador disse sim.
   */
  app.post("/api/pairing/poll", async (c) => {
    const ip = requestClientIp(c, env.trustedProxyIps);
    if (
      !(await checkPersistentBootstrapRateLimit(prisma, "pairing", ip, env.encryptionKey, 60, 60))
    ) {
      return c.json({ message: "Muitas tentativas. Espere um minuto." }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as {
      requestId?: unknown;
      secret?: unknown;
    };
    const outcome = await pollDeviceRequest(
      prisma,
      typeof body.requestId === "string" ? body.requestId : "",
      typeof body.secret === "string" ? body.secret : "",
    );
    if (outcome.state !== "approved") return c.json({ state: outcome.state });
    const ctx = await auth.$context;
    const created = await ctx.internalAdapter.createSession(outcome.userId, false);
    const user = await prisma.user.findUnique({
      where: { id: outcome.userId },
      select: { name: true },
    });
    // O navegador (app do desktop, Chrome) entra pelo cookie; o celular usa o token.
    c.header(
      "set-cookie",
      await sessionSetCookie(auth, created.token, new Date(created.expiresAt)),
    );
    return c.json({
      state: "approved",
      token: created.token,
      name: user?.name ?? "",
    });
  });

  /**
   * Redefinir a senha numa instalação sem e-mail. Quem está sentado na máquina já manda
   * nela; o que não pode é isso valer pela rede. Por isso: só de loopback, só quando o
   * deploy não tem mailer, e o link sai uma vez só, com validade curta.
   */
  app.post("/api/local/reset-link", async (c) => {
    const peer = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
      ?.incoming?.socket?.remoteAddress;
    const ip = requestClientIp(c, env.trustedProxyIps);
    if (!requestIsFromThisMachine(peer, forwardedClientIp(c), env.trustedProxyIps)) {
      return c.json({ error: "Not found" }, 404);
    }
    const mailer = mailerEnabled({
      emailDisabled: env.authEmailDisabled,
      resendApiKey: env.resendApiKey,
    });
    if (mailer) {
      return c.json(
        {
          error: "Este servidor envia e-mail; use o link que chegou na caixa.",
        },
        400,
      );
    }
    if (!allowRequest(clientKey(ip, "local-reset"), 5, 60_000)) {
      return c.json({ message: "Muitas tentativas. Espere um minuto." }, 429);
    }
    const body = (await c.req.json().catch(() => ({}))) as { email?: unknown };
    const email = typeof body.email === "string" ? body.email.trim() : "";
    if (!email) return c.json({ error: "Informe o e-mail da conta" }, 400);
    await auth.api
      .requestPasswordReset({
        body: { email, redirectTo: `${env.webOrigin}/reset-password` },
      })
      .catch(() => undefined);
    const url = takeLocalResetLink(email);
    // Sem conta com esse e-mail não há link — e a resposta é a mesma, para não revelar
    // quais e-mails existem nesta instalação.
    return c.json({ url: url ?? null });
  });

  app.use(
    "/rpc/*",
    bodyLimit({
      maxSize: 1024 * 1024,
      onError: (c) => c.json({ message: "A requisição é grande demais." }, 413),
    }),
  );
  app.use("/rpc/*", async (c, next) => {
    const path = new URL(c.req.url).pathname;
    const limit = rpcMutationRateLimit(path);
    if (limit !== null) {
      const ip = requestClientIp(c, env.trustedProxyIps);
      if (!allowRequest(clientKey(ip, `rpc-mutation:${path}`), limit, 60_000)) {
        return c.json({ message: "Muitas tentativas. Espere um minuto." }, 429);
      }
    }
    await next();
  });
  app.use("/rpc/*", async (c, next) => {
    const session = await auth.api.getSession({
      headers: sessionHeaders(c.req.raw),
    });
    const actor = session?.user
      ? await requireMembership(prisma, session.user.id).catch(() => null)
      : null;
    const { matched, response } = await rpc.handle(c.req.raw, {
      prefix: "/rpc",
      context: {
        actor,
        signal: c.req.raw.signal,
        // O endereço por onde este cliente chegou: é por ele que a tela do bot volta.
        screenOrigin: screenProxyOrigin({
          requestUrl: c.req.url,
          forwardedProto: c.req.header("x-forwarded-proto") ?? null,
          forwardedHost: c.req.header("x-forwarded-host") ?? null,
          // Mesmo critério do IP do cliente: cabeçalho encaminhado só conta vindo de um proxy nosso.
          forwardedTrusted: requestFromTrustedProxy(c, env.trustedProxyIps),
          fallback: env.webOrigin,
        }),
      },
    });
    if (matched) {
      const streamed = withStreamingHeaders(response);
      return c.newResponse(streamed.body, streamed);
    }
    await next();
  });

  /**
   * Arquivos do fio. Ficam fora do oRPC porque atravessam bytes crus: o upload chega como
   * multipart e o download sai como o arquivo mesmo, para o navegador saber abrir ou salvar.
   */
  async function fileActor(c: Context) {
    const session = await auth.api.getSession({
      headers: sessionHeaders(c.req.raw),
    });
    if (!session?.user) return null;
    return requireMembership(prisma, session.user.id).catch(() => null);
  }

  app.post(
    "/files/:botId",
    bodyLimit({
      maxSize: MAX_ARTIFACT_BYTES + 1024 * 1024,
      onError: (c) => c.json({ message: "O arquivo é grande demais." }, 413),
    }),
    async (c) => {
      const actor = await fileActor(c);
      if (!actor) return c.json({ message: "Entre na sua conta." }, 401);
      const botId = c.req.param("botId");
      const bot = await prisma.bot.findFirst({
        where: { id: botId, workspaceId: actor.workspaceId },
        select: { id: true },
      });
      if (!bot) return c.json({ message: "Bot não encontrado." }, 404);

      const body = await c.req.parseBody();
      const file = body.file;
      if (!(file instanceof File)) return c.json({ message: "Mande um arquivo." }, 400);
      const bytes = new Uint8Array(await file.arrayBuffer());
      try {
        const stored = await putArtifact(prisma, {
          workspaceId: actor.workspaceId,
          botId: bot.id,
          userId: actor.userId,
          name: file.name || "arquivo",
          mimeType: file.type || "application/octet-stream",
          bytes,
        });
        return c.json({ ...stored, image: isImage(stored.mimeType) });
      } catch (error) {
        return c.json(
          {
            message: error instanceof Error ? error.message : "Não deu para guardar.",
          },
          400,
        );
      }
    },
  );

  app.get("/files/:id", async (c) => {
    const actor = await fileActor(c);
    if (!actor) return c.json({ message: "Entre na sua conta." }, 401);
    const found = await readArtifact(prisma, actor.workspaceId, c.req.param("id"));
    if (!found) return c.json({ message: "Arquivo não encontrado." }, 404);
    // Imagem abre na própria página; o resto o navegador salva com o nome certo.
    const how = isImage(found.mimeType) ? "inline" : "attachment";
    return c.body(found.bytes as unknown as ArrayBuffer, 200, {
      "Content-Type": found.mimeType,
      "Content-Length": String(found.bytes.byteLength),
      "Content-Disposition": `${how}; filename*=UTF-8''${encodeURIComponent(found.name)}`,
      "Cache-Control": "private, max-age=3600",
    });
  });

  if (billing) {
    // Stripe webhooks are signed over the raw request body, so this route
    // lives outside the oRPC handler and reads the body as text.
    app.post(
      "/billing/webhook",
      bodyLimit({
        maxSize: 1024 * 1024,
        onError: (c) => c.json({ error: "Webhook payload too large" }, 413),
      }),
      async (c) => {
        const signature = c.req.header("stripe-signature");
        if (!signature) return c.json({ error: "Missing stripe-signature header" }, 400);
        const payload = await c.req.text();
        let event: ReturnType<typeof billing.verifyWebhook>;
        try {
          event = billing.verifyWebhook(payload, signature);
        } catch {
          return c.json({ error: "Invalid webhook signature" }, 400);
        }
        try {
          const result = await billing.handleEvent(event);
          return c.json({ received: true, duplicate: result.duplicate });
        } catch {
          // Non-2xx makes Stripe retry the event later.
          return c.json({ error: "Webhook processing failed" }, 500);
        }
      },
    );
  }
  /**
   * `/hooks/*` is the public, unauthenticated-by-cookie surface an outside system posts
   * to. It never shares a response shape with `/rpc/*`: a bad endpoint or secret gets the
   * same generic 401 an emitter would see for a typo, never a hint about which case
   * applied, and nothing here ever echoes back the internal `/rpc` API surface.
   */
  app.use("/hooks/*", async (c, next) => {
    await next();
    c.res.headers.set("Cache-Control", "no-store");
  });

  app.get("/hooks/health", (c) => c.json({ app: "quibt-webhooks" as const, ready: true }));

  /**
   * Every POST here registers three handlers in this exact order: authenticate against
   * `service.authorize()` using only headers/path (never the body), enforce `bodyLimit`,
   * then parse and hand off to `service.receive()`. `bodyLimit` only reads request bytes
   * when it has to (no `Content-Length`), and that read never happens before auth ran,
   * so an unauthenticated request never causes this process to buffer its body.
   */
  function webhookAuth(pathSecretParam?: "secret") {
    return async (c: Context, next: () => Promise<void>) => {
      const endpointId = webhookEndpointIdParam(c);
      // Checked before any DB read/write: a wrong-secret flood — or an enumeration of
      // invented endpoint ids — must be turned away here, not after it has already cost
      // `service.authorize()` a query (and, on a wrong guess, a write) every single
      // time. `allowWebhookRequest` lives in its own store, never the one shared by
      // `/api/auth/*` and `/rpc/*`, precisely because `endpointId` here needs no
      // authentication to invent.
      const ip = requestClientIp(c, env.trustedProxyIps);
      if (!allowWebhookRequest(ip, endpointId)) {
        return c.json({ accepted: false as const, error: "rate_limited" }, 429);
      }
      const pathSecret = pathSecretParam ? c.req.param(pathSecretParam) : undefined;
      const secret = readWebhookSecret(c.req.raw.headers, pathSecret);
      const metadata = {
        eventName: readWebhookEventName(c.req.raw.headers),
        deliveryId: readWebhookDeliveryId(c.req.raw.headers),
      };
      const authorized = secret
        ? await webhookService.authorize(endpointId, secret, metadata)
        : false;
      if (!authorized) {
        return c.json({ accepted: false as const, error: "invalid_secret" }, 401);
      }
      await next();
    };
  }

  const webhookBodyLimit = bodyLimit({
    maxSize: WEBHOOK_MAX_BODY_BYTES,
    onError: async (c) => {
      const endpointId = webhookEndpointIdParam(c);
      await webhookService.recordRejected(endpointId, 413, "payload_too_large", {
        eventName: readWebhookEventName(c.req.raw.headers),
        deliveryId: readWebhookDeliveryId(c.req.raw.headers),
      });
      return c.json({ accepted: false as const, error: "payload_too_large" }, 413);
    },
  });

  async function webhookProcessor(c: Context, pathSecretParam?: "secret") {
    const endpointId = webhookEndpointIdParam(c);
    const pathSecret = pathSecretParam ? c.req.param(pathSecretParam) : undefined;
    // Re-derived rather than threaded through `c.set`: authentication already proved one
    // exists, so this is just re-reading the same headers/path, never a new trust decision.
    const secret = readWebhookSecret(c.req.raw.headers, pathSecret) ?? "";
    const eventName = readWebhookEventName(c.req.raw.headers);
    const deliveryId = readWebhookDeliveryId(c.req.raw.headers);

    try {
      let raw: string;
      try {
        raw = await c.req.text();
      } catch {
        await webhookService.recordRejected(endpointId, 400, "body_read_failed", {
          eventName,
          deliveryId,
        });
        return c.json({ accepted: false as const, error: "body_read_failed" }, 400);
      }

      let payload: unknown;
      try {
        payload = parseWebhookPayload(raw, c.req.header("content-type"));
      } catch (error) {
        if (error instanceof WebhookPayloadError) {
          await webhookService.recordRejected(endpointId, error.status, "invalid_json", {
            eventName,
            deliveryId,
          });
          return c.json(
            { accepted: false as const, error: "invalid_json" },
            error.status as ContentfulStatusCode,
          );
        }
        throw error;
      }

      // `service.receive()` re-authenticates against the secret independently: a rotation
      // landing between the check above and this call must still be enforced correctly.
      const result = await webhookService.receive({
        endpointId,
        secret,
        event: { payload, eventName, deliveryId },
      });
      if (result.outcome === "rejected") {
        return c.json(
          { accepted: false as const, error: result.reason ?? "rejected" },
          result.statusCode as ContentfulStatusCode,
        );
      }
      return c.json(
        {
          accepted: true as const,
          duplicate: result.duplicate,
          runId: result.runId,
        },
        202,
      );
    } catch (error) {
      // Anything unaccounted for above: a genuinely unexpected exception, or a real race
      // (e.g. the webhook is deleted between this middleware's `authorize()` and the
      // `receive()` call above). The emitter gets a generic, no-store JSON 500 — never a
      // stack trace or a raw DB error message — and `recordRejected` is best-effort: if it
      // also fails (the webhook it would attach to may be the very thing that vanished),
      // that failure must never change the response already decided below.
      console.error("webhook processing failed", error);
      await webhookService
        .recordRejected(endpointId, 500, "processing_failed", {
          eventName,
          deliveryId,
        })
        .catch(() => undefined);
      return c.json({ accepted: false as const, error: "processing_failed" }, 500);
    }
  }

  app.post("/hooks/:endpointId", webhookAuth(), webhookBodyLimit, (c) => webhookProcessor(c));
  app.post("/hooks/:endpointId/:secret", webhookAuth("secret"), webhookBodyLimit, (c) =>
    webhookProcessor(c, "secret"),
  );

  app.get("/health", async (c) =>
    c.json({
      ok: true,
      edition: env.edition,
      runtime: env.agentRuntime,
      sandbox: env.sandboxProvider,
      composio: (await stack.composio?.available().catch(() => false)) ?? false,
      wakeup: wakeupKind,
      worker: await workerPresence.read(),
    }),
  );
  app.get("/ready", async (c) => {
    try {
      await prisma.$queryRawUnsafe("SELECT 1");
      const ready = readinessPayload(true);
      return c.json(ready.body, ready.status);
    } catch {
      const unavailable = readinessPayload(false);
      return c.json(unavailable.body, unavailable.status);
    }
  });

  return {
    app,
    prisma,
    wakeup,
    sandbox,
    connector,
    composio: stack.composio,
    executor,
    webhookService,
    stop: async () => {
      oauthLogins.abortAll();
      if (queueReconciler) clearInterval(queueReconciler);
      await wakeup.stop();
      await connector.stop();
      await prisma.$disconnect().catch(() => undefined);
      if (created.pool) await closeThreadNotifier(created.pool).catch(() => undefined);
      await created.pool?.end().catch(() => undefined);
    },
  };
}

/** Both `/hooks/:endpointId` and `/hooks/:endpointId/:secret` always declare this
 * param, so a missing value here would mean Hono matched the wrong route entirely —
 * this only exists to satisfy `param()`'s general `string | undefined` signature. */
function webhookEndpointIdParam(c: Context): string {
  return c.req.param("endpointId") ?? "";
}

/**
 * Só o próprio computador: nada de confiar em cabeçalho, que o cliente escolhe.
 *
 * Loopback é a faixa inteira 127.0.0.0/8 mais `::1` — endereços que a placa de rede
 * nunca leva para fora. Faixa privada (10/8, 172.16/12, 192.168/16), link-local
 * (169.254/16) e CGNAT (100.64/10) são a rede de outra pessoa e ficam de fora.
 */
export function isLoopbackAddress(address: string | undefined): boolean {
  if (!address) return false;
  const plain = address
    .replace(/^::ffff:/, "")
    .trim()
    .toLowerCase();
  const bare = plain.startsWith("[") ? plain.slice(1, plain.indexOf("]")) : plain;
  if (bare === "::1" || bare === "localhost") return true;
  return /^127\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(bare);
}

/** Minting bootstrap invites trusts only the transport socket, never forwarded headers. */
export function isLoopbackMintPeer(peerAddress: string | undefined): boolean {
  return isLoopbackAddress(peerAddress);
}

/**
 * proxy reverso, que é como o self-host roda, **todo** navegador da rede chega com
 * `remoteAddress` de loopback, o do próprio proxy. Por isso, quando o deploy declara
 * proxies confiáveis, o socket precisa ser loopback **e** o IP que o proxy anuncia
 * também. Proxy que não anuncia IP nenhum é recusado: sem essa informação não dá para
 * distinguir o navegador desta máquina do celular do vizinho.
 */
export function requestIsFromThisMachine(
  peerAddress: string | undefined,
  forwardedClientIp: string | undefined,
  trustedProxyIps: readonly string[],
): boolean {
  if (!isLoopbackAddress(peerAddress)) return false;
  // Forwarding headers mean a proxy is present. An empty trust list cannot prove the proxy's
  // client, so fail closed instead of treating the proxy's loopback socket as the user.
  if (forwardedClientIp && trustedProxyIps.length === 0) return false;
  if (trustedProxyIps.length === 0) return true;
  if (!forwardedClientIp) return false;
  return isLoopbackAddress(forwardedClientIp);
}

/** O IP que um proxy confiável anuncia, se anunciar algum. */
function forwardedClientIp(c: {
  req: { header(name: string): string | undefined };
}): string | undefined {
  const real = c.req.header("x-real-ip")?.trim();
  if (real) return real;
  const forwarded = c.req.header("x-forwarded-for");
  if (!forwarded) return undefined;
  const hops = forwarded
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
  return hops[hops.length - 1];
}

function requestBootstrapClaimClientIp(
  c: { req: { header(name: string): string | undefined }; env?: unknown },
  trustedProxyIps: readonly string[],
): string {
  const peerIp = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  const boundedPeer = peerIp?.trim().slice(0, 128) ?? "unknown";
  if (!trustedProxyIps.includes(boundedPeer)) {
    return boundedPeer;
  }
  return clientIp({ get: (name) => c.req.header(name) }, peerIp, trustedProxyIps);
}

/**
 * O proxy do web roda junto da API (mesmo compose, mesma máquina), e é ele quem
 * encaminha o host do navegador. Um cliente qualquer não é proxy: os cabeçalhos
 * `x-forwarded-*` dele não valem nada aqui.
 */
function requestFromTrustedProxy(
  c: { req: { header(name: string): string | undefined }; env?: unknown },
  trustedProxyIps: readonly string[],
): boolean {
  const peerIp = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  const peer = (peerIp ?? "").trim().slice(0, 128);
  if (!peer) return false;
  if (trustedProxyIps.includes(peer)) return true;
  // O proxy do próprio produto fala com a API pela rede interna do compose: um peer
  // privado é o web ao lado, nunca a internet.
  return isPrivatePeer(peer);
}

/** Loopback e faixas privadas — o que só existe dentro da máquina ou da rede do deploy. */
/** O host que o cliente digitou/abriu, e não o do salto interno entre containers. */
export function loopbackClientHost(host: string | undefined | null): boolean {
  const value = (host ?? "").split(",")[0]?.trim().toLowerCase() ?? "";
  if (!value) return false;
  const name = value.startsWith("[") ? value.slice(0, value.indexOf("]") + 1) : value.split(":")[0];
  return isLoopbackAddress(name);
}

/**
 * Uma chave, um trabalho.
 *
 * O `BETTER_AUTH_SECRET` assina o cookie de sessão. A capacidade da tela e a prova de
 * proxy interno usam chaves **derivadas** dele com um rótulo próprio, do mesmo jeito que
 * `resolveSupervisorToken`/`resolveBootstrapSecret` fazem em `packages/core/src/secrets-guard.ts`.
 * Sem isso, uma URL de tela vazada era um oráculo de HMAC da chave de sessão, e a mesma
 * chave valia nos três domínios. Trocar um rótulo invalida só aquele domínio — e os dois
 * lados (quem assina e quem verifica) precisam derivar o MESMO valor.
 */
export const SCREEN_CAPABILITY_LABEL = "quibt-bot/screen-capability/v1";
export const INTERNAL_PROXY_LABEL = "quibt-bot/internal-proxy-proof/v1";

export function deriveDomainKey(authSecret: string, label: string): string {
  return createHmac("sha256", authSecret).update(label).digest("base64url");
}

/** Chave que assina a capacidade do proxy de tela (`/novnc/…`). */
export function screenCapabilityKey(authSecret: string): string {
  return deriveDomainKey(authSecret, SCREEN_CAPABILITY_LABEL);
}

/** Chave que assina a prova injetada pelo proxy do web do próprio Quibt. */
export function internalProxyKey(authSecret: string): string {
  return deriveDomainKey(authSecret, INTERNAL_PROXY_LABEL);
}

/**
 * Capacidade do app do desktop: posse do segredo local, não posição de rede.
 *
 * Com a stack em Docker, o navegador do dono chega à API pelo mesmo `172.17.0.1` de
 * qualquer aparelho do Wi-Fi — a 3100 é publicada em `0.0.0.0` de propósito, para o QR do
 * celular. Endereço, ali, não separa ninguém. O Electron, porém, administra a instalação:
 * ele escreve e lê o `quibt.env` (modo 0600) e pode provar que tem o segredo. Quem tem
 * esse segredo já poderia forjar o cookie assinado de sessão, então a capacidade não
 * entrega poder novo — ela só evita que o dono fique do lado de fora.
 *
 * O valor é `v1.<instante>.<nonce>.<assinatura>`, vale por um minuto, serve uma vez só e
 * está preso ao método e ao caminho: um cabeçalho estático lido do disco não se reaproveita.
 */
export const DESKTOP_SESSION_LABEL = "quibt-bot/desktop-local-session/v1";
export const DESKTOP_CAPABILITY_HEADER = "x-quibt-desktop-session";
export const DESKTOP_CAPABILITY_TTL_MS = 60_000;
/** Relógios do host e do container andam juntos; isto só absorve o arredondamento. */
const DESKTOP_CAPABILITY_SKEW_MS = 5_000;
/** Teto do mapa de nonces: um cliente barulhento não pode crescer memória sem fim. */
const DESKTOP_NONCE_LIMIT = 1_000;

export function desktopSessionKey(authSecret: string): string {
  return deriveDomainKey(authSecret, DESKTOP_SESSION_LABEL);
}

export function signDesktopSessionCapability(input: {
  authSecret: string;
  method: string;
  path: string;
  issuedAt: number;
  nonce: string;
}): string {
  const signature = createHmac("sha256", desktopSessionKey(input.authSecret))
    .update(`v1:${input.method.toUpperCase()}:${input.path}:${input.issuedAt}:${input.nonce}`)
    .digest("base64url");
  return `v1.${input.issuedAt}.${input.nonce}.${signature}`;
}

/**
 * Confere e **gasta** a capacidade. `used` guarda os nonces já vistos até o vencimento;
 * repetir o mesmo cabeçalho não entra duas vezes.
 */
export function consumeDesktopSessionCapability(
  capability: string | undefined,
  input: {
    authSecret: string;
    method: string;
    path: string;
    used: Map<string, number>;
    now?: number;
  },
): boolean {
  const now = input.now ?? Date.now();
  for (const [nonce, expiresAt] of input.used) {
    if (expiresAt <= now) input.used.delete(nonce);
  }
  const parts = (capability ?? "").split(".");
  if (parts.length !== 4 || parts[0] !== "v1") return false;
  const issuedAt = Number(parts[1]);
  const nonce = parts[2] ?? "";
  if (!Number.isSafeInteger(issuedAt) || !/^[A-Za-z0-9_-]{1,64}$/.test(nonce)) return false;
  if (issuedAt > now + DESKTOP_CAPABILITY_SKEW_MS) return false;
  if (issuedAt <= now - DESKTOP_CAPABILITY_TTL_MS) return false;
  if (input.used.has(nonce)) return false;
  const expected = signDesktopSessionCapability({
    authSecret: input.authSecret,
    method: input.method,
    path: input.path,
    issuedAt,
    nonce,
  });
  if (!isAuthorizedBootstrapSecret(capability ?? "", expected)) return false;
  if (input.used.size >= DESKTOP_NONCE_LIMIT) {
    const oldest = input.used.keys().next();
    if (!oldest.done) input.used.delete(oldest.value);
  }
  input.used.set(nonce, issuedAt + DESKTOP_CAPABILITY_TTL_MS);
  return true;
}

export function internalProxyProof(secret: string): string {
  return createHmac("sha256", internalProxyKey(secret))
    .update("quibt-local-browser-proxy-v1")
    .digest("base64url");
}

/**
 * Onde "abrir o app já é entrar" pode existir.
 *
 * O auto-login entrega a conta do dono sem credencial nenhuma; ele só faz sentido numa
 * instalação que fala consigo mesma. `WEB_ORIGIN` e `BETTER_AUTH_URL` são configuração do
 * servidor — nenhum cliente os escolhe. Se qualquer um dos dois for um endereço que a rede
 * alcança (IP de LAN, domínio público atrás de TLS de terceiro), a porta simplesmente não
 * existe: lá a entrada é por código, com aprovação.
 */
export function deploymentAllowsLocalSession(env: { webOrigin: string; authUrl: string }): boolean {
  return [env.webOrigin, env.authUrl].every((origin) => {
    try {
      return isLoopbackAddress(new URL(origin).hostname);
    } catch {
      return false;
    }
  });
}

/** O caminho pedido, sem query: é a ele que a capacidade do desktop está presa. */
function requestPathname(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url.split("?")[0] ?? url;
  }
}

/** Toda a cadeia do `X-Forwarded-For`, na ordem em que os proxies escreveram. */
export function forwardedHops(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((hop) => hop.trim())
    .filter(Boolean);
}

export function requestClaimsLocalBrowser(input: {
  clientHost: string | undefined;
  peerAddress: string | undefined;
  forwardedHops: readonly string[];
  proxyProof: string | undefined;
  authSecret: string;
  /** `deploymentAllowsLocalSession(env)`: configuração do servidor, não do cliente. */
  deployIsLocal: boolean;
}): boolean {
  if (!input.deployIsLocal) return false;
  if (!loopbackClientHost(input.clientHost)) return false;

  // Sem cabeçalho de encaminhamento não há proxy no caminho: o kernel prova que o socket
  // nasceu nesta máquina, e isso é o mais perto de "está no teclado" que dá para chegar.
  if (input.forwardedHops.length === 0) return isLoopbackAddress(input.peerAddress);

  // Com proxy no caminho, quem fala com a API é o web do próprio Quibt (loopback no
  // `pnpm dev`, rede interna do compose no Docker) e precisa apresentar a prova HMAC.
  if (!isLoopbackAddress(input.peerAddress) && !isPrivatePeer(input.peerAddress ?? "")) {
    return false;
  }
  if (!isAuthorizedBootstrapSecret(input.proxyProof ?? "", internalProxyProof(input.authSecret))) {
    return false;
  }
  // A prova só diz "passei pelo web", nunca *quem* chamou o web: ela é injetada em toda
  // requisição encaminhada. Quem diz isso é a cadeia de IPs, e um endereço privado é a LAN
  // inteira (ou a ponte do Docker, que faz a rede virar o mesmo 172.17.0.1 do dono). Por
  // isso vale só loopback, e a cadeia toda: um salto público antes do último significa que
  // alguém na frente já encaminhou outro cliente.
  return input.forwardedHops.every((hop) => isLoopbackAddress(hop));
}

function clientReachedLoopback(
  c: {
    req: { header(name: string): string | undefined; url: string };
    env?: unknown;
  },
  env: { authSecret: string; webOrigin: string; authUrl: string },
): boolean {
  // `x-forwarded-host` é escolhido pelo cliente sempre que o proxy da frente não o
  // sobrescreve — e o do vite repassa o que chegou. Aqui vale só o Host do transporte.
  let clientHost = c.req.header("host");
  try {
    clientHost ??= new URL(c.req.url).host;
  } catch {
    clientHost = undefined;
  }
  const peerAddress = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return requestClaimsLocalBrowser({
    clientHost,
    peerAddress,
    // A cadeia inteira, não só o último salto: `X-Real-IP` é ignorado de propósito.
    forwardedHops: forwardedHops(c.req.header("x-forwarded-for")),
    proxyProof: c.req.header("x-quibt-internal-proxy"),
    authSecret: env.authSecret,
    deployIsLocal: deploymentAllowsLocalSession(env),
  });
}

export function isPrivatePeer(peer: string): boolean {
  const host = peer.replace(/^::ffff:/, "");
  if (host === "127.0.0.1" || host === "::1" || host === "localhost") return true;
  if (/^10\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  if (/^192\.168\.\d{1,3}\.\d{1,3}$/.test(host)) return true;
  return /^172\.(1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}$/.test(host);
}

function requestClientIp(
  c: { req: { header(name: string): string | undefined }; env?: unknown },
  trustedProxyIps: readonly string[],
) {
  const peerIp = (c.env as { incoming?: { socket?: { remoteAddress?: string } } } | undefined)
    ?.incoming?.socket?.remoteAddress;
  return clientIp({ get: (name) => c.req.header(name) }, peerIp, trustedProxyIps);
}

/**
 * Whether the deployment's own settings refuse this sign-up. better-auth applies SIGNUPS_ENABLED
 * on its own too, so the two gates read as an AND — but they can no longer disagree: quando a
 * variável está definida, a subida alinha `deployment_settings.signupsEnabled` com ela e a tela
 * recusa gravar o campo. Sem a variável, vale só o que está salvo (e o padrão salvo é fechado).
 *
 * O cadastro nasce fechado, e o primeiro dono não pode ficar do lado de fora por causa disso:
 * enquanto o deploy não tem dono, o interruptor ainda não vale — quem entra prova o controle
 * da máquina com o código do instalador, checado logo depois desta porta.
 */
export function deploymentSignupDenial(
  settings: { signupsEnabled: boolean; signupAllowlist: string | null } | null,
  email: string,
  options: { firstOwner?: boolean } = {},
): string | null {
  if (!settings) return null;
  if (!settings.signupsEnabled && !options.firstOwner) {
    return "Este deploy não está aceitando novas contas.";
  }
  const allowlist = parseAllowlist(settings.signupAllowlist ?? undefined);
  if (email && !emailAllowed(email, allowlist)) return "Este e-mail não pode criar conta";
  return null;
}

/** Reads the saved settings and the request email; a broken read must not open the door. */
async function signupDenial(
  prisma: PrismaClient,
  request: Request,
): Promise<{ message: string; status: 403 | 503 } | null> {
  let settings: {
    signupsEnabled: boolean;
    signupAllowlist: string | null;
  } | null;
  let firstOwner: boolean;
  try {
    [settings, firstOwner] = await Promise.all([
      prisma.deploymentSettings.findUnique({
        where: { id: "default" },
        select: { signupsEnabled: true, signupAllowlist: true },
      }),
      deploymentNeedsFirstOwner(prisma),
    ]);
  } catch {
    return {
      message: "Não foi possível verificar se este deploy aceita novas contas.",
      status: 503,
    };
  }
  const body = await request
    .clone()
    .json()
    .catch(() => null);
  const email =
    body && typeof body === "object" && "email" in body
      ? String((body as { email?: string }).email ?? "")
      : "";
  const message = deploymentSignupDenial(settings, email, { firstOwner });
  return message ? { message, status: 403 } : null;
}

export function readinessPayload(databaseReady: boolean) {
  return databaseReady
    ? { body: { ok: true as const }, status: 200 as const }
    : { body: { ok: false as const }, status: 503 as const };
}

/**
 * O cookie de sessão que o navegador vai mandar de volta — assinado como o better-auth
 * assina (HMAC-SHA256 do token em base64, `token.assinatura`, URL-encoded), com o nome e
 * as opções que ele mesmo usa (em https o nome ganha o prefixo __Secure-). Um cookie cru
 * era aceito por ninguém: "abrir já é entrar" e "entrar com código" gravavam a sessão no
 * banco e o navegador continuava deslogado.
 */
type SessionCookieAttributes = {
  path?: string;
  httpOnly?: boolean;
  sameSite?: string;
  secure?: boolean;
  domain?: string;
};

export function signedSessionCookie(
  cookie: { name: string; attributes: SessionCookieAttributes },
  secret: string,
  token: string,
  expiresAt: Date,
  now = new Date(),
): string {
  // O leitor do cookie é o better-call: `token.assinatura`, assinatura em base64 padrão
  // (com =), tudo URL-encoded — exatamente o que `signCookieValue` produz do outro lado.
  const signature = createHmac("sha256", secret).update(token).digest("base64");
  const value = encodeURIComponent(`${token}.${signature}`);
  const maxAge = Math.max(60, Math.floor((expiresAt.getTime() - now.getTime()) / 1000));
  const opts = cookie.attributes ?? {};
  const parts = [`${cookie.name}=${value}`, `Path=${opts.path ?? "/"}`, `Max-Age=${maxAge}`];
  if (opts.domain) parts.push(`Domain=${opts.domain}`);
  if (opts.httpOnly !== false) parts.push("HttpOnly");
  if (opts.sameSite) {
    const mode = String(opts.sameSite);
    parts.push(`SameSite=${mode.charAt(0).toUpperCase()}${mode.slice(1)}`);
  }
  if (opts.secure) parts.push("Secure");
  return parts.join("; ");
}

async function sessionSetCookie(
  authInstance: { $context: Promise<unknown> },
  token: string,
  expiresAt: Date,
): Promise<string> {
  const ctx = (await authInstance.$context) as {
    secret: string;
    authCookies: {
      sessionToken: { name: string; attributes: SessionCookieAttributes };
    };
  };
  return signedSessionCookie(ctx.authCookies.sessionToken, ctx.secret, token, expiresAt);
}

function sessionHeaders(request: Request) {
  const headers = new Headers(request.headers);
  const authz = headers.get("authorization");
  if (authz?.toLowerCase().startsWith("bearer ") && !headers.get("cookie")) {
    headers.set("cookie", `better-auth.session_token=${authz.slice(7).trim()}`);
  }
  return headers;
}
