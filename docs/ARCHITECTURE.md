# Architecture

How the tools work. For usage see the [README](../README.md); for why things are this way see
[DECISIONS.md](DECISIONS.md); for facts about the game see [GAME-NOTES.md](GAME-NOTES.md).

```text
game/ (data, js)
   │
   ├─ src/data ──────── GameData: JSON files, plugin params, TemplateEvent resolution
   │     │
   │     ├─ src/events ── decoder → op trees → printer (+ decoder coverage)
   │     │       │
   │     │       └─ src/analysis ── effects per op (+ scripts, plugins, database)
   │     │                │            → cross-reference index → where / index / symbols
   │     │                │
   └─ src/harness ────────┴──── src/check: run in the real engine, compare with the index
```

## Data access (`src/data/`)

`GameData` reads `game/data/*.json` and `js/plugins.js` directly (cached), with no engine
involved. It also resolves TemplateEvent: `templateFor(event)` finds the template a `<TE:…>`
note names on the template map (`TemplateMapId`), and `effectivePages(event)` returns the pages
the event actually runs.

## Event decoder and printer (`src/events/`)

- **Lists** (`lists.ts`): every command list with a source: map page (templated events yield the
  template's pages, plus their own marked `original`; the template map itself is skipped),
  common event, troop page, or a database row (for analysis).
- **Decoder** (`decode.ts` → `ops.ts`): turns a list into a tree of typed ops.
  - Blocks are the commands indented deeper than their opener, as in the engine. End markers and
    closers are consumed when present.
  - Multi-line commands absorb their continuation lines (401, 405, 408, 605, 655, 657, 505).
  - About 50 commands get dedicated shapes (conditions, variable operands, transfers, items, …).
    The rest decode to a generic op with parameters named from a spec table. Layouts follow
    `Game_Interpreter.commandNNN`; move-route step names come from the engine's
    `Game_Character.ROUTE_*` constants.
  - Problems become issues, never exceptions: **gaps** (unknown code, unexpected shape) or
    **anomalies** (odd structure, decoded as the engine runs it).
- **Printer** (`render.ts`, `document.ts`, `names.ts`): Python-like pseudo-code with ids
  resolved to names (`S22 noCollar`, `item 7 "Potion"`), page headers with triggers and
  conditions, and template info.
- **Coverage** (`coverage.ts`): gaps and anomalies ranked with sample locations, plugin commands
  vs the runtime registry, script counts, and engine commands that enabled plugins override.

## Analysis (`src/analysis/`)

- **Effects** (`effects.ts`): what one op reads, writes and calls, as `Effect`s on `Entity`s
  (switch, variable, self switch, item/weapon/armor, gold, skill, state, class, actor, quest,
  bestiary, achievement, common event, map event, map, troop).
  - Engine commands: from the interpreter's semantics.
  - Plugin commands: handlers written from their registered implementations (`PLUGIN_EFFECTS`),
    a reviewed list of no-effect commands (`PRESENTATION`), and everything else reported as
    unanalyzed.
- **Scripts** (`script.ts`): parsed with acorn; constant references to engine APIs
  (`$gameSwitches`, `$gameVariables`, `$gameSelfSwitches`, party items and gold, skills,
  `$gameMap.event(N).start()`, `reserveCommonEvent`, quests, GALV `sswitch`).
  - It tracks simple constant bindings (`const x = …`, `for (const k of KEYS)`) and partly known
    self-switch keys.
  - A reference it can't pin down still yields an effect, with an unknown id.
- **Ids** can be constant, symbolic (`{var: N}`: the value of variable N), or unknown; maps and
  events can also be "current"/"self" (the running event).
- **Index** (`xref.ts`):
  1. **Walk** every decoded list, tracking which variables hold known constants or copies along
     straight-line code, and path conditions from `if V op const`. Effects inside Skip blocks are
     marked dead.
  2. **Autonomous move routes** of each page are indexed as part of the page (index −1).
  3. **Common-event summaries:** each common event's caller-dependent effects (symbolic ids,
     "self") with their path conditions, including those of the events it calls.
  4. **Call sites** fill summaries in from their known values, dropping paths the values rule out.
     Fully resolved effects become refs at the call site, with the chain in `via`.
  5. **Inline local calls** (`callLocalEventInline`) re-attribute the called page's "this event"
     effects to the caller.
  6. **Database refs** (`database.ts`): class learnings, item/skill effects, skill-granting
     traits, enemy drops (effect and trait codes from the engine's constants), and what finishing
     each book does.
- **Books** (`books.ts`): parses item note tags as the engine does and derives each book's
  completion effects (learn/forget skill, willpower). They appear twice: as database refs on the
  book item (Aura's path: the item runs CE607/CE608), and on `books:readBook` (the companions'
  path; every book applies, since which one is assigned is runtime state). Parameter gains aren't
  modelled, like the engine's Change Parameter: there's no parameter entity.
- **Blessing** (`blessing.ts`, `TLB_SKABlessMenu:openScene` handler): blessable item pairs
  derived from note tags, with the bless skills that allow each. The skill in force is runtime
  state, so every call site lists every pair, labelled "with skill 389/390" (checked against the
  plugin's own `itemValid`).
- **New Game+** (`newgame-plus.ts`): the carry-over skill list (`<score_cost>`). The
  `initCarryOverSkills` handler lists every one as a possible learn; `startNewGamePlus` is a
  call to the start map, and its reset isn't listed per entity, since it ends the playthrough.
  `test/plugin-models.test.ts` checks the list, and the blessing pairs, against the plugins'
  own code in the harness.
- **Plugin reviews** (`plugin-review.ts`, `plugin-review.json`, `npm run plugins`): each command
  with a verdict in `effects.ts` (modelled / no effect / unanalyzed), with sha256 prefixes of its
  registered handler's source and its plugin file, read from a booted harness.
  `test/plugin-review.test.ts` fails on a changed hash, a verdict without a record (or the
  reverse), and an event-used command without a verdict.
- Note tags are parsed by `notes.ts`, matching `DataManager.extractMetadata`.
- **Crafting** (`TLB_SKACraftMenu:openScene` handler): per recipe, the target item is "crafted
  (into stock V…)", ingredients are lost, the stock variable is written, and the success switch
  is set. The target is a write in the same sense as "shop sells": a source, not a direct gain.
- **Queries** (`src/cli/where.ts`): refs by entity, grouped by what happens, with the places that
  ultimately run a common event. `src/cli/index.ts` writes `symbols.json` and the unanalyzed report.

## Headless harness (`src/harness/`)

`Harness.boot()` builds a Node `vm` context and boots the game in it:

- **Environment** (`browser.ts`, `xhr.ts`, `sandbox-fs.ts`): DOM and canvas stand-ins; `<img>`
  loads instantly; `<script>` elements are evaluated from the game dir (so `PluginManager.setup`
  works unchanged); a file-backed `XMLHttpRequest` that completes synchronously and refuses URLs
  outside the game dir; a read-only `fs` that resolves paths against the game dir (NW.js's working
  directory) and records swallowed writes; fake timers; a seeded `Math.random`.
- **Boot:** the `js/main.js` script list (minus audio decoding and Effekseer, which start
  workers/WASM), `PluginManager.setup($plugins)`, then `Scene_Boot` (`create` → `isReady` polling
  → `start`). Scene requests during `start` are recorded without throwing, because plugins do
  their processing in `start` wrappers after the original returns; `resizeScreen` is stubbed (no
  renderer). The context has its own microtask queue, drained explicitly, so the game's promises
  settle deterministically while the frame loop stays synchronous. Player data comes from an
  empty profile unless `saveDir` is given. An uncreated `Scene_Map` stands in for
  `SceneManager._scene`; autosaves are recorded, not written.
- **Frames:** `frame()` mirrors `Scene_Map.updateMain` (map, player, timer, screen, input), ends
  animations and balloons, answers messages, settles promises and performs transfers.
  `runCommonEvent` and `runEventPage` run code on the map interpreter until it leaves that list;
  scene requests stop the run.
- **Messages** (`messages.ts`): text is dismissed; choices follow the choice plugin's visibility,
  enable, default and cancel rules, driven by an `InputQueue` of presses or a choice policy.
  Everything is recorded in a transcript.
- **Tracking** (`tracker.ts`): wraps the setters for switches, variables, self switches, items
  and gold, after plugins load.
- **Author's tests** (`event-test.ts`): a reconstructed `event_test` plugin, run from a game in
  progress with `automaticTest` on.
- **Tracing** (`trace.ts`): records every write to one target with the game-code stack and the
  parallel events running at that moment.

## Runtime cross-check (`src/check/`)

For each entry point (a common event on the empty map, or a map event page on its own map) the
check starts a game in progress, runs the entry, and classifies each tracked change against the
index (`StaticWrites`): the entry's own closure of writes through calls, the parallel common
events, and the events of every map visited. Verdicts are explained / visited-map / dynamic /
unexplained (see DECISIONS). Results go to `out/crosscheck/report.txt` and `results.json`.

## Planned components

- **Control-flow graph:** basic blocks with labels, jumps and loops (labels cross blocks), page
  conditions as guards with page priority (later pages hide earlier ones).
- **Day model and reachability:** day transitions, per-day resources, deadlines and the Reality
  clock. Requirement slicing (AND/OR trees) with page-priority intervals, random vs controllable
  edges. Eventually a lower bound on days from requirements and a concrete route as the upper
  bound; equal bounds = proven optimal.
- **Outputs:** an interactive map pre-rendered offline with the game's own Tilemap and served with
  Leaflet or OpenSeadragon (no game code ships); a query UI on the index; a walkthrough with typed
  references, plus a linter that replays routes against the model.
- **Analysis extensions:** evaluate conditions in the harness rather than only statically;
  generate plugin-handler skeletons from plugins' `@command`/`@arg` headers; TypeScript types
  generated from the game's schemas (`game/schemas/`).
- **Infrastructure:**
  - version diffing tied to CHANGELOG entries
  - stable anchors (map, event, page, hash of command subtree) with fuzzy re-matching, since
    command indices shift between versions
  - an annotation layer with provenance (including the symbol overlay)
  - a content-coverage oracle (seen messages vs all messages)
  - a harness REPL over real saves
  - an instrumentation mod for recording real play
  - storage: SQLite for publishing; an in-memory graph or Datalog for recursive queries
