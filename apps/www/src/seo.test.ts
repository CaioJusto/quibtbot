import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPY, ROUTES } from "./i18n";
import { INDEXABLE_PAGES, robotsTxt, sitemapEntries, sitemapXml } from "./seo";
import { SITE_URL } from "./site";

const src = path.dirname(fileURLToPath(import.meta.url));

describe("bilingual site metadata", () => {
  it("builds absolute URLs from the same origin the pages declare as canonical", () => {
    const config = readFileSync(path.join(src, "..", "astro.config.mjs"), "utf8");
    expect(config).toContain(`site: "${SITE_URL}"`);
  });

  it("lists every public page in both languages in the sitemap, excluding the unlinked waitlist", () => {
    expect(INDEXABLE_PAGES).not.toContain("waitlist");

    const entries = sitemapEntries();
    const urls = entries.map((entry) => entry.url).sort();
    const expected = [
      ...INDEXABLE_PAGES.map((page) => new URL(ROUTES.en[page], SITE_URL).toString()),
      ...INDEXABLE_PAGES.map((page) => new URL(ROUTES["pt-BR"][page], SITE_URL).toString()),
    ].sort();
    expect(urls).toEqual(expected);

    const xml = sitemapXml();
    expect(xml.startsWith("<?xml")).toBe(true);
    for (const url of expected) expect(xml).toContain(`<loc>${url}</loc>`);
    expect(xml).toContain('hreflang="x-default"');
    expect(xml).not.toContain("/pricing");
    expect(xml).not.toContain("/waitlist");
    expect(xml).not.toContain("/lista-de-espera");
  });

  it("points robots at the sitemap and has nothing left to hide", () => {
    const robots = robotsTxt();
    expect(robots).toContain(`Sitemap: ${new URL("/sitemap.xml", SITE_URL).toString()}`);
    // Não existe mais rascunho fora do índice: preço e lista de espera foram removidos
    // do site antes de o repositório virar público.
    expect(robots).not.toContain("Disallow: /");
  });

  it("keeps the English and Portuguese copy trees structurally identical", () => {
    expect(shape(COPY.en)).toEqual(shape(COPY["pt-BR"]));
    expect(Object.keys(ROUTES.en).sort()).toEqual(Object.keys(ROUTES["pt-BR"]).sort());
  });

  it("has no unlinked draft page left in the site", () => {
    for (const gone of ["pricing.astro", "waitlist.astro", path.join("pt", "lista-de-espera.astro")]) {
      expect(existsSync(path.join(src, "pages", gone)), gone).toBe(false);
    }
  });
});

function shape(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(shape);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .map(([key, entry]) => [key, shape(entry)] as const)
        .sort(([a], [b]) => a.localeCompare(b)),
    );
  }
  return typeof value;
}
