# Montserrat (web)

The typeface of the wallet sign-in page. These three weights are the ones the page sets:
Light 300 (headings), Regular 400 (body), Medium 500 (buttons and labels).

## Why the binaries are committed

They are **source**. `scripts/build-fonts.mjs` reads them and emits
`src/web/brand/fonts.generated.ts`, which inlines them as base64 into the sign-in page so it makes
no subresource requests and can run under a `default-src 'none'` CSP.

That generated module is **gitignored**: it is an artefact, rebuilt by `npm run build` (and by
`pretest` and `typecheck`), so the fonts live in the repo exactly once and the two can never drift.
The build never depends on a third-party URL staying reachable.

Adding or replacing a weight means dropping the file here and updating the `WEIGHTS` table in
`scripts/build-fonts.mjs`.

## Provenance

Latin subset from [`@fontsource/montserrat`](https://www.npmjs.com/package/@fontsource/montserrat)
v5.3.0, which repackages [Montserrat](https://github.com/JulietaUla/Montserrat).

| File | Bytes | Weight |
| --- | --- | --- |
| `montserrat-latin-300-normal.woff2` | 18708 | 300 |
| `montserrat-latin-400-normal.woff2` | 18780 | 400 |
| `montserrat-latin-500-normal.woff2` | 18748 | 500 |

## Licence

Montserrat is © 2011 The Montserrat Project Authors and licensed under the
[SIL Open Font License 1.1](OFL.txt), which permits bundling and redistribution with software.
