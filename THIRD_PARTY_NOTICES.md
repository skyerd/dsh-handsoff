# Third-party notices

HandsOff is a **split-licence** project:

- **Code:** MIT — see [`LICENSE`](LICENSE).
- **Bundled default artwork:** CC-BY 3.0 — see [`ASSETS-LICENSE.md`](ASSETS-LICENSE.md).
- **User-imported artwork:** not bundled and not sublicensed; it stays in the
  user’s browser and keeps its own licence.

The package manifest therefore declares `MIT AND CC-BY-3.0`.

This file records the projects we reviewed while choosing the pet architecture,
the licensing reason each one was or was not reused, and the required
attribution. Reviews were checked against public sources on 2026-10-30.

## Bundled artwork and required attribution

### Q-style cartoon mermaid — **used**

- **Author:** Aeihu
- **Source:** <https://opengameart.org/content/q-style-cartoon-mermaid>
- **Licence:** CC-BY 3.0 — <https://creativecommons.org/licenses/by/3.0/>
- **What we used:** the base chibi mermaid illustration, cropped and downscaled.
- **Changes:** we composited an original navy/white maid bodice, skirt, apron,
  lace headdress, puffed sleeves and whale emblem; selected three expressions
  (`idle`, `done`, `sleep`); encoded them as WebP data URIs.
- **Where:** `packages/client/ui-settings-session-orchestrator/src/client/petArt.ts`
- **Attribution requirement:** credit “Q-style cartoon mermaid by Aeihu,
  CC-BY 3.0, via OpenGameArt.org” when redistributing the artwork.

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
- **If you want the model embedded as the default:** obtain written permission
  from the original author first and accept the much larger runtime and memory
  footprint. Without that permission, even a “personal non-commercial” label
  cannot replace the licence the author actually granted.

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

1. **Bundled default:** the CC-BY 3.0 chibi whale maid above, which permits
   commercial use and modifications with attribution.
2. **Local personal import:** the “Custom artwork” dialog stores the user’s
   selected whale-maid PNGs only in that browser. Nothing is uploaded, bundled
   or redistributed. The user is responsible for having permission to use them.

“DeepSeek” is a trademark of DeepSeek. The bundled chibi whale maid is a
project mascot derived from a CC-BY 3.0 mermaid, not an official DeepSeek asset,
and nothing here implies endorsement by DeepSeek.

## Assets in this repository

| Asset | Location | Licence |
|---|---|---|
| Bundled whale-maid artwork (derived from Aeihu’s mermaid) | `PetSprite` data URIs in `petArt.ts` | CC-BY 3.0, © Aeihu; modifications © skyerd and dsh-handsoff contributors |
| Pet code (sprite renderer, bubble, overlay, state model, local importer) | `PetSprite.*`, `PetBubble.*`, `DesktopPet.*`, `petModel.ts`, `petPrefs.ts`, `petArtStore.ts`, `PetArtDialog.*` | MIT, © skyerd and dsh-handsoff contributors |
| User-imported sprite files | Browser IndexedDB only; never committed or published | Not licensed by this project; follows the user’s own licence |

If you later add a third-party sprite sheet, sound or font, record the exact
source URL, author, licence and required attribution in this file before
merging it.
