/**
 * Node's spec-compliant global `FormData` throws on the RN `{uri, name, type, size}` file
 * descriptor that `apps/mobile/lib/attachments.ts#buildFilePart` builds — it requires a
 * real `Blob`/`File`. React Native's own `FormData` accepts that descriptor and reads the
 * bytes from `uri` under the hood. This stands in for RN's `FormData` in the harness so
 * `uploadAttachment` runs its real, unmodified append logic and actually performs a
 * working multipart upload against the API's real `/files/:botId` route.
 *
 * Mirrors the `FakeFormData` test double in `apps/mobile/lib/attachments.test.ts`, but
 * this one produces a real `File` instead of recording the call, because the harness
 * uploads to a live server instead of a mocked `fetch`.
 */

type RNFilePart = { uri: string; name: string; type: string; size: number };

function isRNFilePart(value: unknown): value is RNFilePart {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { uri?: unknown }).uri === "string" &&
    (value as { uri: string }).uri.startsWith("data:")
  );
}

function fileFromDataUri(part: RNFilePart): File {
  const comma = part.uri.indexOf(",");
  const base64 = comma >= 0 ? part.uri.slice(comma + 1) : "";
  const bytes = Buffer.from(base64, "base64");
  return new File([bytes], part.name, { type: part.type });
}

const GlobalFormData = FormData;

export class NodeCapableFormData extends GlobalFormData {
  override append(name: string, value: unknown, filename?: string): void {
    if (isRNFilePart(value)) {
      super.append(name, fileFromDataUri(value), filename ?? value.name);
      return;
    }
    super.append(name, value as never, filename);
  }
}

/** Encodes bytes as the `data:` URI a `PickedFile.uri` needs for `NodeCapableFormData` to decode. */
export function dataUri(bytes: Uint8Array, mimeType: string): string {
  return `data:${mimeType};base64,${Buffer.from(bytes).toString("base64")}`;
}
