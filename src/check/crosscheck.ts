// Runtime cross-check of the cross-reference index.
//
// Runs common events in the headless harness and compares the state changes the game actually
// made with what the index predicts that event (and everything it calls) can write. A change
// the index can't account for is a bug in the index, or a gap worth knowing about.
//
// This tests soundness ("did the index miss a write?") on the paths the run takes; it says
// nothing about branches not taken, or about predicted writes that didn't happen.

import type { Entity } from "../analysis/effects.ts";
import type { Ref, XrefIndex } from "../analysis/xref.ts";
import type { GameData } from "../data/game-data.ts";
import type { Harness, StopReason } from "../harness/harness.ts";
import type { Change } from "../harness/tracker.ts";

/**
 * - explained: a constant write in the event or what it calls
 * - visited-map: only by the events of a map the run transferred to (weaker attribution)
 * - dynamic: only by a write whose id isn't constant
 * - unexplained: nothing in the index accounts for it
 */
export type Verdict = "explained" | "visited-map" | "dynamic" | "unexplained";

export interface CheckedChange {
  change: Change;
  verdict: Verdict;
}

/** What a check run started: a common event, or one page of a map event. */
export type Entry = { kind: "ce"; id: number } | { kind: "page"; mapId: number; eventId: number; page: number };

export const entryLabel = (e: Entry) => (e.kind === "ce" ? `CE${e.id}` : `Map${String(e.mapId).padStart(3, "0")}/E${e.eventId}/p${e.page}`);

export interface RunCheck {
  entry: Entry;
  stop: StopReason | "error";
  error?: string;
  frames: number;
  /** Maps the run transferred to. */
  visited: number[];
  changes: CheckedChange[];
}

/** Everything a common event may write, including through the events it calls. */
export class StaticWrites {
  private readonly byCe = new Map<number, Ref[]>();
  private readonly calls = new Map<number, Set<number>>();
  private readonly closure = new Map<number, Ref[]>();
  /** Per map: writes in its event pages, and the common events those pages call. */
  private readonly byMap = new Map<number, { writes: Ref[]; calls: Set<number> }>();
  /** Per map event page ("map/event/page"): its writes and the common events it calls. */
  private readonly byPage = new Map<string, { writes: Ref[]; calls: Set<number> }>();

  constructor(index: XrefIndex) {
    for (const r of index.refs) {
      const s = r.site.source;
      if (s.kind === "map" && !r.site.dead) {
        const m = this.byMap.get(s.mapId) ?? { writes: [], calls: new Set() };
        if (r.effect.access === "write") m.writes.push(r);
        if (r.effect.access === "call" && r.effect.entity.kind === "commonEvent" && typeof r.effect.entity.id === "number") m.calls.add(r.effect.entity.id);
        this.byMap.set(s.mapId, m);
        const key = `${s.mapId}/${s.eventId}/${s.page}${s.original ? "/original" : ""}`;
        const p = this.byPage.get(key) ?? { writes: [], calls: new Set() };
        if (r.effect.access === "write") p.writes.push(r);
        if (r.effect.access === "call" && r.effect.entity.kind === "commonEvent" && typeof r.effect.entity.id === "number") p.calls.add(r.effect.entity.id);
        this.byPage.set(key, p);
      }
      if (s.kind !== "common" || r.site.dead) continue;
      if (r.effect.access === "write") {
        if (!this.byCe.has(s.id)) this.byCe.set(s.id, []);
        this.byCe.get(s.id)!.push(r);
      }
      if (r.effect.access === "call" && r.effect.entity.kind === "commonEvent" && typeof r.effect.entity.id === "number") {
        if (!this.calls.has(s.id)) this.calls.set(s.id, new Set());
        this.calls.get(s.id)!.add(r.effect.entity.id);
      }
    }
  }

  /** What one map event page (and the common events it calls) may write. */
  pageWrites(mapId: number, eventId: number, page: number): Ref[] {
    const p = this.byPage.get(`${mapId}/${eventId}/${page}`);
    if (!p) return [];
    return [...p.writes, ...[...p.calls].flatMap((ce) => this.writes(ce))];
  }

  /** What a map's events (and the common events they call) may write. */
  mapWrites(mapId: number): Ref[] {
    const m = this.byMap.get(mapId);
    if (!m) return [];
    return [...m.writes, ...[...m.calls].flatMap((ce) => this.writes(ce))];
  }

  writes(ce: number): Ref[] {
    let out = this.closure.get(ce);
    if (out) return out;
    out = [];
    const seen = new Set<number>();
    const visit = (id: number) => {
      if (seen.has(id)) return;
      seen.add(id);
      out!.push(...(this.byCe.get(id) ?? []));
      for (const callee of this.calls.get(id) ?? []) visit(callee);
    };
    visit(ce);
    this.closure.set(ce, out);
    return out;
  }
}

const isConst = (v: unknown) => typeof v === "number";

/** How a static write relates to an observed change: exact, possibly (id not constant), or no. */
function relation(change: Change, e: Entity): Verdict | undefined {
  switch (change.kind) {
    case "switch":
    case "variable":
    case "item":
    case "weapon":
    case "armor": {
      if (e.kind !== change.kind) return undefined;
      const id = (e as { id: unknown }).id;
      if (!isConst(id)) return "dynamic";
      return id === change.id ? "explained" : undefined;
    }
    case "gold":
      return e.kind === "gold" ? "explained" : undefined;
    case "selfSwitch": {
      if (e.kind !== "selfSwitch") return undefined;
      const [m, ev, letter] = change.key;
      if (e.letter === "?") return "dynamic";
      if (e.letter !== letter) return undefined;
      const mapOk = e.mapId === m || e.mapId === "current";
      const eventOk = e.eventId === ev || e.eventId === "self";
      if (mapOk && eventOk) return isConst(e.mapId) && isConst(e.eventId) ? "explained" : "dynamic";
      if ((mapOk || !isConst(e.mapId)) && (eventOk || !isConst(e.eventId))) return "dynamic";
      return undefined;
    }
  }
}

function match(change: Change, writes: Ref[]): Verdict {
  let best: Verdict = "unexplained";
  for (const r of writes) {
    const v = relation(change, r.effect.entity);
    if (v === "explained") return v;
    if (v === "dynamic") best = "dynamic";
  }
  return best;
}

/** `own`: the event's closure; `elsewhere`: writes of maps it visited. */
export function classify(change: Change, own: Ref[], elsewhere: Ref[]): Verdict {
  const v = match(change, own);
  if (v === "explained") return v;
  const w = match(change, elsewhere);
  if (w === "explained") return "visited-map";
  return v === "dynamic" || w === "dynamic" ? "dynamic" : "unexplained";
}

export interface CrossCheckOptions {
  /** Frames per run before giving up. */
  maxFrames?: number;
  /** What to run (default: every common event with commands). */
  entries?: Entry[];
  /** Common events that may run alongside (parallel triggers); their writes also explain changes. */
  parallel?: number[];
  /** Common events run first to set up "a game in progress" (default: CE16 initGame). */
  setup?: number[];
  /** Party for the runs (default: Aura, actor 1). */
  party?: number[];
}

/** Every common event with commands. */
export const commonEventEntries = (data: GameData): Entry[] =>
  data.commonEvents.flatMap((ce) => (ce && ce.list.length > 1 ? [{ kind: "ce" as const, id: ce.id }] : []));

/** Every map event page with commands. */
export function pageEntries(data: GameData, maps = data.mapIds()): Entry[] {
  const out: Entry[] = [];
  for (const mapId of maps) {
    if (mapId === data.templateMapId()) continue;
    for (const event of data.map(mapId).events) {
      if (!event) continue;
      // Runtime page indices are into the template's pages for templated events.
      data.effectivePages(event).forEach((p, page) => {
        if (p.list.length > 1) out.push({ kind: "page", mapId, eventId: event.id, page });
      });
    }
  }
  return out;
}

/**
 * Runs each entry from a fresh "game in progress" (new game, setup common events, party) and
 * checks the changes it made. Common events run on the empty map; pages run on their own map.
 */
export function crossCheck(h: Harness, data: GameData, statics: StaticWrites, o: CrossCheckOptions = {}): RunCheck[] {
  const entries = o.entries ?? commonEventEntries(data);
  const parallel = o.parallel ?? data.commonEvents.flatMap((ce) => (ce && ce.trigger === 2 ? [ce.id] : []));
  const results: RunCheck[] = [];
  for (const entry of entries) {
    h.input.clear();
    let stop: RunCheck["stop"];
    let frames = 0;
    let error: string | undefined;
    try {
      h.newGame({ mapId: 0 });
      for (const id of o.setup ?? [16]) h.runCommonEvent(id);
      for (const actorId of o.party ?? [1]) {
        h.g.$gameActors.actor(actorId); // construct before adding (see event-test.ts)
        h.g.$gameParty.addActor(actorId);
      }
      h.tracker.clear();
      h.visitedMaps.length = 0;
      const max = o.maxFrames ?? 3000;
      const run = entry.kind === "ce" ? h.runCommonEvent(entry.id, max) : h.runEventPage(entry.mapId, entry.eventId, entry.page, max);
      stop = run.stop;
      frames = run.frames;
    } catch (e) {
      stop = "error";
      // Errors thrown by game code come from the context's realm: no `instanceof Error`.
      error = String((e as { message?: unknown })?.message ?? e);
    }
    // newGame's own changes happen before the clear; everything after is the run's.
    // Maps the run transferred to run their own events too; the tracker can't tell who made a
    // change, so their writes also count as explanations.
    const visited = [...new Set(h.visitedMaps)].filter((m) => m > 0);
    const ownWrites = entry.kind === "ce" ? statics.writes(entry.id) : statics.pageWrites(entry.mapId, entry.eventId, entry.page);
    const own = [...ownWrites, ...parallel.flatMap((p) => statics.writes(p))];
    // For a page run, its own map's other events also run (parallel processes, local calls).
    const elsewhere = visited.flatMap((m) => statics.mapWrites(m));
    const changes = h.tracker.changes.map((change) => ({ change, verdict: classify(change, own, elsewhere) }));
    results.push({ entry, stop, frames, visited, changes, ...(error ? { error } : {}) });
  }
  return results;
}
