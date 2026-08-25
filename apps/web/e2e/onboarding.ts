import { expect, type Page } from "@playwright/test";

const CREATE_BOT = /Crie seu primeiro bot|Dê um rosto/;

async function headingVisible(page: Page, name: string | RegExp) {
  return page
    .getByRole("heading", { name })
    .isVisible()
    .catch(() => false);
}

export async function completeOnboarding(page: Page) {
  await page.waitForURL(/\/(onboarding|app)/, { timeout: 20_000 });
  const chief = page.getByText("Chief").first();
  const anyStep = page.getByRole("heading", {
    name: /Seu time de bots começa aqui|Escolha o plano|Traga o seu modelo|Qual modelo seus bots usam|Como pagar pelos modelos|Onde o computador|Crie seu primeiro bot|Dê um rosto/,
  });
  await anyStep.or(chief).waitFor({ timeout: 20_000 });
  if ((await chief.isVisible().catch(() => false)) && page.url().includes("/app")) {
    await waitForChiefThread(page);
    return;
  }

  if (await headingVisible(page, /Seu time de bots começa aqui/)) {
    await page.getByRole("button", { name: "Continuar" }).click();
    await page
      .getByRole("heading", { name: /Seus bots trabalham em um computador próprio/ })
      .waitFor();
    await page.getByRole("button", { name: "Continuar" }).click();
    await page
      .getByRole("heading", {
        name: /Um time fica melhor quando cada personagem tem uma missão/,
      })
      .waitFor();
    await page.getByRole("button", { name: "Criar meu primeiro bot" }).click();
    await page
      .getByRole("heading", {
        name: /Escolha o plano|Traga o seu modelo|Qual modelo seus bots usam|Como pagar pelos modelos|Onde o computador|Crie seu primeiro bot|Dê um rosto/,
      })
      .waitFor();
  }

  if (await headingVisible(page, /Escolha o plano/)) {
    await page.getByRole("button", { name: /^Continuar/ }).click();
    await page
      .getByRole("heading", {
        name: /Traga o seu modelo|Qual modelo seus bots usam|Como pagar pelos modelos|Crie seu primeiro bot|Dê um rosto/,
      })
      .waitFor();
  }

  if (
    await headingVisible(
      page,
      /Traga o seu modelo|Qual modelo seus bots usam|Como pagar pelos modelos/,
    )
  ) {
    const modelHeading = page.getByRole("heading", {
      name: /Traga o seu modelo|Qual modelo seus bots usam|Como pagar pelos modelos/,
    });
    const skipModel = page.getByRole("button", { name: "Pular por agora" });
    await skipModel.scrollIntoViewIfNeeded();
    await skipModel.click();
    await expect(modelHeading).toBeHidden({ timeout: 10_000 });
    await page
      .getByRole("heading", { name: /Onde o computador|Crie seu primeiro bot|Dê um rosto/ })
      .waitFor();
  }

  if (await headingVisible(page, /Onde o computador/)) {
    await page.getByRole("button", { name: "Manter o padrão" }).click();
    await page.getByRole("heading", { name: CREATE_BOT }).waitFor();
  }

  if (await headingVisible(page, CREATE_BOT)) {
    await page.locator("label:has-text('Nome') input").fill("Chief");
    await page.getByRole("button", { name: "Abrir o Quibt Bot" }).click();
  }

  await waitForChiefThread(page);
  await expect(chief).toBeVisible();
}

async function waitForChiefThread(page: Page) {
  if (!/\/app\/[^/]+$/.test(new URL(page.url()).pathname)) {
    const chiefButton = page
      .getByRole("complementary")
      .getByRole("button", { name: /Chief/ })
      .first();
    if (await chiefButton.isVisible().catch(() => false)) await chiefButton.click();
  }
  await page.waitForURL(/\/app\/[^/]+$/, { timeout: 20_000 });
  await page
    .getByRole("main")
    .getByRole("textbox", { name: /Mensagem para Chief/ })
    .waitFor({ state: "visible", timeout: 20_000 });
}

/**
 * Enters the single-owner local deployment exactly like the product does: the first
 * browser creates the owner with a name, and later loopback browsers claim that same
 * local session without obsolete e-mail/password fields.
 */
export async function enterLocalDeployment(page: Page, name: string) {
  await page.goto("/sign-up");
  const nameInput = page.getByPlaceholder("Seu nome");
  const destination = page.waitForURL(/\/(onboarding|app)/).then(() => "session" as const);
  const firstOwner = nameInput.waitFor({ state: "visible" }).then(() => "owner" as const);
  if ((await Promise.race([destination, firstOwner])) === "owner") {
    const bootstrapSecret = process.env.BOOTSTRAP_SECRET?.trim();
    if (!bootstrapSecret) throw new Error("BOOTSTRAP_SECRET is required for first-owner E2E");
    const invite = await page.request.post("/api/bootstrap/invites", {
      headers: { "x-quibt-bootstrap-secret": bootstrapSecret },
    });
    expect(invite.ok(), await invite.text()).toBe(true);
    const body = (await invite.json()) as { code?: unknown };
    expect(body.code).toEqual(expect.any(String));

    await nameInput.fill(name);
    await page.getByPlaceholder("Código do instalador").fill(String(body.code));
    await page.getByRole("button", { name: "Começar" }).click();
  }
}
