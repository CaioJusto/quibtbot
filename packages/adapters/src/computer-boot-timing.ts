/** How long a loser waits for another process to finish booting. */
export const DESKTOP_BOOT_WAIT_MS = 120_000;
/** Boot claims older than this may be stolen (crashed worker). */
export const DESKTOP_BOOT_STALE_MS = 120_000;
export const DESKTOP_BOOT_POLL_MS = 50;
/** Heartbeat cadence while provisioning; must stay well below the stale threshold. */
export const BOOT_CLAIM_HEARTBEAT_MS = 30_000;
