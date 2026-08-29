/** Box v1 OpenAPI-aligned shapes used by the desktop remote installer. */

export const SERVER_BOX_NAME = "Quibt Bot server";
export const BOX_TRIAL_SERVER_TTL_SECONDS = 2 * 60 * 60;

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

export interface CreateBoxResponse {
  box: BoxRecord;
}

export interface ListBoxesResponse {
  boxes: BoxRecord[];
}

export interface GetBoxResponse {
  box: BoxRecord;
}

export function isServerBoxRecord(box: BoxRecord): boolean {
  // The public Box schema marks `environment` as optional and no-env responses
  // may omit it entirely instead of returning an explicit null.
  return (
    box.name === SERVER_BOX_NAME && (box.environment === null || box.environment === undefined)
  );
}

export function createServerBoxRequest(ttlSeconds: number | null = null): CreateBoxRequest {
  return { ttlSeconds, noEnv: true };
}
