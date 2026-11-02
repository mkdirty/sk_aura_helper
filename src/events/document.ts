// Whole-file renderings: a map (all events and pages), a common event, a troop.
// Every list is decoded once; issues are reported to `onDecoded` for the coverage tally.

import type { CommonEvent, GameData, MapEventPage, Troop, TroopPage } from "../data/game-data.ts";
import { decodeList, type Decoded, type DecodeOptions } from "./decode.ts";
import type { CommandList, ListSource } from "./lists.ts";
import { Names } from "./names.ts";
import { renderOps, type TextMode } from "./render.ts";

export interface DocumentOptions {
  data: GameData;
  decode: DecodeOptions;
  text: TextMode;
  /** Called with every decoded list (for coverage). */
  onDecoded?: (list: CommandList, decoded: Decoded) => void;
}

const TRIGGERS = ["action button", "player touch", "event touch", "autorun", "parallel"];
const PRIORITIES = ["below characters", "same as characters", "above characters"];
const CE_TRIGGERS = ["none", "autorun", "parallel"];
const SPANS = ["battle", "turn", "moment"];

function body(source: ListSource, list: CommandList["list"], o: DocumentOptions, names: Names, depth: number): string[] {
  const decoded = decodeList(list, o.decode);
  o.onDecoded?.({ source, list }, decoded);
  const lines = renderOps(decoded.ops, { names, text: o.text }, depth);
  return lines.length ? lines : ["    ".repeat(depth) + "(empty)"];
}

function pageConditions(c: MapEventPage["conditions"], names: Names): string[] {
  const out: string[] = [];
  if (c.switch1Valid) out.push(`${names.switch(c.switch1Id)} is ON`);
  if (c.switch2Valid) out.push(`${names.switch(c.switch2Id)} is ON`);
  if (c.variableValid) out.push(`${names.variable(c.variableId)} >= ${c.variableValue}`);
  if (c.selfSwitchValid) out.push(`self ${c.selfSwitchCh} is ON`);
  if (c.itemValid) out.push(`has ${names.item("item", c.itemId)}`);
  if (c.actorValid) out.push(`${names.actor(c.actorId)} in party`);
  return out;
}

export function renderMap(mapId: number, o: DocumentOptions): string {
  const map = o.data.map(mapId);
  const names = new Names(o.data);
  names.currentMap = map;
  const out = [`# ${names.map(mapId)}${map.displayName ? ` (display name ${JSON.stringify(map.displayName)})` : ""}`];
  if (map.note) out.push(`# note: ${map.note.replace(/\n/g, " ⏎ ")}`);
  for (const event of map.events) {
    if (!event) continue;
    out.push("", `=== E${event.id} ${JSON.stringify(event.name)} at (${event.x}, ${event.y}) ===`);
    if (event.note) out.push(`note: ${event.note.replace(/\n/g, " ⏎ ")}`);
    event.pages.forEach((page, index) => {
      const conds = pageConditions(page.conditions, names);
      const img = page.image.characterName ? `${page.image.characterName}#${page.image.characterIndex}` : page.image.tileId ? `tile ${page.image.tileId}` : "none";
      out.push(
        `--- page ${index}: ${TRIGGERS[page.trigger] ?? `trigger ${page.trigger}`}, ${PRIORITIES[page.priorityType] ?? ""}, image ${img}` +
          `${conds.length ? `; when ${conds.join(" and ")}` : ""} ---`,
      );
      out.push(...body({ kind: "map", mapId, eventId: event.id, page: index }, page.list, o, names, 1));
    });
  }
  return out.join("\n") + "\n";
}

export function renderCommonEvent(ce: CommonEvent, o: DocumentOptions): string {
  const names = new Names(o.data);
  const trigger = CE_TRIGGERS[ce.trigger] ?? `trigger ${ce.trigger}`;
  const out = [`=== ${names.commonEvent(ce.id)} (${trigger}${ce.trigger ? ` while ${names.switch(ce.switchId)} is ON` : ""}) ===`];
  out.push(...body({ kind: "common", id: ce.id }, ce.list, o, names, 1));
  return out.join("\n") + "\n";
}

function troopConditions(c: TroopPage["conditions"], names: Names): string[] {
  const out: string[] = [];
  if (c.turnEnding) out.push("end of turn");
  if (c.turnValid) out.push(c.turnB ? `turn ${c.turnA} + ${c.turnB}*X` : `turn ${c.turnA}`);
  if (c.enemyValid) out.push(`enemy #${c.enemyIndex} hp <= ${c.enemyHp}%`);
  if (c.actorValid) out.push(`${names.actor(c.actorId)} hp <= ${c.actorHp}%`);
  if (c.switchValid) out.push(`${names.switch(c.switchId)} is ON`);
  return out;
}

export function renderTroop(troop: Troop, o: DocumentOptions): string {
  const names = new Names(o.data);
  const members = troop.members.map((m, i) => `#${i} ${names.enemy(m.enemyId)}${m.hidden ? " (hidden)" : ""}`).join(", ");
  const out = [`=== ${names.troop(troop.id)} ===`, `members: ${members || "none"}`];
  troop.pages.forEach((page, index) => {
    const conds = troopConditions(page.conditions, names);
    out.push(`--- page ${index}: span ${SPANS[page.span] ?? page.span}${conds.length ? `; when ${conds.join(" and ")}` : ""} ---`);
    out.push(...body({ kind: "troop", troopId: troop.id, page: index }, page.list, o, names, 1));
  });
  return out.join("\n") + "\n";
}
