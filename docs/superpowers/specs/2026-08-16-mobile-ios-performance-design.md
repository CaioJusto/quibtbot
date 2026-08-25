# Mobile iOS performance design

## Context

The Expo 57 / React Native 0.86 mobile client already uses native iOS capabilities
through Expo and React Native, including native-stack navigation, SF Symbols,
`ActionSheetIOS`, blur, haptics, camera, notifications, Keychain, safe areas, and
`WKWebView`. The application has no custom Swift or Objective-C code, and this
work will preserve that managed Expo architecture.

The performance audit found avoidable work in four user-visible hot paths:

- the home inbox mounts every bot and group inside a `ScrollView`;
- the plugin catalog also mounts every row and reloads uncached remote images;
- live thread updates rebuild derived rows and can request repeated scrolls;
- remote-computer control polls frequently and emits one RPC per pointer event.

The iOS export also includes avoidable image and font assets. Several asynchronous
effects can publish stale state after navigation, and the package-local test
command does not discover the existing mobile tests.

## Goals

1. Preserve the current UI, navigation, native integrations, copy, and behavior.
2. Keep scrolling and typing responsive as inboxes, catalogs, and threads grow.
3. Reduce redundant network traffic and JavaScript work during live updates.
4. Cache remote images and reduce avoidable iOS export assets.
5. Make asynchronous screen loading safe across unmounts and parameter changes.
6. Make the documented mobile test command execute the actual mobile suite.

## Non-goals

- No Swift, Objective-C, SwiftUI, or custom native module.
- No visual redesign or navigation change.
- No API contract or server behavior change.
- No removal of supported mascot shapes or colors.
- No speculative memoization of cold onboarding or form paths.

## Design

### 1. Virtualized home and plugin lists

The home screen will replace its outer `ScrollView` and mapped inbox rows with one
`FlatList` whose data is a stable union of bot and group rows. The existing header,
search controls, favorites, pull-to-refresh behavior, insets, and error message
remain list header/footer content. Row rendering will move into memoized
module-level components with stable keys and callbacks.

The plugin catalog will use a `FlatList` with the existing title/search area as its
header and the current explanatory blur card as its footer. Empty, loading,
refreshing, switch, and connection states remain unchanged.

### 2. Cached images and asset loading

Remote avatars and plugin logos will use `expo-image` with disk/memory caching and
appropriate transitions. Static local artwork may continue using React Native
`Image` when caching adds no benefit.

The iOS-only symbol path will be split by platform so the Material Symbols font is
not statically reachable from the iOS module graph. Mascot lookup will retain all
appearances, but asset imports will be reviewed against what Metro must include;
only changes that preserve every supported appearance are allowed.

### 3. Live-thread rendering

Thread derivation will build bot/member lookup maps once rather than copying and
linearly searching collections for every message. The row builder will preserve
references for unchanged rows where inputs and neighboring-message relationships
are unchanged, so a streaming progress update does not invalidate every memoized
message row.

Streaming auto-follow will be coalesced to at most one pending request per frame.
It will still follow only when the reader is already near the bottom. Stable burst
author arrays and header callbacks will prevent unrelated message rows from
rerendering.

### 4. Computer polling and trackpad traffic

Status polling remains active only while the app is foregrounded. Existing
800 ms/2 s intervals remain the upper-frequency fallback, but the poll loop will
be cancellation-safe and will avoid publishing stale results after the bot changes
or the screen unmounts.

Pointer moves will be coalesced to animation-frame cadence. Deltas accumulated
between frames will be sent as one RPC while taps remain immediate and preserve
the current click-slop behavior. Pending frame work will be cancelled on release
and unmount.

### 5. Async correctness

Effects that load computer, group, settings, and plugin state will use an
effect-local active flag or abortable primitive where supported. Results from a
previous bot/group will not update the current screen.

The routine-delete optimistic snapshot will be captured outside the React state
updater, keeping updater functions pure and rollback deterministic. Hook
dependencies will be made explicit without creating repeated boot or navigation
loops.

### 6. Tests and package command

Pure helpers will cover:

- home list item construction and stable keys;
- indexed/reconciled thread rows and unchanged-row reuse;
- pointer coalescing, accumulated deltas, release, and cancellation;
- deterministic routine removal/rollback snapshot behavior;
- platform-specific symbol/font module boundaries where practical.

Behavior changes will follow red-green-refactor. The mobile package test command
will point Vitest at the repository-root configuration so running it from
`apps/mobile` discovers `apps/mobile/lib/**/*.test.ts`.

## Error handling

Existing user-facing messages and optimistic rollback behavior remain. Background
polling and image failures stay non-fatal. Cancellation caused by navigation is
treated as expected control flow and must not surface an error. Real RPC failures
continue to use the current error UI.

## Verification

The implementation is complete only when all of the following pass:

1. New focused tests demonstrate each changed behavior and were observed failing
   before implementation.
2. The complete mobile test suite passes through the mobile package command.
3. Mobile TypeScript checking passes.
4. An iOS production export succeeds and its JS/assets totals are recorded before
   and after.
5. React Doctor changed-scope scan introduces no regression.
6. Manual UI walkthrough confirms home scrolling/search, plugin scrolling,
   streaming auto-follow, and remote trackpad behavior without visual changes.

## Success criteria

- Home and plugin rows are virtualized.
- Unchanged thread rows retain identity across streaming progress updates.
- Pointer RPC frequency is bounded by animation-frame cadence.
- Remote images use explicit cache behavior.
- Material Symbols is absent from the iOS export unless another iOS dependency
  legitimately requires it.
- No stale async state is published by the audited effects.
- Existing product behavior and visual appearance remain intact.
