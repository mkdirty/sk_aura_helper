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

/**
 * Names bound to known constant values in the script being analyzed: `const x = 5`,
 * `const keys = [[141, 15, 'A'], …]`, and `for (const k of keys)` (k takes each element).
 * Deliberately naive about scope: a name is only bound if every binding of it agrees.
 */
let bindings = new Map<string, unknown[]>();
/** Names bound once to an array expression (`const key = [$gameMap.mapId(), e, 'A']`). */
let arrayInits = new Map<string, Node>();

/** The literal value of a node (numbers, strings, booleans, arrays of those), or undefined. */
function literal(node: Node | undefined): unknown {
  if (!node) return undefined;
  if (node.type === "Literal") return node.value;
  if (node.type === "UnaryExpression" && node.operator === "-" && node.argument.type === "Literal" && typeof node.argument.value === "number") return -node.argument.value;
  if (node.type === "ArrayExpression") {
    const items = (node.elements as Node[]).map(literal);
    return items.every((x) => x !== undefined) ? items : undefined;
  }
  return undefined;
}

function collectBindings(ast: acorn.Node): Map<string, unknown[]> {
  const found = new Map<string, unknown[][]>();
  const bind = (name: string, values: unknown[] | undefined) => {
    if (!found.has(name)) found.set(name, []);
    found.get(name)!.push(values ?? []);
  };
  const loops: Node[] = [];
  const loopDeclarators = new Set<Node>();
  const assigned = new Set<string>();
  walk.full(ast, (raw) => {
    const node = raw as Node;
    if (node.type === "ForOfStatement" && node.left.type === "VariableDeclaration") {
      loops.push(node);
      for (const d of node.left.declarations) loopDeclarators.add(d);
    }
  });
  const arrays = new Map<string, unknown[]>();
  const inits = new Map<string, Node[]>();
  walk.full(ast, (raw) => {
    const node = raw as Node;
    if (node.type === "VariableDeclarator" && node.id.type === "Identifier" && !loopDeclarators.has(node)) {
      if (!inits.has(node.id.name)) inits.set(node.id.name, []);
      inits.get(node.id.name)!.push(node.init);
      const v = literal(node.init);
      if (Array.isArray(v)) arrays.set(node.id.name, v);
      bind(node.id.name, v === undefined ? undefined : [v]);
    }
    if (node.type === "AssignmentExpression" && node.left.type === "Identifier") {
      bind(node.left.name, undefined);
      assigned.add(node.left.name);
    }
  });
  for (const loop of loops) {
    const target = loop.left.declarations[0]?.id;
    if (target?.type !== "Identifier") continue;
    const source = loop.right.type === "Identifier" ? arrays.get(loop.right.name) : (literal(loop.right) as unknown[] | undefined);
    bind(target.name, Array.isArray(source) ? source : undefined);
  }
  // Names declared exactly once with an array expression and never reassigned.
  arrayInits = new Map();
  for (const [name, ns] of inits) if (ns.length === 1 && ns[0]?.type === "ArrayExpression" && !assigned.has(name)) arrayInits.set(name, ns[0]);
  const out = new Map<string, unknown[]>();
  for (const [name, all] of found) {
    if (all.length && all.every((vs) => vs.length)) out.set(name, [...new Map(all.flat().map((v) => [JSON.stringify(v), v])).values()]);
  }
  return out;
}

/** Every value a node may have, when they're all known (literals, or bound names). */
function values(node: Node | undefined): unknown[] | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") return bindings.get(node.name);
  const v = literal(node);
  return v === undefined ? undefined : [v];
}

/** Ids for a node that may stand for several (a loop variable over constants). */
function ids(node: Node | undefined): Id[] | undefined {
  const single = id(node);
  if (single !== undefined) return [single];
  const vs = values(node);
  return vs && vs.every((v) => typeof v === "number") ? (vs as number[]) : undefined;
}

/** A constant number, `$gameVariables.value(N)`, or undefined. */
function id(node: Node | undefined): Id | undefined {
  if (!node) return undefined;
  if (node.type === "Identifier") {
    const vs = bindings.get(node.name);
    return vs?.length === 1 && typeof vs[0] === "number" ? vs[0] : undefined;
  }
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

type SelfKey = { mapId: Id | "current"; eventId: Id | "self"; letter: string };

/** Self-switch keys a node may be: an array literal, or a name bound to constant keys. */
function selfKeys(node: Node | undefined): SelfKey[] | undefined {
  if (node?.type === "Identifier") {
    const vs = bindings.get(node.name);
    if (!vs) {
      const init = arrayInits.get(node.name);
      const key = init && selfKey(init);
      return key && [key];
    }
    const keys = vs.map((v) =>
      Array.isArray(v) && v.length === 3 && typeof v[0] === "number" && typeof v[1] === "number" && typeof v[2] === "string" ? { mapId: v[0], eventId: v[1], letter: v[2] } : undefined,
    );
    return keys.every(Boolean) ? (keys as SelfKey[]) : undefined;
  }
  const key = selfKey(node);
  return key && [key];
}

/** Self-switch key `[map, event, "A"]`. "current"/"self" stand for the running event's map/id. */
function selfKey(node: Node | undefined): SelfKey | undefined {
  if (node?.type !== "ArrayExpression" || node.elements.length !== 3) return undefined;
  const [m, e, l] = node.elements as Node[];
  const mapPath = path(m);
  const eventPath = path(e);
  const mapId: Id | "current" | undefined = mapPath === "this._mapId" || mapPath === "$gameMap.mapId()" ? "current" : id(m);
  const eventId: Id | "self" | undefined = eventPath === "this._eventId" || eventPath === "this.eventId()" ? "self" : id(e);
  const letter = l?.type === "Literal" && typeof l.value === "string" ? l.value : undefined;
  if (letter === undefined || (mapId === undefined && eventId === undefined)) return undefined;
  // A partly known key (e.g. "some event on this map, letter A") is kept, with unknown parts.
  return { mapId: mapId ?? { unknown: "script" }, eventId: eventId ?? { unknown: "script" }, letter };
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
  bindings = collectBindings(ast); // also fills arrayInits
  const effects: Effect[] = [];
  let dynamic = 0;
  const add = (e: Effect | undefined) => {
    if (e) effects.push(e);
    else dynamic++;
  };
  const withId = (i: Id | undefined, make: (i: Id) => Effect) => add(i === undefined ? undefined : make(i));
  // Writes (and reads) whose id can't be followed are still recorded, with an unknown id, so
  // queries and the runtime cross-check know something touches that kind of thing here.
  const UNKNOWN: Id = { unknown: "script" };
  const withIds = (is: Id[] | undefined, make: (i: Id) => Effect) => {
    if (is) return is.forEach((i) => add(make(i)));
    dynamic++;
    effects.push(make(UNKNOWN));
  };

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
        return withIds(ids(args[0]), (s) => ({ entity: { kind: "switch", id: s }, access: "read", how: "value" }));
      case "$gameSwitches.setValue":
        return withIds(ids(args[0]), (s) => ({ entity: { kind: "switch", id: s }, access: "write", how: `= ${code.slice(args[1].start, args[1].end)}` }));
      case "$gameVariables.value":
        // As an argument to another API it's also reported there; the read is real either way.
        return withIds(ids(args[0]), (v) => ({ entity: { kind: "variable", id: v }, access: "read", how: "value" }));
      case "$gameVariables.setValue":
        return withIds(ids(args[0]), (v) => ({ entity: { kind: "variable", id: v }, access: "write", how: `= ${code.slice(args[1].start, args[1].end)}` }));
      case "$gameSelfSwitches.value":
      case "$gameSelfSwitches.setValue": {
        const write = fn.endsWith("setValue");
        const keys = selfKeys(args[0]);
        if (!keys) {
          dynamic++;
          effects.push({ entity: { kind: "selfSwitch", mapId: UNKNOWN, eventId: UNKNOWN, letter: "?" }, access: write ? "write" : "read", how: "dynamic key" });
          return;
        }
        for (const key of keys) add({ entity: { kind: "selfSwitch", ...key }, access: write ? "write" : "read", how: write ? `= ${code.slice(args[1].start, args[1].end)}` : "value" });
        return;
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
        if (item.id === undefined) item.id = UNKNOWN;
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

    // GALV_MoveRouteExtrasMZ: <character>.sswitch(letter, status, eventId?, mapId?) sets that
    // character's own self switch (key [mapId || current map, eventId || character id, letter]).
    if (method === "sswitch" && args[0]?.type === "Literal" && typeof args[0].value === "string") {
      const owner = callee.object as Node;
      const ownerId: Id | "self" | undefined =
        owner.type === "ThisExpression" ? "self" : owner.type === "CallExpression" && path(owner.callee) === "$gameMap.event" ? id(owner.arguments[0]) : undefined;
      const eventId = args[2] && !(args[2].type === "Literal" && !args[2].value) ? id(args[2]) : ownerId;
      const mapId = args[3] && !(args[3].type === "Literal" && !args[3].value) ? id(args[3]) : "current";
      if (eventId === undefined || mapId === undefined) return add(undefined);
      return add({ entity: { kind: "selfSwitch", mapId, eventId, letter: args[0].value }, access: "write", how: `= ${args[1] ? code.slice(args[1].start, args[1].end) : "undefined"}` });
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
