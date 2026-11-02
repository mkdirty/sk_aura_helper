import { beforeAll, describe, expect, it } from "vitest";
import { analysisContext } from "../src/analysis/context.ts";
import type { Effect } from "../src/analysis/effects.ts";
import type { Ref } from "../src/analysis/xref.ts";
import { XrefIndex } from "../src/analysis/xref.ts";
import { classify, crossCheck, StaticWrites } from "../src/check/crosscheck.ts";
import { GameData } from "../src/data/game-data.ts";
import { Harness } from "../src/harness/harness.ts";
import type { Change } from "../src/harness/tracker.ts";

const ref = (effect: Effect): Ref => ({ effect, site: { source: { kind: "common", id: 1 }, index: 0, dead: false, via: [] } });
const sw = (id: number): Change => ({ frame: 1, kind: "switch", id, name: "", before: false, after: true });

describe("classify", () => {
  it("explains exact writes, notes dynamic ones, flags the rest", () => {
    const writeS5 = ref({ entity: { kind: "switch", id: 5 }, access: "write", how: "= ON" });
    const writeDynamic = ref({ entity: { kind: "switch", id: { var: 3 } }, access: "write", how: "= ON" });
    expect(classify(sw(5), [writeS5], [])).toBe("explained");
    expect(classify(sw(6), [writeS5, writeDynamic], [])).toBe("dynamic");
    expect(classify(sw(6), [writeS5], [ref({ entity: { kind: "switch", id: 6 }, access: "write", how: "= ON" })])).toBe("visited-map");
    expect(classify(sw(6), [writeS5], [])).toBe("unexplained");
  });

  it("matches self switches written as 'this event' in common events", () => {
    const change: Change = { frame: 1, kind: "selfSwitch", key: [7, 8, "A"], before: false, after: true };
    const own = ref({ entity: { kind: "selfSwitch", mapId: "current", eventId: "self", letter: "A" }, access: "write", how: "= ON" });
    expect(classify(change, [own], [])).toBe("dynamic");
    const exact = ref({ entity: { kind: "selfSwitch", mapId: 7, eventId: 8, letter: "A" }, access: "write", how: "= ON" });
    expect(classify(change, [exact], [])).toBe("explained");
  });
});

describe("runtime cross-check", () => {
  let h: Harness;
  let data: GameData;
  let statics: StaticWrites;
  beforeAll(async () => {
    data = new GameData();
    statics = new StaticWrites(XrefIndex.build(analysisContext(data)));
    h = await Harness.boot();
  });

  it("everything startDay, endDay and Obtain_Item change at runtime is predicted by the index", () => {
    const results = crossCheck(h, data, statics, { entries: [12, 11, 785].map((id) => ({ kind: "ce" as const, id })) });
    const unexplained = results.flatMap((r) => r.changes.filter((c) => c.verdict === "unexplained"));
    expect(unexplained).toEqual([]);
    expect(results.flatMap((r) => r.changes).length).toBeGreaterThan(10);
  });

  it("map event pages run on their own map with their own event id", () => {
    // Map029/E28 "corpse": gives 5 Apples via Obtain_Item and sets its self switch A.
    const [run] = crossCheck(h, data, statics, { entries: [{ kind: "page", mapId: 29, eventId: 28, page: 0 }] });
    expect(run.stop).toBe("completed");
    const kinds = run.changes.map((c) => [c.change.kind, c.verdict]);
    expect(kinds).toContainEqual(["item", "explained"]);
    expect(kinds).toContainEqual(["selfSwitch", "explained"]);
    expect(run.changes.filter((c) => c.verdict === "unexplained")).toEqual([]);
  });
});
