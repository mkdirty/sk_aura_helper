// What each decoded op reads, writes and calls.
//
// Engine commands follow Game_Interpreter (js/rmmz_objects.js). Plugin commands follow their
// registered handlers (read from the plugin sources; see PLUGIN_EFFECTS). Scripts go through
// script.ts. Anything not modelled is reported as "unanalyzed" so coverage stays honest.

import type { Condition, Op, Operand, Value } from "../events/ops.ts";
import { analyzeScript, expressionId } from "./script.ts";

/**
 * A constant id; "the value of variable N" (resolved at call sites when possible); or an id
 * computed in a way the analysis can't follow (`unknown` says where it came from).
 */
export type Id = number | { var: number } | { unknown: string };

/** Whether an id is computed in a way the analysis can't follow. */
export const isUnknownId = (x: unknown): x is { unknown: string } => typeof x === "object" && x !== null && "unknown" in x;

export type Entity =
  | { kind: "switch"; id: Id }
  | { kind: "variable"; id: Id }
  /** "current" map / "self" event: the running event's (for common events, the caller's). */
  | { kind: "selfSwitch"; mapId: Id | "current"; eventId: Id | "self"; letter: string }
  | { kind: "item" | "weapon" | "armor"; id: Id }
  | { kind: "gold" }
  | { kind: "skill"; id: Id }
  | { kind: "state"; id: Id }
  | { kind: "class"; id: Id }
  | { kind: "actor"; id: Id }
  | { kind: "quest"; id: Id; objective?: Id }
  | { kind: "bestiary"; enemyId: Id }
  | { kind: "achievement"; name: string }
  | { kind: "commonEvent"; id: Id }
  | { kind: "mapEvent"; mapId: Id | "current"; eventId: Id | "self"; page?: number }
  | { kind: "map"; id: Id }
  | { kind: "troop"; id: Id };

export interface Effect {
  entity: Entity;
  access: "read" | "write" | "call";
  /** Short description: "== 3", "gain", "learn (actor 1)", "transfer", … */
  how: string;
  /** For gains/losses: the amount and its sign. */
  amount?: Id;
  sign?: 1 | -1;
  /** Set when "this event" was filled in: the effect follows whichever event runs the code. */
  selfRelative?: true;
}

/** What one op does, plus anything about it that couldn't be analyzed. */
export interface OpEffects {
  effects: Effect[];
  /** Reasons this op's effects are incomplete, e.g. "plugin foo:bar", "script (dynamic ref)". */
  unanalyzed: string[];
}

export interface EffectContext {
  /** Plugin parameters by plugin file name (for commands configured through them). */
  pluginParams: (plugin: string) => Record<string, string>;
}

const valueId = (v: Value): Id => (v.kind === "const" ? v.value : { var: v.id });
const range = (from: number, to: number) => Array.from({ length: Math.max(0, to - from + 1) }, (_, k) => from + k);
const pluginKey = (plugin: string, command: string) => `${plugin.split("/").pop()}:${command}`;

/**
 * Plugin commands with no effect on persistent game state, each checked against its registered
 * handler: presentation (pictures, sprites, filters, messages, appearance), UI setup for the
 * next scene, transient flags, platform/telemetry calls, and commands not registered at all.
 */
const PRESENTATION = new Set([
  // Screen filters, pixel animations, standing images, cut-ins, credits.
  "FilterControllerMZ:createFilter",
  "FilterControllerMZ:eraseFilter",
  "FilterControllerMZ:eraseFilterAfterMove",
  "FilterControllerMZ:eraseAllFilter",
  "FilterControllerMZ:moveFilter",
  "FilterControllerMZ:setFilter",
  "FilterControllerMZ:setFilterSpeed",
  "pixel_animations:resumeAnimation",
  "pixel_animations:interruptAnimation",
  "standing_images:show",
  "standing_images:hide",
  "standing_images:lockDim",
  "standing_images:setNameMap",
  "TorigoyaMZ_SkillCutIn:showActorCutIn",
  "credits:playCredits",
  "advanced_pictures:copyPictureHierarchy",
  "advanced_pictures:transferPictureToId",
  "advanced_pictures:waitForPictureMoveCommand",
  "text_utils:addMessage",
  // Actor/event appearance.
  "MPP_CharacterMake_TLB:changeClothing",
  "MPP_CharacterMake_TLB:changeHair",
  "MPP_CharacterMake_TLB:changeAccB",
  "MPP_CharacterMake_TLB:changeWing",
  "MPP_CharacterMake_TLB:changeTail",
  "MPP_CharacterMake_TLB:changeBeastEars",
  "MPP_CharacterMake_TLB:switchPartyDamageTV",
  "MPP_CharacterMake_TLB:switchActorDamageTV",
  "MPP_CharacterMake_TLB:openScene",
  "event_utils:setActorDamageImage",
  "event_utils:setEventImageToActorDamageImage",
  // UI setup for the next scene, transient flags.
  "advanced_item_select:addItemFilter",
  "advanced_item_select:disableCancel",
  "TLB_SKAShop:merchant_setup",
  "ambush:makeNextBattleAmbush",
  "detectors:stunDetector",
  "books:setTargetActor",
  // New Game+ carry-over configuration (applies to the next playthrough).
  "newgame_plus:carryOverSwitchRange",
  "newgame_plus:carryOverVariableRange",
  // Saves, platform, telemetry.
  "ironman:activate",
  "extra_autosave_conditions:customAutosaveTrigger",
  "SteamLinkCommandsAddon:storeStats",
  "SteamLinkCommandsAddon:activateAchievement",
  "analytics:sendDesignEvent",
  "analytics:sendProgressionEvent",
  // Not registered by any shipped plugin: no-ops (event_test is the author's test harness;
  // ska_compendium is a misspelling of compendium in Troop245, so that reveal never happens).
  "event_test:start",
  "event_test:assertTrue",
  "event_test:assertEquals",
  "event_test:pressButton",
  "event_test:success",
  "autosave:autosaveNow",
  "ska_compendium:revealTrait",
  "advanced_pictures:transitionTyped",
  "advanced_pictures:transition",
  "advanced_pictures:attachChildren",
  "NGT_Shatter:shatterPicture",
  "text_utils:showTemplateMessage",
  "event_utils:setEventImageToActorImage",
  "MPP_CharacterMake_TLB:changePart",
  "MPP_CharacterMake_TLB:changeColour",
  // Shop UI configuration for the next shop scene ($gameTemp only).
  "TLB_SKAShop:item_setup",
]);

/** Known-but-unmodelled plugin commands, with what they do. */
const UNANALYZED_NOTES: Record<string, string> = {
  "books:readBook": "plugin books:readBook (reading progress; finished books can teach skills)",
  "newgame_plus_skills:initCarryOverSkills": "plugin newgame_plus_skills:initCarryOverSkills (learns NG+ carried skills)",
  "newgame_plus_skills:showOptionsForSkills": "plugin newgame_plus_skills:showOptionsForSkills (NG+ skill picker)",
  "newgame_plus:startNewGamePlus": "plugin newgame_plus:startNewGamePlus",
  "TLB_SKACraftMenu:openScene": "plugin TLB_SKACraftMenu:openScene (crafting: consumes and gives items)",
  "TLB_SKABlessMenu:openScene": "plugin TLB_SKABlessMenu:openScene (blessing menu)",
};

type PluginHandler = (args: Record<string, any>, ctx: EffectContext, out: OpEffects) => void;

const bool = (v: unknown) => String(v) === "true";

/**
 * Adds script effects (or an unanalyzed note) for a JS snippet. `self`: what `this` means for
 * "this event" references (a move route's `this` is the character being moved).
 */
function scriptEffects(code: string, out: OpEffects, readOnly = false, self?: Id | "self") {
  const a = analyzeScript(code);
  if (!a.parsed) out.unanalyzed.push("script (parse error)");
  if (a.dynamic) out.unanalyzed.push("script (dynamic ref)");
  for (const raw of a.effects) {
    let e = readOnly && raw.access === "write" ? { ...raw, access: "read" as const } : raw;
    if (self !== undefined && e.entity.kind === "selfSwitch" && e.entity.eventId === "self") e = { ...e, entity: { ...e.entity, eventId: self } };
    out.effects.push(e);
  }
}

function selfSwitchWrite(mapId: Id | "current" | "self" | undefined, eventId: Id | "self" | "current" | undefined, letter: string, value: boolean, out: OpEffects) {
  if (mapId === undefined || mapId === "self" || eventId === undefined || eventId === "current") {
    out.unanalyzed.push("self switch (dynamic key)");
    return;
  }
  out.effects.push({ entity: { kind: "selfSwitch", mapId, eventId, letter }, access: "write", how: `= ${value ? "ON" : "OFF"}` });
}

/** Handlers for plugin commands, written from each plugin's registerCommand implementation. */
const PLUGIN_EFFECTS: Record<string, PluginHandler> = {
  // auramz/selfswitches_utils.js
  "selfswitches_utils:setLocalSelfSwitch": (a, _c, out) => selfSwitchWrite("current", expressionId(String(a.eventID)), a.selfswitch, bool(a.value), out),
  "selfswitches_utils:setLocalSelfSwitchRange": (a, _c, out) => {
    for (const e of range(Number(a.fromEventID), Number(a.toEventID))) selfSwitchWrite("current", e, a.selfswitch, bool(a.value), out);
  },
  "selfswitches_utils:setExternalSelfSwitch": (a, _c, out) =>
    selfSwitchWrite(expressionId(String(a.mapID)), expressionId(String(a.eventID)), a.selfswitch, bool(a.value), out),
  "selfswitches_utils:setExternalSelfSwitchRange": (a, _c, out) => {
    const mapId = expressionId(String(a.mapID));
    for (const e of range(Number(a.fromEventID), Number(a.toEventID))) selfSwitchWrite(mapId, e, a.selfswitch, bool(a.value), out);
  },
  "selfswitches_utils:synchronizeLocalSelfSwitches": (a, _c, out) => {
    out.effects.push({ entity: { kind: "selfSwitch", mapId: "current", eventId: Number(a.observedEventID), letter: a.selfswitch }, access: "read", how: "value" });
    out.effects.push({ entity: { kind: "selfSwitch", mapId: "current", eventId: Number(a.affectedEventID), letter: a.selfswitch }, access: "write", how: `= self ${a.selfswitch} of event ${a.observedEventID}` });
  },
  // auramz/event_utils.js: runs another event's page as a child interpreter.
  // callLocalEvent runs the page as the called event; callLocalEventInline runs it as the
  // *calling* event (setupChild(list, inline ? eventId : parentEventId), inline=false).
  "event_utils:callLocalEvent": (a, _c, out) => localEvent(a, out, false),
  "event_utils:callLocalEventInline": (a, _c, out) => localEvent(a, out, true),
  // auramz/quests.js
  "quests:addQuest": (a, _c, out) => {
    out.effects.push({ entity: { kind: "quest", id: Number(a.questID) }, access: "write", how: "add" });
    for (const o of safeJson<string[]>(a.objectives) ?? []) out.effects.push({ entity: { kind: "quest", id: Number(a.questID), objective: Number(o) }, access: "write", how: "add" });
  },
  "quests:addObjective": (a, _c, out) => out.effects.push({ entity: { kind: "quest", id: Number(a.questID), objective: Number(a.objectiveID) }, access: "write", how: "add" }),
  "quests:setObjectiveStatus": (a, _c, out) =>
    out.effects.push({ entity: { kind: "quest", id: Number(a.questID), objective: Number(a.objectiveID) }, access: "write", how: `status = ${a.status}` }),
  "quests:setQuestStatus": (a, _c, out) => out.effects.push({ entity: { kind: "quest", id: Number(a.questID) }, access: "write", how: `status = ${a.status}` }),
  "quests:updateReward": () => {},
  "quests:overrideReward": () => {},
  "quests:updatedObjectiveDescription": () => {},
  // auramz/adult_content_option.js: copies the config option into a switch.
  "adult_content_option:readAdultOption": (_a, ctx, out) => {
    const sw = Number(ctx.pluginParams("adult_content_option").adultContentSwitch);
    out.effects.push({ entity: { kind: "switch", id: sw }, access: "write", how: "= adult content option" });
  },
  // auramz/choices.js: conditions are evaluated when the choice is shown (reads only).
  "choices:setChoiceOption": (a, _c, out) => scriptEffects(String(a.condition ?? ""), out, true),
  "choices:setChoiceShowCondition": (a, _c, out) => scriptEffects(String(a.condition ?? ""), out, true),
  "choices:setChoiceColorCondition": (a, _c, out) => scriptEffects(String(a.condition ?? ""), out, true),
  "choices:setChoiceAlternateText": (a, _c, out) => scriptEffects(String(a.condition ?? ""), out, true),
  "choices:setHideSingleOptionChoices": () => {},
  // auramz/compendium.js (bestiary)
  "compendium:revealTrait": (a, _c, out) => bestiary(a.enemy, "reveal trait", out),
  "compendium:addBossKill": (a, _c, out) => bestiary(a.enemy, "add kill", out),
  "compendium:addBeastiaryEntry": (a, _c, out) => bestiary(a.enemyID, "add entry", out),
  "compendium:revealStat": (a, _c, out) => bestiary(a.enemy, "reveal stat", out),
  "compendium:revealAffinity": (a, _c, out) => bestiary(a.enemy, "reveal affinity", out),
  "compendium:revealSkill": (a, _c, out) => bestiary(a.enemy, "reveal skill", out),
  "compendium:revealAll": (a, _c, out) => bestiary(a.enemy, "reveal all", out),
  // auramz/conditional_goods.js: unlock conditions are evaluated by the next shop (reads).
  "conditional_goods:setUnlockCondition": (a, _c, out) => scriptEffects(String(a.unlockCondition ?? ""), out, true),
  // deploy/steam.js
  "steam:activateAchievement": (a, _c, out) => out.effects.push({ entity: { kind: "achievement", name: String(a.achievementName) }, access: "write", how: "unlock" }),
  // TLB_SKASelectSkill: opens a skill picker; the chosen skill id goes to a variable.
  "TLB_SKASelectSkill:selectSkill": (a, _c, out) => out.effects.push({ entity: { kind: "variable", id: Number(a.skillIdVariable) }, access: "write", how: "= selected skill" }),
  "SteamLinkCommandsAddon:getStatInt": (a, _c, out) => out.effects.push({ entity: { kind: "variable", id: Number(a.variableId) }, access: "write", how: "= Steam stat" }),
  "SteamLinkCommandsAddon:getAchievementCount": (a, _c, out) => out.effects.push({ entity: { kind: "variable", id: Number(a.variableId) }, access: "write", how: "= Steam achievement count" }),
  "conditional_goods:setDiscount": (a, _c, out) => scriptEffects(String(a.discount ?? ""), out, true),
  "advanced_states:unlockStates": (a, _c, out) => {
    for (const st of safeJson<string[]>(a.stateIds) ?? []) out.effects.push({ entity: { kind: "state", id: Number(st) }, access: "write", how: "unlock (state list)" });
  },
  // choices.createChoice: a choice built from args; the chosen option's value goes to a variable.
  "choices:createChoice": (a, _c, out) => {
    const v = expressionId(String(a.returnVariable ?? ""));
    if (typeof v === "number") out.effects.push({ entity: { kind: "variable", id: v }, access: "write", how: "= choice value" });
    else out.unanalyzed.push("createChoice (dynamic return variable)");
    for (const c of safeJson<string[]>(a.choices) ?? []) {
      const choice = safeJson<Record<string, string>>(c) ?? {};
      for (const k of ["enableCondition", "showCondition", "colorCondition"]) if (choice[k]) scriptEffects(choice[k], out, true);
    }
  },
  // auramz/obstacles_choices.js: shows obstacle choices; the chosen option runs a common event
  // and the result goes to a variable.
  "obstacles_choices:showChociesForObstacle": (a, _c, out) => {
    if (a.commonEvent) out.effects.push({ entity: { kind: "commonEvent", id: Number(a.commonEvent) }, access: "call", how: "obstacle choice" });
    if (a.variableForReturnValue) out.effects.push({ entity: { kind: "variable", id: Number(a.variableForReturnValue) }, access: "write", how: "= obstacle choice" });
  },
};

function localEvent(a: Record<string, any>, out: OpEffects, asCaller: boolean) {
  const eventId = expressionId(String(a.eventID));
  if (eventId === undefined || eventId === "current") return void out.unanalyzed.push("local event call (dynamic id)");
  const page = Number(a.pageID);
  // pageID -1: the event's current page.
  out.effects.push({ entity: { kind: "mapEvent", mapId: "current", eventId: eventId === 0 ? "self" : eventId, ...(page >= 0 ? { page } : {}) }, access: "call", how: asCaller ? "local event (as caller)" : "local event" });
}

function bestiary(enemy: unknown, how: string, out: OpEffects) {
  const id = expressionId(String(enemy));
  if (typeof id === "number" || (id && typeof id === "object")) out.effects.push({ entity: { kind: "bestiary", enemyId: id }, access: "write", how });
  else out.unanalyzed.push("bestiary (dynamic enemy)");
}

function safeJson<T>(s: unknown): T | undefined {
  try {
    return JSON.parse(String(s)) as T;
  } catch {
    return undefined;
  }
}

function readValue(v: Value, out: OpEffects) {
  if (v.kind === "var") out.effects.push({ entity: { kind: "variable", id: v.id }, access: "read", how: "value" });
}

function operandReads(x: Operand, out: OpEffects) {
  switch (x.kind) {
    case "var":
      return readValue(x, out);
    case "gameData": {
      const d = x.data;
      if (d.kind === "itemCount") out.effects.push({ entity: { kind: d.itemKind, id: d.id }, access: "read", how: "count" });
      if (d.kind === "other" && d.what === "gold") out.effects.push({ entity: { kind: "gold" }, access: "read", how: "value" });
      if (d.kind === "actorStat") out.effects.push({ entity: { kind: "actor", id: d.actorId }, access: "read", how: d.stat });
      return;
    }
    case "script":
      return scriptEffects(x.code, out);
  }
}

function conditionReads(c: Condition, out: OpEffects) {
  const read = (entity: Entity, how: string) => out.effects.push({ entity, access: "read", how });
  switch (c.kind) {
    case "switch":
      return read({ kind: "switch", id: c.id }, `is ${c.value ? "ON" : "OFF"}`);
    case "variable":
      read({ kind: "variable", id: c.id }, `${c.op} ${c.rhs.kind === "const" ? c.rhs.value : `V${c.rhs.id}`}`);
      return readValue(c.rhs, out);
    case "selfSwitch":
      return read({ kind: "selfSwitch", mapId: "current", eventId: "self", letter: c.letter }, `is ${c.value ? "ON" : "OFF"}`);
    case "actor": {
      const arg = Number(c.arg);
      if (c.test === "inParty") return read({ kind: "actor", id: c.actorId }, "in party?");
      if (c.test === "skill") return read({ kind: "skill", id: arg }, `has? (actor ${c.actorId})`);
      if (c.test === "class") return read({ kind: "class", id: arg }, `is? (actor ${c.actorId})`);
      if (c.test === "state") return read({ kind: "state", id: arg }, `has? (actor ${c.actorId})`);
      if (c.test === "weapon") return read({ kind: "weapon", id: arg }, `equipped? (actor ${c.actorId})`);
      if (c.test === "armor") return read({ kind: "armor", id: arg }, `equipped? (actor ${c.actorId})`);
      return read({ kind: "actor", id: c.actorId }, c.test);
    }
    case "gold":
      return read({ kind: "gold" }, `${c.op} ${c.amount}`);
    case "hasItem":
      return read({ kind: c.itemKind, id: c.id }, "has?");
    case "script":
      return scriptEffects(c.code, out);
    case "unknown":
      out.unanalyzed.push("condition (unknown)");
      return;
  }
}

/** The effects of one op itself (not of the ops nested inside it). */
export function opEffects(op: Op, ctx: EffectContext): OpEffects {
  const out: OpEffects = { effects: [], unanalyzed: [] };
  const push = (entity: Entity, access: Effect["access"], how: string, extra: Partial<Effect> = {}) => out.effects.push({ entity, access, how, ...extra });

  switch (op.kind) {
    case "if":
      conditionReads(op.condition, out);
      break;
    case "numberInput":
    case "itemChoice":
      push({ kind: "variable", id: op.variableId }, "write", op.kind === "numberInput" ? "= input number" : "= selected item");
      break;
    case "callCommon":
      push({ kind: "commonEvent", id: op.id }, "call", "call");
      break;
    case "setSwitches":
      for (const s of range(op.from, op.to)) push({ kind: "switch", id: s }, "write", `= ${op.value ? "ON" : "OFF"}`);
      break;
    case "setVariables": {
      const rhs =
        op.operand.kind === "const" ? String(op.operand.value) : op.operand.kind === "var" ? `V${op.operand.id}` : op.operand.kind === "random" ? `random(${op.operand.min}..${op.operand.max})` : op.operand.kind;
      for (const v of range(op.from, op.to)) push({ kind: "variable", id: v }, "write", `${op.op} ${rhs}`);
      operandReads(op.operand, out);
      break;
    }
    case "setSelfSwitch":
      push({ kind: "selfSwitch", mapId: "current", eventId: "self", letter: op.letter }, "write", `= ${op.value ? "ON" : "OFF"}`);
      break;
    case "changeGold":
      push({ kind: "gold" }, "write", op.sign > 0 ? "gain" : "lose", { amount: valueId(op.delta), sign: op.sign });
      readValue(op.delta, out);
      break;
    case "changeItems":
      push({ kind: op.itemKind, id: op.id }, "write", op.sign > 0 ? "gain" : "lose", { amount: valueId(op.delta), sign: op.sign });
      readValue(op.delta, out);
      break;
    case "changeParty":
      push({ kind: "actor", id: op.actorId }, "write", op.add ? "join party" : "leave party");
      break;
    case "transfer":
      push({ kind: "map", id: valueId(op.mapId) }, "call", "transfer");
      for (const v of [op.mapId, op.x, op.y]) readValue(v, out);
      break;
    case "moveRoute":
      for (const s of op.steps) {
        if (s.name === "switch_on" || s.name === "switch_off") push({ kind: "switch", id: Number(s.params[0]) }, "write", `= ${s.name === "switch_on" ? "ON" : "OFF"} (move route)`);
        if (s.name === "script") {
          // `this` in a route script is the moved character: the player has no self switches.
          const self = op.character.kind === "event" ? op.character.id : op.character.kind === "this" ? "self" : undefined;
          if (op.character.kind === "player") scriptEffects(String(s.params[0] ?? ""), out);
          else scriptEffects(String(s.params[0] ?? ""), out, false, self);
        }
      }
      break;
    case "battle":
      if (op.troop.kind === "random") push({ kind: "troop", id: 0 }, "call", "random encounter");
      else push({ kind: "troop", id: valueId(op.troop) }, "call", "battle");
      break;
    case "shop":
      for (const g of op.goods) push({ kind: g.itemKind, id: g.id }, "write", "shop sells");
      break;
    case "changeSkill":
      push({ kind: "skill", id: op.skillId }, "write", `${op.learn ? "learn" : "forget"} (${op.actor.kind === "actor" ? `actor ${op.actor.id}` : op.actor.kind === "party" ? "party" : `actor V${op.actor.id}`})`);
      break;
    case "changeState":
      push({ kind: "state", id: op.stateId }, "write", op.add ? "add" : "remove");
      break;
    case "changeClass":
      push({ kind: "class", id: op.classId }, "write", `set (actor ${op.actorId})`);
      break;
    case "changeEquipment":
      if (op.itemId) push({ kind: op.slot === 1 ? "weapon" : "armor", id: op.itemId }, "write", `equip (actor ${op.actorId})`);
      break;
    case "changeActorValue":
    case "changeParam":
      readValue(op.delta, out);
      break;
    case "generic":
      // Get Location Info writes its result to a variable.
      if (op.code === 285) push({ kind: "variable", id: Number(op.args.variableId) }, "write", "= location info");
      break;
    case "script":
      scriptEffects(op.js, out);
      break;
    case "plugin": {
      const key = pluginKey(op.plugin, op.command);
      const handler = PLUGIN_EFFECTS[key];
      if (handler) handler(op.args, ctx, out);
      else if (!PRESENTATION.has(key)) out.unanalyzed.push(UNANALYZED_NOTES[key] ?? `plugin ${key}`);
      break;
    }
    case "legacyPlugin":
      out.unanalyzed.push("legacy plugin command");
      break;
    case "unknown":
      out.unanalyzed.push(`unknown code ${op.code}`);
      break;
  }
  return out;
}
