import { expect, type Locator, type Page, test } from "@playwright/test";
import { completeOnboarding, enterLocalDeployment } from "./onboarding";

test.describe.configure({ mode: "serial" });

test("the local owner returns in another browser and a bot completes durable work", async ({
  browser,
}) => {
  // The first browser creates this deployment's single local owner. A second loopback
  // browser claims that same owner session, matching the current passwordless product.
  // Clipboard permissions keep webhook copy feedback deterministic.
  const a = await browser.newContext({ permissions: ["clipboard-read", "clipboard-write"] });
  const b = await browser.newContext();
  const pageA = await a.newPage();
  const pageB = await b.newPage();

  await enterLocalDeployment(pageA, "Ada");
  await completeOnboarding(pageA);
  await expect(pageA.getByText("Chief").first()).toBeVisible();

  await enterLocalDeployment(pageB, "Ada");
  await completeOnboarding(pageB);
  await expect(pageB.getByText("Chief").first()).toBeVisible();

  const composer = pageA.getByPlaceholder(/Pergunte|Mensagem/);
  await sendMessage(
    pageA,
    composer,
    "write a file in your home called notes/result.txt that says isolation-ok",
  );
  await expect(
    pageA.getByText(/writing that into my home|isolation-ok|handled/i).first(),
  ).toBeVisible({
    timeout: 30_000,
  });

  await pageA.reload();
  await expect(pageA.getByText(/isolation-ok|writing that into my home/i).first()).toBeVisible();

  await openWebhooksJourney(pageA);

  await a.close();
  await b.close();
});

test("takeover, routine, plugins, and export are reachable", async ({ page }) => {
  await enterLocalDeployment(page, "Flow");
  await completeOnboarding(page);

  const composer = page.getByPlaceholder(/Pergunte|Mensagem/);
  await sendMessage(page, composer, "install the gsc cli and sign in");
  await expect(page.getByText(/sign in to continue|protected input/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByTitle(/Computador|Shared computer/).click();
  // The exact accessible name belongs only to the dashboard action that takes control.
  await page.getByRole("button", { name: "Assumir controle", exact: true }).click();
  await expect(page.getByText(/signed in|session stays|Você tem o controle/i).first()).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole("button", { name: "Fechar computador" }).click();

  await page.getByRole("main").getByLabel("Ajustes do bot").click();
  // Discovery only: live speech is intentionally outside the golden path.
  await expect(page.getByText("Voz", { exact: true })).toBeVisible();
  await page.getByText("Mais opções", { exact: true }).click();
  await page.getByRole("button", { name: /Adicionar rotina/ }).click();
  const routineSwitch = page.getByRole("switch");
  await expectSwitchThumbContained(routineSwitch);
  await routineSwitch.click();
  await expectSwitchThumbContained(routineSwitch);
  await routineSwitch.click();
  await expectSwitchThumbContained(routineSwitch);
  await page.locator("label:has-text('Nome') input").fill("Monday briefing");
  await page
    .locator("label:has-text('Instrução') textarea")
    .fill("write a file in your home called notes/result.txt that says routine-ok");
  await page.getByRole("button", { name: "Salvar" }).click();
  await expect(page.getByText("Monday briefing")).toBeVisible();
  await page.getByLabel("Fechar painel").click();

  await page.getByLabel("Conta").click();
  await page
    .getByRole("dialog", { name: "Conta" })
    .getByRole("button", { name: "Plugins", exact: true })
    .click();
  await expect(page.getByPlaceholder("Buscar apps")).toBeVisible();
  await page.getByRole("button", { name: "Fechar plugins" }).click();

  await page.getByRole("main").getByLabel("Ajustes do bot").click();
  await page.getByText("Mais opções", { exact: true }).click();
  await expect(page.getByRole("button", { name: "Exportar" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Apagar bot" })).toBeVisible();
});

test("a bot group can be created and talked to", async ({ page }) => {
  await enterLocalDeployment(page, "Group");
  await completeOnboarding(page);

  await page.getByLabel(/Nova conversa|Criar|Novo bot/).click();
  await expect(page.getByRole("option", { name: "Importar equipe (.md)" })).toBeVisible();
  // O diálogo "Nova conversa" é um listbox; "Criar novo grupo" é role=option, não button.
  await page.getByRole("option", { name: /Novo grupo/i }).click();
  await page.getByLabel("Nome do grupo").fill("Launch crew");
  await page.getByRole("checkbox").first().check();
  await page.getByRole("button", { name: "Criar grupo" }).click();

  await page.waitForURL(/\/app\/g\//);
  await expect(page.getByPlaceholder("Buscar")).toHaveValue("");
  await expect(page.getByText("Launch crew").first()).toBeVisible();
  await page.getByLabel("Ajustes do grupo").click();
  await expect(page.getByRole("button", { name: "Remover" }).first()).toBeVisible();
  await page.getByLabel("Fechar").click();

  await sendMessage(
    page,
    page.getByPlaceholder(/Pergunte Launch crew|Mensagem para Launch crew/),
    "say hello to the group",
  );
  await expect(page.getByText("say hello to the group").first()).toBeVisible({ timeout: 30_000 });
});

async function sendMessage(page: Page, composer: Locator, text: string) {
  await composer.fill(text);
  await expect(composer).toHaveValue(text);
  // Clicking the scoped, accessible control is stable even if a bot-list refresh
  // moves focus between fill and submit. A bare page.keyboard Enter was racy here.
  await page.getByRole("main").getByRole("button", { name: "Enviar" }).click();
  await expect(page.getByRole("main").getByText(text, { exact: true }).first()).toBeVisible();
}

async function expectSwitchThumbContained(control: Locator) {
  await expect
    .poll(async () => {
      return control.evaluate((root) => {
        const thumb = root.querySelector("span");
        if (!(thumb instanceof HTMLElement)) return false;
        const trackBox = root.getBoundingClientRect();
        const thumbBox = thumb.getBoundingClientRect();
        return (
          thumbBox.left >= trackBox.left &&
          thumbBox.top >= trackBox.top &&
          thumbBox.right <= trackBox.right &&
          thumbBox.bottom <= trackBox.bottom
        );
      });
    })
    .toBe(true);
}

/**
 * Exercises the full webhooks journey for a deployment owner: configure the global
 * public URL, create a webhook, copy its one-time credential, test it, watch an
 * activity row land, then use "Abrir no chat" to get back to the bot without error.
 * The owner-only URL step is skipped (not asserted as a failure) if this actor turns
 * out not to be the deployment owner, since ownership is a global, first-signup fact
 * this test does not control.
 */
async function openWebhooksJourney(page: Page) {
  await page.getByRole("main").getByLabel("Ajustes do bot").click();
  await page.getByText("Mais opções", { exact: true }).click();
  await page.getByRole("button", { name: "Webhooks" }).click();
  await expect(page.getByText("Webhooks", { exact: true })).toBeVisible();

  const publicUrlInput = page.getByLabel("URL pública");
  if (await publicUrlInput.isVisible().catch(() => false)) {
    await publicUrlInput.fill("https://ada-webhooks.example.com");
    await page.getByRole("button", { name: "Salvar URL", exact: true }).click();
    await expect(publicUrlInput).toHaveValue("https://ada-webhooks.example.com");
    await expect(page.getByRole("button", { name: "Remover URL pública" })).toBeVisible();
  }

  await page.getByRole("button", { name: "+ Adicionar webhook" }).click();
  await page.getByLabel("Nome").fill("Chamados abertos");
  await page.getByRole("button", { name: "Criar webhook", exact: true }).click();
  await expect(page.getByText("Chamados abertos").first()).toBeVisible();

  await expect(page.getByText(/Guarde o segredo agora/)).toBeVisible();
  await page.getByRole("button", { name: "Copiar endpoint", exact: true }).click();
  await expect(page.getByText("Endpoint copiado.")).toBeVisible();
  await page.getByRole("button", { name: "Copiar segredo" }).click();
  await expect(page.getByText("Segredo copiado.")).toBeVisible();
  await page.getByRole("button", { name: "Copiar url privada" }).click();
  await expect(page.getByText("URL privada copiado.")).toBeVisible();
  await page.getByRole("button", { name: "Copiar curl" }).click();
  await expect(page.getByText("Comando curl copiado.")).toBeVisible();
  await page.getByLabel("Ocultar credencial").click();

  await page.getByRole("button", { name: "Testar Chamados abertos" }).click();
  await expect(page.getByText("Aceito").first()).toBeVisible({ timeout: 15_000 });

  const openInChat = page.getByRole("button", { name: "Abrir no chat" }).first();
  if (await openInChat.isVisible().catch(() => false)) {
    await openInChat.click();
  } else {
    await page.getByLabel("Fechar webhooks").click();
  }
  await expect(page.getByRole("main").getByLabel("Ajustes do bot")).toBeVisible();
}
