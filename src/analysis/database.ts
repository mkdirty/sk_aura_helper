// Effects that live in the database rather than in events: class skill learnings, item and
// skill effects (learn a skill, run a common event, add/remove states), skill-granting traits,
// and enemy drops. Effect/trait codes come from the engine's Game_Action.EFFECT_* and
// Game_BattlerBase.TRAIT_* constants.

import fs from "node:fs";
import path from "node:path";
import type { GameData } from "../data/game-data.ts";
import type { Effect } from "./effects.ts";
import type { Ref } from "./xref.ts";

/** `Class.PREFIX_NAME = N` constants from the engine source. */
export function engineConstants(gameDir: string, prefix: string): Record<string, number> {
  const src = fs.readFileSync(path.join(gameDir, "js/rmmz_objects.js"), "utf8");
  const out: Record<string, number> = {};
  const re = new RegExp(`${prefix.replace(/\./g, "\\.")}(\\w+)\\s*=\\s*(\\d+);`, "g");
  for (const m of src.matchAll(re)) out[m[1]] = Number(m[2]);
  return out;
}

const ITEM_KIND_BY_DROP = { 1: "item", 2: "weapon", 3: "armor" } as const;

type Row = { id: number; name: string; [k: string]: any };

export function databaseRefs(data: GameData): Ref[] {
  const EFFECT = engineConstants(data.dir, "Game_Action.EFFECT_");
  const TRAIT = engineConstants(data.dir, "Game_BattlerBase.TRAIT_");
  const refs: Ref[] = [];
  const add = (table: string, id: number, index: number, effect: Effect) =>
    refs.push({ effect, site: { source: { kind: "database", table, id }, index, dead: false, via: [] } });

  const classes = data.classes as Array<Row | null>;
  for (const c of classes) {
    if (!c) continue;
    (c.learnings ?? []).forEach((l: { level: number; skillId: number }, i: number) =>
      add("classes", c.id, i, { entity: { kind: "skill", id: l.skillId }, access: "write", how: `learn at level ${l.level} (class ${c.id})` }),
    );
  }

  const usable: Array<[string, Array<Row | null>]> = [
    ["items", data.items as Array<Row | null>],
    ["skills", data.skills as Array<Row | null>],
  ];
  for (const [table, rows] of usable) {
    const user = table === "items" ? "using item" : "using skill";
    for (const row of rows) {
      if (!row) continue;
      (row.effects ?? []).forEach((e: { code: number; dataId: number }, i: number) => {
        if (e.code === EFFECT.LEARN_SKILL) add(table, row.id, i, { entity: { kind: "skill", id: e.dataId }, access: "write", how: `learn (${user} ${row.id})` });
        else if (e.code === EFFECT.COMMON_EVENT) add(table, row.id, i, { entity: { kind: "commonEvent", id: e.dataId }, access: "call", how: `${user} ${row.id}` });
        else if (e.code === EFFECT.ADD_STATE && e.dataId > 0) add(table, row.id, i, { entity: { kind: "state", id: e.dataId }, access: "write", how: `add (${user} ${row.id})` });
        else if (e.code === EFFECT.REMOVE_STATE) add(table, row.id, i, { entity: { kind: "state", id: e.dataId }, access: "write", how: `remove (${user} ${row.id})` });
      });
    }
  }

  const traitTables: Array<[string, Array<Row | null>, string]> = [
    ["actors", data.actors as Array<Row | null>, "actor"],
    ["classes", classes, "class"],
    ["weapons", data.weapons as Array<Row | null>, "while weapon equipped"],
    ["armors", data.armors as Array<Row | null>, "while armor equipped"],
    ["states", data.states as Array<Row | null>, "while state"],
    ["enemies", data.enemies as Array<Row | null>, "enemy"],
  ];
  for (const [table, rows, label] of traitTables) {
    for (const row of rows) {
      if (!row) continue;
      (row.traits ?? []).forEach((t: { code: number; dataId: number }, i: number) => {
        if (t.code === TRAIT.SKILL_ADD) add(table, row.id, i, { entity: { kind: "skill", id: t.dataId }, access: "write", how: `granted (${label} ${row.id})` });
      });
    }
  }

  for (const enemy of data.enemies as Array<Row | null>) {
    if (!enemy) continue;
    (enemy.dropItems ?? []).forEach((d: { kind: number; dataId: number; denominator: number }, i: number) => {
      const kind = ITEM_KIND_BY_DROP[d.kind as 1 | 2 | 3];
      if (kind) add("enemies", enemy.id, i, { entity: { kind, id: d.dataId }, access: "write", how: `drop 1/${d.denominator} (enemy ${enemy.id})`, amount: 1, sign: 1 });
    });
  }
  return refs;
}
