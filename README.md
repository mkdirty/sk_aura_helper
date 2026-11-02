# sk_aura

Tools that derive player-facing resources from *Star Knightess Aura* (RPG Maker MZ) by reading
the game's own data and running its own engine: readable dumps of all game logic, "where is X
used?" queries, and (planned) an interactive map and a verified walkthrough.

## Documentation

| Doc | What |
| --- | --- |
| [docs/ROADMAP.md](docs/ROADMAP.md) | Goal, plan, current status, next steps, open items |
| [docs/DECISIONS.md](docs/DECISIONS.md) | What was decided and why |
| [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) | How each tool works |
| [docs/GAME-NOTES.md](docs/GAME-NOTES.md) | What we've learned about the game (incl. bugs found) |
| [docs/GAME-REPO.md](docs/GAME-REPO.md) | The `game/` submodule: vendored files, updating the game |
| [CLAUDE.md](CLAUDE.md) | Conventions and workflows for working on this repo |

## Setup

Requires Node 22+ (`nvm use`), `git`, `tar` and `unzip`.

```sh
git clone --recurse-submodules <this repo>   # or: git submodule update --init
npm install
npm run setup          # download + verify the vendored game files into game/
npm run game           # launch the game (Linux)
```

`npm test` runs the test suite (~3s); `npm run typecheck` checks types. The game directory
defaults to `gameDir` in `vendor.json`; override it with `SKA_GAME_DIR`. Generated output goes to
`out/` (gitignored).

## Tools

### Pretty-printer: `npm run print`

Decodes every event command list (map event pages, common events, troop pages) and prints it as
readable pseudo-code with names resolved, plus a coverage report of anything the decoder doesn't
understand.

```sh
npm run print                       # everything → out/events/, plus coverage.txt / coverage.json
npm run print -- ce 11              # one common event to stdout
npm run print -- map 265 8          # one map event (or the whole map without the event id)
npm run print -- troop 5
npm run print -- ce 11 --text first # dialogue: full (default), first line, or none
```

### Where is X used: `npm run where`

Every place the game reads, writes or calls something, from events, scripts, plugin commands
and the database. Includes the chain of helper events behind each effect and the map events that
ultimately run it.

```sh
npm run where -- item 23            # also weapon / armor / skill / state / class / actor / troop
npm run where -- switch 22          # also variable N, gold
npm run where -- selfswitch 11 11 A # map, event, letter
npm run where -- ce 785             # who runs a common event; also: map 7, event 7 8, quest 51
npm run where -- unanalyzed         # what the index couldn't see, ranked
npm run where -- item 23 --json     # options: --dead (include Skip blocks), --callers N|all
npm run index                       # out/index/symbols.json and unanalyzed.txt
```

### Runtime cross-check: `npm run crosscheck`

Runs code in the real engine and checks every state change against what the index predicts.
A change the index can't account for is a bug in the index.

```sh
npm run crosscheck                          # every common event (~5s)
npm run crosscheck -- --pages               # every map event page, on its own map (~28 min)
npm run crosscheck -- --map 29              # one map's pages
npm run crosscheck -- --rerun-unexplained   # only entries that had unexplained changes last time
```

Reports go to `out/crosscheck/`. Verdicts are explained in DECISIONS "Runtime cross-check".

### Headless harness: `npm run harness`

The shipped engine and plugins running in Node: deterministic, read-only, no graphics.

```sh
npm run harness -- ce 16 12 --transcript                # run common events, print changes
npm run harness -- test 50                              # the author's automated tests on Map050
npm run harness -- who self 302,2,A page 302 2 1        # who writes a switch/variable/self switch
npm run harness -- handler selfswitches_utils:setLocalSelfSwitch   # a plugin command's source
```

## Layout

| Path | What |
| --- | --- |
| `game/` | Submodule: the game as shipped (read-only input). See [GAME-REPO.md](docs/GAME-REPO.md). |
| `vendor.json`, `scripts/vendor.mjs` | Pinned downloadable parts of the game, and their installer |
| `src/data/` | Static access to the game's data files |
| `src/events/` | Event command decoder, pretty-printer, decoder coverage |
| `src/analysis/` | Effects per command, script analysis, cross-reference index |
| `src/harness/` | Headless engine |
| `src/check/` | Runtime cross-check |
| `src/cli/` | Command-line entry points |
| `test/` | Vitest suite |
| `docs/` | Documentation (see above) |
| `experiments/` | Local throwaway prototypes (gitignored) |
