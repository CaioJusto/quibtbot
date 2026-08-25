# Quibt Bot landing design QA

## Comparison target

- Source visual truth: `(evidência local) CA7C596A-5E92-4B28-AB1A-D85095C3C715 3.JPEG`.
- Browser-rendered implementation: `(evidência local) quibt-landing-local-desktop-viewport.png`.
- Full comparison input: `(evidência local) quibt-landing-desktop-comparison.png`.
- Mobile evidence: `(evidência local) quibt-landing-local-mobile-viewport-final.png`.
- Demo adjustment source: `/var/folders/52/tf1fdcgd4kz_lqpypjcxzxzh0000gn/T/TemporaryItems/NSIRD_screencaptureui_Rlnm2M/Captura de Tela 2026-08-14 às 23.20.57.png`.
- Demo desktop evidence: `(evidência local) quibt-demo-new-mascots-desktop.png`.
- Demo mobile evidence: `(evidência local) quibt-demo-new-mascots-mobile.png`.
- Demo before/after comparison input: `(evidência local) quibt-demo-mascots-comparison.png`.
- Supplied logo source: `(evidência local) 07_Design_Imagens/default-logo.png`.
- Compact logo evidence: `(evidência local) quibt-compact-logo-header.png`.
- Desktop viewport and state: 1280 x 900 CSS pixels, device scale factor 1, page top, menu closed.
- Mobile viewport and state: 390 x 844 CSS pixels, device scale factor 1, page top; menu checked both open and closed.
- Source pixels: 1280 x 4300. The comparison uses its 1280 x 900 top crop.
- Implementation pixels: 1280 x 900 for the desktop comparison and 390 x 844 for the mobile viewport. No density normalization was required.

## Findings

- No actionable P0, P1, or P2 differences remain.
- Fonts and typography: Outfit, weight, line height, optical scale, and black/gray hierarchy match the source. The hero now wraps across three lines because the local-first Quibt Bot positioning is longer; this is an intentional content change, not layout drift.
- Spacing and layout rhythm: header, split hero, mascot stage, CTA placement, demo overlap, section spacing, and mobile stacking preserve the source composition. Mobile has no horizontal overflow at 390 pixels.
- Colors and visual tokens: the white canvas, black display type, muted copy, Quibt blue CTA, fine dividers, and dark demo surface match the source palette.
- Image quality and asset fidelity: the supplied Quibt mascot PNGs are reused directly at their intended crop and scale. The interactive demo now uses the same new raster mascot family in every bot row, the active-bot header, settings, and computer takeover surface; the old generated avatar marks are absent. No placeholder or CSS-drawn replacement art was introduced.
- Brand asset fidelity: the text-built `Q` lockup was replaced in the shared header/footer component by the supplied 538 x 199 transparent Quibt logo. It renders at a deliberately quiet 72 x 26.6 CSS pixels in both locations.
- Copy and content: login, trial, and pricing actions are absent from the public landing. English is the default at `/`, Portuguese is available at `/pt/`, and every marketing section plus the interactive product demo follows the selected language.
- Accessibility and interactions: semantic headings and links remain intact, focus treatment is preserved, the mobile menu opens and closes, the `EN / PT` selector reaches the matching localized route, and the interactive demo still changes bots and opens/closes its computer panel.
- Waitlist flow: both languages open a five-question, keyboard-friendly conversational form. Desktop and 390-pixel mobile checks confirmed progress, required-field validation, back/continue behavior, localized completion, and the generated email handoff.
- Browser icon: the old synthetic mark was replaced in ICO, 16, 32, 180, 192, and 512-pixel variants by the supplied blue mascot with its transparent background preserved.
- Console check: no browser warnings or errors were recorded on desktop or mobile.

## Focused region evidence

The hero is the first focused comparison region because it contains the changed product positioning and primary CTA. The combined source/implementation image shows matching header alignment, copy/stage proportions, mascot placement, CTA styling, and demo entry point. The demo is the second focused region: its before/after comparison shows the seven old generated marks replaced by the new photographic mascot set without changing panel density, alignment, or interaction layout.

## Comparison history

- Pass 1: the source and implementation hero were compared at 1280 x 900. The longer requested headline changes the line count but preserves hierarchy and balance; no P0/P1/P2 fix was required.
- Responsive pass: 390 x 844 confirmed a three-line hero, full-width CTA, working menu, intact mascot stage, and zero horizontal overflow.
- Pass 2: the supplied demo screenshot exposed the remaining old avatar marks. They were replaced across all demo avatar surfaces with 512 x 512 transparent raster mascots. Desktop and mobile recaptures confirmed every image loaded, panel layout stayed intact, and no horizontal overflow or console error was introduced.
- Pass 3: the supplied Quibt logo replaced the previous synthetic mark in both shared locations. An initial 96-pixel render was reduced after review to 72 pixels so the logo remains present without competing with the page headline.
- Pass 4: the English default route, Portuguese equivalents, mobile language menu, and the complete waitlist interaction were verified in the in-app browser. Both viewports remained free of horizontal overflow and browser warnings/errors.
- Pass 5: the five-step e-mail handoff was replaced by a six-step database-backed flow. The optional X handle, explicit consent, Railway API success state, retry state, and both localized routes were rechecked before production release.

## Implementation checklist

- [x] Preserve the selected landing art direction and supplied mascot assets.
- [x] Replace the hero positioning with local-first Quibt Bot and desktop download buttons.
- [x] Remove login, trial, and pricing actions from the public landing.
- [x] Keep one waitlist conversion path across desktop and mobile.
- [x] Verify build, responsive layout, interactions, and browser console.
- [x] Replace every old demo avatar with the new mascot image family.
- [x] Replace the synthetic header/footer lockup with the supplied compact Quibt logo.
- [x] Make English the default and add complete Portuguese equivalents.
- [x] Add a compact language selector on desktop and in the mobile menu.
- [x] Add and exercise the six-step waitlist experience in both languages.
- [x] Save waitlist entries through the isolated Railway API instead of opening an e-mail client.
- [x] Replace the browser icon with the transparent blue mascot.

## Follow-up polish

- No blocking polish remains.

final result: passed
