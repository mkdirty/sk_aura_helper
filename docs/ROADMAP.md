# Tooling roadmap

Plan for the tooling this project needs, and the infrastructure that makes building it easier.
Only throwaway prototypes exist so far (`experiments/`).

## Goal

Build player-facing tools (interactive map, "where is X used?", "earliest I can get Y?") and use them
to write a walkthrough that is checked to be optimal. Derive as much as possible **from the game's
source**, so answers stay accurate and follow game updates.

## Principles

- **Derive, don't transcribe.** Every fact comes from game data or code. Hand-written knowledge goes
  in a separate annotation layer with provenance (see below).
- **Use the game's own code as ground truth.** The engine runs headless in Node (verified), so the
  game's interpreter can check what static analysis claims.
- **Information first, semantics later.** The current focus is "can we find the information we
  need?" Route definitions (what "Purity" forbids, what "minimize days" means, tiebreakers) are
  deliberately deferred until the walkthrough is near.

## Decisions

### Versions: follow the developer's release schedule

- Keep **pinned stable versions**, and also work through **prereleases incrementally** as they ship.
- Per-version snapshots of derived data exist mainly for diffing: each update's diff shows which
  tooling, annotations and walkthrough sections need attention.
- Version diffing and stable anchors (see below) are therefore core infrastructure.

### Audience: private repo, public outputs

- This repository and the game files stay **private**.
- The walkthrough, interactive map and any web tools are **public**.
- The author's terms: don't sell access to the tools and don't distribute the game files.
  Otherwise we're free to do as we wish.
- Art is already public at <https://gitgud.io/aura-dev/star_knightess_aura_cg>. Default: use the
  files the game actually loads (decrypted from `img/`). Optional nicety: have setup download the
  needed CGs from the public repo instead.
- Keep a clear build boundary: public outputs go to a separate publish target with only derived
  data, rendered images and needed assets, never the raw game repo or game code.

### Languages: EN only for now

- Read EN text **directly from `data/`**. EN is the base language and `languages/EN/` is just an
  export of it (`CustomTranslationEngine`: `BaseLanguage: "EN"`, `ExportBaseOnLaunch`).
- Translation, if ever, is probably walkthrough-only. Walkthrough prose uses typed references
  (`{{item:42}}`) so names can be resolved per language. The translation keys in `languages/*`
  (`events.{id}.pages.{p}["message-N"]`, `Variables.json`, `Speakers.json`, …) are what those
  references would resolve against.

### Route semantics: deferred

Routes will eventually be config (constraints plus ordered objectives, e.g. Nightmare Purity 100%:
see all content that doesn't affect lewdness/corruption, then minimize days). For now we only make
sure the information those definitions will need is findable: what writes corruption, lewdness and
vice; what counts as content; how days advance; what's random.

## Findings about the game

From the first investigation (2026-11-02, game version 1.5.0-prerelease-3). Prototype scripts are
in `experiments/`.

### Scale

- 320 maps, 13,026 map events, 21,280 pages, 1,100 common events, 1,368 troop pages.
- 1,101 switches (621 named), 1,401 variables (881 named).
- 3,494 script blocks but only 1,303 unique. Top shapes are boilerplate
  (`$gameMap.event(N).start()` ×952, `$gameParty._actors=[]` ×393, `_viewedScenes[N]=…` ×494).
- 110 distinct plugin commands. About 10 handlers cover ~85% of uses
  (`choices::setChoiceOption` ×1626, `setLocalSelfSwitch` ×444, `quests::setObjectiveStatus` ×443,
  `quests::addObjective` ×303, `event_utils::callLocalEvent` ×325, …).

### Headless engine works

A Node `vm` context with ~25 lines of stubs loads pixi.js, all six `rmmz_*.js` files and all 142
enabled plugins. `DataManager.createGameObjects()` works, and the real `Game_Interpreter` runs CE16
`initGame` and CE12 `startDay` correctly. Next blockers seen: a sync XHR→fs shim, `$dataCharGene`
(MPP plugin data), and plugin JSON loads.

### Days

- `ska_dayphases.js` is only a UI window. The day counter is **V31**, incremented in exactly one
  place: CE12 `startDay`. CE12 is called from CE20 `startMainGame` and Map002 `rl_end`.
- CE11 `endDay` has 208 calling events.
- Per-day resources: willpower V10 resets to V11; flags like `S704 brothelWorkedToday`,
  `S46 dayStartEventSlotAvailable`.
- Deadlines stored as day timestamps (V701+ block, e.g. `trademondDaysPastDeadline`).
- The Reality (Earth) phases have their own clock (V33 timeSlot on Map002).

### Corruption, lewdness, vice

- Corruption rises **passively** in `endDay` (V32 `dayCorruption`, V571 `corruptionSpeed`) and is
  **spent** (CE8 `checkAutoCorrupts`, "-3 Corruption" to buy a mental change). 296 direct writes.
- Lewdness and vice are funneled: 129 events call CE23 `onLewdAction`, 77 call CE10
  `onViceAction`; V3 has only 6 direct writes. Taint tracking is easy for these.
- Mental-change choices are corruption-gated choice options; `ska_mental.js` itself finds them by
  scanning for `choices::setChoiceOption` with `$gameVariables.value(2) >= N`.

### The game already tracks "content"

- `save/seenMessages.rmmzsave`: global set of seen messages keyed by
  `[mapId,eventId,page,cmdIndex]`, `[troopId,page,idx]` or `[ceId,idx]`.
- `$gameSystem._viewedScenes` (494 writes), Map119 `EarthRecollectionRoom` (403 events, a scene
  index), 62 quests, 48 Steam achievements, compendium `revealTrait`/`addBossKill`.

### Control flow and calls

- 491 labels, 604 jump-to-label, 84 loops: an indent tree is not enough, so the decoder needs a
  control-flow graph.
- Common events act like functions with arguments in variables: items are mostly granted via
  `V650=item; V651=amount; call CE785 Obtain_Item` (338 calls) vs 192 direct `Change Items`.
  CE787 `Obtain_Gold` works the same way.
- Call edges beyond 117: `$gameMap.event(N).start()` (952), `event_utils::callLocalEvent` (325),
  `setExternalSelfSwitch`, `reserveCommonEvent` from compendium teleports (`teleportCE`, 16
  locations, i.e. fast travel).
- Switch-gated parallel CEs: CE3 `addCollar` (S22), CE26 `manageCursedState` (S25), CE842
  `AirDamage` (S68).
- RPG Maker shows the highest page whose conditions hold, so lower pages become missable.

### JavaScript lives in ~6 places

Script commands (355/655, 111 conditions), note tags (`<enable condition:>`,
`<meetsUsableItemCondition:>`…), `Compendium.json`, `Troops`/`Items`/`Skills.json`, plugin-command
args (`setChoiceShowCondition` ×176…), `$gameExpressions`, inline text `\js<…>` (205).

### Variables aren't just integers

Arrays (`.push`), strings (`== "None"`), objects (V30 mentalAction). Static analysis needs a value
domain for these, or must treat them as opaque.

### Plugins

- Use `js/plugins.js` as the list of live code. Eight files on disk aren't registered (incl.
  `seeded_rng`), so randomness is plain `Math.random`. The harness must seed it.
- Plugin-command dispatch uses the file name only (`rmmz_objects.js:11322`); unregistered commands
  silently no-op (`rmmz_managers.js:3164`). Build handler lists from runtime `registerCommand` keys.
- `ska_migration.js` documents state changes between versions (about 100 migrators citing issues).

### Example: "earliest Fire I"

Skill 26. Learned at Map007/E8 `charlotte`, **forgotten** at Map007/E11 and Map209/E35
(probably the upgrade to Fire II), Mage class learns it at level 1, and a lewd variant exists
(712 "Fire II (Lewd Knowledge 20)"). Queries need an actor, learned-vs-has, and no "skills are never
lost" assumption.

### Other

- **Author's own tests:** Map019/020/050 hold `event_test` cases (e.g. corruption equals 4 after
  removing the collar). A stub `event_test` plugin in the harness turns them into our acceptance
  suite. Exclude these maps and Map012 "Palette" from content and the map graph.
- **Author comments:** 1,234 comment commands; show them in the pretty-printer.
- **Schemas already exist** in `game/schemas/` (quests, compendium, pixel animations, mod meta,
  plugin). Generate TS types from them.
- **Saves:** UTF-8-encoded pako strings; decode with the game's own `StorageManager` and
  `JsonEx.parse` in the harness (older saves also pass through `ska_migration`).
- **Maps:** 280 tile-only, 39 tiles+parallax, 1 parallax-only. Images are encrypted (`.png_`).
  Templates are only ambient critters. 487 of 498 variable-target transfers go to the recollection
  room.
- **Mod loader** can inject plugins (`Meta.json` `"plugins"`). Runtime is NW.js 0.48.4 (Chromium 85,
  Node 14), so mod code must avoid post-ES2020 syntax.
- **CHANGELOG** has 264 versions with issue refs; diffs can be attached to entries.

## Architecture

### 1. Kernel

- Minimal loaders: System, CommonEvents, MapInfos, Map*, Troops, `plugins.js`, custom JSON (types
  generated from existing schemas). Skip logic-irrelevant files (Tilesets, Animations) until
  needed.
- **Headless harness:** Node `vm` + stubs, sync XHR shim, metadata extraction, seeded RNG. Used to
  run events, evaluate conditions, decode saves, and run the author's tests.
- Optional later: real NW.js driven over the DevTools protocol for full fidelity (battles,
  rendering).

### 2. Event decoder

- Basic blocks and a **control-flow graph** (labels, jumps, loops). Keep an indent tree for
  pretty-printing only.
- Semantic operations per command (`GiveItem`, `SetSwitch`, `Transfer`, `CallCommon`, …).
- Page conditions as guards, with page-priority (later pages hide earlier ones).

### 3. JavaScript and plugin commands

- One table of every JS snippet from all surfaces, with provenance.
- Static footprint (reads/writes) via acorn; **evaluate** conditions in the harness.
- Plugin-command handlers keyed by runtime `registerCommand` names; skeletons from `@command`
  headers.

### 4. Call graph and cross-reference index

- Call graph covering 117, `event.start`, `callLocalEvent`, external self switches,
  `reserveCommonEvent`/teleports.
- **Constant propagation** of variable-passed arguments into CEs (`Obtain_Item`, `Obtain_Gold`).
- Reads/writes per entity (item, skill, switch, variable, CE, map, troop, shop), with location.
- Taint report: which events (transitively) write corruption, lewdness, vice, mental changes,
  lewd-scene switches.
- Storage: SQLite for publishing and UI; in-memory graph or Datalog for recursive queries.

### 5. Day model and reachability

- Model CE11/CE12/Map002: day transitions, per-day resources, deadlines, the Reality clock.
- Requirement slicing (AND/OR trees) with page-priority intervals.
- Mark random vs controllable edges (battles, `Math.random`).
- Eventually: lower bound on days from requirements, a concrete route as the upper bound. Equal
  bounds = proven optimal.

### 6. Outputs

- **Interactive map:** pre-render map images offline with the game's own Tilemap, serve with
  Leaflet or OpenSeadragon, overlay decoded events. No game code ships.
- **Query CLI and web UI** on the index.
- **Walkthrough** with typed references, and a **linter** that replays routes against the model.

## Bootstrapping infrastructure

1. **Pretty-printer** with names and author comments.
2. **Coverage reports:** commands, plugin-command keys and JS snippets understood, ranked unknowns.
3. **Harness REPL:** load a save, do something, diff switches/variables/party/self switches/quests.
   Replaces a separate save differ.
4. **Differential fuzzing:** run CEs and pages from sampled states in the harness and compare
   actual writes with the static footprint. Every mismatch is a decoder bug.
5. **Author's `event_test` maps** as the acceptance suite.
6. **Content coverage oracle:** seen messages vs the static set of all messages.
7. **Version diffing** tied to CHANGELOG entries, with auto-drafted "walkthrough impact" notes.
8. **Stable anchors:** reference things by (map, event id, page, hash of command subtree/text) with
   fuzzy re-matching on update. Command indices shift between versions.
9. **Annotation layer with provenance,** keyed to those anchors so it breaks loudly on change.
10. **Snapshot tests** on pipeline outputs.
11. **Instrumentation mod** for recording real play (routes), not primary ground truth.

Language: TypeScript, so the game's own JS loads directly.

## Order

1. Kernel: loaders and headless harness
2. Pretty-printer and CFG builder
3. Call graph and taint report
4. Coverage report
5. Cross-reference index with argument propagation ("where is item X")
6. Day model, fuzzed against the harness
7. Requirement slicing, then routing bounds
8. Offline map render and public site (can start any time after step 1)
9. Walkthrough linter and instrumentation mod

### First milestone

1. `npm run harness -- ce 16 12`: boot the VM, run `initGame` and `startDay`, print a named change
   log. Mostly done in `experiments/run_ce.js`.
2. `npm run harness -- test Map050`: stub `event_test` plugin runs the InteractionTest cases and
   reports pass/fail.
3. `npm run print -- ce 11`: pretty-print `endDay` with names.
4. One query: writers of V31/V2/V3/V19 (direct and via call graph) as JSON, with a snapshot test.

## Open (deferred) questions

- Route semantics: what each route forbids, NG+ carry-over, adult-content setting, difficulty.
- What breaks ties under "minimize days" (gold, willpower, battle risk)?
- Whether to fetch CGs from the public repo during setup instead of decrypting game files.
