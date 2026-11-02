// Display names for ids, e.g. `S22 noCollar`, `item 7 "Potion"`, `CE11 endDay`.

import type { GameData, GameMap } from "../data/game-data.ts";
import type { CharacterRef, ItemKind } from "./ops.ts";

const pad3 = (n: number) => String(n).padStart(3, "0");
const quoted = (s: string | undefined) => (s ? ` ${JSON.stringify(s)}` : "");

export class Names {
  private readonly data: GameData;
  /** The map whose events "event N" refers to, if any. */
  currentMap?: GameMap;

  constructor(data: GameData) {
    this.data = data;
  }

  switch(id: number) {
    const name = this.data.system.switches[id];
    return `S${id}${name ? ` ${name}` : ""}`;
  }
  variable(id: number) {
    const name = this.data.system.variables[id];
    return `V${id}${name ? ` ${name}` : ""}`;
  }
  switchRange(from: number, to: number) {
    return from === to ? this.switch(from) : `S${from}..S${to}`;
  }
  variableRange(from: number, to: number) {
    return from === to ? this.variable(from) : `V${from}..V${to}`;
  }
  commonEvent(id: number) {
    const name = this.data.commonEvents[id]?.name;
    return `CE${id}${name ? ` ${name}` : ""}`;
  }
  map(id: number) {
    const name = this.data.mapName(id);
    return `Map${pad3(id)}${name ? ` ${name}` : ""}`;
  }
  item(kind: ItemKind, id: number) {
    const table = kind === "item" ? this.data.items : kind === "weapon" ? this.data.weapons : this.data.armors;
    return `${kind} ${id}${quoted(table[id]?.name)}`;
  }
  actor(id: number) {
    return `actor ${id}${quoted(this.data.actors[id]?.name)}`;
  }
  class(id: number) {
    return `class ${id}${quoted(this.data.classes[id]?.name)}`;
  }
  skill(id: number) {
    return `skill ${id}${quoted(this.data.skills[id]?.name)}`;
  }
  state(id: number) {
    return `state ${id}${quoted(this.data.states[id]?.name)}`;
  }
  enemy(id: number) {
    return `enemy ${id}${quoted(this.data.enemies[id]?.name)}`;
  }
  troop(id: number) {
    return `troop ${id}${quoted(this.data.troops[id]?.name)}`;
  }
  animation(id: number) {
    return `animation ${id}${quoted(this.data.animations[id]?.name)}`;
  }
  event(id: number) {
    return `event ${id}${quoted(this.currentMap?.events[id]?.name)}`;
  }
  character(c: CharacterRef) {
    return c.kind === "player" ? "player" : c.kind === "this" ? "this event" : this.event(c.id);
  }
}
