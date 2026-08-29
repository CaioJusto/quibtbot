import { INSTALL_SCRIPT_RAW_URL } from "@quibt/core";
import { DESKTOP_SIGNING, type DesktopSigning, INSTALL_RELEASE } from "@quibt/installer";
import { COPY, type Locale } from "./i18n";

export const SITE_NAME = "Quibt Bot";
export const SITE_URL = "https://quibt.com.br";
export const SITE_DESCRIPTION =
  "Quibt Bot is the open-source alternative to Grok Bot. Create AI bots with personality, memory, and their own computer.";

/** Same source as the installer/desktop/CLI — see `releaseManifest` in `scripts/release-version.mjs`. */
export const DESKTOP_VERSION = INSTALL_RELEASE;
/**
 * A release só publica os aliases estáveis (`DESKTOP_ARTIFACT_NAMES` em
 * `scripts/release-version.mjs`; o workflow sobe apenas eles). O nome do arquivo não carrega
 * a versão — ela fica na tag da URL. `site.test.ts` confere que estes basenames batem com o script.
 */
const DESKTOP_RELEASE_BASE = `https://github.com/CaioJusto/quibtbot/releases/download/v${DESKTOP_VERSION}`;
export const MAC_DOWNLOAD_URL = `${DESKTOP_RELEASE_BASE}/QuibtBot.dmg`;
export const WIN_DOWNLOAD_URL = `${DESKTOP_RELEASE_BASE}/QuibtBot-setup.exe`;
export const LINUX_DOWNLOAD_URL = `${DESKTOP_RELEASE_BASE}/QuibtBot.AppImage`;

/**
 * A nota do Mac depende de como o DMG da tag foi publicado (`DESKTOP_SIGNING` em
 * `@quibt/installer`, preenchido pelo checklist de release a partir do `signing-status-mac.json`).
 * Um DMG sem notarização é bloqueado pelo Gatekeeper, e a frase precisa dar a saída
 * ("botão direito → Abrir") em vez de prometer que abre sem aviso.
 */
export function macDownloadNote(locale: Locale, signing: DesktopSigning = DESKTOP_SIGNING): string {
  const landing = COPY[locale].landing;
  return signing.mac.notarized ? landing.downloadMacNoteNotarized : landing.downloadMacNoteUnsigned;
}

/**
 * The one-line bootstrap for the self-hosted server, shared with the mobile setup guide.
 * `scripts/install.sh` downloads the `quibtbot` release binary for the machine, checks its
 * SHA-256, and runs `quibtbot install` — the same installer the desktop app and the VPS
 * bootstrap use.
 */
export const INSTALL_COMMAND =
  `curl -fsSL ${INSTALL_SCRIPT_RAW_URL} | QUIBT_RELEASE=${INSTALL_RELEASE} sh`;

const fallbackApp = "http://127.0.0.1:5173";
export const APP_ORIGIN = (import.meta.env.PUBLIC_APP_ORIGIN as string | undefined) || fallbackApp;
export const SIGN_UP_URL = `${APP_ORIGIN.replace(/\/$/, "")}/sign-up`;
export const SIGN_IN_URL = `${APP_ORIGIN.replace(/\/$/, "")}/sign-in`;

export const GITHUB_URL = "https://github.com/CaioJusto/quibtbot";
export const DOCS_URL = "https://github.com/CaioJusto/quibtbot/blob/main/docs/self-host.md";
export const CHANGELOG_URL = "https://github.com/CaioJusto/quibtbot/releases";

/** Marketing copy per plan. The numbers below come from `@quibt/core`. */
