# Quibt social card provenance

- Final export: `public/social/quibt-open-source-v2.png`
- Compatibility copy: `public/og-image.png`
- Canvas: 1200 × 630 PNG for Open Graph and X large-image cards.
- Composition: deterministic SVG typography and shapes rendered with `sharp`.
- Brand sources: `public/quibt-logo.png` and the four approved mascot PNGs under `public/mascots/`.
- Exact headline: `Your own team of AI bots, in a chat app.`
- Generator: `social-card/generate.mjs`

The exported filename is versioned so social crawlers do not reuse the retired `og-image.png` cache entry.
