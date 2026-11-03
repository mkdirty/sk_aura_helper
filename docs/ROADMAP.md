# Roadmap

## Goal

Player-facing tools for *Star Knightess Aura*: an interactive map; answers to questions like
"where can this item be used?" and "when's the earliest I can learn Fire I?". Then a walkthrough
written with those tools and checked to be optimal for its route. As much as possible is derived
from the game's source, so answers stay accurate and follow game updates.

See [DECISIONS.md](DECISIONS.md) for the principles and scope, [ARCHITECTURE.md](ARCHITECTURE.md)
for how the tools work, and [GAME-NOTES.md](GAME-NOTES.md) for what we know about the game.

## Plan

| # | Phase | Status |
| --- | --- | --- |
| 1 | Headless harness: boot the shipped engine in Node; run events; the author's tests | ✅ done |
| 2 | Whole-project decoder, pretty-printer, decoder coverage | ✅ done |
| 3 | Effects per command, cross-reference index (`where`), symbols | ✅ done |
| 4 | Runtime cross-check of the index against the harness | ✅ done |
| 5 | Remaining item/skill sources: crafting, books, blessing, NG+ (every plugin command now has a recorded verdict) | ✅ done |
| 6 | Control-flow graph; requirement tracing ("earliest X"); taint report (what transitively writes corruption, lewdness, vice, mental changes) | planned |
| 7 | Day model, checked against the harness | planned |
| 8 | Reachability and routing bounds (lower bound vs a concrete route) | planned |
| 9 | Offline map render and public site (can start any time) | planned |
| 10 | Walkthrough with typed references; route linter; instrumentation mod | planned |

Supporting infrastructure, built when a phase needs it: version diffing tied to CHANGELOG entries,
stable anchors, the annotation layer (with the symbol overlay), a content-coverage oracle, a harness
REPL over real saves. See ARCHITECTURE "Planned components".

## Status (2026-11-02)

`main` holds phases 1–5 (including NG+, the harness boot fix and the plugin review snapshot);
no branch is pending a merge.

| Tool | State |
| --- | --- |
| Harness | Boots in ~0.25s with all 143 plugins; runs common events and map pages; all 7 Map050 author tests pass |
| Decoder | 23,748 lists / 458,065 commands in ~2s, **0 gaps**, 2 anomalies (Map271/E28); CE11 and Map265/E8 are hand-checked snapshots |
| Index | ~112k references in ~2.5s. Plugin commands: 42 modelled, 60 checked to have no effect, 1 unanalyzed (unused `openSceneDatabase`); all 103 recorded in `plugin-review.json` |
| Cross-check | **0 unexplained** on every entry point (first full run: 3,502). Pages: 10,738 runs, 41,917 changes (31,055 explained, 10,786 visited-map, 76 dynamic), ~27 min. Common events: 551 runs, 1,703 changes (1,605 / 80 / 18), ~5s. Re-run after the harness boot fix (2026-11-02): identical totals (see open items) |
| Tests | 34 passing (`npm test`, ~4s) |

## Next steps

1. **Control-flow graph and requirement tracing:** the step toward "earliest I can learn Fire I".
   Labels and jumps cross blocks (Map265/E8 jumps into a choice branch); page priority makes lower
   pages missable. Book prerequisites (`<idkcheck>` JS on book items, e.g. The Art Of Fire needs a
   Fire rank) are requirements this will need.
2. **Day model** (CE11 `endDay`, CE12 `startDay`, Map002), fuzzed against the harness.
3. **Map renderer**: independent; can start whenever something visual is wanted.

## Open items

- **Report to the author (the user's call):** Troop245 page 1 uses the unregistered
  `ska_compendium::revealTrait`, so enemy 112's "sluggish" trait is never revealed there (see
  GAME-NOTES "Bugs and quirks").
- **Boot fix vs cross-check (2026-11-02):** until the fix, every harness run skipped the plugin
  processing done in `Scene_Boot.start` wrappers (passive skills, database inheritance, dynamic
  prices, artifacts, stance/enhance skills, NG+ skills). Re-running both cross-checks afterwards
  gave identical totals: same outcomes (8,899 completed, 1,001 battle, 432 error, 384 frame cap,
  20 shop, 1 save, 1 NG+ skill picker), same changes and verdicts. Totals only: the previous
  full run's per-entry results weren't kept, so an entry-level diff wasn't possible. Full page
  runs now also save `out/crosscheck/results.full-pages.json` (this run is the current one; `out/`
  is gitignored, so a fresh clone must re-run to get a baseline).
- **Cross-check coverage** (full run, 2026-11-02):
  - **Weak attribution for a quarter of changes:** 10,786 of 41,917 page-run changes are
    explained only by "an event on a visited map" (the tracker can't tell which interpreter made a
    change). Tagging changes with the running interpreter would make these exact.
  - **Runs that don't finish:** 1,001 page runs stop at a battle, 20 at a shop, 384 hit the frame
    cap, and 432 crash. 386 of the crashes are Map074 recollection-room scene pages (page 2 of
    E109 onward) that expect caller-provided array variables, so those scenes are effectively
    unchecked. Common events: 115 of 551 crash for the same reason.
  - It follows default choices only. Choice-exploring policies and battle emulation would widen
    it. The full page run takes ~28 min (~150 ms/run) and hasn't been profiled.
- **Blessing call sites over-approximate:** the White Priestess at Map008 casts Bless Item I but
  is listed for every blessing, including those only Bless Item II (390) allows; the "with skill"
  label says which. Fixing it needs `$gameTemp.setLastUsedSkillId(N)` tracked as known state
  along straight-line code.
- **Dev maps** (Map012 Palette, Map019/020/050 tests) are still included in the index and dump.
  They should be excluded from "content" and the map graph; decide when building those.
- **Unanalyzed** (`npm run where -- unanalyzed`): ~420 non-constant call arguments (mostly
  runtime-chosen recollection maps and selected items) and scripts with computed ids. 557 sites
  in all, 106 distinct "argument not constant" groups.
- **Not modelled by design (no entity for them):** actor parameter gains (stat books, Change
  Parameter), MP costs (blessing in MP mode), book progress and NG+ selections (plugin state
  outside the tracked switches/variables/items).
- **Not analyzed yet:** JS in note tags (`<enable condition:>`, books' `<idkcheck>` and
  `<yescondition>`), plugin parameters, text escapes
  (`\V[n]`, `\js<…>`), Compendium conditions; battle-only state (troop pages are indexed but
  battles don't run in the harness).
- The symbol annotation overlay is planned, not built.

## Deferred questions

- Route semantics: what each route forbids, NG+ carry-over, adult-content setting, difficulty.
- What breaks ties under "minimize days" (gold, willpower, battle risk)?
- Whether setup should fetch CGs from the public art repo instead of using the game's files.
