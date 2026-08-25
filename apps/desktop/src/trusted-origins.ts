import { isLocalWebUrl } from "./stack.js";

export class TrustedOriginPolicy {
  private localOrigin: string;
  private currentOrigin: string | null = null;

  constructor(localWebUrl: string) {
    this.localOrigin = new URL(localWebUrl).origin;
  }

  getOrigins(): Set<string> {
    const origins = new Set<string>([this.localOrigin]);
    if (this.currentOrigin && this.currentOrigin !== this.localOrigin) {
      origins.add(this.currentOrigin);
    }
    return origins;
  }

  isTrusted(raw: string): boolean {
    try {
      return this.getOrigins().has(new URL(raw).origin);
    } catch {
      return false;
    }
  }

  isLocal(raw: string): boolean {
    try {
      return new URL(raw).origin === this.localOrigin;
    } catch {
      return false;
    }
  }

  setRemote(url: string | null): void {
    if (!url || isLocalWebUrl(url)) {
      this.currentOrigin = null;
      return;
    }
    this.currentOrigin = new URL(url).origin;
  }

  bootstrap(localWebUrl: string, remoteUrl: string | null): void {
    this.localOrigin = new URL(localWebUrl).origin;
    this.setRemote(remoteUrl);
  }
}
