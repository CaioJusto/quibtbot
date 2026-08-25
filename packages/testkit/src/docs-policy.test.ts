import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

function read(relPath: string): string {
  return readFileSync(path.resolve(relPath), "utf8");
}

/**
 * The public documentation surface: the README plus every long-form guide a self-hoster is
 * expected to read. Internal planning docs (`docs/superpowers/**`) and operator-only notes
 * (`docs/editions.md`, `docs/audit-*.md`) are deliberately excluded — they describe the Cloud
 * edition engine for operators, which the product rules keep out of the public path.
 */
const PUBLIC_DOCS: Record<string, string> = {
  "README.md": read("README.md"),
  "docs/architecture.md": read("docs/architecture.md"),
  "docs/mobile.md": read("docs/mobile.md"),
  "docs/self-host.md": read("docs/self-host.md"),
  "docs/desktop.md": read("docs/desktop.md"),
  "docs/computers.md": read("docs/computers.md"),
  "docs/onboarding.md": read("docs/onboarding.md"),
};

const ALL_PUBLIC_TEXT = Object.values(PUBLIC_DOCS).join("\n");

/** Guides that walk a person through a choice; README is a summary, not a guide. */
const GUIDE_PATHS = [
  "docs/architecture.md",
  "docs/mobile.md",
  "docs/self-host.md",
  "docs/desktop.md",
  "docs/computers.md",
  "docs/onboarding.md",
];

describe("public documentation policy", () => {
  it("links the architecture and mobile guides from the README", () => {
    expect(PUBLIC_DOCS["README.md"]).toMatch(/\[[^\]]*\]\(docs\/architecture\.md\)/);
    expect(PUBLIC_DOCS["README.md"]).toMatch(/\[[^\]]*\]\(docs\/mobile\.md\)/);
  });

  it("documents the quibtbot install bootstrap somewhere public", () => {
    expect(ALL_PUBLIC_TEXT).toContain("quibtbot install");
  });

  it("never groups E2B with VPS or Box as a server that stays up when the laptop is off", () => {
    const laptopOffHostPatterns = [
      /VPS\s*\/\s*E2B\s*\/\s*Box/i,
      /the machine is a VPS[^\n]*E2B[^\n]*(laptop|notebook)[^\n]*(off|powered)/i,
      /máquina for VPS[^\n]*E2B[^\n]*(notebook|desligad)/i,
    ];
    for (const [name, text] of Object.entries(PUBLIC_DOCS)) {
      for (const pattern of laptopOffHostPatterns) {
        expect(text, `${name} groups E2B with always-on server hosts`).not.toMatch(pattern);
      }
    }

    const negation = /never|nunca|não hospeda|não hosteia|not on this|não neste/i;
    for (const [name, text] of Object.entries(PUBLIC_DOCS)) {
      const laptopOffLines = text
        .split("\n")
        .filter((line) =>
          /(laptop|notebook).*(off|desligad|powered off)|(off|desligad|powered off).*(laptop|notebook)/i.test(
            line,
          ),
        );
      for (const line of laptopOffLines) {
        if (/E2B/i.test(line) && !negation.test(line)) {
          expect.fail(`${name} implies E2B keeps the API up when the laptop is off: "${line}"`);
        }
      }
    }
  });

  it("never lists E2B as a place the Quibt server (the API) can run", () => {
    const architecture = PUBLIC_DOCS["docs/architecture.md"];
    expect(architecture).toMatch(/E2B[^\n]*never hosts the Quibt server/i);

    const serverHostsLine = architecture.split("\n").find((line) => /server hosts?:/i.test(line));
    expect(serverHostsLine, "docs/architecture.md must enumerate server hosts").toBeDefined();
    expect(serverHostsLine).not.toMatch(/E2B/);

    // Every doc that lists where the server/API runs must keep E2B off that list, unless the
    // line is explicitly negating it (e.g. "E2B never hosts the Quibt server").
    const negation = /never|nunca|não hospeda|não hosteia/i;
    for (const [name, text] of Object.entries(PUBLIC_DOCS)) {
      const serverLines = text
        .split("\n")
        .filter((line) => /(o servidor Quibt|the (quibt )?(api|server) runs?)\b/i.test(line));
      for (const line of serverLines) {
        if (/E2B/i.test(line) && !negation.test(line)) {
          expect.fail(`${name} lists E2B as a server host: "${line}"`);
        }
      }
    }
  });

  it("states the laptop/host requirement for a locally-hosted API", () => {
    expect(PUBLIC_DOCS["docs/self-host.md"]).toMatch(
      /this (computer|machine)[^\n]{0,160}(stays?|stay) (on|powered on)[^\n]{0,80}API/i,
    );
    expect(PUBLIC_DOCS["README.md"]).toMatch(/turn(ed|ing)? (it|this) off[^\n]{0,80}API/i);
  });

  it("says Box gives every bot one persistent VM, never a shared machine", () => {
    expect(PUBLIC_DOCS["README.md"]).toMatch(/box[^\n]*one (persistent )?VM per bot/i);
    expect(PUBLIC_DOCS["docs/computers.md"]).toMatch(/uma VM por bot/i);
    expect(PUBLIC_DOCS["docs/architecture.md"]).toMatch(
      /box[^\n]*one VM per bot|one VM per bot[^\n]*box/i,
    );
  });

  it("keeps public docs free of a waitlist or a hosted Quibt Cloud call-to-action", () => {
    for (const [name, text] of Object.entries(PUBLIC_DOCS)) {
      expect(text, name).not.toMatch(/waitlist|lista de espera/i);
      expect(text, name).not.toMatch(/quibt cloud/i);
    }
  });

  it("orients every guide with the two Quibt questions", () => {
    for (const relPath of GUIDE_PATHS) {
      const text = PUBLIC_DOCS[relPath];
      expect(text, relPath).toContain("Onde o Quibt fica ligado?");
      expect(text, relPath).toContain("Onde os bots trabalham?");
    }
  });

  it("documents the mobile test commands", () => {
    expect(PUBLIC_DOCS["docs/mobile.md"]).toContain("pnpm --filter @quibt/mobile test");
    expect(PUBLIC_DOCS["docs/mobile.md"]).toContain("pnpm e2e:mobile");
  });

  it("documents the canonical architecture diagram once", () => {
    const architecture = PUBLIC_DOCS["docs/architecture.md"];
    expect(architecture).toMatch(/```mermaid/);
    expect(architecture.match(/```mermaid/g)?.length).toBe(1);
  });

  it("documents SecureStore and the EAS/native-SSH requirement in the mobile guide", () => {
    const mobile = PUBLIC_DOCS["docs/mobile.md"];
    expect(mobile).toMatch(/SecureStore/);
    expect(mobile).toMatch(/Expo Go/);
    expect(mobile).toMatch(/EAS/);
  });
});
