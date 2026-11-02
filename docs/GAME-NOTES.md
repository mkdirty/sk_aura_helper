# Notes on the game

What we've learned about *Star Knightess Aura*'s data, engine and plugins, by topic. Verified
against game version **1.5.0-prerelease-3** (2026-11-02) unless noted. When a game update changes
something here, update it.

IDs follow the tools' notation: `S22` switch, `V31` variable, `CE11` common event,
`Map007/E8/p0#103` (map, event, page, command index).

## Contents

- [Scale](#scale)
- [Engine and plugins](#engine-and-plugins)
- [Event data](#event-data)
- [Control flow and calls](#control-flow-and-calls)
- [Where JavaScript lives](#where-javascript-lives)
- [Variables and state](#variables-and-state)
- [Days](#days)
- [Corruption, lewdness, vice](#corruption-lewdness-vice)
- [Content tracking](#content-tracking)
- [Items, skills and other sources](#items-skills-and-other-sources)
- [Text and languages](#text-and-languages)
- [The author's own tests](#the-authors-own-tests)
- [Assets, saves and other files](#assets-saves-and-other-files)
- [Bugs and quirks in the game](#bugs-and-quirks-in-the-game)

## Scale

- 320 maps, 13,026 map events, 21,280 event pages, 1,100 common events, 1,368 troop pages.
  23,748 command lists, 458,065 commands in all.
- 1,100 switches (621 named) and 1,400 variables (881 named). **Every switch and variable the game
  uses is named** (including script references); all unnamed ones are unused. Names are unique
  apart from one duplicated `-- Mental World` section header.
- Names starting with `--` are editor section headers, not real flags. One is used: V25
  `-- System`, the author's test-chain counter.
- 3,494 script commands, 1,303 distinct. Common shapes are boilerplate:
  `$gameMap.event(N).start()` ×952, `$gameParty._actors=[]` ×393, `_viewedScenes[N]=…` ×494.
- 110 distinct plugin commands (6,543 uses); about 10 cover ~85% of uses
  (`choices::setChoiceOption` ×1626, `setLocalSelfSwitch` ×444, `quests::setObjectiveStatus` ×443,
  `quests::addObjective` ×303, `event_utils::callLocalEvent(Inline)` ×325, …).

## Engine and plugins

- **Live code** is what `js/plugins.js` enables: 147 entries, 143 unique (a `-----------`
  separator entry repeats; an empty file of that name exists). Eight plugin files on disk aren't
  enabled, including `seeded_rng`, so randomness is plain `Math.random`.
- **Plugin-command dispatch** uses only the plugin's file name (`Utils.extractFileName`,
  `rmmz_objects.js:11322`): `auramz/compendium` and `compendium` are the same. Unregistered
  commands silently do nothing (`rmmz_managers.js:3164`).
- **Commands registered conditionally:** analytics commands only when the player opted into
  telemetry. `event_test::*` and `autosave::*` are never registered in the shipped build.
- **Enabled plugins override 7 engine commands:** 101 (CustomTranslationEngine, backlog,
  TemplateEvent, TLB_SKASelectSkill), 102 and 357 (CustomTranslationEngine), 105
  (CustomTranslationEngine, backlog, TemplateEvent), 117 (ska_analytics), 301 (ambush), 352
  (ironman). The disabled MUSH_Audio_Engine would also override 354.
- **Boot:** about two dozen plugins hook `Scene_Boot`. TemplateEvent loads its template map
  there; artifact, passive skills, NG+ skills and others process database notes there. Data
  loading is promise-based: the mod loader loads mods first, then the database, and applies mods
  to each data file and map asynchronously.
- **TemplateEvent:** events with a `<TE:name>` (or `<TE:id>`) note run a template event's data
  from Map223 instead of their own: pages, conditions, triggers, move routes. With this game's
  settings (`AutoOverride`, `OverrideTarget` Image only), only the image is kept from the
  original. 299 events on 46 maps use templates. Mostly ambient wildlife, but they do run logic
  (e.g. bird spawners set their own self switches). A template can still run the event's own pages
  (`getOriginalPages`).
- **GALV_MoveRouteExtrasMZ** adds move-route helpers; `this.sswitch(letter, value, eventId?,
  mapId?)` sets a self switch (default: the moved character's own) and is used in hundreds of
  routes.
- **Constructing actors:** adding actor 1 to the party before she has been constructed recurses
  forever (MPP_CharacterMake's actor setup refreshes the player, which reads the party leader, so
  actor 1 is constructed again). The game always touches the actor first.
- **Mod loader** can inject plugins (`Meta.json` `"plugins"`). Runtime is NW.js 0.48.4
  (Chromium 85, Node 14), so mod code must avoid post-ES2020 syntax.
- `ska_dayphases.js` is only a UI window (see [Days](#days)).
- `ska_mental.js` scans maps at runtime for corruption-gated `choices::setChoiceOption` commands to
  enumerate mental changes, which confirms that convention.
- `ska_migration.js` (`$.version = 110`, ~100 `MigratorNToN+1` classes citing issues) documents
  save-state changes between versions.

## Event data

- **Blocks are delimited by indentation alone** in the engine (`skipBranch` skips while the next
  command is deeper). The editor's code-0 end-of-body markers and closers (412, 404, 413, 604,
  409) are cosmetic. Map271/E28 is missing a 412 and runs fine.
- **109 "Skip" is a block** (109 … 409) whose body never runs: the editor's way of commenting out
  code (e.g. CE163, CE308, CE574). Writes inside it never happen.
- **Labels and jumps cross block boundaries:** 491 labels, 604 jumps, 84 loops. Map265/E8 jumps
  into a choice branch. CE11 has two `END_DAY` labels, one alone inside a nested `if`.
- **Page priority:** the highest-numbered page whose conditions hold runs, so content on lower
  pages becomes unreachable once a later page's conditions are met.
- **Autonomous move routes:** 1,356 pages have a custom movement route (`page.moveRoute`) that runs
  outside any command list: scripts, switch steps, GALV `sswitch` calls.
- **Map158/E1 `PROTECTED_SI_FROM_EXCLUDE`** is not logic: 394 two-parameter Show Picture commands
  (no `indent` field) listing images, presumably so deployment doesn't exclude them as unused.
- 1,234 comment commands (108) carry the author's own explanations (e.g. "Variable 28 contains
  the ID of the harvest item"); the printer shows them as `#` lines.
- Map events' notes carry tags (e.g. `<TE:…>`). The decoder covers all commands with 0 gaps.

## Control flow and calls

- **Common events act like functions with arguments in variables.** Items are mostly granted via
  `V651 = amount; V650 = item; call CE785 Obtain_Item` (338 calls; only 192 direct `Change
  Items`). Helpers: CE785 `Obtain_Item`, CE786 `Lose_Item`, CE787 `Obtain_Gold`, CE788
  `Lose_Gold`. CE785 gives `V651` if it's > 0, else 1.
- **Arguments get copied:** e.g. harvest nodes call CE206 `Harvest_Ether` (sets `V28 = 203`,
  `V30 = 10`), which calls CE204 `Harvest` (`V650 = V28`), which calls CE785.
- **Callers set up arrays too:** many scene common events expect `V566 lewdTags = []` (or similar)
  from the caller first, so they can't run standalone. The same goes for the recollection room's
  scene pages (Map074, page 2 of E109 onward), which call `.forEach` on a variable their entry
  point fills in.
- **Call edges beyond 117:** `$gameMap.event(N).start()` (952), `event_utils::callLocalEvent` /
  `callLocalEventInline` (325), `$gameTemp.reserveCommonEvent`, compendium fast travel
  (`teleportCE`, 16 locations with `shrineCondition`), item and skill effects that run a common
  event (425), obstacle choices (`showChociesForObstacle` runs a common event).
- **`callLocalEventInline` runs the called page as the calling event** (`setupChild(list,
  inline ? eventId : parentEventId)` with `inline = false`); `callLocalEvent` runs it as the called
  event. The names are the reverse of what you'd guess. Every `loot_*` event delegates to a shared
  page this way, so the shared page's `self A = ON` switches the *caller*.
- **Self switches inside common events** refer to the calling map event.
- **Switch-gated parallel common events:** CE3 `addCollar` (S22), CE26 `manageCursedState` (S25),
  CE842 `AirDamage` (S68).
- **Variable-target transfers:** 487 of 498 go to the recollection room (V640 `recollectionMap`).

## Where JavaScript lives

- Script commands (355/655), script conditions (111) and operands (122).
- Move-route scripts, in commands and in autonomous routes.
- Plugin-command arguments: choice conditions (`setChoiceShowCondition` ×176 …), shop unlock
  conditions, discounts, quest/template format params, `createChoice`.
- Note tags (`<enable condition:>` ×87, `<meetsUsableItemCondition:>` ×28, `<idkcheck:>`).
- `Compendium.json` (273 `$game…` refs, incl. `shrineCondition`/`teleportCE`), `Troops.json`
  (684), `Items.json` (195), `Skills.json` (214).
- `$gameExpressions` (game_expressions plugin parameters), inline text `\js<…>` (205), plugin
  parameters evaluated by TextScriptBase.
- Some scripts loop over constant arrays, e.g. Map022/E21 `setup_control_crystals` sets 6
  switches and 8 self switches of events on other maps via `for (const key of keys)`, then
  restores them.
- Some scripts compute ids through plugin code at runtime (e.g. CE23's sensitivity variables come
  from `Window_AuraSexual.prototype.makeSensitivityVariables()`).

## Variables and state

- Variables hold more than integers: arrays (`.push`, tag lists like `"orgasm:N"`), strings
  (V93 `lostVirginityTo == "None"`), objects (V30 mentalAction).
- Quest state lives in `$gameQuests._data[q]._objectives[o]` (62 quests in `Quests.json`).
- Self-switch keys are stringified by the engine, so `[198, "21", "B"]` (string event ids from
  plugins) and `[198, 21, "B"]` are the same switch.

## Days

- The day counter is **V31**, incremented in exactly one place: CE12 `startDay`. CE12 is called
  from CE20 `startMainGame` and Map002/E1 `rl_end`.
- CE11 `endDay` has 208 calling events. It moves the player to Map053, removes party members,
  resets per-day flags, runs end-of-day progress, and applies passive corruption.
- Per-day resources: willpower V10 resets to V11 `maxWillpower`; flags like S704
  `brothelWorkedToday`, S46 `dayStartEventSlotAvailable`.
- Deadlines are stored as day timestamps (V701+ block, e.g. `trademondDaysPastDeadline`,
  `dayLastGeneralKilled`).
- The Reality (Earth) phases have their own clock (V33 `timeSlot` on Map002).

## Corruption, lewdness, vice

- **Corruption (V2) rises passively** in `endDay` (V32 `dayCorruption` = day mod 2, V571
  `corruptionSpeed`; adjusted by difficulty V624) and is **spent** (CE8 `checkAutoCorrupts`:
  "-3 Corruption" to buy a mental change). 296 direct writes.
- Lewdness (V3) and vice (V19) are funneled: 129 events call CE23 `onLewdAction`, 77 call CE10
  `onViceAction`; V3 has only 6 direct writes.
- Mental-change choices are corruption-gated choice options (`$gameVariables.value(2) >= N`).
- `initGame` (CE16) sets the corruption parameters: V14 `maxCorruption` 25, V568
  `collarCorruption` 4, V569/V570 lewd/vice corruption 1, V571 `corruptionSpeed` 1.
- Adult content: S9 `adultContent` is set from the config option by
  `adult_content_option:readAdultOption` (194 uses).

## Content tracking

The game already records what the player has seen, which a "see all content" route can use:

- `save/seenMessages.rmmzsave`: a global, cross-save set of seen messages keyed by
  `[mapId, eventId, page, cmdIndex]` (map), `[troopId, page, idx]` (troop) or `[ceId, idx]`.
- `$gameSystem._viewedScenes` (494 writes) and Map119 `EarthRecollectionRoom` (403 events, a
  scene index).
- 62 quests, 48 Steam achievements, compendium `revealTrait` / `addBossKill`.

## Items, skills and other sources

- Sources beyond events: class skill learnings (`Classes.json`), item/skill effects (learn skill
  ×48, run common event ×425, add/remove state), skill-granting traits (actors, classes, states,
  an enemy), enemy drops, shops (incl. conditional goods).
- **Books** (`auramz/books.js`): 40 items with `<book:true>`. Each needs `<readings:N>` sessions
  (plus the actor's extra readings). Finishing one runs `completeSkillBook` (`<skillId>`, plus
  `<forgetId>` for the previous rank, e.g. book 453 swaps Offensive Stance I → II) or
  `completeStatBook` (`<statplus:["mat:2"]>`; `"wp"` adds to V11 willpower instead of a
  parameter). Lewd books (`<lewdmin>`) have neither tag. `<idkcheck>` is a JS prerequisite (e.g.
  The Art Of Fire is blocked while `getSkillRank(25) == 0`: skill 25 "-- Fire" is the rank family
  header, so any rank of Fire unlocks it).
  - **Aura** reads by using the item at home: CE607 statBooks / CE608 skillBooks, one reading per
    day (ends with CE11 `endDay`).
  - **Companions** (actors 2, 3, 4, 16) are gifted a book at Map007 "Gift Item" (CE882 sets
    `currentBook` and *loses the item*), then progress nightly through CE883 → `books:readBook`.
    The registered `books:assignBook` is never used.
- **Crafting** (`TLB_SKACraftMenu:openScene`, 4 places: Map009/E1 alchemist, Map181/E4 Louise
  (general shop), Map218/E6 (artifact workshop), Map226/E4 (elixir alchemist)) doesn't give the item. Each craft loses the ingredients and adds the
  recipe quantity (or the efficiency variable, if larger) to a **stock variable**, which that
  merchant's shop sells from. The success switch turns on after any craft.
  `openSceneDatabase` and the formula database are unused.
- **Unmodelled sources:** the blessing menu, NG+ skill carry-over.
- Example, **Fire I (skill 26):** learned at Map007/E8 `charlotte`; **forgotten** at Map007/E11
  and Map209/E35 (probably the upgrade to Fire II); learned at level 1 by classes 3 "Mage",
  15 and 23 (fire slimes). A lewd variant exists (712 "Fire II (Lewd Knowledge 20)"). So
  "earliest skill" questions need an actor, learned-vs-has, and must allow skills to be lost.
- Example, **Ether (item 203):** 90 harvest nodes (CE206) and 11 large ones (CE227), chests,
  corpses, and using the Engagement Ring item (CE147 `breakEngagementRing`).

## Text and languages

- `data/*.json` holds the EN text inline: EN is CustomTranslationEngine's base language
  (`BaseLanguage: "EN"`, `ExportBaseOnLaunch`), and `languages/EN/` is an export of it, not loaded
  when playing in EN.
- Translation keys in `languages/*` (`events.{id}.pages.{p}["message-N"|"choice-N"]`,
  `Variables.json`, `Speakers.json`, `AllPlugins.json`, `Extra.json`) are what per-language
  references would resolve against. Some CTE text is conditional on game state.

## The author's own tests

- Map019 "Test" is a hub: CE5 `startTest` (autorun on S2) saves the position and moves there; its
  E9 `automatic_tests` (S3 `automaticTest`) visits Map020 (battle tests) then Map050 (interaction
  tests). Tests are autorun events chained through V25.
- The `event_test` plugin isn't shipped; its commands (`start`, `assertTrue`, `assertEquals`,
  `pressButton`, `success`) and helpers (`valueOfSwitch`, `valueOfVariable`, `hasSkill`,
  `numItems`) are reconstructed in the harness. All 7 Map050 tests pass there; Map020's needs
  battles.
- Tests assume a game in progress (Aura in the party; `initGame`'s values, e.g. collar corruption 4).
- Map012 "Palette" and Map019/020/050 are dev maps; CTE's export ignore list skips them too.

## Assets, saves and other files

- Images and audio are encrypted (`.png_`, `.ogg_`; `hasEncryptedImages`). Maps: 280 tile-only,
  39 tiles + parallax, 1 parallax-only.
- Saves are pako-deflated JSON written as UTF-8-encoded binary strings; decode with the game's own
  `StorageManager` + `JsonEx.parse` (older saves also pass through `ska_migration`).
- Schemas exist in `game/schemas/` (quests, compendium, pixel animations, mod meta, plugin).
- `CHANGELOG.md` has 264 versions with issue refs.
- Licensing signals: `package.json` says `CC BY-NC-SA 4.0`, the EULA forbids redistribution, the
  auramz plugins are MIT. The author's permission for this project is recorded in
  [DECISIONS.md](DECISIONS.md).

## Bugs and quirks in the game

- **Troop245 page 1 calls `ska_compendium::revealTrait`**, which no plugin registers (every other
  use is `compendium`), so enemy 112's "sluggish" trait is never revealed in that fight. Not yet
  reported to the author.
- `selfswitches_utils:setExternalSelfSwitchRange` loops from the string argument
  (`for (let i = args.fromEventID; …)`), so the first key has a string event id. Harmless, since
  keys are stringified.
- `auramz/autosave::autosaveNow` (3 uses) has no plugin; it does nothing.
- Map271/E28 is missing a 412 closer (harmless; see [Event data](#event-data)).
