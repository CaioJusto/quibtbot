/**
 * Immutable source revision for every public `curl | sh` bootstrap command.
 *
 * This deliberately points at the reviewed commit that contains `scripts/install.sh`,
 * rather than at a movable branch or tag. When the installer script changes, publish
 * that change first and then advance this revision in a follow-up commit.
 */
export const INSTALL_SCRIPT_REVISION = "f75c7c22b79a75cf682e3e461e6d61ea58202101";

export const INSTALL_SCRIPT_RAW_URL = `https://raw.githubusercontent.com/CaioJusto/quibtbot/${INSTALL_SCRIPT_REVISION}/scripts/install.sh`;
