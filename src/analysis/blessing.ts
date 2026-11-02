// Blessing (auramzui/TLB_SKABlessMenu.js): turns an item into its blessed version.
//
// TLB.SKABlessMenu.itemValid: an item can be blessed when it has <blessed_version:N>, isn't
// itself <blessed:true> or <cannot_bless:true>, and has one of the item-type tags listed in the
// bless skill's <canbless:recovery,bomb,…>. The bless skill is $gameTemp.lastActionData(0): the
// skill just used (CE272, run by the skills), or set by script before opening (the White
// Priestess's gold mode). Each blessing loses the item and gains the blessed one, paying MP
// (mode 1) or gold (mode 2).

import type { GameData } from "../data/game-data.ts";
import { noteMeta } from "./notes.ts";

export interface Blessing {
  from: number;
  to: number;
  /** Bless skills whose <canbless> types cover the item. */
  skills: number[];
}

type Row = { id: number; note?: string } | null;

export function blessings(items: Row[], skills: Row[]): Blessing[] {
  const blessSkills = skills
    .filter((s): s is NonNullable<Row> => !!s)
    .map((s) => ({ id: s.id, types: String(noteMeta(s.note ?? "").canbless ?? "").split(",").filter(Boolean) }))
    .filter((s) => s.types.length > 0);
  const out: Blessing[] = [];
  for (const item of items) {
    if (!item) continue;
    const meta = noteMeta(item.note ?? "");
    const to = parseInt(String(meta.blessed_version));
    if (Number.isNaN(to) || !items[to] || meta.blessed === "true" || meta.cannot_bless === "true") continue;
    const by = blessSkills.filter((s) => s.types.some((t) => meta[t] === "true")).map((s) => s.id);
    if (by.length > 0) out.push({ from: item.id, to, skills: by });
  }
  return out;
}

export const gameBlessings = (data: GameData) => blessings(data.items as Row[], data.skills as Row[]);
