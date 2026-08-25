/// <reference types="astro/client" />

declare module "*.png" {
  const src: string;
  export default src;
}

interface ImportMetaEnv {
  readonly PUBLIC_APP_ORIGIN?: string;
  readonly PUBLIC_WAITLIST_API_URL?: string;
  readonly PUBLIC_WAITLIST_URL?: string;
}

interface ImportMeta {
  readonly env: ImportMetaEnv;
}
