import { expect, test } from "@playwright/test";
import { completeOnboarding, enterLocalDeployment } from "./onboarding";

/** Sobe um arquivo, baixa de volta e confere que ele aparece na conversa. */
test("arquivo sobe, volta e aparece no fio", async ({ page }) => {
  page.on("pageerror", (e) => console.log("PAGE ERROR:", String(e).slice(0, 200)));
  await enterLocalDeployment(page, "Caio");
  await completeOnboarding(page);

  const result = await page.evaluate(async () => {
    const rpc = await fetch("/rpc/bots/list", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ json: {} }),
      credentials: "include",
    });
    const raw = await rpc.text();
    let bots: unknown;
    try {
      bots = JSON.parse(raw);
    } catch {
      return { error: "resposta nao json", raw: raw.slice(0, 400) };
    }
    const asAny = bots as { json?: unknown[] } | unknown[];
    const list = (Array.isArray(asAny) ? asAny : (asAny.json ?? [])) as { id?: string }[];
    const botId = list?.[0]?.id;
    if (!botId) return { error: "sem bot", status: rpc.status, raw: raw.slice(0, 400) };

    const bytes = new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8]);
    const form = new FormData();
    form.append("file", new Blob([bytes], { type: "text/csv" }), "planilha.csv");
    const up = await fetch(`/files/${botId}`, {
      method: "POST",
      body: form,
      credentials: "include",
    });
    const stored = await up.json();
    if (!up.ok) return { error: "upload falhou", stored };

    const down = await fetch(`/files/${stored.id}`, { credentials: "include" });
    const back = new Uint8Array(await down.arrayBuffer());

    const sent = await fetch("/rpc/threads/send", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        json: { botId, text: "segue a planilha", attachments: [stored.id] },
      }),
      credentials: "include",
    });

    return {
      botId,
      stored,
      downloadStatus: down.status,
      disposition: down.headers.get("content-disposition"),
      contentType: down.headers.get("content-type"),
      sameBytes: back.length === bytes.length && back.every((b, i) => b === bytes[i]),
      sendStatus: sent.status,
    };
  });

  console.log("RESULTADO:", JSON.stringify(result, null, 2));
  expect(result.error).toBeUndefined();
  expect(result.stored.name).toBe("planilha.csv");
  expect(result.stored.size).toBe(8);
  expect(result.downloadStatus).toBe(200);
  expect(result.sameBytes).toBe(true);
  expect(result.disposition).toContain("attachment");
  expect(result.sendStatus).toBe(200);

  // E o arquivo aparece na conversa, como cartão para baixar.
  await page.reload();
  await expect(page.getByText("planilha.csv").first()).toBeVisible({ timeout: 20_000 });
  // test-results/ é ignorado pelo git: o print é prova da rodada, não conteúdo do repositório.
  await page.screenshot({ path: "test-results/arquivo-no-fio.png" });
});
