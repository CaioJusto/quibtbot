/** Box v1 OpenAPI-aligned shapes used by the mobile remote installer. */

export const BOX_API_BASE_URL = "https://ascii.dev/api/box/v1";
export const SERVER_BOX_NAME = "Quibt Bot server";

export interface BoxRecord {
  id: string;
  name?: string | null;
  state: string;
  url?: string | null;
  /** Null when the box is no-env or detached from an environment. */
  environment?: string | null;
}

export interface CreateBoxRequest {
  ttlSeconds: number | null;
  noEnv: true;
  name?: string;
}

export function isServerBoxRecord(box: BoxRecord): boolean {
  return box.name === SERVER_BOX_NAME && box.environment === null;
}

export function createServerBoxRequest(): CreateBoxRequest {
  return { ttlSeconds: null, noEnv: true };
}
