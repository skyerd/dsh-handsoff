# Third-party notices

HandsOff is an **MIT-licensed** project:

- **Code:** MIT — see [`LICENSE`](LICENSE).
- **Bundled default artwork:** MIT — the `ds鲸鲸娘 / 大肥鱼` sprite sheet from
  [`zhouwu97/ds-pet`](https://github.com/zhouwu97/ds-pet); see
  [`ASSETS-LICENSE.md`](ASSETS-LICENSE.md).
- **User-imported artwork:** not bundled and not sublicensed; it stays in the
  user’s browser and keeps its own licence.

The package manifest therefore declares `MIT`.

This file records the projects we reviewed while choosing the pet architecture,
the licensing reason each one was or was not reused, and the required
attribution. Reviews were checked against public sources on 2026-10-30.

## Bundled artwork and attribution

### `zhouwu97/ds-pet` — **used**

- **Author:** zhouwu97 and ds-pet contributors.
- **Source:** <https://github.com/zhouwu97/ds-pet>
- **Licence:** **MIT** — <https://github.com/zhouwu97/ds-pet/blob/main/LICENSE>
- **What it is:** the “ds鲸鲸娘 / 大肥鱼” Work Pets v2 sprite sheet for Codex,
  DeepSeek Harness and the web: 1536 × 2288 px, 8 × 11 cells of 192 × 208,
  57 action frames and 16 gaze frames.
- **What we used:** the sprite sheet as the bundled default character.
  We cleared the tiny baked-in “哦鲸鲸…” label from each cell, downscaled the
  sheet to 1152 × 1716, and encoded it as a quality-92 WebP data URI
  (about 0.56 MB) so the npm package stays under 10 MB.
- **Where:** `packages/client/ui-settings-session-orchestrator/src/client/petArt.ts`;
  timing table in `petFrames.ts`.
- **Attribution requirement:** keep the MIT notice and credit the source
  repository when redistributing the artwork. The character is fan-made and is
  not an official DeepSeek asset; nothing here implies endorsement by DeepSeek.
- **Source asset hash:** `codex/asset-info.json` records SHA-256
  `9ddd3bcaad42ee348f9afce7ed12a39c14541b40cfdbf654c2880017e70be6ee` for the
  original PNG.

### Lucide — icon vocabulary **used as reference**

- **Source:** <https://github.com/lucide-icons/lucide>
- **Licence:** **ISC** — <https://github.com/lucide-icons/lucide/blob/main/LICENSE>
- **What it is:** a 24 × 24, 1.8-stroke outline icon set.
- **What we used:** the rail icons (`EllipsisIcon`, `HomeIcon`, `EyeIcon`,
  `EyeOffIcon`, `ExpandIcon`, `MinimizeIcon`) are inline SVG paths written in
  that vocabulary. No Lucide package, font or sprite is bundled; the icons are
  ordinary MIT-licensed source files under `PetIcons.tsx`.
- **Where:** `packages/client/ui-settings-session-orchestrator/src/client/PetIcons.tsx`.
- **ISC notice (retained because the geometry is derived from Lucide):**

  ```text
  ISC License

  Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as
  part of Feather (MIT). All other copyright (c) for Lucide are held by
  Lucide Contributors 2022.

  Permission to use, copy, modify, and/or distribute this software for any
  purpose with or without fee is hereby granted, provided that the above
  copyright notice and this permission notice appear in all copies.
  ```

## User-supplied Live2D model — not bundled

### DeepSeek-chan / 大肥鱼 free Live2D model

- **Files:** `大肥鱼.moc3` (Cubism 5 / MOC3 v5, 15.7 MB), five 4096×4096
  textures (43.6 MB), motions, expressions, physics and a 125.6 MB source PSD.
  Runtime assets alone are about **60.5 MB**, far above this plugin’s 10 MB
  package target.
- **Usage notice:** the model is a free public distribution. Personal live
  streaming, video creation (including platform revenue), social posting,
  parameter adjustment and personal derivative works are allowed with
  attribution. The notice **prohibits redistributing the complete model files**,
  reselling them, claiming authorship, or using the model as a paid product /
  paid material / part of a commercial product. Brand, corporate and commercial
  collaborations require the author’s prior confirmation.
- **Attribution:** model name DeepSeek-chan (大肥鱼); original art and
  separation by **神宫凉子**; Live2D modelling by **霓虹猫_NeonNeko**; source:
  the author’s free distribution page.
- **What this repository does:** it does **not** bundle, commit, mirror or
  redistribute the model. The local “Custom artwork” importer accepts exported
  PNG/WebP frames only; it does not read `.moc3` / `.model3.json` directly. A
  user who wants to use the model should keep it in VTube Studio (the author’s
  recommended software) or export frames locally and import them.
- **If you want the Live2D model embedded:** obtain written permission from the
  original author first and accept the much larger runtime and memory footprint.
  Without that permission, even a “personal non-commercial” label cannot replace
  the licence the author actually granted.

## Projects reviewed, not bundled

### `lov0vo/dsh-whale-maid`

- **Code licence:** MIT (code only).
- **Character:** the 1024Store / DeepSeek plugin-market whale girl.
- **What it is:** a DSH desktop pet extracted from the plugin-market page,
  with ten state sheets plus generated poses.
- **Licensing constraint:** the repository’s `NOTICE` states that the character
  artwork belongs to the original site and authors, **no licence is granted**,
  and the assets are **personal, non-commercial use only**. Redistribution,
  commercial use, merchandise and sublicensing are explicitly not permitted.
  The repository also states it does not represent that permission was obtained.
- **What we used:** the action vocabulary (`idle / work / think / sleep /
  welcome / joy / sad / wake`) as a checklist for our mood mapping.
- **What we did not use or bundle:** its PNG sprite files, preview image,
  audio, UI or Python/JS source.
- **How users can still use it:** the “Custom artwork” importer accepts locally
  selected files and stores them in IndexedDB. The repository never bundles or
  redistributes them.

### `RYANFFY/deepseek-dafeiyu-pet`

- **Code licence:** MIT.
- **What it is:** a Windows desktop pet built around the “鲸鱼娘 · 大肥鱼”
  character, with three-view sprites and a DeepSeek balance widget.
- **Licensing constraint:** the character is a community fan work of DeepSeek
  V4 Pro; copyright belongs to DeepSeek and the original creator, the artwork is
  for personal learning and exchange only, and commercial use requires official
  permission.
- **What we used:** interaction ideas (drag, bubble reminders, a compact
  progress readout) as design reference only.
- **What we did not use or bundle:** its character art, sprite sheets, sounds,
  configuration files or Python source.

### `mdd111/deepseek-dafeiyu-pet`

- **Code licence:** MIT.
- **What it is:** an enhanced fork of the project above, adding eleven
  DSH-triggered poses and a settings window.
- **Licensing constraint:** it repeats the same fan-art notice: the 大肥鱼
  artwork is non-commercial and belongs to DeepSeek and the original creator.
- **What we used:** the action/state names as a checklist.
- **What we did not use or bundle:** its `sprites/dsh/**` images,
  `assets/**` audio, UI or Python source.

### `HuanLinOTO/dsh-plugin-pet-rs`

- **Declared licence:** MIT (README). GitHub’s licence detector reports
  `NOASSERTION`, so the README statement is the authoritative claim.
- **What it is:** a native Rust desktop pet (transparent always-on-top window,
  tray, five whale states, dual SSE reads of DSH).
- **What we used:** the five-state vocabulary and the lightweight goal as
  design reference only.
- **What we did not use or bundle:** its Rust source, binaries, pixel-art
  sprite package and sounds.

## Why the exact whale-maid sheets are not in this repository

A split licence can keep code MIT while shipping artwork under a different
licence — but **only if the artwork’s owner actually grants that licence**.
The `dsh-whale-maid` files are not offered under a non-commercial licence; the
author explicitly withholds redistribution rights and states that permission
has not been obtained. Adding a “personal non-commercial” header would not
create a licence that the rights holder never granted, and publishing the files
in this repository or its npm package would be redistribution.

Two supported paths instead:

1. **Bundled default:** the MIT-licensed `ds鲸鲸娘 / 大肥鱼` sprite sheet above,
   which permits reuse, modification and redistribution with the MIT notice.
2. **Local personal import:** the “Custom artwork” dialog stores the user’s
   selected whale-maid PNGs only in that browser. Nothing is uploaded, bundled
   or redistributed. The user is responsible for having permission to use them.

“DeepSeek” is a trademark of DeepSeek. The bundled whale maid is a community
fan work from `zhouwu97/ds-pet`, not an official DeepSeek asset, and nothing
here implies endorsement by DeepSeek.

## Assets in this repository

| Asset | Location | Licence |
|---|---|---|
| Bundled ds鲸鲸娘 / 大肥鱼 sprite sheet | `PetSprite` data URI in `petArt.ts` | MIT, © zhouwu97 and ds-pet contributors; derivative © skyerd and dsh-handsoff contributors |
| Pet code (sprite renderer, frame timing, bubble, right-click rail, overlay, state model, local importer) | `PetSprite.*`, `petFrames.ts`, `PetBubble.*`, `PetRail.*`, `PetIcons.tsx`, `DesktopPet.*`, `petModel.ts`, `petPrefs.ts`, `petArtStore.ts`, `PetArtDialog.*` | MIT, © skyerd and dsh-handsoff contributors |
| Rail line icons (inline SVG) | `PetIcons.tsx` | ISC-style geometry from [Lucide](https://github.com/lucide-icons/lucide); paths authored inline, © skyerd and dsh-handsoff contributors |
| User-imported sprite files | Browser IndexedDB only; never committed or published | Not licensed by this project; follows the user’s own licence |

If you later add a third-party sprite sheet, sound or font, record the exact
source URL, author, licence and required attribution in this file before
merging it.
