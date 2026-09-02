import { createCipheriv, createDecipheriv, createHash, randomBytes } from "node:crypto";
import { mkdir, readdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type {
  AdapterContext,
  CommandRequest,
  ComputerRef,
  SandboxProvider,
} from "@quibt/adapter-kit";
import { machineFamily } from "@quibt/core";

export const WORKSPACE_CHECKPOINT_DIR = "workspace-checkpoints";
export const WORKSPACE_CHECKPOINT_FILE = "snapshot.qbhc";
export const WORKSPACE_CHECKPOINT_MAGIC = "QBHC1";

/** Directory/file names that are cache, not portable work. */
export const PORTABLE_HOME_EXCLUDED_SEGMENTS: ReadonlySet<string> = new Set([
  "Cache",
  "Code Cache",
  "GPUCache",
  "tmp",
  "node_modules",
  "_cacache",
  "trash",
  "Trash",
  ".Trash",
  ".X11-unix",
  "novnc",
  ".novnc",
  "SingletonLock",
  "SingletonSocket",
  "SingletonCookie",
  "lockfile",
  "LOCK",
]);

export interface PortableHomeEntry {
  path: string;
  content: Uint8Array;
}

export interface PortableHomeLayout {
  homeRoot: string;
  chromeRoots: string[];
  /** Docker / VPS share one /home; apply must not overlay a sibling's live house. */
  sharedHome: boolean;
}

export interface PortableHomeVolume {
  collect(): Promise<PortableHomeEntry[]>;
  apply(entries: PortableHomeEntry[]): Promise<void>;
}

export interface WorkspaceCheckpointStore {
  save(botId: string, entries: PortableHomeEntry[]): Promise<void>;
  load(botId: string): Promise<PortableHomeEntry[] | null>;
}

export type SandboxWithPortableHome = SandboxProvider & {
  checkpointHome(computer: ComputerRef, context: AdapterContext): Promise<void>;
  restoreHome(computer: ComputerRef, context: AdapterContext): Promise<void>;
  collectPortableHome?(
    computer: ComputerRef,
    context: AdapterContext,
  ): Promise<PortableHomeEntry[]>;
  applyPortableHome?(
    computer: ComputerRef,
    entries: PortableHomeEntry[],
    context: AdapterContext,
  ): Promise<void>;
};

export function shouldExcludePortablePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, "/").split("/").filter(Boolean);
  return parts.some((part) => PORTABLE_HOME_EXCLUDED_SEGMENTS.has(part));
}

export function isSafePortablePath(relativePath: string): boolean {
  const parts = relativePath.replace(/\\/g, "/").split("/");
  if (parts[0] !== "home" && parts[0] !== "chrome") return false;
  return parts.every((part) => part.length > 0 && part !== "." && part !== "..");
}

export function isSharedWorkspaceHome(kind: string): boolean {
  const family = machineFamily(kind) ?? kind;
  return family === "docker" || family === "remote-supervisor";
}

export function portableHomeLayout(kind: string, botId: string): PortableHomeLayout {
  const family = machineFamily(kind) ?? kind;
  if (family === "e2b") {
    return {
      homeRoot: "/home/user",
      chromeRoots: [
        "/home/user/.config/chromium",
        "/home/user/.config/google-chrome",
        "/home/user/.config/google-chrome-for-testing",
      ],
      sharedHome: false,
    };
  }
  if (family === "box") {
    return {
      homeRoot: "/home/ubuntu",
      chromeRoots: [
        "/home/ubuntu/.config/chromium",
        "/home/ubuntu/.config/google-chrome",
        "/home/ubuntu/.config/google-chrome-for-testing",
      ],
      sharedHome: false,
    };
  }
  if (family === "daytona") {
    return {
      homeRoot: "/home/daytona",
      chromeRoots: [
        "/home/daytona/.config/chromium",
        "/home/daytona/.config/google-chrome",
        "/home/daytona/.config/google-chrome-for-testing",
      ],
      sharedHome: false,
    };
  }
  const chrome = `/quibt-desktops/${botId}/chrome`;
  return {
    homeRoot: "/home/quibt",
    chromeRoots: [chrome, "/home/quibt/.config/chromium", "/home/quibt/.config/google-chrome"],
    sharedHome: isSharedWorkspaceHome(kind),
  };
}

export function collectFromFileMap(
  files: Map<string, string>,
  layout: PortableHomeLayout,
): PortableHomeEntry[] {
  const entries: PortableHomeEntry[] = [];
  const chromeRoots = layout.chromeRoots.map(normalizeAbs);
  const homeRoot = normalizeAbs(layout.homeRoot);
  for (const [rawPath, content] of files) {
    const abs = normalizeAbs(rawPath);
    const chromeRel = relativeToAny(abs, chromeRoots);
    if (chromeRel !== null) {
      pushEntry(entries, `chrome/${chromeRel}`.replace(/\/$/, ""), content);
      continue;
    }
    const homeRel = relativeToRoot(abs, homeRoot);
    if (homeRel === null) continue;
    if (chromeRoots.some((root) => abs === root || abs.startsWith(`${root}/`))) continue;
    pushEntry(entries, `home/${homeRel}`.replace(/\/$/, ""), content);
  }
  return entries;
}

export function applyToFileMap(
  files: Map<string, string>,
  layout: PortableHomeLayout,
  entries: PortableHomeEntry[],
): void {
  const chromeRoot = layout.chromeRoots[0] ?? path.posix.join(layout.homeRoot, ".config/chromium");
  for (const entry of entries) {
    if (!shouldApplyEntry(entry.path, layout.sharedHome)) continue;
    const abs = materializeAbs(entry.path, layout.homeRoot, chromeRoot);
    if (!abs) continue;
    files.set(abs, new TextDecoder().decode(entry.content));
  }
}

export function hostDirPortableHomeVolume(input: {
  homeRoot: string;
  chromeRoot: string;
  sharedHome?: boolean;
}): PortableHomeVolume {
  return {
    async collect() {
      const home = await walkHostDir(input.homeRoot, "home");
      const chrome = await walkHostDir(input.chromeRoot, "chrome");
      return [...home, ...chrome];
    },
    async apply(entries) {
      for (const entry of entries) {
        if (!shouldApplyEntry(entry.path, input.sharedHome === true)) continue;
        const abs = materializeHost(entry.path, input.homeRoot, input.chromeRoot);
        if (!abs) continue;
        await mkdir(path.dirname(abs), { recursive: true });
        await writeFile(abs, Buffer.from(entry.content));
      }
    },
  };
}

export function createWorkspaceCheckpointStore(input: {
  dataDir: string;
  encryptionKey: string;
}): WorkspaceCheckpointStore {
  const root = path.resolve(input.dataDir, WORKSPACE_CHECKPOINT_DIR);
  return {
    async save(botId, entries) {
      const filtered = entries.filter((entry) => isStoreableEntry(entry.path));
      const payload = encodeSnapshot(filtered);
      const cipher = encryptBytes(input.encryptionKey, payload, botId);
      const dir = path.join(root, safeId(botId));
      await mkdir(dir, { recursive: true });
      const dest = path.join(dir, WORKSPACE_CHECKPOINT_FILE);
      const tmp = `${dest}.tmp`;
      await writeFile(tmp, cipher);
      await rename(tmp, dest);
    },
    async load(botId) {
      const dest = path.join(root, safeId(botId), WORKSPACE_CHECKPOINT_FILE);
      try {
        const buf = await readFile(dest);
        return decodeSnapshot(decryptBytes(input.encryptionKey, buf, botId));
      } catch (error) {
        if (isMissing(error)) return null;
        throw error;
      }
    },
  };
}

export async function checkpointPortableHome(
  store: WorkspaceCheckpointStore,
  botId: string,
  volume: PortableHomeVolume,
): Promise<void> {
  await store.save(botId, await volume.collect());
}

export async function restorePortableHome(
  store: WorkspaceCheckpointStore,
  botId: string,
  volume: PortableHomeVolume,
): Promise<"restored" | "missing"> {
  const entries = await store.load(botId);
  if (!entries) return "missing";
  await volume.apply(entries);
  return "restored";
}

export function volumeFromFileMap(
  files: Map<string, string>,
  layout: PortableHomeLayout,
): PortableHomeVolume {
  return {
    async collect() {
      return collectFromFileMap(files, layout);
    },
    async apply(entries) {
      applyToFileMap(files, layout, entries);
    },
  };
}

export function portableHomeVolumeFor(
  provider: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
  options?: { dataDir?: string },
): PortableHomeVolume {
  const capable = asPortableHome(provider);
  if (capable?.collectPortableHome && capable.applyPortableHome) {
    return {
      collect: () => capable.collectPortableHome!(computer, context),
      apply: (entries) => capable.applyPortableHome!(computer, entries, context),
    };
  }
  if (computer.kind === "docker" && options?.dataDir) {
    return hostDirPortableHomeVolume({
      homeRoot: workspaceHomeOnHost(options.dataDir, context.workspaceId),
      chromeRoot: workspaceChromeOnHost(options.dataDir, context.workspaceId, computer.botId),
      sharedHome: true,
    });
  }
  return commandPortableHomeVolume(provider, computer, context);
}

export function workspaceHomeOnHost(dataDir: string, workspaceId: string) {
  return path.resolve(dataDir, "workspaces", safeHostId(workspaceId), "home");
}

export function workspaceChromeOnHost(dataDir: string, workspaceId: string, botId: string) {
  return path.resolve(
    dataDir,
    "workspaces",
    safeHostId(workspaceId),
    "desktops",
    safeId(botId),
    "chrome",
  );
}

export function withWorkspaceCheckpoint(
  provider: SandboxProvider,
  store: WorkspaceCheckpointStore,
  options?: { dataDir?: string },
): SandboxWithPortableHome {
  const volume = (computer: ComputerRef, context: AdapterContext) =>
    portableHomeVolumeFor(provider, computer, context, options);

  const checkpointHome = async (computer: ComputerRef, context: AdapterContext) => {
    try {
      await checkpointPortableHome(store, computer.botId, volume(computer, context));
    } catch (error) {
      console.error("workspace-checkpoint: save failed", error);
    }
  };

  const restoreHome = async (computer: ComputerRef, context: AdapterContext) => {
    await restorePortableHome(store, computer.botId, volume(computer, context));
  };

  const wrapped: SandboxWithPortableHome = {
    describe: () => provider.describe(),
    async provision(request, context) {
      const ref = await provider.provision(request, context);
      // Workspace-scoped Docker boots the container as botId "workspace"; the
      // real bot restore happens in bootSharedDesktopSession.
      if (request.botId !== "workspace") {
        await restoreHome({ ...ref, botId: request.botId }, { ...context, botId: request.botId });
      }
      return ref;
    },
    execute: (computer, request, context) => provider.execute(computer, request, context),
    connectScreen: (computer, request, context) =>
      provider.connectScreen(computer, request, context),
    sendInput: (computer, input, lease, context) =>
      provider.sendInput(computer, input, lease, context),
    snapshot: (computer, context) => provider.snapshot(computer, context),
    async stop(computer, context) {
      await checkpointHome(computer, context);
      await provider.stop(computer, context);
    },
    async destroy(computer, context) {
      await checkpointHome(computer, context);
      await provider.destroy(computer, context);
    },
    checkpointHome,
    restoreHome,
  };

  if (provider.revokeScreen) {
    wrapped.revokeScreen = (computer, context) => provider.revokeScreen!(computer, context);
  }
  if (provider.exists) {
    wrapped.exists = (computer, context) => provider.exists!(computer, context);
  }
  if (provider.presence) {
    wrapped.presence = (computer, context) => provider.presence!(computer, context);
  }
  if (provider.start) {
    wrapped.start = (computer, context) => provider.start!(computer, context);
  }
  if (provider.destroyBotSession) {
    wrapped.destroyBotSession = async (computer, context, sessionOptions) => {
      await checkpointHome(computer, context);
      await provider.destroyBotSession!(computer, context, sessionOptions);
    };
  }
  const keepAlive = (
    provider as SandboxProvider & {
      keepAlive?: (computer: ComputerRef, context?: AdapterContext) => Promise<void>;
    }
  ).keepAlive;
  if (keepAlive) {
    (wrapped as SandboxWithPortableHome & { keepAlive: typeof keepAlive }).keepAlive = (
      computer,
      context,
    ) => keepAlive(computer, context);
  }
  const innerCollect = asPortableHome(provider);
  if (innerCollect?.collectPortableHome) {
    wrapped.collectPortableHome = (computer, context) =>
      innerCollect.collectPortableHome!(computer, context);
  }
  if (innerCollect?.applyPortableHome) {
    wrapped.applyPortableHome = (computer, entries, context) =>
      innerCollect.applyPortableHome!(computer, entries, context);
  }
  return wrapped;
}

export async function checkpointSandboxHome(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<void> {
  const provider = sandbox as SandboxWithPortableHome;
  if (typeof provider.checkpointHome !== "function") return;
  await provider.checkpointHome(computer, context);
}

export async function restoreSandboxHome(
  sandbox: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): Promise<void> {
  const provider = sandbox as SandboxWithPortableHome;
  if (typeof provider.restoreHome !== "function") return;
  await provider.restoreHome(computer, context);
}

function commandPortableHomeVolume(
  provider: SandboxProvider,
  computer: ComputerRef,
  context: AdapterContext,
): PortableHomeVolume {
  const layout = portableHomeLayout(computer.kind, computer.botId);
  return {
    async collect() {
      const result = await runCaptured(
        provider,
        computer,
        ["python3", "-c", collectPython(layout)],
        context,
      );
      if (result.code !== 0) {
        throw new Error(result.stderr.trim() || "portable home collect failed");
      }
      const parsed = JSON.parse(result.stdout || '{"files":[]}') as {
        files?: Array<{ p?: string; c?: string }>;
      };
      return (parsed.files ?? [])
        .filter((file): file is { p: string; c: string } => typeof file.p === "string")
        .filter((file) => isStoreableEntry(file.p))
        .map((file) => ({
          path: file.p,
          content: Buffer.from(file.c ?? "", "base64"),
        }));
    },
    async apply(entries) {
      const chromeRoot =
        layout.chromeRoots[0] ?? path.posix.join(layout.homeRoot, ".config/chromium");
      const filtered = entries.filter((entry) => shouldApplyEntry(entry.path, layout.sharedHome));
      for (const batch of chunk(filtered, 16)) {
        const result = await runCaptured(
          provider,
          computer,
          ["python3", "-c", applyPython(layout.homeRoot, chromeRoot, batch)],
          context,
        );
        if (result.code !== 0) {
          throw new Error(result.stderr.trim() || "portable home apply failed");
        }
      }
    },
  };
}

async function runCaptured(
  provider: SandboxProvider,
  computer: ComputerRef,
  argv: string[],
  context: AdapterContext,
): Promise<{ stdout: string; stderr: string; code: number }> {
  const request: CommandRequest = { argv, timeoutMs: 120_000 };
  let stdout = "";
  let stderr = "";
  let code = 0;
  for await (const event of provider.execute(computer, request, context)) {
    if (event.type === "stdout") stdout += event.data;
    if (event.type === "stderr") stderr += event.data;
    if (event.type === "exit") code = event.code;
  }
  return { stdout, stderr, code };
}

function collectPython(layout: PortableHomeLayout): string {
  return [
    "import json,os,base64",
    `EXCL=set(${JSON.stringify([...PORTABLE_HOME_EXCLUDED_SEGMENTS])})`,
    `HOME=${JSON.stringify(layout.homeRoot)}`,
    `CHROMES=${JSON.stringify(layout.chromeRoots)}`,
    "CHROME_ABS=[os.path.abspath(c) for c in CHROMES if c]",
    "def skip(p):",
    "    return any(part in EXCL for part in p.replace('\\\\','/').split('/'))",
    "def under_chrome(full):",
    "    a=os.path.abspath(full)",
    "    return any(a==c or a.startswith(c+os.sep) for c in CHROME_ABS)",
    "def walk(root, prefix, omit_chrome=False):",
    "    out=[]",
    "    if not os.path.isdir(root):",
    "        return out",
    "    for dp, dns, fns in os.walk(root):",
    "        dns[:] = [d for d in dns if d not in EXCL]",
    "        for name in fns:",
    "            full=os.path.join(dp,name)",
    "            if omit_chrome and under_chrome(full):",
    "                continue",
    "            rel=os.path.relpath(full,root).replace(os.sep,'/')",
    "            portable=f'{prefix}/{rel}'",
    "            if skip(portable):",
    "                continue",
    "            try:",
    "                data=open(full,'rb').read()",
    "            except OSError:",
    "                continue",
    "            out.append({'p':portable,'c':base64.b64encode(data).decode('ascii')})",
    "    return out",
    "files=walk(HOME,'home',True)",
    "for chrome in CHROMES:",
    "    if chrome and os.path.isdir(chrome):",
    "        files.extend(walk(chrome,'chrome'))",
    "        break",
    "print(json.dumps({'files':files}), end='')",
  ].join("\n");
}

function applyPython(homeRoot: string, chromeRoot: string, entries: PortableHomeEntry[]): string {
  const payload = entries.map((entry) => ({
    p: entry.path,
    c: Buffer.from(entry.content).toString("base64"),
  }));
  return [
    "import json,os,base64",
    `HOME=os.path.abspath(${JSON.stringify(homeRoot)})`,
    `CHROME=os.path.abspath(${JSON.stringify(chromeRoot)})`,
    `ITEMS=json.loads(${JSON.stringify(JSON.stringify(payload))})`,
    "def contained(root, rel):",
    "    if rel is None:",
    "        return root",
    "    if not rel or rel.startswith('/') or any(p in ('', '.', '..') for p in rel.split('/')):",
    "        return None",
    "    path=os.path.abspath(os.path.join(root, rel))",
    "    if path!=root and not path.startswith(root+os.sep):",
    "        return None",
    "    return path",
    "def dest(portable):",
    "    if portable=='home':",
    "        return HOME",
    "    if portable.startswith('home/'):",
    "        return contained(HOME, portable[5:])",
    "    if portable=='chrome':",
    "        return CHROME",
    "    if portable.startswith('chrome/'):",
    "        return contained(CHROME, portable[7:])",
    "    return None",
    "for item in ITEMS:",
    "    path=dest(item['p'])",
    "    if not path:",
    "        continue",
    "    os.makedirs(os.path.dirname(path) or '.', exist_ok=True)",
    "    open(path,'wb').write(base64.b64decode(item.get('c') or ''))",
  ].join("\n");
}

async function walkHostDir(root: string, prefix: string): Promise<PortableHomeEntry[]> {
  const entries: PortableHomeEntry[] = [];
  async function visit(current: string, rel: string): Promise<void> {
    const dirents = await readdir(current, { withFileTypes: true }).catch((error) => {
      if (isMissing(error)) return null;
      throw error;
    });
    if (!dirents) return;
    for (const dirent of dirents) {
      const childRel = rel ? `${rel}/${dirent.name}` : dirent.name;
      const portable = `${prefix}/${childRel}`;
      if (PORTABLE_HOME_EXCLUDED_SEGMENTS.has(dirent.name) || shouldExcludePortablePath(portable)) {
        continue;
      }
      const full = path.join(current, dirent.name);
      if (dirent.isSymbolicLink()) continue;
      if (dirent.isDirectory()) {
        await visit(full, childRel);
        continue;
      }
      if (!dirent.isFile()) continue;
      const info = await stat(full).catch(() => null);
      if (!info?.isFile()) continue;
      entries.push({ path: portable, content: new Uint8Array(await readFile(full)) });
    }
  }
  try {
    const info = await stat(root);
    if (!info.isDirectory()) return entries;
  } catch (error) {
    if (isMissing(error)) return entries;
    throw error;
  }
  await visit(root, "");
  return entries;
}

function pushEntry(entries: PortableHomeEntry[], portable: string, content: string) {
  const cleaned = portable.replace(/\/+/g, "/");
  if (!cleaned || !isStoreableEntry(cleaned)) return;
  entries.push({ path: cleaned, content: new TextEncoder().encode(content) });
}

function shouldApplyEntry(portable: string, sharedHome: boolean): boolean {
  if (!isStoreableEntry(portable)) return false;
  if (sharedHome && (portable === "home" || portable.startsWith("home/"))) return false;
  return true;
}

function isStoreableEntry(portable: string): boolean {
  return isSafePortablePath(portable) && !shouldExcludePortablePath(portable);
}

function materializeAbs(portable: string, homeRoot: string, chromeRoot: string): string | null {
  if (portable === "home") return normalizeAbs(homeRoot);
  if (portable.startsWith("home/")) {
    return containedPosix(homeRoot, portable.slice(5));
  }
  if (portable === "chrome") return normalizeAbs(chromeRoot);
  if (portable.startsWith("chrome/")) {
    return containedPosix(chromeRoot, portable.slice(7));
  }
  return null;
}

function materializeHost(portable: string, homeRoot: string, chromeRoot: string): string | null {
  if (portable === "home") return path.resolve(homeRoot);
  if (portable.startsWith("home/")) return containedJoin(homeRoot, portable.slice(5));
  if (portable === "chrome") return path.resolve(chromeRoot);
  if (portable.startsWith("chrome/")) return containedJoin(chromeRoot, portable.slice(7));
  return null;
}

function containedPosix(root: string, rel: string): string {
  const normalizedRoot = normalizeAbs(root);
  const candidate = path.posix.normalize(`${normalizedRoot}/${rel}`);
  if (candidate !== normalizedRoot && !candidate.startsWith(`${normalizedRoot}/`)) {
    throw new Error("Path escapes the portable home");
  }
  return candidate;
}

function containedJoin(root: string, rel: string): string {
  const resolvedRoot = path.resolve(root);
  const resolved = path.resolve(resolvedRoot, rel);
  if (resolved !== resolvedRoot && !resolved.startsWith(`${resolvedRoot}${path.sep}`)) {
    throw new Error("Path escapes the portable home");
  }
  return resolved;
}

function normalizeAbs(value: string): string {
  const posix = value.replace(/\\/g, "/");
  if (posix === "/") return "/";
  return posix.replace(/\/+$/, "") || "/";
}

function relativeToRoot(abs: string, root: string): string | null {
  if (abs === root) return "";
  if (abs.startsWith(`${root}/`)) return abs.slice(root.length + 1);
  return null;
}

function relativeToAny(abs: string, roots: string[]): string | null {
  for (const root of roots) {
    const rel = relativeToRoot(abs, root);
    if (rel !== null) return rel;
  }
  return null;
}

function encodeSnapshot(entries: PortableHomeEntry[]): Buffer {
  const body = {
    v: 1 as const,
    files: entries.map((entry) => ({
      p: entry.path,
      c: Buffer.from(entry.content).toString("base64"),
    })),
  };
  return gzipSync(Buffer.from(JSON.stringify(body), "utf8"));
}

function decodeSnapshot(payload: Buffer): PortableHomeEntry[] {
  const body = JSON.parse(gunzipSync(payload).toString("utf8")) as {
    files?: Array<{ p?: string; c?: string }>;
  };
  return (body.files ?? [])
    .filter((file): file is { p: string; c: string } => typeof file.p === "string")
    .filter((file) => isStoreableEntry(file.p))
    .map((file) => ({ path: file.p, content: Buffer.from(file.c ?? "", "base64") }));
}

function keyFrom(secret: string): Buffer {
  return createHash("sha256").update(secret).digest();
}

function encryptBytes(secret: string, plain: Buffer, aad: string): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", keyFrom(secret), iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const enc = Buffer.concat([cipher.update(plain), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([Buffer.from(WORKSPACE_CHECKPOINT_MAGIC), iv, tag, enc]);
}

function decryptBytes(secret: string, blob: Buffer, aad: string): Buffer {
  const magic = blob.subarray(0, 5).toString("utf8");
  if (magic !== WORKSPACE_CHECKPOINT_MAGIC) {
    throw new Error("Invalid workspace checkpoint");
  }
  const iv = blob.subarray(5, 17);
  const tag = blob.subarray(17, 33);
  const enc = blob.subarray(33);
  const decipher = createDecipheriv("aes-256-gcm", keyFrom(secret), iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(enc), decipher.final()]);
}

function safeId(id: string): string {
  if (!id || id === "." || id === ".." || path.basename(id) !== id) {
    throw new Error("Invalid bot id");
  }
  return id;
}

function safeHostId(id: string): string {
  return id.replace(/[^a-zA-Z0-9_.-]/g, "") || "box";
}

function asPortableHome(provider: SandboxProvider): SandboxWithPortableHome | null {
  const candidate = provider as SandboxWithPortableHome;
  if (
    typeof candidate.collectPortableHome === "function" ||
    typeof candidate.applyPortableHome === "function" ||
    typeof candidate.checkpointHome === "function"
  ) {
    return candidate;
  }
  return null;
}

function chunk<T>(items: T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += size) out.push(items.slice(i, i + size));
  return out;
}

function isMissing(error: unknown): error is NodeJS.ErrnoException {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}
