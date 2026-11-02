// Extracts game-state references from the game's JavaScript snippets (script commands,
// script conditions and operands, plugin-command conditions, move-route scripts).
//
// This is pattern matching on the AST for the engine APIs the game actually uses with
// constant (or "value of variable N") arguments. Anything else is not understood, and
// is reported as such rather than guessed.

import * as acorn from "acorn";
import * as walk from "acorn-walk";
import type { Effect, Id } from "./effects.ts";

export interface ScriptAnalysis {
  effects: Effect[];
  parsed: boolean;
  /** References to known APIs whose arguments weren't constant. */
  dynamic: number;
}

type Node = acorn.Node & Record<string, any>;

/** `x.y.z` → "x.y.z" for identifiers/this/non-computed members; undefined otherwise. */
function path(node: Node | undefined): string | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return node.name;
  if (node.type === "ThisExpression") return "this";
  if (node.type === "MemberExpression" && !node.computed) {
    const obj = path(node.object);
    return obj && `${obj}.${node.property.name}`;
  }
  if (node.type === "CallExpression" && node.arguments.length === 0) {
    const callee = path(node.callee);
    return callee && `${callee}()`;
  }
  return undefined;
}

/** A constant number, `$gameVariables.value(N)`, or undefined. */
function id(node: Node | undefined): Id | undefined {
  if (!node) return undefined;
  if (node.type === "Literal" && typeof node.value === "number") return node.value;
  if (node.type === "Literal" && typeof node.value === "string" && /^\d+$/.test(node.value)) return Number(node.value);
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal") return -Number(node.argument.value);
  if (node.type === "CallExpression" && path(node.callee) === "$gameVariables.value") {
    const v = node.arguments[0];
    if (v?.type === "Literal" && typeof v.value === "number") return { var: v.value };
  }
  return undefined;
}

const ITEM_TABLES: Record<string, "item" | "weapon" | "armor"> = { $dataItems: "item", $dataWeapons: "weapon", $dataArmors: "armor" };

/** `$dataItems[N]` → { kind, id }. */
function itemRef(node: Node | undefined): { kind: "item" | "weapon" | "armor"; id: Id | undefined } | undefined {
  if (node?.type !== "MemberExpression" || !node.computed) return undefined;
  const kind = ITEM_TABLES[path(node.object) ?? ""];
  return kind && { kind, id: id(node.property) };
}

/** Self-switch key `[map, event, "A"]`. "current"/"self" stand for the running event's map/id. */
function selfKey(node: Node | undefined) {
  if (node?.type !== "ArrayExpression" || node.elements.length !== 3) return undefined;
  const [m, e, l] = node.elements as Node[];
  const mapPath = path(m);
  const eventPath = path(e);
  const mapId: Id | "current" | undefined = mapPath === "this._mapId" || mapPath === "$gameMap.mapId()" ? "current" : id(m);
  const eventId: Id | "self" | undefined = eventPath === "this._eventId" || eventPath === "this.eventId()" ? "self" : id(e);
  const letter = l?.type === "Literal" && typeof l.value === "string" ? l.value : undefined;
  if (mapId === undefined || eventId === undefined || letter === undefined) return undefined;
  return { mapId, eventId, letter };
}

/** `$gameActors.actor(N)` → N, `$gameParty.leader()` → "leader". */
function actorRef(node: Node | undefined): number | "leader" | undefined {
  if (!node) return undefined;
  if (path(node) === "$gameParty.leader()") return "leader";
  if (node.type === "CallExpression" && path(node.callee) === "$gameActors.actor") {
    const a = id(node.arguments[0]);
    return typeof a === "number" ? a : undefined;
  }
  return undefined;
}

export function analyzeScript(code: string): ScriptAnalysis {
  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", allowReturnOutsideFunction: true, allowAwaitOutsideFunction: true });
  } catch {
    return { effects: [], parsed: false, dynamic: 0 };
  }
  const effects: Effect[] = [];
  let dynamic = 0;
  const add = (e: Effect | undefined) => {
    if (e) effects.push(e);
    else dynamic++;
  };
  const withId = (i: Id | undefined, make: (i: Id) => Effect) => add(i === undefined ? undefined : make(i));

  walk.full(ast, (raw) => {
    const node = raw as Node;
    if (node.type === "MemberExpression" && node.computed && path(node.object) === "$gameQuests._data") {
      withId(id(node.property), (q) => ({ entity: { kind: "quest", id: q }, access: "read", how: "status" }));
      return;
    }
    if (node.type !== "CallExpression") return;
    const callee = node.callee as Node;
    const fn = path(callee);
    const args = node.arguments as Node[];
    const method = callee.type === "MemberExpression" && !callee.computed ? callee.property.name : undefined;

    switch (fn) {
      case "$gameSwitches.value":
        return withId(id(args[0]), (s) => ({ entity: { kind: "switch", id: s }, access: "read", how: "value" }));
      case "$gameSwitches.setValue":
        return withId(id(args[0]), (s) => ({ entity: { kind: "switch", id: s }, access: "write", how: `= ${code.slice(args[1].start, args[1].end)}` }));
      case "$gameVariables.value":
        // As an argument to another API it's also reported there; the read is real either way.
        return withId(id(args[0]), (v) => ({ entity: { kind: "variable", id: v }, access: "read", how: "value" }));
      case "$gameVariables.setValue":
        return withId(id(args[0]), (v) => ({ entity: { kind: "variable", id: v }, access: "write", how: `= ${code.slice(args[1].start, args[1].end)}` }));
      case "$gameSelfSwitches.value":
      case "$gameSelfSwitches.setValue": {
        const key = selfKey(args[0]);
        return add(key && { entity: { kind: "selfSwitch", ...key }, access: fn.endsWith("setValue") ? "write" : "read", how: fn.endsWith("setValue") ? `= ${code.slice(args[1].start, args[1].end)}` : "value" });
      }
      case "$gameParty.hasItem":
      case "$gameParty.numItems": {
        const item = itemRef(args[0]);
        if (!item) return add(undefined);
        return withId(item.id, (i) => ({ entity: { kind: item.kind, id: i }, access: "read", how: fn.endsWith("hasItem") ? "has?" : "count" }));
      }
      case "$gameParty.gainItem":
      case "$gameParty.loseItem": {
        const item = itemRef(args[0]);
        if (!item) return add(undefined);
        const amount = args[1] ? id(args[1]) : 1;
        const lose = fn.endsWith("loseItem");
        return withId(item.id, (i) => ({ entity: { kind: item.kind, id: i }, access: "write", how: lose ? "lose" : "gain", ...(amount !== undefined ? { amount, sign: lose ? -1 : 1 } : {}) }));
      }
      case "$gameParty.gainGold":
      case "$gameParty.loseGold": {
        const amount = id(args[0]);
        const lose = fn.endsWith("loseGold");
        return add({ entity: { kind: "gold" }, access: "write", how: lose ? "lose" : "gain", ...(amount !== undefined ? { amount, sign: lose ? -1 : 1 } : {}) });
      }
      case "$gameParty.gold":
        return add({ entity: { kind: "gold" }, access: "read", how: "value" });
      case "$gameTemp.reserveCommonEvent":
        return withId(id(args[0]), (c) => ({ entity: { kind: "commonEvent", id: c }, access: "call", how: "reserve" }));
    }

    // $gameMap.event(N).start()
    if (method === "start" && callee.object.type === "CallExpression" && path(callee.object.callee) === "$gameMap.event") {
      return withId(id(callee.object.arguments[0]), (e) => ({ entity: { kind: "mapEvent", mapId: "current", eventId: e }, access: "call", how: "start" }));
    }
    // <actor>.hasSkill / isLearnedSkill / learnSkill / forgetSkill
    if (method && ["hasSkill", "isLearnedSkill", "learnSkill", "forgetSkill"].includes(method)) {
      const actor = actorRef(callee.object);
      if (actor === undefined) return;
      const write = method === "learnSkill" || method === "forgetSkill";
      return withId(id(args[0]), (s) => ({
        entity: { kind: "skill", id: s },
        access: write ? "write" : "read",
        how: `${method === "learnSkill" ? "learn" : method === "forgetSkill" ? "forget" : "has?"} (${actor === "leader" ? "leader" : `actor ${actor}`})`,
      }));
    }
  });
  return { effects, parsed: true, dynamic };
}

/**
 * The value of a JS expression used as an id (plugin arguments the plugin `eval`s or parses):
 * a constant, `$gameVariables.value(N)`, or the running event's id/map ("self"/"current").
 */
export function expressionId(expr: string): Id | "self" | "current" | undefined {
  const trimmed = expr.trim();
  if (/^-?\d+$/.test(trimmed)) return Number(trimmed);
  let node: Node;
  try {
    node = acorn.parseExpressionAt(trimmed, 0, { ecmaVersion: "latest" }) as Node;
  } catch {
    return undefined;
  }
  if (node.end !== trimmed.length) return undefined;
  const p = path(node);
  if (p === "this._eventId" || p === "this.eventId()") return "self";
  if (p === "this._mapId" || p === "$gameMap.mapId()") return "current";
  return id(node);
}
