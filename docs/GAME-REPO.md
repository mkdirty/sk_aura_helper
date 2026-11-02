# The game repository (`game/`)

`game/` is a submodule: a private repository holding the game as shipped, minus freely
downloadable and non-game files. It's read-only input for every tool. The tools never write to it
(the harness sandboxes writes).

## What the game repo does not commit

**Vendored** (restored by `npm run setup`; each verified byte-identical to the shipped copy):

| Source | Version | Installs |
| --- | --- | --- |
| NW.js (normal, linux-x64) | 0.48.4 (Chromium 85.0.4183.121, Node 14.12.0) | runtime files; launcher `nw` → `Game` |
| Effekseer for WebGL | 1.70b | `js/libs/effekseer.min.js`, `effekseer.wasm` |
| localforage (npm) | 1.7.3 | `js/libs/localforage.min.js` |
| pako (npm) | 1.0.11 | `js/libs/pako.min.js` |

`js/libs/pixi.js` and `js/libs/GameAnalytics.js` do **not** match any upstream release (custom
builds), so they stay committed. `vendor.json` pins each source (URL, SHA-256, file mapping);
`scripts/vendor.mjs` downloads, verifies and installs them. Downloads are cached in
`.cache/vendor/` (gitignored); re-running setup only copies files that differ (`-- --force`
overwrites everything).

**Not game data** (simply absent from a fresh clone):

- `js/libs/lib/`: Windows-only Steamworks/greenworks binaries. The Linux build never shipped its
  own, so behavior on Linux is unchanged.
- `tools/`: Steam Workshop mod-upload tooling (`steamcmd.exe`, `upload_mod.*`).
- `mods/`: the two bundled mods are disabled-by-default examples/tools; the mod loader recreates
  the folder if missing. Your own local mods also live here.
- `languages/scripts/`, `.gitlab-ci.yml`, `.gitmodules`, `.gitignore`, `.git`, `README.md`: the
  translation repo's tooling and metadata.
- `img/portraits/.gitkeep`, `__pycache__/`.

## Updating the game

1. Copy the new build over `game/` (the game repo's checkout).
2. `npm run runtime:detect`. If the NW.js version changed, update the `nwjs` source in
   `vendor.json` (SHA-256 from `https://dl.nwjs.io/v<version>/SHASUMS256.txt`) and the runtime
   list in `game/.gitignore`.
3. `npm run vendor:check`. It fails if any vendored file differs from its pinned source (e.g. the
   game bumped a library) or isn't ignored by `game/.gitignore`.
4. Re-run the checks that flag changed game logic: `npm test` (fails on new decoder gaps), then
   `npm run print` and `npm run crosscheck -- --pages`, and review `where unanalyzed`.
5. Commit in `game/`, then commit the updated submodule pointer here, so every tools commit
   records the exact game version it was built against.

## Git notes

- The game repo is committed **byte-exact** (`* -text -eol`): the game's JSON mixes CRLF and LF,
  so line-ending normalization would alter extraction input. Images, audio, fonts, Effekseer
  effects and RPG Maker's encrypted assets (`.png_`, `.ogg_`) are marked `binary` there.
- This repo normalizes its own source to LF.
