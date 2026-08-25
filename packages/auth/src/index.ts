import { emailAllowed, parseAllowlist, signupsOpen } from "@quibt/core";
import type { PrismaClient } from "@quibt/db";
import { betterAuth } from "better-auth";
import { prismaAdapter } from "better-auth/adapters/prisma";
import { APIError } from "better-auth/api";
import { bearer, oneTimeToken, organization } from "better-auth/plugins";
import { provisionUserWorkspaceInTx } from "./provision-user-workspace.js";

export interface AuthEnv {
  secret: string;
  baseURL: string;
  webOrigin: string;
  signupsEnabled: string | undefined;
  signupAllowlist: string | undefined;
  extraOrigins?: string[];
  nodeEnv: string;
  resendApiKey: string | undefined;
  emailFrom: string;
  emailDisabled: boolean;
}

/**
 * Uma instalação local não tem servidor de e-mail: sem isto, quem esquece a senha fica
 * trancado para sempre no próprio computador. Quando não há mailer, o link de redefinição
 * é guardado aqui por poucos minutos e só pode ser lido pelo próprio host — ver o endpoint
 * `/api/local/reset-link` em apps/api. Nunca sai daqui por rede.
 */
const LOCAL_LINK_TTL_MS = 15 * 60_000;
const localResetLinks = new Map<string, { url: string; expiresAt: number }>();

function rememberLocalResetLink(email: string, url: string) {
  const now = Date.now();
  for (const [key, value] of localResetLinks) {
    if (value.expiresAt <= now) localResetLinks.delete(key);
  }
  localResetLinks.set(email.trim().toLowerCase(), { url, expiresAt: now + LOCAL_LINK_TTL_MS });
}

/** Lê e consome o link. Serve uma vez: o próximo pedido precisa de um link novo. */
export function takeLocalResetLink(email: string): string | null {
  const key = email.trim().toLowerCase();
  const found = localResetLinks.get(key);
  localResetLinks.delete(key);
  if (!found || found.expiresAt <= Date.now()) return null;
  return found.url;
}

/** O deploy consegue mandar e-mail? Sem isso, a redefinição só acontece no computador. */
export function mailerEnabled(env: Pick<AuthEnv, "emailDisabled" | "resendApiKey">): boolean {
  return !env.emailDisabled && Boolean(env.resendApiKey);
}

async function deliverAuthEmail(
  env: AuthEnv,
  to: string,
  subject: string,
  url: string,
): Promise<void> {
  if (env.emailDisabled) {
    console.info("[auth] E-mail de autenticação desativado; mensagem não enviada.");
    return;
  }
  if (env.resendApiKey) {
    const res = await fetch("https://api.resend.com/emails", {
      method: "POST",
      signal: AbortSignal.timeout(10_000),
      headers: {
        authorization: `Bearer ${env.resendApiKey}`,
        "content-type": "application/json",
      },
      body: JSON.stringify({
        from: env.emailFrom,
        to,
        subject,
        html: `<p><a href="${url}">${url}</a></p>`,
      }),
    });
    if (!res.ok) {
      throw new Error(`Failed to send auth email (${res.status})`);
    }
    return;
  }
  if (env.nodeEnv !== "production") {
    // Authentication URLs contain single-use credentials. Never put them in
    // process logs, even on a development deployment.
    console.info(`[auth] ${subject} for ${to}; URL omitida por segurança.`);
  }
}

export function createAuth(prisma: PrismaClient, env: AuthEnv) {
  if (env.nodeEnv === "production" && !env.emailDisabled && !env.resendApiKey) {
    throw new Error("Missing RESEND_API_KEY");
  }
  return betterAuth({
    appName: "Quibt Bot",
    secret: env.secret,
    baseURL: env.baseURL,
    trustedOrigins: [env.webOrigin, env.baseURL, ...(env.extraOrigins ?? [])],
    database: prismaAdapter(prisma, { provider: "postgresql" }),
    emailAndPassword: {
      enabled: true,
      disableSignUp: !signupsOpen(env.signupsEnabled),
      sendResetPassword: async ({ user, url }) => {
        if (!mailerEnabled(env)) rememberLocalResetLink(user.email, url);
        await deliverAuthEmail(env, user.email, "Redefinir senha do Quibt Bot", url);
      },
    },
    emailVerification: {
      sendOnSignUp: true,
      autoSignInAfterVerification: true,
      sendVerificationEmail: async ({ user, url }) => {
        await deliverAuthEmail(env, user.email, "Confirme seu e-mail no Quibt Bot", url);
      },
    },
    user: {
      changeEmail: {
        enabled: true,
        sendChangeEmailConfirmation: async ({ user, newEmail, url }) => {
          await deliverAuthEmail(
            env,
            newEmail || user.email,
            "Confirme o novo e-mail do Quibt Bot",
            url,
          );
        },
      },
    },
    plugins: [
      bearer(),
      /**
       * Emparelhar o celular: o computador, já logado, cunha um código de uso único e
       * o põe no QR. O celular troca o código por uma sessão e entra sem digitar senha.
       * Dois minutos de validade e guardado com hash — quem fotografar o QR depois
       * disso não leva nada. Ver docs/onboarding.md.
       */
      oneTimeToken({ expiresIn: 2, storeToken: "hashed" }),
      organization({
        allowUserToCreateOrganization: false,
        creatorRole: "owner",
      }),
    ],
    hooks: {
      before: async (ctx) => {
        const path = String((ctx as { path?: string }).path ?? "");
        if (!path.includes("sign-up")) return;
        const allowlist = parseAllowlist(env.signupAllowlist);
        const email =
          typeof ctx.body === "object" && ctx.body && "email" in ctx.body
            ? String((ctx.body as { email?: string }).email ?? "")
            : "";
        if (email && !emailAllowed(email, allowlist)) {
          throw new APIError("BAD_REQUEST", { message: "Este e-mail não pode criar conta" });
        }
      },
    },
    databaseHooks: {
      user: {
        create: {
          after: async (user) => {
            await provisionUserWorkspace(prisma, user);
          },
        },
      },
    },
  });
}

/**
 * Cria o workspace pessoal de um usuário recém-criado via Better Auth. First-owner
 * enrollment signups use a separate atomic path in apps/api and never hit this hook.
 */
export async function provisionUserWorkspace(
  prisma: PrismaClient,
  user: { id: string },
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await provisionUserWorkspaceInTx(tx, user.id);
  });
}

export type Auth = ReturnType<typeof createAuth>;

export const blockedAuthPaths = [
  "/organization/create",
  "/organization/invite",
  "/organization/accept-invitation",
  "/organization/reject-invitation",
  "/organization/remove-member",
  "/organization/update-member-role",
];

export { newAuthId, provisionUserWorkspaceInTx } from "./provision-user-workspace.js";
