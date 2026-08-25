# Design QA — Quibt Bot desktop interaction polish

## Comparison target

- Source visual truth (live Grok Bot, base): `(evidência local) grok-bot-desktop-live-base.png`
- Source interaction captures:
  - `(evidência local) grok-bot-desktop-new-menu.png`
  - `(evidência local) grok-bot-desktop-settings.png`
  - `(evidência local) grok-bot-desktop-routine.png`
- Rendered implementation: `(evidência local) quibt-desktop-polish-final.png`
- Rendered interaction captures:
  - `(evidência local) quibt-desktop-new-menu-polished.png`
  - `(evidência local) quibt-desktop-computer-polished.png`
  - `(evidência local) quibt-desktop-settings-polished.png`
  - `(evidência local) quibt-desktop-routine-polished.png`
- Combined full-view evidence: `(evidência local) qa-full-view-side-by-side.png`
- Combined focused evidence:
  - `(evidência local) qa-new-menu-side-by-side.png`
  - `(evidência local) qa-computer-side-by-side.png`
  - `(evidência local) qa-settings-side-by-side.png`
  - `(evidência local) qa-routine-side-by-side.png`

## Viewport and normalization

- Source full capture: 2122 × 1520 physical pixels at 2× density, normalized to 1061 × 760 CSS pixels.
- Source interaction captures: 1061 × 760 pixels at 1× density.
- Implementation capture: 881 × 806 CSS pixels at 1× density in the Codex in-app browser.
- The current in-app browser surface was narrower than the Grok desktop window, so the full-view board demonstrates responsive hierarchy rather than pixel precision. At 881 px, Quibt intentionally uses its verified two-column tablet state while a detail panel is open.
- Blocking component comparisons were normalized at the same state and near-identical width: source detail panel 318 × 760, implementation detail panel 320 × 760; source and implementation new-chat regions 560 × 360.
- State: signed-in desktop, light theme, a bot conversation selected; new-chat picker, computer details, settings, and new-routine states compared independently.

## Findings

No actionable P0, P1, or P2 differences remain.

- Fonts and typography: both products use the macOS system/SF stack. Quibt now follows the source's 12.5–15 px hierarchy, compact labels, medium-weight headings, message wrapping, role-badge truncation, and antialiasing.
- Spacing and layout rhythm: the sidebar, conversation, fixed 320 px detail rail, 48 px header, compact rows, bubble rhythm, rounded composer, panel fields, and 11–16 px radii reproduce the source hierarchy. The implementation preserves its responsive two-column state at 881 px without overlap or horizontal overflow.
- Colors and tokens: the white/soft-gray/near-black balance, thin gray dividers, restrained shadows, selected-row fill, disabled controls, black active switches, and black user bubbles align with the source.
- Image quality and asset fidelity: Quibt retains its own high-resolution mascot PNG family and the clean light-blue desktop WebP requested for the product. The computer preview shows that real raster directly, at the correct aspect ratio, with an Open overlay; no placeholder replaces it.
- Copy and content: every visible name, role, preview, conversation, label, and routine instruction is Quibt-specific Portuguese content. Dora, Nilo, Téo, Lumi, and Bento intentionally replace the source characters and messages.
- Icons and controls: add, search, monitor, settings, chevrons, microphone, send, routine, plugins, and account controls share consistent sizing and stroke treatment. Hover, active, pressed, expanded, focused, selected, disabled, loading, empty, and open/closed states are represented.
- Accessibility: primary controls are semantic buttons with labels, the new-chat picker is a labeled dialog/listbox, Escape closes it, search inputs and forms have accessible names, images have alt text, focus-visible outlines are present, and reduced-motion behavior remains intact.

## Full-view evidence

The combined board confirms the same light desktop language, compact bot list, black/gray chat bubbles, top toolbar, and anchored composer. The source is shown in its 1061 px three-column state while the implementation is shown at the available 881 px two-column breakpoint, so the board is not used for exact track measurements. Quibt's mascots, Portuguese copy, `+ Tarefa`, and product-specific controls are intentional product differences.

## Focused evidence

- New conversation: the full recipient picker now matches the source's white floating surface, selected first row, searchable bot list, compact avatars, keyboard hints, and click-to-open behavior. Quibt keeps an additional group action because groups are a first-class product feature.
- Computer: the 320 px rail matches the source's preview scale, centered Open affordance, label, long empty-state spacing, and routine CTA. The blue-white wallpaper and control-transfer button are intentional Quibt requirements.
- Settings: the source and implementation align on centered header, back/close controls, avatar, compact name/title/description fields, notification card, and black active switch. Character customization and advanced tools stay functional behind explicit progressive-disclosure controls.
- Routine: the header, active switch, disabled destructive/test actions, compact fields, add-trigger row, and empty history state align. Quibt adds an explicit Save button because this product does not auto-persist incomplete routines.

## Comparison history

1. Initial interaction comparison — blocked.
   - P2: the add button opened a small generic two-item menu instead of a searchable recipient picker.
   - P2: settings exposed the full character gallery and every advanced setting at once, producing much higher density than the source.
   - P2: the computer thumbnail used extra browser chrome and the empty-routine block sat too high.
   - P2: routine scheduling was expanded by default and the active switch inherited action-button styling.
2. Fix pass.
   - Rebuilt new conversation as an opaque searchable picker with Quibt bots, outside-click close, Escape close, and selection navigation.
   - Reworked settings into the compact source hierarchy; character selection and advanced controls now open on click.
   - Rendered the clean desktop image directly with a centered Open overlay and matched the empty-routine vertical placement.
   - Rebuilt routine creation around the compact active/action toolbar, collapsed add-schedule control, history state, and black switch.
3. Post-fix focused comparison — passed.
   - Evidence: `qa-new-menu-side-by-side.png`, `qa-computer-side-by-side.png`, `qa-settings-side-by-side.png`, and `qa-routine-side-by-side.png`.
   - No actionable P0/P1/P2 differences remain.

## Primary interactions tested

- Open new conversation, filter the bot list, select a bot, close by outside click, and close with Escape.
- Select a different bot and verify the route, conversation, and composer update.
- Open and close the computer panel; verify the running desktop raster and responsive detail rail.
- Open settings, return to the computer panel, close settings, open/close the character picker, and expand advanced options.
- Open routine creation, toggle the schedule editor, and verify disabled Delete/Test plus active Save behavior without submitting data.
- Open and close Plugins.
- Open and close the compact account popover.
- Browser console checked after the interaction pass: zero warning/error entries from application code.

## Technical validation

- Repository suite: 1053 passed, 3 skipped.
- Golden end-to-end journeys: 3 passed (account isolation and durable work; takeover/routine/plugins/export; group creation and chat).
- Web TypeScript check: passed.
- Web production build: passed.
- Desktop TypeScript check: passed.
- Desktop Electron build: passed.
- Biome on all touched web files: passed.

## 2026-08-16 onboarding and computer follow-up

- New first-run captures:
  - `verify-report/design-qa/quibt-onboarding-welcome.png`
  - `verify-report/design-qa/quibt-onboarding-computer.png`
  - `verify-report/design-qa/quibt-onboarding-jobs.png`
- New product-state captures:
  - `verify-report/design-qa/quibt-create-bot.png`
  - `verify-report/design-qa/quibt-account.png`
  - `verify-report/design-qa/quibt-machine.png`
  - `verify-report/design-qa/quibt-computer-panel.png`
  - `verify-report/design-qa/quibt-computer-open-fixed.png`
- Same-frame source comparison: `verify-report/design-qa/grok-vs-quibt-main-selected.png`. The Grok source and Quibt implementation were normalized to 1280 × 720 and inspected together. The compact sidebar, selected bot row, top actions, message rhythm, anchored composer, and optional third computer rail preserve the source hierarchy while all names, messages, roles, mascots, and Portuguese copy remain original to Quibt.
- Asset fidelity: `quibt-onboarding-team.png` and `quibt-computer-setup.png` are transparent raster compositions generated from the repository's exact mascot references. Their crop, density, white/ice-blue lighting, and transparent edges were checked in the actual onboarding viewport.
- Onboarding behavior: Continue, Back, progress, first-bot transition, provider selection handoff, generated imagery, and accessible progress semantics were exercised in the in-app browser. No overlap, clipping, broken crop, or contrast issue remained at the desktop viewport.
- Create-bot behavior: the searchable new-conversation picker opens, the new-bot panel opens, role starters populate the role and mission fields, the character picker remains available, and Create stays disabled until a name exists.
- Computer behavior: opening the rail shows the clean blue-white desktop raster; opening the full computer now preserves that same image instead of falling back to a black status surface. Close, settings, control-transfer, routine, and open states retain semantic labels.
- Settings behavior: account and machine surfaces use the same white/soft-gray desktop system. Inputs, selected cards, primary actions, muted copy, and destructive actions retain readable contrast.
- Desktop runtime: `@quibt/desktop` compiled, launched Electron 43.4.0 against the local application, created a live renderer process, and stayed running while the web and API readiness probes returned success. Native accessibility capture remained unavailable only because macOS was locked; the exact renderer URL and states were exercised through the in-app browser.
- Follow-up finding: the first end-to-end pass exposed stale onboarding and collapsed-settings selectors. The test journey now follows the three intro steps, expands More options before routine/export actions, and waits for the post-takeover confirmation rather than a transient empty-run window.

## Follow-up polish

- P3: the source uses a double-chevron close glyph while Quibt uses a single chevron from its existing icon system.
- P3: `+ Tarefa`, transfer-of-control, groups, and explicit routine Save remain visible product capabilities not present in the Grok reference.

final result: passed

## 2026-08-16 account and settings system refresh

- Source visual truth: `(evidência local)` (the accepted signed-in Quibt desktop language).
- Rendered implementation: `(evidência local)`.
- Combined same-frame comparison: `(evidência local)`.
- Additional rendered evidence:
  - `(evidência local)`
  - `(evidência local)`
  - `(evidência local)`
  - `(evidência local)`
- Viewport and normalization: source and account implementation are both 881 × 806 CSS/physical pixels at 1× density. The 520 × 800 responsive account capture is also 1×. No scaling normalization was required.
- State: signed-in light desktop; source has Dora selected; implementation shows account settings at its top state. This is a design-system comparison rather than a claim that settings should reproduce the conversation layout.

### Required fidelity surfaces

- Fonts and typography: both surfaces use the same system/SF stack, compact muted labels, near-black display headings, controlled wrapping, and medium optical weights. The account title and field hierarchy remain readable at 520 px.
- Spacing and layout rhythm: the account hero, sticky section navigation, 20 px cards, field spacing, machine two-column layout, phone/plan headers, and floating machine actions share the shell's compact rhythm. Measured horizontal overflow is zero at 881 px and 520 px.
- Colors and visual tokens: white cards, cool-gray workspace, thin neutral borders, near-black primary actions, blue selection/focus, green status, and restrained shadows follow the signed-in shell.
- Image quality and asset fidelity: `apps/web/public/quibt-account-profile.png` is a 1200 × 800 transparent raster with the Quibt mascot, profile card, and key. `quibt-computer-setup.png` visibly presents the back of the monitor to the viewer and the screen to the mascot. No placeholder or CSS-drawn illustration is used.
- Copy and content: settings copy remains Quibt-specific Portuguese. Labels, model providers, machine guidance, destructive warnings, and onboarding character names are preserved.

### Findings and comparison history

1. Initial refresh — blocked.
   - P1: the former account hero used a busy two-character security scene the user rejected.
   - P2: account content was a long undifferentiated stack with inconsistent button treatment.
   - P2: machine configuration did not separate provider choice from the selected provider guide.
   - P2: the jobs onboarding stage pushed its footer below an 881 × 806 viewport.
2. Fix pass.
   - Replaced the rejected scene with a single-character account/profile illustration on genuine alpha transparency.
   - Added a responsive account section rail, consistent card system, alert/status treatments, pressed/hover/focus/disabled button feedback, and a light loading state.
   - Split machine selection and guidance into balanced columns with a sticky action bar; aligned phone and billing headers to the same settings language.
   - Added an 761–900 px jobs layout so all three roles and both navigation buttons fit without page overflow.
3. Post-fix comparison — passed.
   - No actionable P0, P1, or P2 finding remains.

### Primary interactions tested

- Onboarding Continue and Back states across welcome, computer, and jobs; the 881 × 806 jobs state now has `scrollHeight === innerHeight`, and the footer remains fully visible.
- Account section link navigation to Models.
- Machine option selection; E2B changes to the blue selected border/background state without saving or mutating the active provider.
- Account and machine responsive overflow checks at 881 px; account repeated at 520 px.
- Browser console after the final account render: zero warnings and zero errors.

### Technical validation

- Focused Vitest: 2 files, 10 tests passed.
- Web production build: passed (600 modules).
- Biome formatting/check on the touched web source files: passed.
- `git diff --check`: passed.

final result: passed
