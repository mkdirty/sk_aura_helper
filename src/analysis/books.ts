// Books (auramz/books.js): what finishing a book does, derived from the book item's note tags.
//
// Aura reads by using the item (CE607 statBooks / CE608 skillBooks); companions are gifted a
// book (CE882) and read it nightly (CE883 → books:readBook). Both paths end in the plugin's
// completeSkillBook / completeStatBook, which read the item's notes:
//   <skillId:N>   learn skill N;  <forgetId:M>  forget skill M (the previous rank)
//   <statplus:["mat:2", "wp:10"]>  add to a parameter, or to the willpower variable for "wp"
// Lewd books (<lewdmin>) have neither tag and go through other events.

import type { GameData } from "../data/game-data.ts";
import type { Effect } from "./effects.ts";

/** Note tags as the engine parses them (DataManager.extractMetadata). */
export function noteMeta(note: string): Record<string, string | true> {
  const meta: Record<string, string | true> = {};
  for (const m of note.matchAll(/<([^<>:]+)(:?)([^>]*)>/g)) meta[m[1]] = m[2] === ":" ? m[3] : true;
  return meta;
}

export interface Book {
  itemId: number;
  /** Persistent effects of finishing the book; `reader` names who, when known ("actor 2"). */
  effects: (reader?: string) => Effect[];
}

type ItemRow = { id: number; note?: string } | null;

/**
 * Books that do something when finished. Parameter gains (statplus other than "wp") aren't
 * modelled, the same as the engine's Change Parameter command: the index has no parameter entity.
 */
export function bookCompletions(items: ItemRow[], willpowerVariableId: number): Book[] {
  const books: Book[] = [];
  for (const item of items) {
    if (!item) continue;
    const meta = noteMeta(item.note ?? "");
    if (meta.book !== "true") continue;
    const skillId = typeof meta.skillId === "string" ? parseInt(meta.skillId) : NaN;
    const forgetId = typeof meta.forgetId === "string" ? parseInt(meta.forgetId) : NaN;
    let stats: string[] = [];
    if (typeof meta.statplus === "string") {
      try {
        stats = JSON.parse(meta.statplus);
      } catch {
        stats = [];
      }
    }
    const wp = stats.filter((s) => s.split(":")[0] === "wp").map((s) => parseInt(s.split(":")[1]));
    // readBook checks isStatBook first, so a book with both tags would only apply its stats.
    const isStat = meta.statplus !== undefined && meta.statplus !== "";
    const isSkill = !isStat && !Number.isNaN(skillId);
    if (!isSkill && wp.length === 0) continue;
    books.push({
      itemId: item.id,
      effects: (reader) => {
        const by = reader ? `${reader} finishes book item ${item.id}` : `finishing book item ${item.id}`;
        const out: Effect[] = [];
        if (isSkill) {
          out.push({ entity: { kind: "skill", id: skillId }, access: "write", how: `learn (${by})` });
          if (!Number.isNaN(forgetId)) out.push({ entity: { kind: "skill", id: forgetId }, access: "write", how: `forget (${by})` });
        }
        for (const v of wp) {
          out.push({ entity: { kind: "variable", id: willpowerVariableId }, access: "read", how: "value" });
          out.push({ entity: { kind: "variable", id: willpowerVariableId }, access: "write", how: `+= ${v} (${by})` });
        }
        return out;
      },
    });
  }
  return books;
}

/** The game's books, with the willpower variable from the plugin's parameters. */
export const gameBooks = (data: GameData): Book[] =>
  bookCompletions(data.items as ItemRow[], Number(data.pluginParams("books").willpowerVariableId));
