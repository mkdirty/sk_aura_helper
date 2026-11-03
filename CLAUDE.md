# Working on sk_aura_helper

Tools derived from *Star Knightess Aura*'s source (RPG Maker MZ). Before starting work:

1. **`docs/ROADMAP.md`**: status, next steps and open items. Pick up from "Next steps".
2. **`docs/DECISIONS.md`**: principles agreed with the user. Don't relitigate them; add new
   decisions there.
3. `docs/ARCHITECTURE.md` (how things work), `docs/GAME-NOTES.md` (facts about the game), and
   `README.md` (commands) as needed.

## Keeping docs current

Each file holds one kind of thing. Put new information where it belongs:

| What | Where |
| --- | --- |
| Status, next steps, open items | `docs/ROADMAP.md` |
| A decision and its reason | `docs/DECISIONS.md` |
| How a component works | `docs/ARCHITECTURE.md` |
| A fact about the game (incl. bugs found) | `docs/GAME-NOTES.md` |
| How to use a command | `README.md` |
| How to work on the repo | this file |

## Conventions

- **No machine-specific paths in tracked files.** The game dir comes from `vendor.json` or
  `SKA_GAME_DIR`; prototypes go in gitignored `experiments/`. Grep for `/home/` before committing.
- TypeScript, run with `tsx` (this machine's Node lacks built-in TS support). `tsconfig` uses
  `erasableSyntaxOnly`: no parameter properties, enums or namespaces.
- `npm test` and `npm run typecheck` must pass before committing. The decoder test fails on any
  new decoder gap by design: it flags new command shapes after a game update.
- `game/` is read-only. Generated output goes to gitignored `out/`.
- Work on branches; merge into `main` with `--ff-only` when the user asks. Commit only when asked;
  push after every commit (standing permission).
- Prefer reading the game's own code over guessing: engine semantics are in
  `game/js/rmmz_objects.js`, and plugins in `game/js/plugins/` (enabled list: `js/plugins.js`).

## Workflows

- **Decoder gaps:** `npm run print`, read `out/events/coverage.txt` from the top, fix the most
  frequent gap first, and check against the raw JSON for the cited locations.
- **Plugin command effects:** write handlers from the *registered* implementation
  (`npm run harness -- handler plugin:command`), not the command's name. Add them to
  `PLUGIN_EFFECTS` in `src/analysis/effects.ts`, or to `PRESENTATION` if the handler has no
  persistent effect. Unhandled ones are ranked in `npm run where -- unanalyzed`. Then record the
  review: `npm run plugins -- --accept plugin:command`. After a game update, `npm run plugins`
  lists handlers that changed since their review: re-read each before accepting it.
- **Index soundness:** run `npm run crosscheck` (~5s) or `-- --pages` (~28 min). Diagnose the top
  unexplained group with `npm run harness -- who <target> page <map> <event> <page>`, fix, then
  `npm run crosscheck -- --rerun-unexplained` (seconds). Record what the fix taught in
  GAME-NOTES / ARCHITECTURE. Run `--pages` in the background with output to a log, and before
  reading results confirm it really finished (the log/report header says "10738 runs" or so;
  background-task notices have fired early). Compare against the previous
  `results.full-pages.json` before overwriting it matters.
- **Harness runs need a game in progress:** new game, CE16 `initGame`, then construct actor 1
  *before* adding her (adding first recurses forever via MPP). `startGameInProgress()` in
  `src/harness/trace.ts` does this. Many common events need caller-provided arguments, so map
  pages are better entry points.
- **Errors thrown by game code** come from the vm realm: `instanceof Error` fails, so use duck
  typing (`e?.message`).
