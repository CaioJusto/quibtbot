import { defaultApiBase } from "./endpoint";

export function webOrigin() {
  const configured = process.env.EXPO_PUBLIC_WEB_ORIGIN?.replace(/\/$/, "");
  if (configured) return configured;
  const api = defaultApiBase();
  if (api.includes("127.0.0.1") || api.includes("localhost")) return "http://127.0.0.1:5173";
  return api;
}

export function billingReturnUrl(kind: "success" | "canceled") {
  return `${webOrigin()}/billing?billing=${kind}&app=1`;
}
