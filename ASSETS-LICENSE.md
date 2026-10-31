# Artwork licence

## Bundled default artwork — MIT

The default butler fish artwork shipped in
`packages/client/ui-settings-session-orchestrator/src/client/petArt.ts` is the
**“ds鲸鲸娘 / 大肥鱼”** sprite sheet from
[`zhouwu97/ds-pet`](https://github.com/zhouwu97/ds-pet):

| Field | Value |
|---|---|
| Character | ds鲸鲸娘 / 大肥鱼 (Q-style blue whale maid) |
| Repository | <https://github.com/zhouwu97/ds-pet> |
| Author | **zhouwu97** and ds-pet contributors |
| Licence | **MIT** — <https://github.com/zhouwu97/ds-pet/blob/main/LICENSE> |
| Original asset | `codex/jingjing-spritesheet.png`, 1536 × 2288, 8 × 11 cells of 192 × 208 |
| Asset info | `codex/asset-info.json`, SHA-256 `9ddd3bcaad42ee348f9afce7ed12a39c14541b40cfdbf654c2880017e70be6ee` |

### Changes made for HandsOff

- Cleared the tiny baked-in “哦鲸鲸…” label from the top-left corner of every
  cell so the UI can render a real, readable speech bubble.
- Downscaled the full sheet to **1152 × 1716** (cell **144 × 156**), which is a
  near-exact 1:1 match for the 144 px desktop sprite and still crisp at 96 px.
- Encoded it as a quality-92 WebP data URI (about **0.56 MB**, roughly 0.74 MB
  as Base64) instead of the original 2.99 MB PNG, keeping the npm package far
  below its 10 MB budget.
- Added CSS-only water spouts, bubbles, sparkles, sweat and `z` marks; the
  sprite sheet itself is unmodified apart from the crop mask and downscale.

MIT permits reuse, modification and redistribution provided the copyright and
permission notice are kept. The full MIT text is in [`LICENSE`](LICENSE); the
character attribution is recorded in [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).

## Code — MIT

All source code in this repository is under the MIT licence; see [`LICENSE`](LICENSE).
Because the bundled artwork is also MIT, the package declares `MIT`.

## User-imported artwork — not bundled

The “Custom artwork” importer stores user-selected files in the browser’s
IndexedDB only. Those files:

- are **not** uploaded to any server;
- are **not** written into the repository, `client.js`, or the npm tarball;
- remain under whatever licence their owner granted.

The importer does not grant any licence to those files. In particular, the
`dsh-whale-maid` / `deepseek-dafeiyu-pet` character art is marked by its
authors as personal, non-commercial material with no redistribution rights.
This repository does not bundle it; only import it locally if you have
permission to use it.
