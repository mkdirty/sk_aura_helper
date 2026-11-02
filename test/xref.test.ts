import { beforeAll, describe, expect, it } from "vitest";
import { analysisContext } from "../src/analysis/context.ts";
import type { Entity } from "../src/analysis/effects.ts";
import { analyzeScript, expressionId } from "../src/analysis/script.ts";
import { XrefIndex, type Ref } from "../src/analysis/xref.ts";
import { GameData } from "../src/data/game-data.ts";
import { sourceLabel } from "../src/events/lists.ts";

let index: XrefIndex;
beforeAll(() => {
  index = XrefIndex.build(analysisContext(new GameData()));
});

const where = (kind: Entity["kind"], id: number) => index.find(kind, (e) => (e as { id: unknown }).id === id).filter((r) => !r.site.dead);
const label = (r: Ref) => `${sourceLabel(r.site.source)}#${r.site.index}`;
const gains = (refs: Ref[]) => refs.filter((r) => r.effect.access === "write" && r.effect.how === "gain");

describe("cross-reference index (facts checked against the printed events)", () => {
  it("item 23 Apple: Obtain_Item arguments resolved at the call, impossible branch dropped", () => {
    const refs = where("item", 23);
    // Map029/E28 sets V651 = 5, V650 = 23, then calls CE785; only the quantity > 0 path applies.
    const corpse = gains(refs).filter((r) => label(r) === "Map029/E28/p0#11");
    expect(corpse.map((r) => [r.effect.amount, r.site.via])).toEqual([[5, [785]]]);
    expect(refs.some((r) => r.effect.how === "shop sells" && label(r) === "Map006/E42/p0#34")).toBe(true);
  });

  it("item 203 Ether: copy through V28 → V650 across CE206 → CE204 → CE785", () => {
    const viaHarvest = gains(where("item", 203)).find((r) => label(r) === "CE206#2");
    expect(viaHarvest?.site.via).toEqual([204, 785]);
  });

  it("self switches set inside common events resolve to the calling map event", () => {
    const refs = index.find("selfSwitch", (e) => e.kind === "selfSwitch" && e.mapId === 11 && e.eventId === 11 && e.letter === "A");
    expect(refs.map((r) => [label(r), r.effect.how, r.site.via])).toContainEqual(["Map011/E11/p0#0", "= ON", [206, 204]]);
  });

  it("skill 26 Fire I: event learn/forget and class learnings", () => {
    const hows = where("skill", 26).map((r) => `${label(r)} ${r.effect.how}`);
    expect(hows).toContain("Map007/E8/p0#103 learn (actor 1)");
    expect(hows).toContain("Map007/E11/p3#83 forget (actor 1)");
    expect(hows).toContain("classes[3]#0 learn at level 1 (class 3)");
  });
});

describe("books and crafting (from the plugins' handlers and item notes)", () => {
  it("skill 505 The Art Of Fire: taught by finishing book item 456, by Aura or a companion", () => {
    const hows = where("skill", 505).map((r) => `${label(r)} ${r.effect.how}`);
    expect(hows).toContain("items[456]#0 learn (finishing book item 456)");
    expect(hows).toContain("CE883#0 learn (actor 2/3/4/16 finishes book item 456)");
  });

  it("skill 282 Offensive Stance I: forgotten when book item 453 teaches rank II", () => {
    expect(where("skill", 282).map((r) => r.effect.how)).toContain("forget (finishing book item 453)");
  });

  it("V11 willpower: raised by finishing book item 455", () => {
    expect(where("variable", 11).map((r) => `${label(r)} ${r.effect.how}`)).toContain("items[455]#1 += 10 (finishing book item 455)");
  });

  it("blessing: item 7 Bomb → 303 Blessed Bomb with either bless skill; drugs need Bless Item II (390)", () => {
    const hows = (id: number) => where("item", id).filter((r) => label(r) === "CE272#0").map((r) => r.effect.how);
    expect(hows(7)).toContain("lose (blessed into item 303, with skill 389/390)");
    expect(hows(303)).toContain("gain (blessed from item 7, with skill 389/390)");
    expect(hows(364)).toContain("gain (blessed from item 55, with skill 390)");
    // Already-blessed items have no blessed version of their own.
    expect(where("item", 303).some((r) => r.effect.how.startsWith("lose (blessed into"))).toBe(false);
  });

  it("Louise's crafting (Map181/E4): bombs into stock V506 from item 204, success switch S45", () => {
    const at = (refs: Ref[]) => refs.filter((r) => label(r) === "Map181/E4/p0#42").map((r) => r.effect.how);
    expect(at(where("item", 7))).toContain("crafted (into stock V506, 5 per craft)");
    expect(at(where("item", 204))).toContain("lose (crafting ingredient for item 7, 1 per craft)");
    expect(at(where("variable", 506))).toContain("+= crafted item 7");
    expect(at(where("switch", 45))).toContain("= ON (after crafting)");
  });
});

describe("script analysis", () => {
  it("finds constant references to engine APIs", () => {
    const { effects, parsed } = analyzeScript("$gameParty.gainItem($dataItems[$gameVariables.value(650)], 3); if ($gameSwitches.value(22)) $gameMap.event(5).start();");
    expect(parsed).toBe(true);
    expect(effects).toContainEqual({ entity: { kind: "item", id: { var: 650 } }, access: "write", how: "gain", amount: 3, sign: 1 });
    expect(effects).toContainEqual({ entity: { kind: "switch", id: 22 }, access: "read", how: "value" });
    expect(effects).toContainEqual({ entity: { kind: "mapEvent", mapId: "current", eventId: 5 }, access: "call", how: "start" });
  });

  it("expands loops over constant arrays (Map022/E21's control-crystal setup)", () => {
    const code = "const keys = [[141, 15, 'A'], [163, 1, 'A']]; const ids = [18, 233];\nfor (const id of ids) $gameSwitches.setValue(id, true);\nfor (const k of keys) $gameSelfSwitches.setValue(k, true);\nfor (const id of ids) $gameSwitches.setValue(id, false);";
    const writes = analyzeScript(code).effects.filter((e) => e.access === "write").map((e) => JSON.stringify(e.entity));
    expect(new Set(writes)).toEqual(
      new Set([
        '{"kind":"switch","id":18}',
        '{"kind":"switch","id":233}',
        '{"kind":"selfSwitch","mapId":141,"eventId":15,"letter":"A"}',
        '{"kind":"selfSwitch","mapId":163,"eventId":1,"letter":"A"}',
      ]),
    );
    // A name reassigned to something unknown is not trusted: the write is kept, with an unknown id.
    expect(analyzeScript("let s = 5; s = foo(); $gameSwitches.setValue(s, true)")).toMatchObject({
      effects: [{ entity: { kind: "switch", id: { unknown: "script" } }, access: "write" }],
      dynamic: 1,
    });
  });

  it("records references it can't pin down with an unknown id instead of guessing", () => {
    expect(analyzeScript("$gameSwitches.setValue(x, true)")).toMatchObject({ effects: [{ entity: { kind: "switch", id: { unknown: "script" } } }], dynamic: 1 });
    expect(analyzeScript("this is not js(")).toMatchObject({ parsed: false });
  });

  it("reads ids from plugin argument expressions", () => {
    expect(expressionId("12")).toBe(12);
    expect(expressionId("this._eventId")).toBe("self");
    expect(expressionId("$gameVariables.value(7)")).toEqual({ var: 7 });
    expect(expressionId("foo + 1")).toBeUndefined();
  });
});
