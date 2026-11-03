# Phase 6 plan: control-flow graph and requirement tracing

> **Status: agreed (2026-11-02).** Written by a planning subagent. The open questions (8.2) are
> answered in DECISIONS "Query defaults for `needs`", and the proposals (8.3) are adopted in
> DECISIONS "How the graph is built and answers are given". Where they differ from this plan
> (configuration left open, not assumed ON; Erase Event means once per map visit), DECISIONS wins.
> Line numbers cite the code as of commit `5df4220`.

This plan is based on reading the docs, all of `src/` and `test/`, the engine (`game/js/rmmz_objects.js`) and the relevant plugins, plus read-only runs of `where`, `print` and small `node`/`tsx` scans over `game/data`. I changed no files. Example CLI outputs in section 4 are mock-ups: every fact in them was checked against the data, but the formatting is a proposal.

---

## 0. Summary

The graph should be built in five layers on top of what exists, each usable and testable on its own:

1. **Per-list CFG.** Nodes are raw command indices. It follows the engine's own jump, branch and loop semantics, and is checked against interpreter traces from the harness.
2. **Typed condition language.** Event conditions, page conditions, choice enable/show conditions, and JS conditions (note tags included) are translated by pattern into atoms. What can't be translated becomes explicit `opaque` or `untracked` atoms.
3. **Path conditions.** Each site gets the condition that must hold on the state at list entry. Simple assignments are substituted through, so conditions on scratch and argument variables like V36/V650 turn into real requirements.
4. **World graph.** Entries (pages with priority and trigger, common-event callers, item and skill use, transfers, battles, shops, fast travel, database rows) plus **rules**. A rule is one indexed write together with its guard, its per-run cost and its execution budget.
5. **Query engine.** A delete-relaxed reachability fixpoint over the rules (classical relaxed planning, with value-level facts for quest-stage variables and execution budgets for one-shot pages). Backward extraction from it gives "what do I have to do to achieve X". A separate threat analysis over the ignored deletes gives missability and the taint report.

The headline command is `npm run needs -- <goal>`. It prints numbered ways, best first. Each step cites `Map/E/p#idx`, the page conditions, the choice taken and any assumptions, and the same result is available as JSON with typed references for the site and walkthrough.

---

## 1. Purpose and the questions to support

### 1.1 Questions, with real chains from the data

**Q1: "When's the earliest Aura can learn Fire I (skill 26)?"** `where skill 26` lists one in-playthrough event learn: `Map007/E8/p0#103` (Charlotte). The chain behind it shows what the graph has to represent:

- **Page 0 of Map007/E8** runs on action button when `V192 charlotte >= 4`. Page 1 (`S181 homewreckingVice is ON`, empty) has priority over it (`Game_Event.findProperPageIndex`, rmmz_objects.js:9327).
  - S181 is turned ON at 3 sites and OFF at 3 sites (Map007/E42/p3#451, Map016/E24/p1#508, Map179/E2/p2#61). So it **blocks Fire I temporarily, not permanently**.
- **Inside the page:**
  - choice 0 "Learning Magic.";
  - `if V192 >= 23` → `if S702 enrolledMagicAcademy` else exit. This is a disjunction: `V192 < 23 ∨ S702`.
  - `js($gameParty.leader().getSkillRank(25) == 0)`. skill_rank.js:58 and `maxSkillRank` = 3 mean "the leader knows none of skills 26–28".
  - `choices::setChoiceOption(0, "$gameParty.leader().mp >= 10")`: the MP stat isn't tracked.
  - choice "Learn Fire I. (MP ≥ 10)" → learn → `call CE11 endDay`, so this step ends the day.
- **How `V192 >= 4` is reached** (a quest-stage variable written by `+= 1` under `==` guards and by `= const`):
  - Guild Clerk Map007/E2/p0#48: `V182 adventurerGuild = 1`. Page 1 (`V182 >= 1`) then hides page 0, so it is one-shot by priority.
  - Map011/E2 "spiderqueen" p0 (event touch): battle with troop 3 "Young Spider Queen". On win: `V182 += 1`, `V192 += 1`, self A ON. Page 1 `when self A` makes it one-shot.
  - CE146 endOfDayEventProgress (run at end of day):
    - `if V182 >= 2: if V192 == 1: V192 += 1; V193 charlotteJailDays = 15`;
    - later in the *same run*: `if 2 <= V192 <= 3: V193 -= 1; if V193 == 0: V192 = 4`.
    - So it takes **15 end-of-day runs** after the battle, and the first decrement happens in the same run that sets 15. Getting that count right depends on ordering within the list.
- **Other ways:**
  - `CE20#15` NG+ carry-over (a playthrough boundary).
  - Class learnings for classes 3/15/23. Class 3 "Mage" is Charlotte's class (Actors.json: actor 2 → class 3), so these don't apply to Aura. Skill goals therefore need an actor.
  - 4 dynamic skill writes, which must be reported as not followed.

**Q2: "What does The Art Of Fire (skill 505) need?"**

- **Item 456** (`<book:true><readings:5><skillId:505><idkcheck:$gameActors.actor($gameVariables.value(36)).getSkillRank(25) == 0>`) has item effect common event 608.
- **CE608 skillBooks** gates the reading with:
  - `V254 rampagingGolem` not in 100..200;
  - book progress (plugin state);
  - `if js(eval($gameParty.lastItem().meta.idkcheck))` → refuse. V36 = 1 was set just before, so this means "Aura has no Fire rank".
  - `if js($dataMap.meta.home)`: only Map005 AbandonedShrine has `<home>`.
  - CE605 → `S12`;
  - a choice whose enable condition is `$gameParty.lastItem().meta.yescondition ? eval(…) : true`;
  - progress `V30` per session (CE609, reading speed: untracked);
  - each session runs `CE11 endDay`.
- **Getting the book:** Map137/E43 "corpse_book" p0 (`V651=1; V650=456; call CE785`, then self A, so one-shot). Map137 is entered from Map133 E21/22/23/42 (player-touch doors), Map138/E35 and Map176/E30–31.
- **Second way:** gift the book to a companion (CE882 Gift_Item, which also evaluates `idkcheck` with V36 = that companion, and *loses the item*), then nightly CE883 → `books:readBook`.
- **Needed from the graph:** context binding (`lastItem` = 456), note-tag JS, map-note predicates, untracked plugin state and repetition.

**Q3: "What unlocks Map137 Underground?"** Transfers into it (9 constant ones) and the requirements of the pages that perform them, recursively back to the start map. 497 variable-target transfers (mostly V640 recollectionMap) must be resolved through value sets or reported.

**Q4: "Is X missable, and what makes it so?"**

- Charlotte's Fire I is *temporarily* blocked while S181 is ON.
- Map137/E43 is a *one-shot* pickup (self A). Gifting item 456 *consumes* it (CE882 loses the item).
- Lower pages hidden by monotone higher-page conditions are the real "missables".

**Q5: Taint ("what writes corruption V2, lewdness V3, vice V19, mental changes").** Map006/E58 "flash_pussy_guard" p0 offers a choice, "Show Pussy." → CE532 or "Leave.".

- In CE532, with `S9 adultContent OFF`, jumps to `EndLewdScene` / `EndLewdScenePink` skip the scene text.
- The writes after the branch still happen unless `S14 recollection` is ON: `gold += 150`, `_viewedScenes[432]`, `S432`, and `call CE23 onLewdAction`.
- So turning adult content off does **not** avoid the lewd action; choosing "Leave." does.
- The jump into the `if S17 extraLewd` block's tail is exactly the case where purely lexical conditions are wrong.

### 1.2 Facts from the inspection that shape the design

| Fact | Consequence |
| --- | --- |
| **Labels and jumps.** 604 jumps; 496 jump to another indent, 189 go backward, 5 go to missing labels (no-op: Map109/E1/p8#335, Map109/E4/p4#134, Map214/E19/p0#338, Map244/E71/p0#58, Map265/E28/p3#663). Duplicate labels in 3 lists (CE11 `END_DAY`, CE1005 `EndLewdScene`, Map175/E22/p0 `PLAYER_DEALER_ROLL`); `command119` takes the **first** (rmmz_objects.js:10144). | The CFG must resolve jumps on the raw list, exactly like the engine. |
| A rough scan finds **~143 jumps that enter a block from outside** (10 in common events: CE155, CE158, CE301, CE532, CE594). | The index's lexical `Guard`s (xref.ts:31–36, 223–231) are wrong after such labels. Call-site instantiation *drops* paths using them (xref.ts:296), which is a soundness risk. |
| 21,280 pages. Triggers: action 16,868, player touch 1,491, event touch 1,067, autorun 1,375, parallel 479. Page conditions: variable 4,371, self switch 4,070, switch1 2,821, item 43, switch2 21, actor 13. 5,537 events have ≥2 pages. | Page priority and one-shot detection matter everywhere. |
| **JS conditions.** 3,490 (script `if` + `setChoiceOption`/`ShowCondition`), 1,513 distinct. About 2,342 (67%) already fit a small grammar (switch/variable values, party items/gold, actor(N)/leader, getSkillRank, hasSkill, stats, `&&`/`||`/`!`/comparisons). The largest leftovers: `battleMemberHasPassiveNoteTag` (124), `BattleManager._preemptive` (75), `$gameQuests._data` (~130), `$gameExpressions.value` (53), `$gameTroop.turnCount` (48), `getSkillRank(var)` (46), `$dataMap.meta.*` (~57). | A pattern translator with an atom catalog is worth building. Evaluating at query time isn't needed. |
| `$gameExpressions` are named JS macros in plugin parameters (game_expressions.js:57). | Expand them inline. |
| Choice conditions are set by plugin commands before the choice and cleared with the message (choices.js:170–198, 277–296). A 101 followed by 102 sets up the choices in the same message (rmmz_objects.js:9797ff). | The CFG binds pending choice conditions to the next choice. |
| **Transfers don't stop the interpreter** (`Game_Map.setup` doesn't clear it, and `command201` waits for the transfer, rmmz_objects.js:10491). `command117` passes `eventId` only while `isOnCurrentMap()` (10124–10130, 9544). 1,646 pages transfer away from their own map; 339 of them then call a common event (the callee has no "this event"), and 13 then use current-map refs (`event(N).start()`, `callLocalEvent`, `setLocalSelfSwitch`) that point at the new map. | Track map context along paths. The index resolves these against the origin map (xref.ts:144, 293). |
| 25 class learnings carry a JS `note` that skill_rank.js evaluates (`applyLearning`, `eval(learning.note)`), e.g. class 3's Fire II learning runs `this.forgetSkill(26)`. database.ts:36–38 ignores them. | A gap in "has skill" answers. |
| Teleport common events (CE901–916) show "not run from any map event": they're started by the compendium menu (`reserveCommonEvent(teleportCE)`, compendium.js:561; availability `shrineCondition`, e.g. `$gameSelfSwitches.value([5,5,'A']) && !$gameSwitches.value(11)`). | "Menu" entries are missing from the graph. |
| **`where --json` truncates at 65,536 bytes when piped** (`where variable 192 --json \| wc -c` → 65536). `console.log` is followed by `process.exit(0)` (where.ts:150–152, also 72–74). | Must be fixed before JSON is consumed by tools. |
| Index: 111,675 refs; live writes 50,804 (variables 32,896, self switches 6,876, switches 5,326, items 1,238, actors 1,056, quests 992, skills 801…), calls 38,954, 7,414 distinct written entities. Build ~2.5–3 s (`where` takes ~3 s wall). | Sizes for the rule table. |

---

## 2. Model

### 2.1 Layers

```text
decoded ops (events/ops.ts) ── effects (analysis/effects.ts) ── index (analysis/xref.ts)   [existing]
        │                                   │
   L1 CFG per list (graph/cfg.ts)           │
        │                                   │
   L2 Cond language + JS translator (graph/cond.ts, graph/js-cond.ts)
        │
   L3 path conditions per site (graph/paths.ts)
        │
   L4 world graph: entries + rules (graph/world.ts)  ← page conds, triggers, calls, transfers, DB, menu
        │
   L5 relaxed reachability, derivations, threats (graph/reach.ts, graph/needs.ts, graph/threats.ts)
        │
   CLIs: cfg, needs, taint, where --guards        harness: interpreter traces + oracles (check/cfg-check.ts)
```

Proposed home: a new `src/graph/`. It reuses `ListSource` (lists.ts:5–11), `Op` (ops.ts:67–108), `Condition` (ops.ts:40–53), `Effect`/`Entity`/`Id` (effects.ts:16–50), `Site`/`Ref` (xref.ts:17–29), `GameData.effectivePages` (game-data.ts:176), `noteMeta` (notes.ts:4) and `analyzeScript`/`expressionId` (script.ts:193, 312).

### 2.2 CFG (L1)

```ts
// graph/cfg.ts
/** Raw command index in the list (= Op.index, ops.ts:62–65; = Site.index). */
export type NodeId = number;
export const ENTRY = -1, EXIT = -2, GAMEOVER = -3;      // GAMEOVER: 353, 354, lose without a branch

export type EdgeKind =
  | "seq" | "then" | "else"
  | "choice" | "cancel"
  | "win" | "escape" | "lose"
  | "jump" | "repeat" /* 413 → 112 */ | "break" | "exit"
  | "call" | "return";                                  // sync calls are summarised, see 3.5

export interface CfgEdge {
  from: NodeId; to: NodeId; kind: EdgeKind;
  cond?: CondId;                                        // if / page / choice-enable (hash-consed, 2.3)
  choice?: { option: number; label: string; enable?: CondId; show?: CondId; isDefault: boolean };
}
export interface CfgNode {
  id: NodeId;
  op?: Op;
  dead: boolean;                                        // inside Skip (ops.ts:78) or unreachable from ENTRY
  scc?: number;                                         // cyclic SCC id (loops, backward jumps)
}
export interface Cfg {
  source: ListSource;
  nodes: Map<NodeId, CfgNode>;
  succ: Map<NodeId, CfgEdge[]>;
  pred: Map<NodeId, CfgEdge[]>;
  blocks: Array<{ start: NodeId; end: NodeId }>;        // basic blocks, for storage and printing
  issues: CfgIssue[];   // "missing label", "duplicate label (first wins)", "break outside loop",
                        // "unreachable code", "jump enters block"
}
```

### 2.3 Conditions (L2)

The language extends `Condition` (ops.ts:40) with atoms the analysis needs, and makes "can't tell" explicit.

```ts
// graph/cond.ts
export type ActorSel = number | "leader" | { var: number };   // {var} resolved by bindings (V36)
export type SiteKey = string;                                  // `${sourceLabel(src)}#${index}` (lists.ts:21)

export type Atom =
  | { k: "switch"; id: number; on: boolean }
  | { k: "var"; id: number; op: Comparison; rhs: number }
  | { k: "varVar"; id: number; op: Comparison; rhs: number }    // V op V
  | { k: "self"; mapId: number | "current"; eventId: number | "self"; letter: string; on: boolean }
  | { k: "count"; item: { kind: ItemKind; id: number }; op: Comparison; n: number; withEquip?: boolean }
  | { k: "gold"; op: Comparison; n: number }
  | { k: "knows"; actor: ActorSel; skill: number }
  | { k: "rank"; actor: ActorSel; family: number; op: Comparison; n: number }   // skill_rank.js:58
  | { k: "state"; actor: ActorSel; id: number }
  | { k: "inParty"; actor: number } | { k: "partySize"; op: Comparison; n: number }
  | { k: "quest"; id: number; objective?: number; status?: number | "added" }
  | { k: "onMap"; maps: number[] }                             // incl. $dataMap.meta.home → [5]
  | { k: "choice"; at: SiteKey; option: number }               // the player picks it
  | { k: "battle"; at: SiteKey; outcome: "win" | "escape" | "lose" }
  | { k: "random"; at: SiteKey; what: string; p?: number }
  | { k: "untracked"; what: string; reads: Entity[] }          // MP, MAT, level, book progress, NG+ picks
  | { k: "config"; what: "adultContent" | "difficulty" | "telemetry"; atom?: Atom } // S9 via readAdultOption
  | { k: "opaque"; js: string; at: SiteKey; reads: Entity[] }; // reads from analyzeScript

export type Cond =
  | { k: "true" } | { k: "false" } | { k: "atom"; a: Atom }
  | { k: "not"; c: CondId } | { k: "and"; cs: CondId[] } | { k: "or"; cs: CondId[] };
export type CondId = number;   // hash-consed table with simplification (absorption, a∧¬a, ordering)
```

### 2.4 World graph (L4)

```ts
// graph/world.ts
export type EntryKey =
  | { k: "page"; mapId: number; eventId: number; page: number }   // effective pages (TemplateEvent)
  | { k: "ce"; id: number }
  | { k: "troop"; troopId: number; page: number }
  | { k: "use"; table: "items" | "skills"; id: number }            // menu/battle use
  | { k: "menu"; what: "teleport"; location: number }              // compendium fast travel
  | { k: "learning"; classId: number; index: number }              // Classes.json learnings (+ note JS)
  | { k: "newGame" };

/** How an entry comes to run. */
export interface EntryEdge {
  entry: EntryKey;
  how: "action" | "touch" | "autorun" | "parallel"   // page trigger (rmmz_objects.js:9400ff, 9448, 9460)
     | "call" | "callLocal" | "start" | "reserve"     // sync vs deferred (3.5)
     | "use" | "teleport" | "levelUp" | "battle" | "boot";
  pre: CondId;                       // page: own conds ∧ ¬(each higher page's conds) ∧ onMap
  from?: Site;                       // the calling site, if any
  bind?: Binding;                    // argument env and context slots at the call (3.5)
  forced: boolean;                   // autorun/parallel/endDay pipeline: the player can't avoid it
}
export interface Binding {
  env: Map<number, Id>;
  lastItem?: number; lastSkill?: number;
  eventId?: number | 0; mapId?: number;
}
```

### 2.5 Facts and rules (L4)

```ts
export type Fact =
  | Atom                                  // state atoms only
  | { k: "reached"; at: SiteKey }         // "scene seen", "this command ran"
  | { k: "runs"; entry: EntryKey };

/** One guarded effect = an action in the planning sense. */
export interface Rule {
  ref: Ref;                               // xref.ts:26 (effect + site incl. via chain)
  establishes: Fact[];                    // from the effect's structured value (5, upgrade U2)
  falsifies: Fact[];                      // deletes: OFF, forget, lose, = other value
  transition?: { var: number; from?: ValuePred; to: number | { add: number } };
  pre: CondId;                            // local path condition at the entry state (L3), args bound
  entry: EntryKey;
  budget: 1 | "many";                     // one-shot by page priority/self switch/erase (3.7)
  cost: Cost;                             // per application
  tags: { endsDay?: true; forced?: true; random?: true; battle?: true;
          taint?: Array<"corruption" | "lewdness" | "vice" | "mental">; ngplus?: true };
}
export interface Cost { days: number; battles: number; random: number; assumed: number; actions: number }
```

**Variable domains.**

- *Scratch/argument variables* get no global facts. A variable counts as scratch when every read of it, in every list, is dominated by a write in that list or bound by the caller. Examples: V36 tmp, V650/V651, V625. This is derived from the CFG, in line with DECISIONS "Scratch and argument slots aren't global symbols".
- *Stage variables* (finite value sets from `=` const and guarded `+=`) get value-level facts `V192=k`.
- Everything else gets intervals.
- Non-integer variables (arrays, strings, objects: GAME-NOTES "Variables and state") are opaque.

### 2.6 Query results (L5)

```ts
export interface Goal { fact: Fact; actor?: number; label: string /* "{{skill:26}} for {{actor:1}}" */ }
export interface Way {
  rule: Rule | EntryEdge;
  cost: Cost;
  needs: Need[];
  assumptions: Atom[];          // untracked/opaque/config atoms taken as satisfiable
  threats: Threat[];
  steps: Step[];                // player-facing linearisation
}
export interface Need {
  goal: Goal;
  status: "initial" | "derived" | "assumed" | "unknown" | "unreachable";
  ways: Way[];                  // best first, truncated (--ways)
  ref?: string;                 // "(see 1.2)" for shared subgoals
}
export interface Threat { kind: "blocks" | "hides-page" | "consumes" | "forgets"; by: Rule; permanent: boolean }
export type Step = {
  kind: "go" | "talk" | "touch" | "choose" | "battle" | "use" | "buy" | "endDay" | "wait" | "have";
  ref: string;                  // typed refs: {{map:7}}, {{event:7:8}}, {{site:Map007/E8/p0#103}}
  text: string;
  at?: { mapId: number; x: number; y: number };
};
```

---

## 3. Algorithms

### 3.1 CFG construction

The CFG is built from the decoded tree (`decodeList`, decode.ts:114) plus the raw list for label and loop scans. It works continuation-passing, back to front: `build(body, succ)` returns the entry node of `body`. Node ids are raw indices, so jump targets in other bodies need no second pass.

**Edge rules**, each tied to the engine code it follows:

| Op | Edges | Engine |
| --- | --- | --- |
| `if` | `then` → build(then, succ) with c; `else` → build(else, succ), or succ, with ¬c | 111 sets `_branch`, skipBranch; 411 (9927, 10077) |
| `choice` | one `choice` edge per branch to build(body, succ). Cancel: if `cancelType` maps to an option, that option; if -2, the 403 branch; if -1, no cancel | 102/402/403 (9829–9866) |
| branch end | → succ (after the construct) | the next 402/403/411 marker skips (see the claim below) |
| `loop` | head(112) → build(body, head); 413's `repeat` → head | 112/413 (10086–10096) |
| `breakLoop` | to the index after the matching 413, found by **scanning the raw list forward and counting 112/413 codes**, not by indent; scanning to the end means EXIT | 113 (10098) |
| `jump` | to the **first** label with that name in the raw list, else fall through (issue "missing label") | 119 (10144) |
| `exitEvent` | → EXIT | 115 (10118) |
| `battle` | `win`/`escape`(canEscape)/`lose`(canLose) → bodies; no branches → succ, plus `lose` → GAMEOVER (game-specific handler, tagged) | 301/601–603 (10933–10975) |
| `skip` | node → succ; body built but `dead` | 109 (decode.ts:255) |
| 353/354 | → GAMEOVER | |
| `transfer` | seq, plus a *map-context change* annotation (3.5) | 201 (10491) |

**Claim to verify:** after a jump into a branch body, falling off its end leaves the construct. `jumpTo` (10156) resets `_branch[indent]` for every indent crossed between source and target. Afterwards:

- 402 skips because `null !== n`;
- 403 skips because `null >= 0` is true in JS;
- 411 skips because `null !== false`;
- 601–603 skip.

So "end of branch body → after the construct" holds for jumps too. Entering a branch body by falling through a marker is impossible, because a marker is only reached by falling off a sibling body or right after its opener. The harness trace check (6.3) tests this claim on every executed jump.

**Post-pass:**

- reachability from ENTRY ("unreachable code" issues, e.g. code after `jump to "present"` in Map265/E8, or CE11's second `END_DAY` label as a jump target);
- Tarjan SCCs (loops, backward jumps such as Map265/E8 "beginning");
- dominators and post-dominators (Cooper–Harvey–Kennedy). Taint and "unavoidable" need these.

**Choice-condition binding.** Walking straight-line code, keep a pending map `option → {enable, show, alt}` from `choices:setChoiceOption` / `setChoiceShowCondition` (and `createChoice`). Attach it to the next `choice` op. Clear it at any other text message that isn't the choice's own 101, mirroring `Game_Message.clear` (choices.js:170). `setHideSingleOptionChoices` marks the choice "auto when only one is visible".

**Complexity:** O(n) per list, plus O(n) per break/jump scan (bounded by list length). About 458k nodes and ~500k edges in all.

### 3.2 Page, trigger and scheduling semantics

- **Page active:** `act(p) = conds(p) ∧ ⋀_{q>p} ¬conds(q)`, per `findProperPageIndex` (9327) and `meetsConditions` (9338).
  - Page condition encodings: switches ON, `variable >= value`, self switch `=== true` with key `[this._mapId, this._eventId, ch]`, `hasItem` (items only), actor in party.
  - Templated events use the template's pages (`effectivePages`).
  - Erase Event (214, rmmz_objects.js:10627) makes the event pageless until the map reloads. Tag the rule `budget 1 per visit`.
- **Triggers:** 0 action and 1/2 touch are *player* entries (need `onMap(m)`, the tile is assumed reachable; tiles are phase 9). 3 autorun is *forced* once `onMap ∧ act`, and repeats until it disables itself. 4 parallel is *forced*, may run at any time while active, and has its own interpreter (9460).
- **Scheduling order**, for "forced before player can act":
  - `setupStartingEvent` (6821): reserved common events, then starting map events in event-id order (6847), then autorun common events (6858).
  - Parallel common events while their switch is ON: CE3/S22, CE26/S25, CE842/S68 (`Game_CommonEvent.isActive`, 6905).
  - Autorun common event CE5/S2 (dev).
- **Troop pages:** need "in battle with troop T". Their conditions (turn, HP, switch) are mostly `untracked`; the switch ones are typed.

### 3.3 Path conditions (L3)

The goal is, for every node n, `PC(n)`: a necessary condition on the state at list entry (plus choice, random and battle atoms) for n to execute.

1. **Process nodes in topological order** of the DAG left after removing SCC back edges. Carry a **symbolic store** σ: var → `const c | entry(V)+k | copy | gameData(actor stat → untracked) | random(min..max) | opaque@site`. This generalizes the index's `Env` (xref.ts:88, 201–216), which only knows constants and copies.
2. **Edge conditions** go through σ:
   - `if V192 >= 5` after `V192 += 1` becomes `entry(V192) >= 4`;
   - `if V36 >= 3` after `V36 = actor 2 level` becomes `untracked("actor 2 level") >= 3`;
   - a decided constant turns the edge into true/false (dead edge).
3. **At joins:** `PC = ⋁ preds (PC(p) ∧ edge)` in the hash-consed table, with simplification. Factoring out shared conjuncts keeps formulas small. Where σ differs between predecessors, the variable becomes `opaque@join` (it doesn't matter later unless read).
4. **Caps:** if a formula exceeds N atoms (proposed 64), fall back to the conjunction of conditions on **dominating** edges. That is still a necessary condition; the site is flagged `simplified`.
5. **SCCs:** at SCC entry, every variable written inside the SCC is havocked. Conditions on them inside the SCC are dropped (weaker, still necessary) and flagged `approx: loop`.
6. **Map context:** a `transfer` sets `mapCtx` to its target. Later `current`-map references and `callCommon` bindings (`eventId: 0` once off the origin map, 10124) use it.

Cost is O(n · |σ-live|) per list with hash-consing. The estimate is low seconds for the whole project, to be measured in milestone M4.

### 3.4 Interprocedural handling and context slots

- **Sync calls** (117, `callLocalEvent[Inline]`, the `obstacles_choices` common event): a summary edge `call → return`. The callee's rules are instantiated per call site with a `Binding` (env and context).
  - This generalizes `instantiateCalls` (xref.ts:288) from "fill in symbolic ids" to "fill in symbolic ids **and** guards", using CFG path conditions instead of lexical guards.
  - The callee can't jump into the caller, so the summaries are exact for control.
- **Deferred calls** (`reserveCommonEvent`, `$gameMap.event(N).start()`, item/skill common-event effects, `teleportCE`): entry edges with *no* path env (as xref.ts:196–197 already does). The target page of `start()` is "whichever page is active then".
- **Context slots** (`Binding.lastItem`, `lastSkill`, `eventId`, `mapId`):
  - an item's common-event effect binds `lastItem = item`;
  - `$gameTemp.setLastUsedSkillId(N)` before the bless menu binds `lastSkill` (fixes the open item "Blessing call sites over-approximate");
  - 117 after a transfer binds `eventId = 0`.
  - The translator turns `$gameParty.lastItem()` into `ctx.lastItem`, and `eval(<ctx>.meta.T)` into "parse the note tag T of that item as JS", recursively.
- **Requirements of common-event sites are never materialized per site.** `runs(ce)` is a fact whose establishers are its entry edges. The fixpoint (3.7) handles the 410 entry points of CE146 or the 208 callers of CE11 with no blow-up.

### 3.5 JS condition translation: what the graph must understand

Translation is by AST pattern with acorn (already a dependency; same style as script.ts:193), never by evaluation:

- **Atom catalog:** `$gameSwitches.value(N)`, `$gameVariables.value(N)` (and as the RHS), `$gameSelfSwitches.value([m,e,'A'])`, `$gameParty.numItems/hasItem($dataItems[N])`, `$gameParty.gold()`, `$gameParty.members().length`, `$gameParty.inBattle()`, `$gameActors.actor(N|V)` / `$gameParty.leader()` with `.getSkillRank(F)` (with `maxSkillRank` from plugin params = 3), `.hasSkill/.isLearnedSkill(N)`, `.isStateAffected(N)`, stats (`untracked`), quest status (`$gameQuests._data[q]…`, `QuestManager.getObjectiveStatus`), `$gameExpressions.value("x")` (expanded), `$dataMap.meta.T` (becomes `onMap(maps with <T>)`), `$dataActors[...]`/`$dataSkills[...].meta` (static lookups).
- **Everything else** becomes `opaque` with the `reads` from `analyzeScript`, so the search can still say "depends on S22 in a way we can't translate".

Note-tag and other inputs, by priority for the target questions:

| Input | Needed for | Plan |
| --- | --- | --- |
| `<idkcheck>` (books), `<yescondition>` | reading a book (Q2), companion gifts | translate, via the `lastItem` context and V36 binding |
| Choice enable/show conditions (×3,490 incl. `if` scripts) | almost every requirement and mental-change gate | translate; bound to choices (3.1) |
| Compendium `shrineCondition` / `teleportCE` | map reachability by fast travel | translate (simple atoms); new `menu` entries |
| `conditional_goods:setUnlockCondition` | shop availability | translate |
| Class learning `note` JS (25) | skill gains/losses at level up | index as effects (upgrade U5) |
| `<enable condition:>` (skills ×87), `<meetsUsableItemCondition:>` (×28) | using skills/items from the menu | translate the simple ones; the rest (mostly battle: troop/states) as opaque |
| `\js<…>` text escapes, alternate texts | display only | ignore (listed as not needed) |

**Harness evaluation** is the test oracle (6.4), not a query-time mechanism. It keeps queries static and fast, and it checks the translator rather than trusting it.

### 3.6 From effects to rules

- **One rule per live write ref.** The fact view comes from the structured effect value (U2): `switch = ON/OFF`, `var = c / += d / -= d / = V / random / opaque`, `gain/lose n`, `learn/forget (actor)`, `self = ON/OFF`, `quest status`.
- **Book completions** are attached to the `completeSkillBook` / `completeStatBook` script sites in CE607/CE608 (Aura) and `books:readBook` in CE883 (companions) with the `lastItem`/V36 bindings, not only to the database row (database.ts:83). Otherwise their guards are invisible.
- **`budget`:**
  - 1 if every path from the page entry through the site reaches a write that makes a higher page's conditions *exactly* true (typically `self X = ON` with page q `when self X`), or falsifies `conds(p)` (e.g. the Guild Clerk's `V182 = 1` against page 1 `V182 >= 1`), or runs Erase Event;
  - otherwise `many`.
  - A conservative test, checked on the post-dominator tree.
- **`cost`:**
  - `days += 1` if the rule's entry is the end-of-day pipeline (reached only through CE11), or a call to CE11 post-dominates the site in its list (Charlotte: learn → `CE11 endDay`);
  - `battles` for win edges; `random` for drop or `random` operands; `assumed` per untracked or opaque atom; `actions` per player choice or interaction.
  - The phase 7 day model replaces `days`.
- **Value transition graphs** for stage variables: nodes are values. `= c` edges come from anywhere; `+= d` under a guard `V == v` is an edge v→v+d; an unguarded `+= d` with budget 1 is a *budgeted increment* (usable once along a derivation); a repeatable increment is unbounded (widened to an interval). The V193 countdown is 15 edges, each needing one `runs(CE146)`, so 15 days.

### 3.7 "Achieve X": relaxed reachability, then backward extraction

The game is treated as a planning problem: facts, and rules as actions with preconditions `pre ∧ entry-runs ∧ transition-from` and positive effects `establishes`. Deletes are ignored (*delete relaxation*).

1. **Forward fixpoint** (Knuth's generalization of Dijkstra over AND/OR graphs; equivalently h_add/h_max from relaxed planning). Initial facts come from the new-game state (all OFF/0, System.json start map, actors' initial classes and skills). The intro autoruns (Map001/E1 → CE16, CE20) are ordinary forced rules.
   - Cost of a rule application = `rule.cost + combine(pre costs)`. Use `max` for h_max (admissible: a real lower bound that phase 8 can use) and `sum` for h_add (ranking and plan extraction).
   - **Cycles are handled naturally**: V192 depends on V192 through value nodes, and pending facts have cost ∞ until established.
   - Budgeted increments are enforced in value-domain propagation (a subset-sum over one-shot increments; small per variable).
   - The whole game is computed once and cached (3.10).
2. **Answering `needs X`:** pick the rules that establish X (looked up by entity; `XrefIndex.find`, xref.ts:340), rank them by cost, and recursively **extract the best supporting derivation** (like relaxed-plan extraction). Each extraction step reports:
   - its page/entry requirement (including the "higher pages inactive" negations);
   - its path condition, as player-facing choices and branch facts;
   - subgoals, expanded to `--depth`, with shared ones printed once and referenced;
   - assumptions (untracked or opaque atoms), and alternative ways (`--ways`).
3. **Disjunction** is native: OR nodes are ways, and in-list disjunctions (`V192 < 23 ∨ S702`) are kept as formulas and shown as "either … or …".
4. **Unknowns and honesty:**
   - Writes with unknown ids (`{unknown}`, `{var}` left unresolved; e.g. "+19 references to item ids that aren't constant") are "maybe" rules: never used in the best derivation, always counted in a footer.
   - Value-set analysis (U9) resolves many of them to finite sets (V640's constant assignments, for example).
   - "Unreachable" is only claimed when no maybe-writer and no opaque atom is involved; otherwise the answer is "not found (n unknowns)".
5. **Monotone vs non-monotone:** a fact is monotone if no rule falsifies it (S with only ON writes, a variable with only increasing writes). Answers about non-monotone requirements carry their threats (3.8). Real ordering is phase 8's job, and the output says so.

**Complexity:** facts are on the order of 40–60k (bools ×2, value facts for stage variables, self switches, `runs`/`reached` for rule entries), with ~50k rules plus ~40k entry edges and Σ|pre| in the low hundreds of thousands. A heap-based fixpoint is O((F + Σ|pre|) log F), well under a second. Extracting a derivation afterwards takes milliseconds.

### 3.8 Missability and threats

For each way W of X, its **killers** are:

- rules that falsify a fact W requires (OFF/forget/lose/other value);
- rules that make a higher page's conditions true for W's page (priority hiding).

A killer is **permanent** if no relaxed-reachable rule re-establishes the falsified fact. It is **temporary** otherwise, like S181 with its 3 OFF writers.

- X is **possibly missable** if every way has a permanent killer that is relaxed-reachable without X.
- The report says "missable if you do K before X", citing K's site, and separates `one-shot` (the way disables itself, like Map137/E43 self A), `consumed` (CE882 loses item 456) and `temporarily blocked`.
- This is an over-approximation of "missable", labelled as such. Phase 8 refines it with ordering.

### 3.9 Taint report

1. **Targets:** V2, V3, V19 (directly and through CE23/CE10, which are already in the call graph), plus "mental changes" (choice edges whose enable condition reads V2 is the ska_mental convention).
2. **Per player-facing entry** (page, item use), list each tainting rule reachable through sync calls, classified by its local PC:
   - *unavoidable*: it post-dominates the entry, or its PC uses only state atoms the player can't influence at that point;
   - *choice-avoidable*: PC contains `choice` atoms (Map006/E58 "Leave.");
   - *state-gated*: e.g. `S14 recollection`, corruption thresholds;
   - *forced entry*: autorun/parallel, or the end-of-day pipeline (passive corruption in CE11).
3. **Config atoms** (S9) are reported separately: "not avoided by adult content OFF" is the CE532 case.
4. **Derivations are tagged** with the taint of the rules they use, so `needs X` can say "this way raises lewdness" (input for future route constraints).

### 3.10 Sizes and performance

| Stage | Size | Time (target) |
| --- | --- | --- |
| Decode (existing) | 23,748 lists / 458,065 commands | ~2 s |
| Index (existing) | 111,675 refs | ~2.5 s |
| CFG (all lists) | ~458k nodes, ~500k edges, far fewer blocks | ≤ 1 s |
| Path conditions + choice binding | hash-consed formulas, ~50k rule guards | 1–3 s |
| World graph + fixpoint | ~50k rules, ~40k entries, ~50k facts | ≤ 1 s |
| **Cold build total** | | **~6–8 s** |
| Cached load (`out/graph/`, JSON or NDJSON keyed by a hash of `game/data/*.json`, `js/plugins.js` and `src/` version) | rules + entries + fixpoint costs, ~10–30 MB | ~0.5–1 s |
| `needs` query after load | | < 50 ms; CLI wall < 1.5 s cached |

`where` would use the same cache: it rebuilds the index every run today (~3 s).

---

## 4. Query UX

### 4.1 Commands

- `npm run needs -- <goal> [--actor N] [--ways 3] [--depth 4] [--json] [--assume S9=ON,V624=1] [--ngplus] [--dev] [--from-save PATH]`
  - Goal syntax reuses `where`: `skill 26`, `item 456`, `switch 181 [off]`, `variable 192 ">=4"`, `selfswitch 137 43 A`, `map 137`, `event 7 8 [page]`, `site Map007/E8/p0#103`, `quest 0 2 [status]`, or typed refs (`{{skill:26}}`).
  - Defaults: within one playthrough (NG+ ways listed in a footer), dev maps excluded, adult content assumed ON (proposal; see open questions).
- `npm run needs -- --missable <goal>`: ways, killers, one-shot/consumed/temporary.
- `npm run taint -- corruption|lewdness|vice|mental [--entry Map006/E58] [--json]`.
- `npm run cfg -- map 265 8 [page] | ce 532 [--dot] [--paths]`: blocks, edges and per-site PCs, for debugging and the hand-checked snapshots.
- `npm run where -- … --guards`: today's output, each ref followed by its one-line requirement (page conditions + PC). This is the earliest user-visible gain (M4).
- `npm run graph`: build and cache, and write `out/graph/coverage.txt`. That file counts translated vs opaque conditions by top pattern, unresolved jumps, approx/simplified sites, maybe-writers per kind, and entries with no known trigger (like the decoder's coverage report).
- Later: `needs --from-save` seeds initial facts from a real save via the harness (planned "harness REPL over real saves"): "from *my* save, what do I still need?"

### 4.2 Output conventions

- Numbered ways, best first, with cost in brackets: `[1 day, 1 battle, 2 assumed]`.
- Every step is "what → where → when": a location (`Map007 AdventurerGuild / E8 "charlotte" (7,5) / page 0 #103`), the page condition, the choices with their labels, and the branch facts.
- Leaf markers: `[player choice]`, `[battle: win troop 3]`, `[assumed: Aura MP ≥ 10 (actor stat, not modelled)]`, `[random 1/8]`, `[15 × end of day]`, `[one-shot]`, `[NG+]`.
- Shared subgoals are printed once (`see 1.2`). Depth cut-offs say how much is hidden. A footer gives unknowns ("not followed: 4 writes of skill ids that aren't constant; see `where unanalyzed`").
- JSON has the same tree (`Way`/`Need`/`Step`, 2.6) with typed refs, so the site and walkthrough render the same data.

### 4.3 Examples (mock-ups from verified facts)

**Example 1:** `npm run needs -- skill 26 --actor 1`

```text
Aura (actor 1) learns skill 26 "Fire I": 1 way in this playthrough (+1 NG+, 3 class learnings for other actors)

1. Map007 AdventurerGuild / E8 "charlotte" (7,5) / page 0 #103   learn (actor 1)   [≈16 end of day, 1 battle, 1 assumed]
   page 0 runs (action button) when V192 charlotte >= 4
     and page 1 is inactive: S181 homewreckingVice is OFF   (initially OFF; ON at 3 sites, OFF again at 3: temporary)
   talk → choose "Learning Magic." → either V192 < 23, or S702 enrolledMagicAcademy is ON
        → Aura knows none of skills 26–28 (Fire rank 0)                    [script condition, translated]
        → choose "Learn Fire I. (MP ≥ 10)"   enabled when Aura MP >= 10    [assumed: actor stat]
        → ends the day (CE11 endDay)
   needs 1.1  V192 charlotte >= 4
     ← CE146 endOfDayEventProgress #14  V192 = 4  when V193 charlotteJailDays reaches 0
         V193 = 15 at CE146 #4, -1 per run of CE146 while 2 <= V192 <= 3 (same run included)   [15 × end of day]
       needs 1.2  V192 == 1 and V182 adventurerGuild >= 2   (CE146 #2–#3, at end of day)
         ← Map011 NorthernMinesArea1 / E2 "spiderqueen" / page 0 (event touch)   [battle: win troop 3 "Young Spider Queen"] [one-shot]
              V182 += 1, V192 += 1
           needs V182 >= 1 ← Map007 / E2 "clerk" / page 0 #48  V182 = 1 (talk) [one-shot: page 1 when V182 >= 1]
           needs on Map011 ← … (3 transfers; --depth to expand)
     needs on Map007 AdventurerGuild ← (start area; see `needs map 7`)

also: CE20 startMainGame #15  NG+ carry-over (if picked in Map073/E22)   [NG+: excluded by default]
not for Aura: classes 3 "Mage" (actor 2 Charlotte), 15, 23 learn it at level 1
not followed: 4 writes of skill ids that aren't constant (see `where unanalyzed`)
```

**Example 2:** `npm run needs -- skill 505 --actor 1 --depth 2`

```text
Aura learns skill 505 "The Art Of Fire": 2 ways
1. Read book item 456 at home: CE608 skillBooks (use item 456 from the menu)   [5+ sessions, each ends the day]
   on Map005 AbandonedShrine ($dataMap.meta.home)  ·  not (100 <= V254 rampagingGolem <= 200)
   Aura's Fire rank >= 1  (item 456 <idkcheck> "getSkillRank(25) == 0" blocks)   ← needs skill 26/27/28 (see `needs skill 26`)
   S12 OFF after CE605 checkBookDebuffs · choose "Yes." (no <yescondition> on item 456)
   reading progress reaches <readings:5> (+ extra readings)   [assumed: book progress and reading speed are plugin/actor state]
   needs has item 456 ← Map137 Underground / E43 "corpse_book" (4,37) / page 0 (action button) via CE785   [one-shot: self A]
2. A companion (actor 2/3/4/16) reads it: gift at Map007 (CE882 Gift_Item, item is consumed) → nightly CE883 books:readBook
   companion's Fire rank >= 1 (<idkcheck> with V36 = companion)
threats: gifting item 456 (CE882) consumes it, so way 1 needs a second copy
not followed: 19 writes of item ids that aren't constant
```

**Example 3:** `npm run needs -- map 137 --depth 1`

```text
Reach Map137 Underground: 9 transfers (+ variable-target transfers resolved to other maps)
1. Map133 Nephlune / E21 "enter_underground" (5,42) / page 0 (player touch) → (5,41)   [no conditions]  needs on Map133 …
   (E22, E23, E42 the same)
2. Map138 UndergroundCity / E35 "enter_underground" / page 0
3. Map176 UndergroundDungeon / E30, E31 "enter_underground" / page 0
```

**Example 4:** `npm run taint -- lewdness --entry Map006/E58`

```text
Map006 Trademond / E58 "flash_pussy_guard" / page 0 (action button)
  choose "Ask For Work." → … → choose "Show Pussy. (+150 Gold, +1 \V[28], Lewdness ≥ \V[562])"  → CE532
    CE532 #… call CE23 onLewdAction (V3 lewdness)   unless S14 recollection is ON
    not avoided by adult content OFF (S9): the scene text is skipped by jumps to "EndLewdScene"/"EndLewdScenePink",
    the lewd action, +150 gold, S432 and viewed scene 432 still happen
  avoidable: choose "Leave." (either choice)
```

### 4.4 What the site and walkthrough need from the same data

- The `Way`/`Step` JSON with typed refs, event coordinates (map pins), transfer coordinates (map-link arrows, which the phase 9 renderer uses), and costs.
- Per-entity precomputed answers (all skills, items, maps, quests: a few thousand small files).
- Stable anchors instead of `#index`. Until anchors exist, emit `site` plus a structural path (`p0/choice@9[0]/if@14.then/…`) and a content hash of the command subtree, so version diffs show "requirements of X changed".
- The route linter (phase 10) replays a route against the rules: each step's `pre` must hold in the simulated state.

---

## 5. Integrations and necessary upgrades

Each upgrade is listed only because the graph needs it.

| # | Where | Upgrade | Why it's necessary |
| --- | --- | --- | --- |
| U1 | `src/events` (new `pageConditions(c): Condition[]`; document.ts:30–39 then renders from it) | Structured page conditions | Requirements and priority negations need typed conditions; today they are only rendered as strings. |
| U2 | effects.ts:40–50 `Effect` | Optional structured value: `assign?: { op: "="\|"+="\|"-="\|…; rhs: Id \| "random" \| "opaque" }`, `on?: boolean` | Transitions and deletes would otherwise have to be parsed from `how` strings ("= 4", "+= 1", "= V625"). |
| U3 | xref.ts:31–53, 221–237, 271–305 | Take common-event summary guards from CFG path conditions instead of lexical `Guard`s | ~143 jumps enter blocks (10 in common events). `instantiateCalls` drops paths by these guards (xref.ts:296). Check with a test diffing the ref set before and after. |
| U4 | xref.ts:144, 293 (`Context`) | Map/event context after transfers | 339 pages call a common event after transferring away (callee `eventId` 0, rmmz_objects.js:10124), and 13 use current-map refs that hit the new map. The index attributes both to the origin. Verify with the harness first. |
| U5 | database.ts:36–38 | Index class learning `note` JS (25 notes; `this` = the actor) | e.g. class 3 Fire II forgets Fire I (`this.forgetSkill(26)`). "Has skill" answers are wrong without it. |
| U6 | books.ts / database.ts / script.ts | Attach book completion to CE607/CE608 `completeSkillBook`/`completeStatBook` sites (with `lastItem`) and to CE883 `readBook` | Requirements need the code path (home map, idkcheck, choice), not just the database row. |
| U7 | harness.ts / tracker.ts | Interpreter attribution: wrap `Game_Interpreter.prototype.executeCommand` (rmmz_objects.js:9660) to keep a stack of (list → `ListSource`, index). Build the identity map for `$dataCommonEvents`, the current `$dataMap` pages (after TemplateEvent) and troops. Tag each `Change` with its site; record executed transitions per interpreter. | Needed for CFG validation (6.3). Also closes the open item "10,786 changes explained only by visited map". |
| U8 | effects.ts + plugin-review.ts | A `PLUGIN_FLOW` table: calls (`event_utils`, `obstacles_choices`), choice binding (`choices:*`), scene/player-action nodes (crafting, bless, shop, skill select), `setHideSingleOptionChoices`. Covered by the existing review hashes. | Plugin commands that affect control flow are invisible otherwise; reviews must expire with the handlers (DECISIONS "Reviews are recorded and expire"). |
| U9 | new value-set pass (graph/) | Flow-insensitive set of constant values per variable; ⊤ if any non-constant write | Resolves variable-target transfers (498, mostly V640) and dynamic ids honestly ("one of {…} by value set"). |
| U10 | where.ts:150–152, 72–74 | Don't `process.exit` right after `console.log` (use `process.exitCode`, or write synchronously) | JSON is truncated at 65,536 bytes when piped (confirmed). Tools and the site will consume JSON. |
| U11 | context.ts | Feed compendium locations (`teleportCE`, `shrineCondition`), `$gameExpressions` and `maxSkillRank` into the analysis context | Missing entries (CE901–916) and translator inputs. |
| U12 (optional) | cli/where.ts, cli/index.ts | Shared `out/graph/` cache | Faster `where`, and one build for all commands. |

**Other integrations:**

- **Symbols** (`symbols.json`): names in output; a `scratch` flag derived in 2.5 (DECISIONS "Scratch and argument slots aren't global symbols").
- **Cross-check:** a new `--cfg` mode piggybacks on the same runs (6.3), so there's no second 28-minute pass.
- **Day model (phase 7):** consumes `cost.days`, the CE11/CE12 entries and the per-day counter patterns (V193). It replaces the "end of day" unit with real day accounting and checks it against the harness.
- **Reachability/routing (phase 8):** h_max from 3.7 is the admissible lower bound; the threats are its ordering constraints.
- **Annotation overlay:** human labels ("Spider Queen quest") on derivation steps, and manual meanings for opaque conditions. Each annotation is keyed by a hash of the condition text so it breaks loudly on change (DECISIONS principle).
- **Version diffing:** snapshot `needs` answers for a goal catalog and diff them between versions.
- **Map renderer:** event and transfer coordinates from the world graph.

---

## 6. Validation

1. **Unit tests on synthetic lists** (style of test/events.test.ts:47–69):
   - a jump into a choice branch (falls out of the construct);
   - a jump into a loop body (repeats);
   - break outside a loop (scan to the end, or to an unrelated 413);
   - duplicate labels (first wins) and missing labels (fall through);
   - Skip blocks dead; battle with and without branches; exit; 403 cancel.
2. **Hand-checked snapshots** (like the CE11 and Map265/E8 snapshots in test/__snapshots__/events.test.ts.snap):
   - `cfg map 265 8` (labels/jumps into a choice);
   - `cfg ce 532 --paths` (PC after `EndLewdScenePink` = `S17 ON`, independent of S9);
   - `cfg ce 11` (the second `END_DAY` is never a jump target);
   - `cfg ce 146 --paths` (the same-run V193 decrement);
   - `needs skill 26 --actor 1` and `needs skill 505` text output.
3. **Harness trace check (CFG soundness on executed paths)**, using U7. For every interpreter, each consecutive executed (list, index) pair must be a CFG edge, or a call/return to a child interpreter (9580 `updateChild`). Every jump, break and marker skip is checked against the static edge.
   - Run in `npm test` on a few entries with scripted input (Map265/E8 choosing "Present Evidence." then cancelling, CE532 with S9 OFF/ON, CE146 with V192 = 1, CE608 with `lastItem` set);
   - and in `crosscheck --pages --cfg` over all 10,738 page runs.
   - Add a choice-exploring policy (round-robin over visible options per choice site, `ChoicePolicy` at messages.ts:47) to widen edge coverage (an existing open item).
4. **Condition oracle:**
   - At each executed 111 and 102, evaluate our `Cond` on the live state and compare it with the engine's `_branch` result or with `isChoiceEnabled`/`isChoiceVisible`. Disagreement on a non-opaque condition is a bug.
   - Offline, for each distinct translated JS condition, `eval` the original in the harness against states captured during the cross-check plus perturbations of the variables it reads, and compare.
5. **Page-selection oracle:** after frames, for every event on the current map, `event._pageIndex` must equal the page predicted by `act(p)` over the live state.
6. **Necessary-condition check for requirements:** snapshot switches, variables, self switches and items at interpreter `setup` (9516). When a site with a rule executes, its `pre` evaluated on that snapshot (and the bound context) must be true or contain opaque atoms. A false `pre` means the requirement is unsound.
7. **Exact attribution** (also via U7): each tracked change must come from the executing site, with a static effect that matches it (stronger than today's verdicts; DECISIONS "Check the index against the running game").
8. **Whole-project properties:**
   - every list builds;
   - unreachable code, unresolved jumps and opaque conditions are counted in `coverage.txt` with a ranked work loop, like decoder gaps;
   - relaxed reachability marks the intro's forced facts as reachable;
   - the harness's new-game intro run (`startGameInProgress`, trace.ts:52) only changes facts the fixpoint calls reachable.

---

## 7. Milestones

Each milestone is independently useful and testable. Sizes are rough source lines.

1. **M1: Per-list CFG + `cfg` CLI + coverage** (~700). Builder, issues, SCCs, dominators, unit tests and snapshots (6.1, 6.2). *Useful on its own:* an unreachable-code report, jump diagnostics, a CFG dump to read alongside `print`.
2. **M2: Harness interpreter attribution + CFG trace check** (~400; U7). `crosscheck --cfg`. *Useful on its own:* validates M1 on real runs, and makes the "visited-map" verdicts exact (closes an open item).
3. **M3: Condition language + JS translator + structured page conditions + choice binding** (~700; U1, U11). Includes the condition oracle and the translated/opaque coverage report.
4. **M4: Path conditions + `where --guards` + index guards from the CFG** (~600; U2, U3, U4, U10). *Useful on its own:* every `where` answer shows "when". Fixes the jump-guard and transfer-context precision issues, verified by ref-set diffs and the cross-check.
5. **M5: World graph** (~800; U5, U6, U8, U9). Entries (pages with priority and triggers, common-event callers, item/skill use with `lastItem`, compendium teleports, transfers with value sets, battles/troops, shops, class learnings, drops), rules, budgets, costs, scratch detection. Page-selection oracle.
6. **M6: Relaxed fixpoint + `needs` (text + JSON) + ranking** (~800). The headline. Snapshots for Fire I and The Art Of Fire, plus the necessary-condition check (6.6).
7. **M7: Threats → `--missable` and the taint report** (~500). Post-dominator-based classification; Map006/E58 and CE532 snapshot.
8. **M8: Cache, goal-catalog precompute, anchors draft, `--from-save`** (~400; U12). Feeds phases 9 and 10.

Total ~4,900 lines. That is about as much code again as the repo has today (~5.5k), which matches "central to the project". M1→M2→M3→M4 are strictly sequential; M5 can start after M3; M7 needs M6.

---

## 8. Risks, open questions, proposed decisions

### 8.1 Risks

- **Over-optimism of the relaxed model** (deletes ignored, untracked stats assumed). Mitigations: one-shot budgets, threats listed, every answer labelled "possible plan / lower bound". Phase 8 does the real ordering. A sample of derivations should be replayed in the harness early (a precursor of the route linter).
- **Untracked state** is common: actor stats, MP, levels, book progress, NG+ picks, battle outcomes. Expect many `assumed` markers. A later actor-stat model would need its own phase.
- **Formula growth** in big pages (Map007/E8 page 0 is ~860 commands). Hash-consing, caps and dominator fallback keep it bounded, and the report says where they kicked in.
- **Engine subtleties** (branch state after jumps, transfers mid-list, erase, autorun order, parallel interleaving) are covered by the trace and page oracles. Parallel interleaving is only over-approximated ("may run any time while active").
- **JS variety:** the translator's coverage is measured. The opaque fraction is reported, not hidden.
- **Harness overhead** of hooking `executeCommand` on the 28-minute full run; measure it, and sample if needed.

### 8.2 Open questions for the user

**Answered (2026-11-02):** see DECISIONS "Query defaults for `needs`".

1. Skill goals: default to Aura (actor 1), or "any party member" with the actor shown?
2. Should NG+ ways be excluded by default and listed in a footer (consistent with "New Game+ is a playthrough boundary")?
3. Default configuration assumptions: adult content S9 ON? Difficulty (V624)? Or always require `--assume`?
4. Exclude the dev maps (Map012, Map019, Map020, Map050, plus CE5 `startTest`) from the world graph by default (`--dev` to include)? This is an open item in ROADMAP.
5. Ranking before the day model: is "end-of-day count, then battles, random, assumed, actions" acceptable?
6. Untracked conditions (MP ≥ 10, MAT ≥ 16, level): optimistic and listed (proposed), or blocking?
7. Battle outcomes: assume win is available and lose branches are optional? Treat random drops as "eventually"?
8. Cache format now: JSON/NDJSON in `out/graph/` (proposed), with SQLite only for publishing (phase 9)?

### 8.3 Proposed DECISIONS entries (proposals, not yet agreed)

**Adopted (2026-11-02):** see DECISIONS "How the graph is built and answers are given".

- **CFG follows the interpreter, not the editor (proposal).** Nodes are raw command indices built from the decoded tree. A jump goes to the first label with that name; a missing label is a no-op. Break Loop scans forward by 112/413 depth. The end of a branch body leaves the construct, also after a jump, because `jumpTo` resets branch state. Checked against interpreter traces in the harness.
- **Requirements are necessary conditions; plans are relaxed (proposal).** `Req(site)` must hold whenever the site runs, which the harness checks. `needs` answers come from a delete-relaxed model and are labelled as possible plans or lower bounds. "Unreachable" is only claimed when no unknown writer or opaque condition is involved.
- **Conditions are translated, not evaluated (proposal).** JS (event scripts, choice conditions, note tags) is translated by AST pattern into typed atoms. Anything else stays as explicit `opaque` or `untracked` atoms, with what it reads. Evaluation in the harness is a test oracle.
- **Context slots generalize call-site instantiation (proposal).** `lastItem`, `lastSkill`, `eventId`, `mapId` and argument variables are bound at call and use sites. This also fixes the blessing over-approximation and the post-transfer "this event".
- **Scratch variables are derived, not listed (proposal).** A variable whose every read is preceded by a local write or a caller binding gets no global facts (extends "Scratch and argument slots aren't global symbols").
- **One-shot comes from page priority (proposal).** A rule's execution budget is 1 when its page disables itself (a higher page's conditions become exactly true, its own become false, or Erase Event). That is what makes counters, missability and "consumed" meaningful.
- **Plugin control flow is reviewed like plugin effects (proposal).** Calls, choice binding and scene/player-action semantics of plugin commands live next to `PLUGIN_EFFECTS` and expire with the same handler hashes.
- **Answers are derivation trees with typed references (proposal).** CLI, JSON, site and walkthrough share one schema (`Way`/`Need`/`Step`). Locations are `Map/E/p#idx` now, stable anchors later.

---

### Critical files for implementation

- src/analysis/xref.ts
- src/analysis/effects.ts
- src/events/decode.ts (with src/events/ops.ts)
- src/check/crosscheck.ts (with src/harness/harness.ts and src/harness/tracker.ts)
- game/js/rmmz_objects.js (engine reference: findProperPageIndex 9327, meetsConditions 9338, executeCommand 9660, skipBranch 9694, 102/402/403 9829–9866, 111 9927, 411/413/113/115/117/119/jumpTo 10077–10166, 201 10491, 301 10933, setupStartingEvent 6821)

Also relevant: src/analysis/script.ts, src/analysis/database.ts, src/analysis/books.ts, src/cli/where.ts, src/events/document.ts, game/js/plugins/auramz/choices.js, game/js/plugins/auramz/skill_rank.js, game/js/plugins/auramz/event_utils.js, game/js/plugins/auramz/compendium.js.
