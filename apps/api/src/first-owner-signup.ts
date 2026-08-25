import { randomBytes, randomUUID } from "node:crypto";
import { hashPassword } from "@better-auth/utils/password";
import { newAuthId, provisionUserWorkspaceInTx } from "@quibt/auth";
import type { FirstOwnerEnrollment } from "@quibt/core/bootstrap-invite";
import type { Prisma, PrismaClient } from "@quibt/db";
import { BootstrapFinalizeError, finalizeFirstOwnerInTransaction } from "./bootstrap.js";

export interface FirstOwnerSignupInput {
  email: string;
  password: string;
  name: string;
  image?: string;
}

export class FirstOwnerSignupError extends Error {
  readonly status: 400 | 409 | 422 | 500;

  constructor(message: string, status: 400 | 409 | 422 | 500 = 422) {
    super(message);
    this.name = "FirstOwnerSignupError";
    this.status = status;
  }
}

export interface FirstOwnerSignupHooks {
  finalizeInTransaction?: typeof finalizeFirstOwnerInTransaction;
}

const MIN_PASSWORD_LENGTH = 8;
const MAX_PASSWORD_LENGTH = 128;

/**
 * Quem instalou o Quibt já provou quem é: digitou o código que só aparece na
 * máquina onde ele roda. Pedir e-mail e senha em cima disso não protege nada —
 * esta instalação nem envia e-mail — e ainda cria uma senha a mais para perder.
 *
 * Então o servidor inventa as duas coisas. O e-mail é interno (domínio
 * reservado `.invalid`, que por norma nunca resolve, RFC 2606) e a senha é
 * aleatória e nunca sai daqui: entrar é por código, de outro aparelho já ligado.
 */
export function generatedOwnerEmail(): string {
  return `dono-${randomUUID().slice(0, 8)}@quibt.invalid`;
}

export function generatedOwnerPassword(): string {
  return randomBytes(32).toString("base64url");
}

/** Um e-mail que o servidor inventou não deve aparecer como se fosse da pessoa. */
export function isGeneratedOwnerEmail(email: string | null | undefined): boolean {
  return typeof email === "string" && email.trim().toLowerCase().endsWith("@quibt.invalid");
}

/**
 * Atomically creates credential user, personal workspace, and first-owner claim.
 * Better Auth sign-up is bypassed so no session can exist before this commits.
 */
export async function commitFirstOwnerSignup(
  prisma: PrismaClient,
  enrollment: FirstOwnerEnrollment,
  input: FirstOwnerSignupInput,
  hooks: FirstOwnerSignupHooks = {},
): Promise<{ userId: string; email: string }> {
  const email = input.email.trim();
  const password = input.password;
  const name = input.name.trim();
  if (!name) throw new FirstOwnerSignupError("Nome é obrigatório.", 400);
  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    throw new FirstOwnerSignupError("E-mail inválido.", 400);
  }
  if (!password || password.length < MIN_PASSWORD_LENGTH) {
    throw new FirstOwnerSignupError("Senha muito curta.", 400);
  }
  if (password.length > MAX_PASSWORD_LENGTH) {
    throw new FirstOwnerSignupError("Senha muito longa.", 400);
  }

  const normalizedEmail = email.toLowerCase();
  const passwordHash = await hashPassword(password);
  const finalize = hooks.finalizeInTransaction ?? finalizeFirstOwnerInTransaction;

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const existing = await tx.user.findUnique({ where: { email: normalizedEmail } });
    if (existing) {
      throw new FirstOwnerSignupError(
        "Este e-mail já tem conta. Use outro e-mail ou entre com a senha.",
        422,
      );
    }

    const userId = newAuthId();
    const now = new Date();
    await tx.user.create({
      data: {
        id: userId,
        email: normalizedEmail,
        name,
        emailVerified: false,
        image: input.image ?? null,
        createdAt: now,
        updatedAt: now,
      },
    });
    await tx.account.create({
      data: {
        id: newAuthId(),
        userId,
        accountId: userId,
        providerId: "credential",
        password: passwordHash,
        createdAt: now,
        updatedAt: now,
      },
    });
    await provisionUserWorkspaceInTx(tx, userId);
    await finalize(tx, userId, enrollment);
    return { userId, email: normalizedEmail };
  });
}

export function mapFirstOwnerSignupError(error: unknown): {
  status: 400 | 409 | 422 | 500;
  message: string;
} {
  if (error instanceof FirstOwnerSignupError) {
    return { status: error.status, message: error.message };
  }
  if (error instanceof BootstrapFinalizeError) {
    return { status: 409, message: "Não foi possível confirmar o proprietário inicial." };
  }
  return { status: 500, message: "Não foi possível criar a conta." };
}
