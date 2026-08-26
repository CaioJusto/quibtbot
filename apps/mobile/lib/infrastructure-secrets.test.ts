import { createHash } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";

const getItemAsync = vi.fn();
const setItemAsync = vi.fn();
const deleteItemAsync = vi.fn();

vi.mock("expo-secure-store", () => ({
  getItemAsync,
  setItemAsync,
  deleteItemAsync,
}));

const INDEX_KEY = "quibt.infra._index";
const AUTH_OPTIONS = {
  requireAuthentication: true,
  authenticationPrompt: "Desbloqueie para acessar credenciais de infraestrutura.",
};

function storageKey(hostId: string) {
  const normalized = hostId.trim().toLowerCase().replace(/\.$/, "");
  const digest = createHash("sha256").update(normalized, "utf8").digest("hex");
  return `quibt.infra.${digest}`;
}

beforeEach(() => {
  getItemAsync.mockReset();
  setItemAsync.mockReset();
  deleteItemAsync.mockReset();
  setItemAsync.mockResolvedValue(undefined);
  deleteItemAsync.mockResolvedValue(undefined);
  getItemAsync.mockImplementation(async (key: string) => {
    if (key === INDEX_KEY) return "[]";
    return null;
  });
});

describe("infrastructureCredentialStorageKey", () => {
  it("derives the SecureStore key from SHA-256 of the normalized host", async () => {
    const { infrastructureCredentialStorageKey, normalizeInfrastructureHost } = await import(
      "./infrastructure-secrets.js"
    );

    expect(normalizeInfrastructureHost(" VPS.Example.COM. ")).toBe("vps.example.com");
    expect(infrastructureCredentialStorageKey("VPS.Example.COM.")).toBe(
      storageKey("vps.example.com"),
    );
  });
});

describe("parseSshCredentialHostId", () => {
  it("recovers the exact SSH target stored by the installer", async () => {
    const { parseSshCredentialHostId } = await import("./infrastructure-secrets.js");
    expect(parseSshCredentialHostId("root@46.224.84.18:22")).toEqual({
      username: "root",
      hostname: "46.224.84.18",
      port: 22,
    });
    expect(parseSshCredentialHostId("box.ascii.dev")).toBeNull();
    expect(parseSshCredentialHostId("root@host:70000")).toBeNull();
  });
});

describe("saveInfrastructureCredential", () => {
  it("stores secrets with requireAuthentication and updates metadata index without secrets", async () => {
    const { saveInfrastructureCredential } = await import("./infrastructure-secrets.js");

    await saveInfrastructureCredential("root@vps.example.com:22", {
      type: "password",
      label: "root@vps.example.com:22",
      password: "hunter2",
    });

    const key = storageKey("root@vps.example.com:22");
    expect(setItemAsync).toHaveBeenCalledWith(
      key,
      expect.stringContaining('"password":"hunter2"'),
      AUTH_OPTIONS,
    );

    const indexCall = setItemAsync.mock.calls.find(([storedKey]) => storedKey === INDEX_KEY);
    expect(indexCall).toBeTruthy();
    const index = JSON.parse(indexCall![1] as string) as Array<Record<string, unknown>>;
    expect(index).toHaveLength(1);
    expect(index[0]).toMatchObject({
      hostId: "root@vps.example.com:22",
      label: "root@vps.example.com:22",
      authType: "password",
    });
    expect(index[0]).not.toHaveProperty("password");
    expect(index[0]).not.toHaveProperty("privateKey");
    expect(index[0]).not.toHaveProperty("apiKey");
  });
});

describe("listInfrastructureCredentialMetadata", () => {
  it("returns metadata only and never exposes secret fields", async () => {
    getItemAsync.mockImplementation(async (key: string) => {
      if (key === INDEX_KEY) {
        return JSON.stringify([
          {
            hostId: "box.ascii.dev",
            label: "Box servidor",
            authType: "boxApiKey",
            lastUsedAt: "2026-08-17T10:00:00.000Z",
          },
        ]);
      }
      return null;
    });

    const { listInfrastructureCredentialMetadata } = await import("./infrastructure-secrets.js");
    const rows = await listInfrastructureCredentialMetadata();

    expect(rows).toEqual([
      {
        hostId: "box.ascii.dev",
        label: "Box servidor",
        authType: "boxApiKey",
        lastUsedAt: "2026-08-17T10:00:00.000Z",
      },
    ]);
    expect(JSON.stringify(rows)).not.toContain("apiKey");
  });
});

describe("loadInfrastructureCredential", () => {
  it("preserves the credential when the user cancels biometric authentication", async () => {
    const hostId = "root@vps.example.com:22";
    const key = storageKey(hostId);
    getItemAsync.mockImplementation(async (storedKey: string) => {
      if (storedKey === key) throw new Error("User canceled authentication");
      if (storedKey === INDEX_KEY) return "[]";
      return null;
    });

    const { loadInfrastructureCredential } = await import("./infrastructure-secrets.js");
    await expect(loadInfrastructureCredential(hostId)).resolves.toEqual({
      state: "reauth-required",
    });
    expect(deleteItemAsync).not.toHaveBeenCalled();
  });

  it("returns stored credentials when SecureStore decrypts successfully", async () => {
    const key = storageKey("root@vps.example.com:22");
    getItemAsync.mockImplementation(async (storedKey: string) => {
      if (storedKey === key) {
        return JSON.stringify({
          type: "privateKey",
          label: "root@vps.example.com:22",
          privateKey: "-----BEGIN PRIVATE KEY-----",
          passphrase: "secret",
          savedAt: "2026-08-17T09:00:00.000Z",
          lastUsedAt: "2026-08-17T09:00:00.000Z",
        });
      }
      if (storedKey === INDEX_KEY) return "[]";
      return null;
    });

    const { loadInfrastructureCredential } = await import("./infrastructure-secrets.js");
    const result = await loadInfrastructureCredential("root@vps.example.com:22");

    expect(getItemAsync).toHaveBeenCalledWith(key, AUTH_OPTIONS);
    expect(result).toEqual({
      state: "ok",
      credential: {
        type: "privateKey",
        label: "root@vps.example.com:22",
        privateKey: "-----BEGIN PRIVATE KEY-----",
        passphrase: "secret",
      },
    });
  });

  it("returns reauth-required, deletes unreadable ciphertext, and drops metadata", async () => {
    const hostId = "root@vps.example.com:22";
    const key = storageKey(hostId);
    getItemAsync.mockImplementation(async (storedKey: string) => {
      if (storedKey === key) return "{not-json";
      if (storedKey === INDEX_KEY) {
        return JSON.stringify([
          {
            hostId,
            label: hostId,
            authType: "password",
            lastUsedAt: "2026-08-17T10:00:00.000Z",
          },
        ]);
      }
      return null;
    });

    const { loadInfrastructureCredential } = await import("./infrastructure-secrets.js");
    const result = await loadInfrastructureCredential(hostId);

    expect(result).toEqual({ state: "reauth-required" });
    expect(deleteItemAsync).toHaveBeenCalledWith(key, AUTH_OPTIONS);
    const indexCall = setItemAsync.mock.calls.find(([storedKey]) => storedKey === INDEX_KEY);
    expect(JSON.parse(indexCall![1] as string)).toEqual([]);
  });
});

describe("forgetInfrastructureCredential", () => {
  it("removes the credential entry and metadata row", async () => {
    const hostId = "root@vps.example.com:22";
    const key = storageKey(hostId);
    getItemAsync.mockImplementation(async (storedKey: string) => {
      if (storedKey === INDEX_KEY) {
        return JSON.stringify([
          {
            hostId,
            label: hostId,
            authType: "password",
            lastUsedAt: "2026-08-17T10:00:00.000Z",
          },
        ]);
      }
      return null;
    });

    const { forgetInfrastructureCredential } = await import("./infrastructure-secrets.js");
    await forgetInfrastructureCredential(hostId);

    expect(deleteItemAsync).toHaveBeenCalledWith(key, AUTH_OPTIONS);
    const indexCall = setItemAsync.mock.calls.find(([storedKey]) => storedKey === INDEX_KEY);
    expect(JSON.parse(indexCall![1] as string)).toEqual([]);
  });
});
