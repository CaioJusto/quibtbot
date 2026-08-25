# Mobile iOS Performance Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the existing Expo mobile UI responsive at larger inbox, plugin, thread, and remote-control workloads without changing its appearance or behavior.

**Architecture:** Keep the managed Expo architecture and current routes. Move repeated collection work into pure, tested helpers; virtualize mapped screen content; keep row props referentially stable; use platform-specific modules to keep Android-only font assets out of iOS; and coalesce high-frequency UI events before RPC calls.

**Tech Stack:** Expo 57, React 19.2, React Native 0.86, Expo Router, `expo-image`, TypeScript, Vitest.

## Global Constraints

- Preserve the current UI, navigation, native integrations, copy, and behavior.
- Add no Swift, Objective-C, SwiftUI, or custom native module.
- Change no API contract or server behavior.
- Remove no supported mascot shape or color.
- Use existing `--qb-*`-backed tokens for application chrome; do not add a dark surface.
- Follow red-green-refactor for every behavior change.
- Run commands from `/workspace` unless a step explicitly changes the working directory.

---

### Task 1: Make the mobile test command execute the mobile suite

**Files:**
- Modify: `apps/mobile/package.json`

**Interfaces:**
- Produces: `pnpm --filter @quibt/mobile test` discovers `apps/mobile/lib/**/*.test.ts` through the root Vitest configuration.

- [ ] **Step 1: Reproduce the broken command**

Run:

```bash
cd /workspace/apps/mobile
./node_modules/.bin/vitest run --passWithNoTests
```

Expected: PASS with `No test files found`, proving the package command does not execute the suite.

- [ ] **Step 2: Point Vitest at the repository root**

Change the script to:

```json
"test": "vitest run --root ../.. apps/mobile/lib"
```

- [ ] **Step 3: Run the corrected command**

Run:

```bash
cd /workspace/apps/mobile
./node_modules/.bin/vitest run --root ../.. apps/mobile/lib
```

Expected: 18 test files and 128 or more tests pass.

- [ ] **Step 4: Commit**

```bash
git add apps/mobile/package.json
git commit -m "test: run mobile suite from package script"
```

---

### Task 2: Cache remote images and remove Material Symbols from iOS

**Files:**
- Create: `apps/mobile/lib/icon-font.ts`
- Create: `apps/mobile/lib/icon-font.ios.ts`
- Modify: `apps/mobile/app/_layout.tsx`
- Modify: `apps/mobile/app/index.tsx`
- Modify: `apps/mobile/app/account.tsx`
- Modify: `apps/mobile/app/plugins.tsx`
- Modify: `apps/mobile/lib/assets.test.ts`
- Modify: `apps/mobile/package.json`
- Modify: `pnpm-lock.yaml`

**Interfaces:**
- Produces: `iconFonts: Record<string, number>` with an empty iOS implementation.
- Consumes: `Image` from `expo-image` for remote URI sources only.

- [ ] **Step 1: Write failing platform-boundary and remote-image tests**

Add to `apps/mobile/lib/assets.test.ts`:

```ts
function source(relative: string) {
  return readFileSync(path.join(dir, relative), "utf8");
}

it("keeps Material Symbols out of the iOS font module", () => {
  expect(source("../app/_layout.tsx")).not.toContain("@expo-google-fonts/material-symbols");
  expect(source("./icon-font.ios.ts")).not.toContain("@expo-google-fonts/material-symbols");
  expect(source("./icon-font.ts")).toContain("@expo-google-fonts/material-symbols");
});

it("uses expo-image for remote mobile images", () => {
  for (const file of ["../app/index.tsx", "../app/account.tsx", "../app/plugins.tsx"]) {
    expect(source(file)).toContain('from "expo-image"');
  }
});
```

Use the existing `dir` constant, so paths resolve from `apps/mobile/lib`.

- [ ] **Step 2: Run the focused test and verify RED**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/assets.test.ts
```

Expected: FAIL because `icon-font.ios.ts` does not exist and screens import React Native `Image`.

- [ ] **Step 3: Install the Expo-compatible image package**

Run:

```bash
cd /workspace/apps/mobile
./node_modules/.bin/expo install expo-image --pnpm
```

Expected: `expo-image` is added at the Expo 57-compatible version and `pnpm-lock.yaml` changes.

- [ ] **Step 4: Split the icon font by platform**

Create `apps/mobile/lib/icon-font.ts`:

```ts
import { MaterialSymbols_400Regular } from "@expo-google-fonts/material-symbols/400Regular";

export const iconFonts = { MaterialSymbols_400Regular };
```

Create `apps/mobile/lib/icon-font.ios.ts`:

```ts
export const iconFonts = {};
```

In `_layout.tsx`, replace the direct font import and platform conditional with:

```ts
import { iconFonts } from "../lib/icon-font";

const [fontsLoaded] = useFonts(iconFonts);
```

- [ ] **Step 5: Use cached images for remote sources**

In `index.tsx`, `account.tsx`, and `plugins.tsx`, import:

```ts
import { Image } from "expo-image";
```

Keep existing dimensions and add URI-image behavior:

```tsx
<Image
  source={{ uri }}
  cachePolicy="memory-disk"
  contentFit="cover"
  transition={120}
  style={existingStyle}
/>
```

Do not change local mascot/artwork images in `agent-mark.tsx` or `brand.tsx`.

- [ ] **Step 6: Run focused tests and typecheck**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/assets.test.ts
cd /workspace/apps/mobile && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: PASS.

- [ ] **Step 7: Export iOS and record the asset change**

Run:

```bash
cd /workspace/apps/mobile
./node_modules/.bin/expo export --platform ios --output-dir /tmp/quibt-ios-export-after-images
```

Expected: export succeeds; its asset list does not contain `MaterialSymbols_400Regular.ttf`.

- [ ] **Step 8: Commit**

```bash
git add apps/mobile/app/_layout.tsx apps/mobile/app/index.tsx apps/mobile/app/account.tsx apps/mobile/app/plugins.tsx apps/mobile/lib/icon-font.ts apps/mobile/lib/icon-font.ios.ts apps/mobile/lib/assets.test.ts apps/mobile/package.json pnpm-lock.yaml
git commit -m "perf(mobile): cache remote images on iOS"
```

---

### Task 3: Virtualize the home inbox

**Files:**
- Modify: `apps/mobile/lib/home-layout.ts`
- Modify: `apps/mobile/lib/home-layout.test.ts`
- Modify: `apps/mobile/app/index.tsx`

**Interfaces:**
- Produces:

```ts
export type HomeListItem<B, G> =
  | { kind: "bot"; key: `bot:${string}`; bot: B }
  | { kind: "group"; key: `group:${string}`; group: G };

export function homeListItems<B extends { id: string }, G extends { id: string }>(
  bots: readonly B[],
  groups: readonly G[],
): HomeListItem<B, G>[];
```

- [ ] **Step 1: Write failing helper tests**

Add to `home-layout.test.ts`:

```ts
it("builds stable typed rows for the virtualized inbox", () => {
  const rows = homeListItems([{ id: "one" }, { id: "two" }], [{ id: "team" }]);
  expect(rows.map((row) => row.key)).toEqual(["bot:one", "bot:two", "group:team"]);
  expect(rows.map((row) => row.kind)).toEqual(["bot", "bot", "group"]);
});
```

Add `readFileSync`, `path`, and `fileURLToPath` imports, define
`const dir = path.dirname(fileURLToPath(import.meta.url));`, then add:

```ts
it("renders the inbox through FlatList", () => {
  const screen = readFileSync(resolve(import.meta.dirname, "../app/index.tsx"), "utf8");
  expect(screen).toContain("<FlatList");
  expect(screen).not.toContain("<ScrollView");
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/home-layout.test.ts
```

Expected: FAIL because `homeListItems` and `FlatList` are absent.

- [ ] **Step 3: Implement the pure row builder**

Add the exported types and `homeListItems` to `home-layout.ts`. Preserve the input order and prefix keys by kind to prevent bot/group collisions.

- [ ] **Step 4: Replace the home ScrollView**

Use:

```tsx
<FlatList
  data={homeListItems(listBots, visibleGroups)}
  keyExtractor={(item) => item.key}
  renderItem={renderHomeRow}
  ListHeaderComponent={homeHeader}
  ListFooterComponent={error ? <Text style={styles.error}>{error}</Text> : null}
  initialNumToRender={12}
  maxToRenderPerBatch={10}
  windowSize={7}
  removeClippedSubviews={Platform.OS === "android"}
  refreshControl={existingRefreshControl}
  contentContainerStyle={existingInsets}
/>
```

Extract `HomeBotRow` and `HomeGroupRow` as module-level `memo` components. Pass stable `onOpen`, `onLongPress`, and group navigation callbacks created with `useCallback`. Keep the exact existing JSX and styles inside each row.

- [ ] **Step 5: Run tests and typecheck**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/home-layout.test.ts
cd /workspace/apps/mobile && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: PASS.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/home-layout.ts apps/mobile/lib/home-layout.test.ts apps/mobile/app/index.tsx
git commit -m "perf(mobile): virtualize the home inbox"
```

---

### Task 4: Virtualize the plugin catalog

**Files:**
- Modify: `apps/mobile/lib/plugins-screen.test.ts`
- Modify: `apps/mobile/app/plugins.tsx`

**Interfaces:**
- Produces: one `FlatList<MobileCatalogItem>` with stable slug keys and the existing header/footer content.

- [ ] **Step 1: Write the failing source test**

Add to `plugins-screen.test.ts`:

```ts
it("virtualizes plugin rows", () => {
  const screen = source("../app/plugins.tsx");
  expect(screen).toContain("<FlatList");
  expect(screen).not.toContain("<ScrollView");
  expect(screen).not.toContain("{visible.map(");
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/plugins-screen.test.ts
```

Expected: FAIL because the screen uses `ScrollView` and `visible.map`.

- [ ] **Step 3: Implement the FlatList**

Move the title, count, search field, error/loading/empty states into a memoized
`ListHeaderComponent`. Move the blur explanation into `ListFooterComponent`.
Render each existing switch row through `renderItem`, with:

```tsx
<FlatList
  data={visible}
  keyExtractor={(item) => item.slug}
  renderItem={renderPlugin}
  ListHeaderComponent={header}
  ListFooterComponent={footer}
  initialNumToRender={12}
  maxToRenderPerBatch={10}
  windowSize={7}
  refreshControl={existingRefreshControl}
/>
```

Keep connection polling, switch behavior, labels, and styling unchanged.

- [ ] **Step 4: Run tests and typecheck**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/plugins-screen.test.ts
cd /workspace/apps/mobile && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add apps/mobile/lib/plugins-screen.test.ts apps/mobile/app/plugins.tsx
git commit -m "perf(mobile): virtualize plugin catalog"
```

---

### Task 5: Preserve thread-row identity and coalesce auto-follow

**Files:**
- Modify: `apps/mobile/lib/chat.ts`
- Modify: `apps/mobile/lib/thread-rows.ts`
- Modify: `apps/mobile/lib/thread-rows.test.ts`
- Modify: `apps/mobile/app/thread.tsx`

**Interfaces:**
- Produces:

```ts
export function reconcileThreadRows(
  previous: readonly ThreadRow[],
  input: BuildThreadRowsInput,
): ThreadRow[];
```

- `peerLine` accepts `readonly ChatBot[]`.
- `Thread` keeps one scheduled auto-follow frame in `autoFollowFrame`.

- [ ] **Step 1: Write failing identity tests**

Add to `thread-rows.test.ts`:

```ts
it("reuses unchanged row objects when streaming progress changes", () => {
  const stable = message({ id: "m1" });
  const base = { botId: "bot_self", bots, members: [], isGroup: false };
  const first = reconcileThreadRows([], {
    ...base,
    messages: [stable, message({ id: "progress:run", blocks: [{ kind: "progress", text: "one" }] })],
  });
  const second = reconcileThreadRows(first, {
    ...base,
    messages: [stable, message({ id: "progress:run", blocks: [{ kind: "progress", text: "two" }] })],
  });
  expect(second[0]).toBe(first[0]);
  expect(second[1]).not.toBe(first[1]);
});

it("does not reuse a row when its next-neighbor bundle state changes", () => {
  const stable = message({ id: "m1", authorBotId: "bot_ada" });
  const base = { bots, members, isGroup: true };
  const first = reconcileThreadRows([], { ...base, messages: [stable] });
  const second = reconcileThreadRows(first, {
    ...base,
    messages: [stable, message({ id: "m2", authorBotId: "bot_ada" })],
  });
  expect(second[0]).not.toBe(first[0]);
});
```

Use existing test factories and preserve the same message object explicitly.

- [ ] **Step 2: Run and verify RED**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/thread-rows.test.ts
```

Expected: FAIL because `reconcileThreadRows` is absent.

- [ ] **Step 3: Implement indexed row reconciliation**

Create `Map` lookups for bots and members once per call. Build each next row with
the same output fields as today. Index previous rows by key and return the previous
row only when:

```ts
previous.message === next.message &&
previous.mine === next.mine &&
previous.bundled === next.bundled &&
previous.stamp === next.stamp &&
previous.from === next.from &&
previous.authorName === next.authorName &&
previous.authorColor === next.authorColor &&
previous.authorShape === next.authorShape &&
previous.showAuthorMark === next.showAuthorMark &&
previous.approval === next.approval &&
previous.answerBotId === next.answerBotId
```

Change `peerLine` to accept `readonly ChatBot[]` and remove `[...bots]`.

- [ ] **Step 4: Keep previous rows in Thread**

Replace direct `buildThreadRows` use with:

```ts
const previousRows = useRef<ThreadRow[]>([]);
const rows = useMemo(() => {
  const next = reconcileThreadRows(previousRows.current, {
    messages,
    botId,
    bots,
    members,
    isGroup,
  });
  previousRows.current = next;
  return next;
}, [messages, botId, bots, members, isGroup]);
```

Memoize burst-author arrays by burst id before `renderRow`, and include
`answerSetup` in the header memo dependency list.

- [ ] **Step 5: Coalesce auto-follow**

Add a ref:

```ts
const autoFollowFrame = useRef<number | null>(null);
```

`onContentSizeChange` schedules only when pinned and no frame is pending. The frame
clears its ref and calls `scrollToEnd`. Add an unmount effect that cancels a pending
frame with `cancelAnimationFrame`.

- [ ] **Step 6: Run focused and complete mobile tests**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/thread-rows.test.ts apps/mobile/lib/chat.test.ts
cd /workspace/apps/mobile && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/lib/chat.ts apps/mobile/lib/thread-rows.ts apps/mobile/lib/thread-rows.test.ts apps/mobile/app/thread.tsx
git commit -m "perf(mobile): stabilize streaming thread rows"
```

---

### Task 6: Coalesce trackpad moves and cancel computer polling safely

**Files:**
- Modify: `apps/mobile/lib/computer.ts`
- Modify: `apps/mobile/lib/computer.test.ts`
- Modify: `apps/mobile/app/computer.tsx`

**Interfaces:**
- Produces:

```ts
export type PointerDelta = { x: number; y: number };

export function createPointerMoveCoalescer(
  send: (delta: PointerDelta) => void,
  schedule?: (callback: () => void) => number,
  cancelScheduled?: (id: number) => void,
): {
  add(delta: PointerDelta): void;
  flush(): void;
  cancel(): void;
};
```

- [ ] **Step 1: Write failing coalescer tests**

Add to `computer.test.ts`:

```ts
it("coalesces pointer movement into one scheduled delta", () => {
  let callback: (() => void) | undefined;
  const sent: PointerDelta[] = [];
  const moves = createPointerMoveCoalescer(
    (delta) => sent.push(delta),
    (next) => {
      callback = next;
      return 7;
    },
    () => undefined,
  );
  moves.add({ x: 2, y: 3 });
  moves.add({ x: -1, y: 4 });
  expect(sent).toEqual([]);
  callback?.();
  expect(sent).toEqual([{ x: 1, y: 7 }]);
});

it("cancels a pending pointer movement", () => {
  const sent: PointerDelta[] = [];
  const cancelled: number[] = [];
  const moves = createPointerMoveCoalescer(
    (delta) => sent.push(delta),
    () => 9,
    (id) => cancelled.push(id),
  );
  moves.add({ x: 2, y: 3 });
  moves.cancel();
  expect(cancelled).toEqual([9]);
  expect(sent).toEqual([]);
});
```

- [ ] **Step 2: Run and verify RED**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/computer.test.ts
```

Expected: FAIL because the coalescer is absent.

- [ ] **Step 3: Implement the coalescer**

Accumulate `x` and `y`, schedule only once, clear the pending id before sending,
skip zero deltas, and make both `flush` and `cancel` reset accumulated state.
Default scheduling uses `requestAnimationFrame`; default cancellation uses
`cancelAnimationFrame`.

- [ ] **Step 4: Integrate TrackpadLayer**

Create the coalescer once in a ref, with `send` calling the current bot/control
values through refs. Replace the direct move RPC with `moves.add({ x, y })`.
On responder release, call `moves.flush()` before the click decision. On unmount,
call `moves.cancel()`.

- [ ] **Step 5: Make status publishing cancellation-safe**

Inside the polling effect, use `let active = true`. Move the status request into
an effect-local function and guard every setter with `if (!active) return`.
Cleanup sets `active = false`, removes the app-state listener, and clears the
interval. Keep `computerPollMs(hasControl)` unchanged.

- [ ] **Step 6: Run tests and typecheck**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/computer.test.ts
cd /workspace/apps/mobile && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: PASS.

- [ ] **Step 7: Commit**

```bash
git add apps/mobile/lib/computer.ts apps/mobile/lib/computer.test.ts apps/mobile/app/computer.tsx
git commit -m "perf(mobile): coalesce remote trackpad input"
```

---

### Task 7: Prevent stale async screen state and make routine rollback pure

**Files:**
- Modify: `apps/mobile/lib/routines.tsx`
- Create: `apps/mobile/lib/routines-state.ts`
- Create: `apps/mobile/lib/routines-state.test.ts`
- Modify: `apps/mobile/app/group-settings.tsx`
- Modify: `apps/mobile/app/settings.tsx`

**Interfaces:**
- Produces:

```ts
export function withoutRoutine(
  routines: readonly MobileRoutine[],
  routineId: string,
): MobileRoutine[];
```

- [ ] **Step 1: Write the failing pure-state test**

Create `apps/mobile/lib/routines-state.test.ts`:

```ts
import { describe, expect, it } from "vitest";
import type { MobileRoutine } from "./api.js";
import { withoutRoutine } from "./routines-state.js";

function routine(id: string): MobileRoutine {
  return {
    id,
    name: id,
    prompt: "work",
    cron: "0 9 * * *",
    timezone: "UTC",
    active: true,
    notify: true,
  };
}

describe("withoutRoutine", () => {
it("removes a routine without mutating the rollback snapshot", () => {
  const original = [routine("one"), routine("two")];
  const next = withoutRoutine(original, "one");
  expect(next.map((row) => row.id)).toEqual(["two"]);
  expect(original.map((row) => row.id)).toEqual(["one", "two"]);
});
});
```

- [ ] **Step 2: Run and verify RED**

Run the exact new test file:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/routines-state.test.ts
```

Expected: FAIL because `withoutRoutine` is absent.

- [ ] **Step 3: Implement pure routine deletion**

Implement:

```ts
export function withoutRoutine(
  routines: readonly MobileRoutine[],
  routineId: string,
): MobileRoutine[] {
  return routines.filter((routine) => routine.id !== routineId);
}
```

Capture rollback before calling a setter:

```ts
const previous = routines;
setRoutines(withoutRoutine(previous, routine.id));
```

Keep the existing RPC and restore `previous` on failure.

- [ ] **Step 4: Guard group and settings effects**

For each async effect, declare `let active = true`, perform requests, and check
`active` immediately before every state update. Return:

```ts
return () => {
  active = false;
};
```

For settings, derive stable primitive dependencies:

```ts
const initialColor = initial.color;
const initialShape = initial.shape;
```

Include `initialColor` and `initialShape` in the effect dependencies. A response
for an old `botId`/`groupId` must not update the current screen.

- [ ] **Step 5: Run focused tests, React Doctor errors, and typecheck**

Run:

```bash
./node_modules/.bin/vitest run apps/mobile/lib/routines-state.test.ts apps/mobile/lib/thread-rows.test.ts
cd /workspace/apps/mobile && ./node_modules/.bin/tsc --noEmit -p tsconfig.json
cd /workspace/apps/mobile && npx --yes react-doctor@latest --verbose --scope changed
```

Expected: tests/typecheck PASS; `no-impure-state-updater` is absent from changed code.

- [ ] **Step 6: Commit**

```bash
git add apps/mobile/lib/routines.tsx apps/mobile/lib/routines-state.ts apps/mobile/lib/routines-state.test.ts apps/mobile/app/group-settings.tsx apps/mobile/app/settings.tsx
git commit -m "fix(mobile): ignore stale screen requests"
```

---

### Task 8: Full verification and walkthrough

**Files:**
- Modify only files required by failures found during verification.

**Interfaces:**
- Produces: verification evidence for tests, typecheck, iOS export size, changed-scope diagnostics, and UI behavior.

- [ ] **Step 1: Run the package-level mobile suite**

Run:

```bash
cd /workspace/apps/mobile
./node_modules/.bin/vitest run --root ../.. apps/mobile/lib
```

Expected: all mobile test files pass with zero failures.

- [ ] **Step 2: Run mobile typecheck**

Run:

```bash
cd /workspace/apps/mobile
./node_modules/.bin/tsc --noEmit -p tsconfig.json
```

Expected: exit 0 with no diagnostics.

- [ ] **Step 3: Run repository lint on changed files**

Run:

```bash
cd /workspace
./node_modules/.bin/biome check $(git diff --name-only main...HEAD -- '*.ts' '*.tsx' '*.json')
```

Expected: exit 0.

- [ ] **Step 4: Produce the final iOS export**

Run:

```bash
cd /workspace/apps/mobile
./node_modules/.bin/expo export --platform ios --output-dir /tmp/quibt-ios-export-final
du -sh /tmp/quibt-ios-export-final
```

Expected: export succeeds, total is no larger than the 11 MB baseline, and
`MaterialSymbols_400Regular.ttf` is absent.

- [ ] **Step 5: Run React Doctor regression scan**

Run:

```bash
cd /workspace/apps/mobile
npx --yes react-doctor@latest --verbose --scope changed
```

Expected: no new errors and score does not regress from the 44 baseline.

- [ ] **Step 6: Run a manual GUI walkthrough**

Start the existing mobile development target and use the GUI test executor to:

1. search and scroll the home list;
2. open and scroll the plugin catalog;
3. open a long thread and observe streaming auto-follow while pinned/unpinned;
4. use the remote trackpad and verify click/drag behavior.

Record one concise video showing the successful walkthrough. Preserve the existing
visual design throughout.

- [ ] **Step 7: Commit verification fixes**

If verification required code changes, repeat the relevant focused RED/GREEN test,
then stage the mobile files already owned by this plan:

```bash
git add apps/mobile
git commit -m "fix(mobile): address performance verification findings"
```

If verification changed no code, skip this commit.

- [ ] **Step 8: Push and update the pull request**

```bash
git push -u origin cursor/optimize-mobile-ios-b4e4
```

Update the draft pull request summary with measured test counts, final export
size, React Doctor result, and the walkthrough artifact.
