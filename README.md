# sk_aura

Tools that deterministically extract data from *Star Knightess Aura* (RPG Maker MZ) and turn it into
player-facing resources: an interactive map, a walkable decision graph, and so on.

## Layout

| Path | What |
| --- | --- |
| `game/` | Submodule: private repo holding the game as shipped, minus vendored and non-game files (below). Read-only extraction input; has its own `.gitignore`/`.gitattributes`. |
| `vendor.json` | Pinned, freely downloadable parts of the game (URL + SHA-256 + file mapping). |
| `scripts/vendor.mjs` | Downloads, verifies, and installs those into `game/`. |

## Setup

Requires Node 22+ (`nvm use`), `git`, `tar`, and `unzip`.

```sh
git clone --recurse-submodules <this repo>   # or: git submodule update --init
npm run setup          # download + verify vendored files, install into game/
npm run game           # launch the game (Linux)
```

Downloads are cached in `.cache/vendor/` (gitignored). Re-running setup only copies files that differ;
pass `-- --force` to overwrite everything.

## What the game repo does not commit

**Vendored** (restored by `npm run setup`; each verified byte-identical to the shipped copy):

| Source | Version | Installs |
| --- | --- | --- |
| NW.js (normal, linux-x64) | 0.48.4 (Chromium 85.0.4183.121, Node 14.12.0) | runtime files; launcher `nw` → `Game` |
| Effekseer for WebGL | 1.70b | `js/libs/effekseer.min.js`, `effekseer.wasm` |
| localforage (npm) | 1.7.3 | `js/libs/localforage.min.js` |
| pako (npm) | 1.0.11 | `js/libs/pako.min.js` |

`js/libs/pixi.js` and `js/libs/GameAnalytics.js` do **not** match any upstream release (custom builds),
so they stay committed.

**Not game data** (simply absent from a fresh clone):

- `js/libs/lib/`: Windows-only Steamworks/greenworks binaries. The Linux build never shipped its own,
  so behavior on Linux is unchanged.
- `tools/`: Steam Workshop mod-upload tooling (`steamcmd.exe`, `upload_mod.*`).
- `mods/`: the two bundled mods are disabled-by-default examples/tools; the mod loader recreates the
  folder if missing. Your own local mods also live here.
- `languages/scripts/`, `.gitlab-ci.yml`, `.gitmodules`, `.gitignore`, `.git`, `README.md`:
  the translation repo's tooling and metadata.
- `img/portraits/.gitkeep`, `__pycache__/`.

## Updating the game

1. Copy the new build over `game/` (the game repo's checkout).
2. `npm run runtime:detect`. If the NW.js version changed, update the `nwjs` source in `vendor.json`
   (SHA-256 from `https://dl.nwjs.io/v<version>/SHASUMS256.txt`) and the runtime list in `game/.gitignore`.
3. `npm run vendor:check`. It fails if any vendored file differs from its pinned source (e.g. the game
   bumped a library) or isn't ignored by `game/.gitignore`.
4. Commit in `game/`, then commit the updated submodule pointer here, so every tools commit records the
   exact game version it was built against.

## Git notes

- The game repo is committed **byte-exact** (`* -text -eol`): the game's JSON mixes CRLF and LF, so
  line-ending normalization would alter extraction input. Images, audio, fonts, Effekseer effects, and
  RPG Maker's encrypted assets (`.png_`, `.ogg_`) are marked `binary` there.
- This repo normalizes its own source to LF.
