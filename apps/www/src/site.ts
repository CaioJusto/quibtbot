import { INSTALL_RELEASE } from "@quibt/installer";

export const SITE_NAME = "Quibt Bot";
export const SITE_URL = "https://quibt.com.br";
export const SITE_DESCRIPTION =
  "Quibt Bot is the open-source alternative to Grok Bot. Create AI bots with personality, memory, and their own computer.";

/** Same source as the installer/desktop/CLI — see `releaseManifest` in `scripts/release-version.mjs`. */
export const DESKTOP_VERSION = INSTALL_RELEASE;
export const MAC_DOWNLOAD_URL =
  `https://github.com/CaioJusto/quibtbot/releases/download/v${DESKTOP_VERSION}/QuibtBot-${DESKTOP_VERSION}.dmg`;
export const WIN_DOWNLOAD_URL =
  `https://github.com/CaioJusto/quibtbot/releases/download/v${DESKTOP_VERSION}/QuibtBot-${DESKTOP_VERSION}-setup.exe`;
export const LINUX_DOWNLOAD_URL =
  `https://github.com/CaioJusto/quibtbot/releases/download/v${DESKTOP_VERSION}/QuibtBot-${DESKTOP_VERSION}.AppImage`;

/**
 * The one-line bootstrap for the self-hosted server, shared with the mobile setup guide.
 * `scripts/install.sh` downloads the `quibtbot` release binary for the machine, checks its
 * SHA-256, and runs `quibtbot install` — the same installer the desktop app and the VPS
 * bootstrap use.
 */
export const INSTALL_COMMAND =
  `curl -fsSL https://raw.githubusercontent.com/CaioJusto/quibtbot/v${INSTALL_RELEASE}/scripts/install.sh | QUIBT_RELEASE=${INSTALL_RELEASE} sh`;

const fallbackApp = "http://127.0.0.1:5173";
export const APP_ORIGIN = (import.meta.env.PUBLIC_APP_ORIGIN as string | undefined) || fallbackApp;
export const SIGN_UP_URL = `${APP_ORIGIN.replace(/\/$/, "")}/sign-up`;
export const SIGN_IN_URL = `${APP_ORIGIN.replace(/\/$/, "")}/sign-in`;

export const GITHUB_URL = "https://github.com/CaioJusto/quibtbot";
export const DOCS_URL = "https://github.com/CaioJusto/quibtbot/blob/main/docs/self-host.md";
export const CHANGELOG_URL = "https://github.com/CaioJusto/quibtbot/releases";

/** Marketing copy per plan. The numbers below come from `@quibt/core`. */
