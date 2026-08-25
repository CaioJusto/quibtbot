import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { COPY, ROUTES } from "./i18n";
import { LINUX_DOWNLOAD_URL, MAC_DOWNLOAD_URL, SITE_URL, WIN_DOWNLOAD_URL } from "./site";

const pages = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages");

describe("landing pricing", () => {
  it("talks about each bot's own screen, not a locked-down machine", () => {
    const i18n = readFileSync(path.join(path.dirname(pages), "i18n.ts"), "utf8");
    expect(COPY["pt-BR"].landing.howCopy).toContain("Cada bot tem a própria tela");
    expect(COPY.en.landing.howCopy).toContain("Every bot has its own screen");
    expect(i18n).not.toMatch(/computador isolado/i);
  });

  it("positions the public landing as an open-source Grok Bot alternative", () => {
    expect(COPY.en.landing.title).toBe("The open-source alternative to Grok Bot.");
    expect(COPY["pt-BR"].landing.title).toBe("A alternativa open source ao Grok Bot.");
    expect(COPY.en.metaDescription.toLowerCase()).toContain("grok bot");
    expect(COPY["pt-BR"].metaDescription.toLowerCase()).toContain("grok bot");
    expect(SITE_URL).toBe("https://quibt.com.br");
    expect(COPY.en.landing.lead.toLowerCase()).toMatch(/personality|computer/);
    expect(COPY["pt-BR"].landing.lead.toLowerCase()).toMatch(/personalidade|computador/);
    expect(COPY.en.landing.openCopy.toLowerCase()).not.toMatch(/cloud:/);
    expect(COPY["pt-BR"].landing.openCopy.toLowerCase()).not.toMatch(/cloud:/);
    expect(MAC_DOWNLOAD_URL).toMatch(/QuibtBot-\d+\.\d+\.\d+\.dmg$/);
    expect(WIN_DOWNLOAD_URL).toMatch(/QuibtBot-\d+\.\d+\.\d+-setup\.exe$/);
    expect(LINUX_DOWNLOAD_URL).toMatch(/QuibtBot-\d+\.\d+\.\d+\.AppImage$/);
  });

  it("exposes the open-source install path", () => {
    const site = readFileSync(path.join(path.dirname(pages), "site.ts"), "utf8");
    const landing = readFileSync(path.join(path.dirname(pages), "components", "LandingPage.astro"), "utf8");
    const header = readFileSync(path.join(path.dirname(pages), "components", "Header.astro"), "utf8");
    const publicSurface = `${site}\n${landing}\n${header}`;

    // O comando do site tem de ser algo que um visitante consegue colar e rodar: o
    // script baixa o binário e chama `quibtbot install` por dentro.
    expect(publicSurface).toContain("/scripts/install.sh");
    expect(publicSurface).toContain("QUIBT_RELEASE=");
    expect(site).toContain("quibtbot install");
    expect(publicSurface).toContain("MAC_DOWNLOAD_URL");
    expect(publicSurface).toContain("WIN_DOWNLOAD_URL");
    expect(publicSurface).toContain("LINUX_DOWNLOAD_URL");
    expect(publicSurface).not.toMatch(/waitlist|lista-de-espera|Quibt Cloud/i);
  });

  it("keeps public CTAs free of hosted pricing and sign-up marketing", () => {
    const landing = readFileSync(path.join(path.dirname(pages), "components", "LandingPage.astro"), "utf8");
    const header = readFileSync(path.join(path.dirname(pages), "components", "Header.astro"), "utf8");
    const footer = readFileSync(path.join(path.dirname(pages), "components", "Footer.astro"), "utf8");
    const publicSurface = `${landing}\n${header}\n${footer}`;

    expect(publicSurface).not.toContain("cloudSoon");
    expect(publicSurface).not.toContain("SIGN_IN_URL");
    expect(publicSurface).not.toContain("SIGN_UP_URL");
    expect(publicSurface).not.toContain("PricingGrid");
    expect(publicSurface).not.toContain('href="/pricing"');
    // Preço, lista de espera e o serviço que a alimentava saíram do repositório antes de
    // ele virar público: o produto aberto não vende plano nem coleta e-mail de ninguém.
    expect(publicSurface).not.toMatch(/waitlist|lista-de-espera/i);
    expect(existsSync(path.join(pages, "pricing.astro"))).toBe(false);
    expect(existsSync(path.join(pages, "waitlist.astro"))).toBe(false);
    expect(existsSync(path.join(pages, "pt", "lista-de-espera.astro"))).toBe(false);
  });

  it("serves English by default and a matching Portuguese route", () => {
    const english = readFileSync(path.join(pages, "index.astro"), "utf8");
    const portuguese = readFileSync(path.join(pages, "pt", "index.astro"), "utf8");
    const header = readFileSync(path.join(path.dirname(pages), "components", "Header.astro"), "utf8");

    expect(english).toContain('<LandingPage locale="en" />');
    expect(portuguese).toContain('<LandingPage locale="pt-BR" />');
    expect(header).toContain('class="language-switcher"');
    expect(header).toContain(">EN</a>");
    expect(header).toContain(">PT</a>");
  });

  it("uses the new raster mascots throughout the interactive product demo", () => {
    const demo = readFileSync(path.join(path.dirname(pages), "components", "ProductDemo.tsx"), "utf8");
    const css = readFileSync(path.join(path.dirname(pages), "styles", "global.css"), "utf8");
    const landing = readFileSync(
      path.join(path.dirname(pages), "components", "LandingPage.astro"),
      "utf8",
    );
    const publicMascots = path.join(path.dirname(pages), "..", "public", "mascots");

    expect(demo).toContain("<DemoMascot");
    expect(demo).toContain("<AgentMark");
    expect(demo).toContain("<CharacterPicker");
    expect(demo).toContain("PICKER_SHAPES");
    expect(css).toContain("character-picker.tsx");
    expect(demo).not.toContain("<BotAvatar");
    expect(demo).not.toContain("DEMO_MASCOTS");
    expect(demo).not.toContain("MARK_SHAPES[");
    expect(landing).toContain("client:visible");
    expect(landing).not.toContain("client:load");
    for (const asset of ["onee.png", "cubee.png", "cloudee.png", "sunee.png", "grok.png", "freddy.png"]) {
      expect(existsSync(path.join(publicMascots, "demo", asset))).toBe(true);
    }
  });

  it("uses the supplied Quibt logo image in the shared header and footer lockup", () => {
    const logo = readFileSync(path.join(path.dirname(pages), "components", "Logo.astro"), "utf8");
    const logoAsset = path.join(path.dirname(pages), "..", "public", "quibt-logo.png");

    expect(existsSync(logoAsset)).toBe(true);
    expect(logo).toContain('src="/quibt-logo.png"');
    expect(logo).not.toContain("brand-lockup__mark");
    expect(logo).not.toContain("brand-lockup__word");
  });

  it("uses the transparent blue mascot as the browser icon", () => {
    const layout = readFileSync(path.join(path.dirname(pages), "layouts", "BaseLayout.astro"), "utf8");
    const publicDir = path.join(path.dirname(pages), "..", "public");

    expect(layout).toContain('href="/favicon-32x32.png"');
    expect(layout).not.toContain('href="/favicon.svg"');
    for (const asset of ["favicon.ico", "favicon-16x16.png", "favicon-32x32.png", "apple-touch-icon.png"]) {
      expect(existsSync(path.join(publicDir, asset))).toBe(true);
    }
  });
});
