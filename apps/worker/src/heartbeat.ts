import { hostname } from "node:os";

/**
 * Quem é este worker para o banco: `host:pid` distingue dois processos na mesma máquina e a
 * mesma máquina em dois reinícios; a versão é a do stack publicado, e "dev" quando roda do
 * código-fonte. É o id que vai no batimento e no dono do lease, para bater um com o outro.
 */
export function workerIdentity(
  env: NodeJS.ProcessEnv,
  options: { pid?: number; host?: string } = {},
): { workerId: string; version: string } {
  const host = options.host ?? hostname();
  const pid = options.pid ?? process.pid;
  const version = env.QUIBT_STACK_VERSION?.trim() || env.npm_package_version?.trim() || "dev";
  return { workerId: `${host}:${pid}`, version };
}
