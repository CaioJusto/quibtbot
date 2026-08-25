import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type Attachment,
  attachmentTooBig,
  buildFilePart,
  buildSendWithAttachmentsPayload,
  fileUrl,
  formatBytes,
  MAX_ATTACHMENT_BYTES,
  type PickedFile,
  uploadAttachment,
} from "./attachments.js";

/**
 * Node's spec-compliant `FormData.append` throws on the RN `{uri, name, type}` descriptor
 * (it requires a real `Blob`), so it cannot exercise the on-device construction path.
 * This test double stands in for RN's `FormData`, which accepts that descriptor as-is,
 * letting `uploadAttachment` run its real (unswallowed) append logic in tests.
 */
class FakeFormData {
  private parts = new Map<string, unknown>();
  append(name: string, value: unknown) {
    this.parts.set(name, value);
  }
  get(name: string) {
    return this.parts.get(name) ?? null;
  }
}

const picked: PickedFile = {
  uri: "file:///tmp/planilha.csv",
  name: "planilha.csv",
  mimeType: "text/csv",
  size: 8,
};

const stored: Attachment = {
  id: "art_1",
  name: "planilha.csv",
  mimeType: "text/csv",
  size: 8,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("attachment helpers", () => {
  it("flags files over 25 MB", () => {
    expect(attachmentTooBig(MAX_ATTACHMENT_BYTES)).toBe(false);
    expect(attachmentTooBig(MAX_ATTACHMENT_BYTES + 1)).toBe(true);
  });

  it("formats byte sizes", () => {
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2 KB");
    expect(formatBytes(3 * 1024 * 1024)).toBe("3.0 MB");
  });

  it("builds authenticated file URLs", () => {
    expect(fileUrl("art_1", "http://127.0.0.1:3100")).toBe("http://127.0.0.1:3100/files/art_1");
  });
});

describe("buildFilePart", () => {
  it("builds the RN multipart descriptor preserving filename, MIME and size", () => {
    expect(buildFilePart(picked)).toEqual({
      uri: "file:///tmp/planilha.csv",
      name: "planilha.csv",
      type: "text/csv",
      size: 8,
    });
  });
});

describe("uploadAttachment", () => {
  it("posts multipart to /files/:botId preserving filename, MIME and size", async () => {
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => stored,
    });
    vi.stubGlobal("fetch", fetchMock);
    vi.stubGlobal("FormData", FakeFormData);

    const result = await uploadAttachment("bot_ada", picked, {
      apiBase: "http://127.0.0.1:3100",
      authHeaders: { authorization: "Bearer session" },
    });

    expect(result).toEqual(stored);
    expect(fetchMock).toHaveBeenCalledWith(
      "http://127.0.0.1:3100/files/bot_ada",
      expect.objectContaining({
        method: "POST",
        headers: expect.objectContaining({ authorization: "Bearer session" }),
      }),
    );
    const init = fetchMock.mock.calls[0]![1] as { body: FakeFormData };
    const body = init.body;
    expect(body).toBeInstanceOf(FakeFormData);
    const file = body.get("file") as { uri: string; name: string; type: string; size: number };
    expect(file.uri).toBe("file:///tmp/planilha.csv");
    expect(file.name).toBe("planilha.csv");
    expect(file.type).toBe("text/csv");
    expect(file.size).toBe(8);
  });

  it("surfaces non-2xx upload errors", async () => {
    vi.stubGlobal("FormData", FakeFormData);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockResolvedValue({
        ok: false,
        status: 413,
        json: async () => ({ message: "O arquivo é grande demais." }),
      }),
    );

    await expect(
      uploadAttachment("bot_ada", picked, { apiBase: "http://127.0.0.1:3100" }),
    ).rejects.toThrow("O arquivo é grande demais.");
  });

  it("surfaces abort errors", async () => {
    vi.stubGlobal("FormData", FakeFormData);
    vi.stubGlobal(
      "fetch",
      vi.fn().mockRejectedValue(Object.assign(new Error("Aborted"), { name: "AbortError" })),
    );

    await expect(
      uploadAttachment("bot_ada", picked, {
        apiBase: "http://127.0.0.1:3100",
        signal: AbortSignal.abort(),
      }),
    ).rejects.toThrow("Envio cancelado.");
  });
});

describe("buildSendWithAttachmentsPayload", () => {
  it("passes attachment refs to threads/send", () => {
    expect(
      buildSendWithAttachmentsPayload({
        botId: "bot_ada",
        text: "segue a planilha",
        clientNonce: "nonce-1",
        attachments: [stored],
        replyToId: "msg_prev",
        mentionBotIds: ["bot_rex"],
      }),
    ).toEqual({
      botId: "bot_ada",
      text: "segue a planilha",
      clientNonce: "nonce-1",
      attachments: ["art_1"],
      replyToId: "msg_prev",
      mentionBotIds: ["bot_rex"],
    });
  });

  it("uses attachment names when the draft is empty", () => {
    expect(
      buildSendWithAttachmentsPayload({
        botId: "bot_ada",
        text: "",
        attachments: [stored],
      }).text,
    ).toBe("planilha.csv");
  });
});
