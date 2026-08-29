import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { INSTALL_SCRIPT_RAW_URL } from "@quibt/core";
import { DESKTOP_SIGNING } from "@quibt/installer";
import { DESKTOP_ARTIFACT_NAMES } from "../../../scripts/release-version.mjs";
import { COPY } from "./i18n";
import {
  DESKTOP_VERSION,
  INSTALL_COMMAND,
  LINUX_DOWNLOAD_URL,
  MAC_DOWNLOAD_URL,
  macDownloadNote,
  SITE_URL,
  WIN_DOWNLOAD_URL,
} from "./site";

const pages = path.join(path.dirname(fileURLToPath(import.meta.url)), "pages");
const repoRoot = path.resolve(path.dirname(pages), "..", "..", "..");

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
  });

  it("links the download buttons to the stable artifact names the release actually publishes", () => {
    // O workflow de release só anexa os aliases sem versão (QuibtBot.dmg, QuibtBot-setup.exe,
    // QuibtBot.AppImage). Um nome versionado no botão responde 404 em todo release.
    const releaseDir = `https://github.com/CaioJusto/quibtbot/releases/download/v${DESKTOP_VERSION}/`;
    const urls = {
      mac: MAC_DOWNLOAD_URL,
      windows: WIN_DOWNLOAD_URL,
      linux: LINUX_DOWNLOAD_URL,
    };
    for (const [platform, artifact] of Object.entries(DESKTOP_ARTIFACT_NAMES)) {
      const url = urls[platform as keyof typeof urls];
      expect(url.startsWith(releaseDir)).toBe(true);
      expect(path.posix.basename(new URL(url).pathname)).toBe(artifact);
    }
    expect(DESKTOP_VERSION).toMatch(/^\d+\.\d+\.\d+$/);
  });

  it("describes the Mac DMG the way the tag's signing status says it was published", () => {
    // A frase do Mac é escolhida por DESKTOP_SIGNING (preenchido a partir do
    // signing-status-mac.json da tag), não por uma alegação fixa no texto. Sem notarização o
    // Gatekeeper bloqueia o DMG, e a frase tem de dar a saída (botão direito → Abrir).
    const notarizedPhrase = /notarized by Apple|notarizado pela Apple/;
    const gatekeeperExit = /right-click → Open|botão direito → Abrir/;
    for (const locale of ["en", "pt-BR"] as const) {
      const rendered = macDownloadNote(locale);
      if (DESKTOP_SIGNING.mac.notarized) {
        expect(rendered).toMatch(notarizedPhrase);
        expect(rendered).not.toMatch(gatekeeperExit);
      } else {
        expect(rendered).toMatch(gatekeeperExit);
        expect(rendered).not.toMatch(notarizedPhrase);
      }
      // Os dois ramos existem e trocam de frase quando o status muda.
      const others = { win: { signed: false }, linux: { signed: false } };
      const notarized = { mac: { signed: true, notarized: true }, ...others };
      const unsigned = { mac: { signed: false, notarized: false }, ...others };
      expect(macDownloadNote(locale, notarized)).toMatch(notarizedPhrase);
      expect(macDownloadNote(locale, notarized)).not.toMatch(gatekeeperExit);
      expect(macDownloadNote(locale, unsigned)).toMatch(gatekeeperExit);
      expect(macDownloadNote(locale, unsigned)).not.toMatch(notarizedPhrase);
      expect(macDownloadNote(locale, notarized)).toMatch(/Intel/);
      expect(macDownloadNote(locale, unsigned)).toMatch(/README/);
    }
    const landingPage = readFileSync(
      path.join(path.dirname(pages), "components", "LandingPage.astro"),
      "utf8",
    );
    expect(landingPage).toContain("macDownloadNote(locale)");
    expect(landingPage).not.toMatch(/landing\.downloadMacNote/);
  });

  it("describes Windows and Linux as the unsigned test builds the CI publishes, without jargon", () => {
    for (const locale of ["en", "pt-BR"] as const) {
      const landing = COPY[locale].landing;
      expect(landing.downloadWinNote).toMatch(/SmartScreen/);
      expect(landing.downloadWinNote).toMatch(/Docker Desktop/);
      expect(landing.downloadLinuxNote).toMatch(/libfuse2/);
      // O AppImage não instala o Docker: o usuário Linux instala o Engine (ou o Desktop) sozinho.
      expect(landing.downloadLinuxNote).toMatch(
        /Docker \(Engine or Desktop\)|Docker \(Engine ou Desktop\)/,
      );
      expect(landing.downloadLinuxNote).toMatch(/mark it executable|marque como executável/);
      expect(landing.downloadLatest).not.toMatch(/always the latest|sempre na última/i);
      for (const note of [landing.downloadWinNote, landing.downloadLinuxNote]) {
        expect(note).not.toMatch(/preview|prévia/i);
        expect(note).toMatch(/test|teste/);
      }
    }
    expect(COPY["pt-BR"].landing.downloadMacNoteUnsigned).not.toMatch(/roda do código/);
    expect(COPY["pt-BR"].landing.downloadMacNoteNotarized).not.toMatch(/roda do código/);
  });

  it("keeps the layperson guide and the README on the same Mac story as the site", () => {
    const onboarding = readFileSync(path.join(repoRoot, "docs", "onboarding.md"), "utf8");
    const readme = readFileSync(path.join(repoRoot, "README.md"), "utf8");
    const macLine = onboarding.split("\n").find((line) => /Mac \(Apple silicon\)/.test(line));
    expect(macLine).toBeDefined();
    const readmeMacRow = readme
      .split("\n")
      .find((line) => /^\| macOS \(Apple silicon\)/.test(line));
    expect(readmeMacRow).toBeDefined();
    if (DESKTOP_SIGNING.mac.notarized) {
      expect(macLine).toMatch(/notarizado/);
      expect(readmeMacRow).toMatch(/notarized/);
    } else {
      expect(macLine).toMatch(/botão direito → Abrir/);
      expect(macLine).not.toMatch(/notarizado/);
      expect(readmeMacRow).toMatch(/right-click → Open/);
      expect(readmeMacRow).not.toMatch(/signed \*\*and notarized\*\*/);
    }
    expect(onboarding).toMatch(/Executar assim mesmo/);
    expect(onboarding).toMatch(/libfuse2/);
    expect(onboarding).toMatch(/marque como executável/);
    expect(onboarding).toMatch(/instale o Docker[^\n]*por conta própria/);
  });

  it("exposes the open-source install path", () => {
    const site = readFileSync(path.join(path.dirname(pages), "site.ts"), "utf8");
    const landing = readFileSync(path.join(path.dirname(pages), "components", "LandingPage.astro"), "utf8");
    const header = readFileSync(path.join(path.dirname(pages), "components", "Header.astro"), "utf8");
    const publicSurface = `${site}\n${landing}\n${header}`;

    // O comando do site tem de ser algo que um visitante consegue colar e rodar: o
    // script baixa o binário e chama `quibtbot install` por dentro.
    expect(INSTALL_COMMAND).toContain(INSTALL_SCRIPT_RAW_URL);
    expect(INSTALL_COMMAND).toContain("QUIBT_RELEASE=");
    expect(INSTALL_COMMAND).toMatch(/quibtbot\/[a-f0-9]{40}\/scripts\/install\.sh/);
    expect(publicSurface).toContain("INSTALL_COMMAND");
    expect(site).toContain("quibtbot install");
    expect(publicSurface).toContain("MAC_DOWNLOAD_URL");
    expect(publicSurface).toContain("WIN_DOWNLOAD_URL");
    expect(publicSurface).toContain("LINUX_DOWNLOAD_URL");
    expect(publicSurface).not.toMatch(/waitlist|lista-de-espera|Quibt Cloud/i);
  });

  it("keeps the legal pages free of the waitlist that no longer exists", () => {
    // As páginas de Privacidade e Termos são texto jurídico: elas não podem descrever um
    // formulário que o site não tem mais (nome, e-mail, @ no X, banco na Railway). O teste
    // antigo só olhava a landing, então o texto legal ficou para trás.
    const i18n = readFileSync(path.join(path.dirname(pages), "i18n.ts"), "utf8");
    expect(i18n).not.toMatch(/waitlist|lista de espera/i);
    for (const locale of ["en", "pt-BR"] as const) {
      for (const page of ["privacy", "terms"] as const) {
        const content = COPY[locale][page];
        const text = [
          content.title,
          content.description,
          content.intro,
          ...content.sections.flatMap((section) => [section.title, section.body]),
        ].join("\n");
        expect(text, `${locale}/${page}`).not.toMatch(/waitlist|lista de espera/i);
        expect(text, `${locale}/${page}`).not.toMatch(/early access|acesso antecipado/i);
        expect(text, `${locale}/${page}`).not.toMatch(/Railway/i);
        expect(text, `${locale}/${page}`).not.toMatch(/@ ?no X|X handle/i);
        expect(text, `${locale}/${page}`).not.toMatch(/quibt cloud/i);
        // O site é estático: ele não recebe cadastro, e o produto roda na máquina do leitor.
        expect(text, `${locale}/${page}`).toMatch(
          /no form|does not collect|não coleta|não existe formulário/i,
        );
        expect(text, `${locale}/${page}`).toMatch(/Apache|open[- ]source/i);
      }
    }
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
