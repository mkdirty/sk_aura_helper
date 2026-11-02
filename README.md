# sk_aura

Tools that deterministically extract data from *Star Knightess Aura* (RPG Maker MZ) and turn it into
player-facing resources: an interactive map, a walkable decision graph, and so on.

## Layout

| Path | What |
| --- | --- |
| `game/` | Submodule: private repo holding the game as shipped, minus vendored and non-game files (below). Read-only extraction input; has its own `.gitignore`/`.gitattributes`. |
| `vendor.json` | Pinned, freely downloadable parts of the game (URL + SHA-256 + file mapping). |
| `scripts/vendor.mjs` | Downloads, verifies, and installs those into `game/`. |
| `src/data/` | Static access to the game's data files. |
| `src/events/` | Event command decoder, pretty-printer and coverage report (see below). |
| `src/analysis/` | Reads/writes per command, script analysis, cross-reference index (see below). |
| `src/harness/` | Headless game engine: runs the game's own code in Node (see below). |
| `src/cli/` | Command-line entry points. |
| `test/` | Vitest suite (`npm test`). |
| `docs/ROADMAP.md` | Plan and findings about the game. |

## Setup

Requires Node 22+ (`nvm use`), `git`, `tar`, and `unzip`.

```sh
git clone --recurse-submodules <this repo>   # or: git submodule update --init
npm run setup          # download + verify vendored files, install into game/
npm run game           # launch the game (Linux)
```

Downloads are cached in `.cache/vendor/` (gitignored). Re-running setup only copies files that differ;
pass `-- --force` to overwrite everything.

Development: `npm install`, then `npm test` and `npm run typecheck`. The game directory defaults to
`gameDir` in `vendor.json`; override it with `SKA_GAME_DIR`.

## Event decoder and pretty-printer

`src/events/` decodes every event command list in the game (map event pages, common events, troop
pages) into structured ops, then renders them as readable pseudo-code with names resolved. Blocks
are delimited by indentation, as the engine executes them. One pass also produces a coverage report:
**gaps** (where the decoder may be wrong: unknown codes, unexpected parameter shapes) ranked by
frequency, data **anomalies**, plugin commands (and whether they're registered at runtime), script
counts, and engine commands that plugins override.

```sh
npm run print                       # everything → out/events/ (gitignored), plus coverage.txt/json
npm run print -- ce 11              # one common event to stdout
npm run print -- map 265 8          # one map event (or the whole map without the event id)
npm run print -- troop 5
npm run print -- ce 11 --text first # dialogue: full (default), first line, or none
```

The test suite fails if a full decode has any gaps, so a game update that introduces a new
command shape gets flagged. CE11 and Map265/E8 are hand-checked reference outputs (snapshots).

## Cross-reference index ("where is X used?")

`src/analysis/` works out what each decoded command reads, writes and calls: engine commands, plugin
commands (handlers written from each plugin's registered implementation), and scripts (parsed with
acorn; constant references to engine APIs). Database sources count too: class skill lists, item and
skill effects, skill-granting traits, enemy drops.

Helper common events that take arguments in variables (e.g. `Obtain_Item`: V650 = item,
V651 = amount) are handled generically. Their caller-dependent effects are filled in from values
assigned just before each call, following copies between variables and dropping branches the values
rule out. "This event" inside a common event resolves to the calling map event.

```sh
npm run where -- item 23           # also weapon/armor/skill/state/class/actor/troop/switch/variable/gold
npm run where -- skill 26          # event learn/forget, class learnings, items that teach it
npm run where -- selfswitch 11 11 A
npm run where -- ce 785            # who runs a common event; also: map 7, event 7 8, quest 51
npm run where -- unanalyzed        # what the index couldn't see, ranked
npm run index                      # out/index/symbols.json (+ unanalyzed.txt)
```

References inside common events also list the places that ultimately run them
(`← run from 90 places: Map011/E11 "ether", …`).

## Headless harness

`src/harness/` runs the shipped engine and plugins in a Node `vm` context. It's the ground truth that
static analysis gets checked against. Boot goes through the game's own code: the script list in
`js/main.js`, `PluginManager.setup`, and the real `Scene_Boot` lifecycle (database, mods, template
events, notetag processing).

- **Deterministic:** `Math.random` is seeded, timers never fire on their own, and the profile is
  empty by default (no saves or config are read unless `saveDir` is given).
- **Read-only:** file writes are swallowed and recorded, and there is no network.
- **No graphics or audio:** images "load" instantly and empty, and animations and balloons end
  as soon as they start.
- **Window-free messages:** messages and choices are answered by `MessageDriver`, which follows
  the choice plugin's visibility, enable and default rules. Scripted input (`InputQueue`) drives
  choices; otherwise a policy picks one.
- **Change tracking:** switch, variable, self-switch, item and gold changes are recorded by
  `ChangeTracker`.
- **Scene changes** (battle, menus, shops, …) aren't emulated: a run stops and reports which scene
  was requested.

```sh
npm run harness -- ce 16 12 --transcript   # new game on the empty map, run CE16 then CE12, print changes
npm run harness -- test 50                 # run the author's automated event tests on Map050
```

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
