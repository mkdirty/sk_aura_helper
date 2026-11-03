# Decisions

What was decided, why, and what follows from it. Newest entries go at the end of their section.
When a decision changes, edit its entry and note the date, rather than deleting the history.

## Project principles (2026-11-02)

- **Derive, don't transcribe.** Every fact comes from game data or code, so answers stay accurate
  and follow updates. Hand-written knowledge goes in a separate annotation layer with provenance,
  keyed so it breaks loudly when the game changes (planned).
- **The game's own code is ground truth.** The engine runs headless in Node, so static analysis is
  checked against the real interpreter (the runtime cross-check).
- **Information before semantics.** The current question is "can we find the information we
  need?" Route definitions are deferred (below).
- **Honest coverage.** Tools report what they couldn't handle (decoder gaps, unanalyzed effects,
  cross-check verdicts) instead of guessing.

## Scope and audience

### Versions: follow the developer's release schedule (2026-11-02)

Support the latest game version only: pinned stable versions, plus prereleases worked through as
they ship. No multi-version support. Per-version snapshots of derived data exist for diffing: an
update's diff shows which tools, annotations and walkthrough sections need attention. That makes
version diffing and stable anchors core infrastructure.

### Private repo, public outputs (2026-11-02)

- This repository and the game files stay **private**. The walkthrough, interactive map and any
  web tools are **public**.
- **The author's terms:** don't sell access to the tools and don't distribute the game files;
  otherwise we're free to do as we wish. (The game's `package.json` says CC BY-NC-SA 4.0 and its
  EULA forbids redistribution; the author's permission is what governs this project.)
- Art is already public at <https://gitgud.io/aura-dev/star_knightess_aura_cg>. Default: use the
  files the game actually loads. Optional nicety: have setup download the needed CGs from the
  public repo instead.
- Public outputs are built into a separate publish target containing only derived data, rendered
  images and needed assets, never the raw game repo or game code.

### Languages: EN only for now (2026-11-02)

Read EN text directly from `data/` (EN is the base language; `languages/EN/` is an export).
Translation, if ever, is probably walkthrough-only, so walkthrough prose uses typed references
(`{{item:42}}`) that can be resolved per language through the `languages/*` keys.

### Route semantics: deferred (2026-11-02)

"Optimal" differs per route (e.g. Nightmare Purity 100%: see all content that doesn't affect
lewdness/corruption, then minimize days). Routes will be config: constraints plus ordered
objectives. What each route forbids, NG+ carry-over, the adult-content setting, difficulty and
tiebreakers are decided later, when the walkthrough is near. Until then, the job is to make the
information they'll need findable: what writes corruption/lewdness/vice, what counts as content,
how days advance, what's random.

## Technology

### TypeScript, run with tsx (2026-11-02)

TypeScript, because the game's own JS then loads directly in the harness. This machine's Node
22.22 build lacks built-in TypeScript support (`ERR_NO_TYPESCRIPT`), so scripts run through `tsx`.
`tsconfig` uses `erasableSyntaxOnly`. Tests: vitest.

### No machine-specific paths in the repo (2026-11-02)

The game directory comes from `vendor.json` (`gameDir`) or `SKA_GAME_DIR`. Throwaway prototypes go
in `experiments/`, which is gitignored.

## Harness

### Run the shipped engine in a Node `vm` (2026-11-02)

A context with browser/NW.js stubs, booted through the game's own code: the `js/main.js` script
list, `PluginManager.setup`, and the real `Scene_Boot` lifecycle, because about two dozen plugins
do essential work in boot hooks. Chosen over driving real NW.js: fast (~0.25s boot), scriptable,
no GPU. Real NW.js over DevTools stays an option for rendering and battles.

Design rules, each for a reason:

- **Deterministic:** seeded `Math.random`, timers that never fire on their own, an explicitly
  drained microtask queue, and an empty profile by default (results don't depend on whoever runs it).
- **Read-only and offline:** file writes are swallowed and recorded; no network.
- **No graphics or audio:** images load instantly and empty; animations and balloons end at once.
- **Window-free messages:** a driver answers messages and choices following the choice plugin's
  rules; scripted input drives choices, otherwise a policy picks.
- **Scenes aren't emulated:** a run stops and reports when the game asks for a battle, menu or
  shop.

### "Game in progress" = new game + CE16 `initGame` + Aura in the party (2026-11-02)

The author's tests and many events assume a game in progress, but a new game's party is empty
until the intro runs. This setup approximates that state; it's an approximation, used by the
event-test runner and the cross-check.

## Event decoder

### Decode the whole project, not one event (2026-11-02)

The decoder and printer cover **every event command list** (map pages, common events, troop pages)
from the start, rather than one event such as CE11. The format is uniform, so it costs about the
same, and scoping invites overfitting. A full dump is useful in its own right: greppable game
logic, and diffing dumps between versions gives a logic changelog.

To make "find gaps and fix them" workable:

- **Decode, then render.** Command meanings live in the decoder (reused by later analysis), not
  in string formatting.
- **Gaps are counted, not eyeballed:** the same pass produces a coverage report ranked by
  frequency, and the work loop is re-run → top of the report → fix.
- **A gap has a definition.** A generic fallback (plugin command as name + args, script verbatim)
  is acceptable output. A gap is something that can't be rendered even generically, or a decoding
  we know is wrong.
- **Hand-checked reference outputs** (CE11 `endDay`, Map265/E8) catch silent misreadings, which a
  printer never flags.
- **Boundary:** event command lists only. JS elsewhere is out of scope for this tool, so coverage
  numbers don't overstate.
- **Output:** deterministic, written to gitignored `out/` (regenerable); only reference snapshots
  are committed. Dialogue can be collapsed.

### Blocks follow the engine's indentation semantics (2026-11-02)

The engine delimits blocks by indentation alone, so the decoder does too. Missing end markers or
closers are reported as **anomalies** (odd data, decoded as the engine runs it), separate from
**gaps** (the decoder may be wrong).

## Analysis

### Cross-reference index before the control-flow graph (2026-11-02)

"Where is X read or written" doesn't depend on execution order, so the reads/writes layer and the
index came first and answer the user's first question early. The CFG is built when
requirement tracing needs it.

### Helper arguments are handled generically (2026-11-02)

Instead of special-casing `Obtain_Item`, effects can have symbolic ids ("value of V650"). Each
common event gets a summary of caller-dependent effects with path conditions, and each call site
fills them in from constants and copies assigned just before it, dropping branches the values rule
out. "This event" in common events resolves to the calling event the same way.

### Plugin handlers come from registered implementations (2026-11-02)

Each plugin command's effects are written from its registered handler's source (`npm run harness
-- handler plugin:command`), not guessed from names. Commands with no persistent effect are listed
explicitly, each checked against its handler. Everything else is reported as unanalyzed.

**Reviews are recorded and expire (2026-11-02).** `src/analysis/plugin-review.json` records, for
every command with a verdict, hashes of the registered handler and of the plugin file defining it.
A test fails when either changes after a game update, or when the events use a command with no
verdict, so a review can't silently go stale. The file hash is included because handlers often
delegate to scenes and helpers in the same file. Code in *other* files (e.g. `ska_curses.js`'s
`canSpendGold`, used by blessing) isn't covered. The first snapshot (2026-11-02) was recorded with
`--accept-all` from the reviews made when each command was added, not a fresh re-read of all 103.

### Unknown ids are recorded, not dropped (2026-11-02)

A script write whose target can't be determined still produces an effect, with an unknown id.
Queries can then say "something here writes some variable", and the cross-check can tell
"dynamic" from "missed".

### Symbols: IDs canonical, author's names verbatim (2026-11-02)

The user proposed a symbols database (e.g. `S22 noCollar` → `switch.no_collar`). Decided:

- **Generated `symbols.json`, rebuilt every run:** kind, ID, the author's name verbatim, flags
  (unused, unnamed, section header) and usage counts. Diffing it between versions hints at changed
  meaning.
- **No renamed identifiers.** They'd add a translation step between our output and the source,
  the debug menu (F9 shows IDs), harness logs and the community; and names change between versions
  while IDs don't. Output and walkthrough references stay `S22 noCollar` / `{{switch:22}}`.
- **Knowledge goes in a separate annotation overlay** (descriptions, categories, corrections,
  public display labels), keyed by ID with provenance (planned).
- **Scratch and argument slots aren't global symbols:** "V650 is CE785's item argument" is a
  call-site fact from dataflow.

Facts behind this: every used switch/variable is named, and names are unique apart from one
section header (see GAME-NOTES).

### Runtime-chosen plugin data is listed in full, labelled (2026-11-02)

When a plugin command's effect depends on state the index doesn't track (which book a companion
holds, which bless skill is active, which NG+ skills were picked), the handler lists every
possibility the data allows and labels each with its condition ("with skill 390", "if
selected"), rather than reporting it unanalyzed. That over-approximates per call site, and the
label says how.

### New Game+ is a playthrough boundary (2026-11-02)

`startNewGamePlus` is indexed as a call to the start map, not as writes to every switch and
variable it resets. The index describes one playthrough; carry-over is recorded as facts (which
ranges, which skills) for the deferred route semantics to use.

## Runtime cross-check

### Check the index against the running game (2026-11-02)

Run entry points in the harness, record actual changes, and classify each against the index's
prediction. This tests soundness ("did the index miss a write?") on the paths taken, not
precision. Verdicts:

- **explained:** a constant write in the run's own code or what it calls.
- **visited-map:** only by events of a map the run was on. The tracker can't tell which event
  made a change, so this is weaker attribution, reported separately rather than counted as
  explained.
- **dynamic:** only by a write whose id isn't constant.
- **unexplained:** an index bug or gap.

Map event pages are the main entry points: many common events need caller-provided arguments and
crash when run alone. `--rerun-unexplained` makes the fix loop take seconds instead of the full
~28-minute page run.
