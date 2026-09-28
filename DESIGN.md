# Dashboard design

Uses Tempo's Regen 0.5.0 shared stylesheet, vendored unchanged from `regen-ui@0.5.0` as `vendor/regen.css`, with its MIT license. No JavaScript framework or build step is required. App styles consume Regen semantic tokens and its flat surfaces, 6px radius, compact spacing and Pilat typography.

Reference: [Regen design contract](https://github.com/tempoxyz/regen/blob/90730b70dfe35aaad357b4fbeb3ce3f5df8c048e/DESIGN.md). The two Pilat fonts come from that revision's `site/public/fonts`, originally sourced from `tempoxyz/developers`. Pilat is commercial and retains Tempo's webfont licensing; it is not covered by Regen's MIT license or licensed for third-party redistribution.

Keep labels in sentence case and source details in the native Sources and methodology disclosure. Avoid promotional footers, decorative category labels and duplicated metric cards. Do not hide the data timestamp or conflate inventory with reserves.

Validate desktop/mobile, light/dark, keyboard focus, loading, source failures and populated charts. Design screenshots with fixtures must be labeled as sample data. The HTML starts with unavailable values rather than an embedded historical financial snapshot.
