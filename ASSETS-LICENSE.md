# Artwork licence

## Bundled default artwork — CC-BY 3.0

The default butler fish artwork shipped in `packages/client/ui-settings-session-orchestrator/src/client/petArt.ts` is a derivative of:

| Field | Value |
|---|---|
| Title | Q-style cartoon mermaid |
| Author | **Aeihu** |
| Source | <https://opengameart.org/content/q-style-cartoon-mermaid> |
| Licence | **CC-BY 3.0** — <https://creativecommons.org/licenses/by/3.0/> |
| Original copyright | © Aeihu |

### Changes made for HandsOff

- Cropped and squared the source illustration.
- Downscaled it for a desktop-pet frame.
- Composited an original navy/white maid bodice, skirt, apron, lace headdress, puffed sleeves and whale emblem drawn for this project.
- Selected and encoded three expressions (`idle`, `done`, `sleep`) as WebP data URIs.

This derivative artwork is distributed under **CC-BY 3.0**. Attribution must remain intact when the artwork is reused outside this repository.

## Code — MIT

All source code in this repository remains under the MIT licence; see [`LICENSE`](LICENSE). The package declares `MIT AND CC-BY-3.0` because it contains both code and the bundled artwork above.

## User-imported artwork — not bundled

The “Custom artwork” importer stores user-selected files in the browser’s IndexedDB only. Those files:

- are **not** uploaded to any server;
- are **not** written into the repository, `client.js`, or the npm tarball;
- remain under whatever licence their owner granted.

The importer does not grant any licence to those files. In particular, the `dsh-whale-maid` / `deepseek-dafeiyu-pet` character art is marked by its authors as personal, non-commercial material with no redistribution rights. This repository does not bundle it; only import it locally if you have permission to use it.
