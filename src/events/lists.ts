// Every event command list in the game, with where it lives.

import type { GameData, RawCommand } from "../data/game-data.ts";

export type ListSource =
  /** `original`: a templated event's own page (runs only when its template calls it). */
  | { kind: "map"; mapId: number; eventId: number; page: number; original?: true }
  | { kind: "common"; id: number }
  | { kind: "troop"; troopId: number; page: number }
  /** A database row (no command list), e.g. a class's skill learnings or an item's effects. */
  | { kind: "database"; table: string; id: number };

export interface CommandList {
  source: ListSource;
  list: RawCommand[];
}

const pad = (n: number) => String(n).padStart(3, "0");

/** Short, stable label, e.g. `Map007/E8/p1`, `CE11`, `Troop12/p0`. Pages are 0-based. */
export function sourceLabel(s: ListSource): string {
  switch (s.kind) {
    case "map":
      return `Map${pad(s.mapId)}/E${s.eventId}/p${s.page}${s.original ? "/original" : ""}`;
    case "common":
      return `CE${s.id}`;
    case "troop":
      return `Troop${s.troopId}/p${s.page}`;
    case "database":
      return `${s.table}[${s.id}]`;
  }
}

export function* commonEventLists(data: GameData): Generator<CommandList> {
  for (const ce of data.commonEvents) if (ce) yield { source: { kind: "common", id: ce.id }, list: ce.list };
}

/**
 * A map's event pages as they run: templated events (TemplateEvent) run their template's pages;
 * their own pages are included too, marked `original`.
 */
export function* mapLists(data: GameData, mapId: number): Generator<CommandList> {
  for (const event of data.map(mapId).events) {
    if (!event) continue;
    const pages = data.effectivePages(event);
    for (const [page, p] of pages.entries()) yield { source: { kind: "map", mapId, eventId: event.id, page }, list: p.list };
    if (pages !== event.pages) {
      for (const [page, p] of event.pages.entries()) yield { source: { kind: "map", mapId, eventId: event.id, page, original: true }, list: p.list };
    }
  }
}

export function* troopLists(data: GameData): Generator<CommandList> {
  for (const troop of data.troops) {
    if (!troop) continue;
    for (const [page, p] of troop.pages.entries()) yield { source: { kind: "troop", troopId: troop.id, page }, list: p.list };
  }
}

/**
 * All lists: common events, then maps in id order, then troops. The template map is skipped:
 * its events run as the events that use them, not on that map.
 */
export function* allLists(data: GameData): Generator<CommandList> {
  yield* commonEventLists(data);
  for (const mapId of data.mapIds()) if (mapId !== data.templateMapId()) yield* mapLists(data, mapId);
  yield* troopLists(data);
}
