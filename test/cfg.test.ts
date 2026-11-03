import { beforeAll, describe, expect, it } from "vitest";
import { GameData, type RawCommand } from "../src/data/game-data.ts";
import { engineRouteNames, type DecodeOptions } from "../src/events/decode.ts";
import { allLists, type ListSource } from "../src/events/lists.ts";
import { Names } from "../src/events/names.ts";
import { cycles, dominators, postDominators, SINK } from "../src/graph/cfg-analysis.ts";
import { renderCfgText } from "../src/graph/cfg-print.ts";
import { buildCfg, cfgContext, ENTRY, EXIT, GAMEOVER, type Cfg, type CfgContext } from "../src/graph/cfg.ts";

let data: GameData;
let ctx: CfgContext;
let decode: DecodeOptions;
beforeAll(() => {
  data = new GameData();
  ctx = cfgContext(data);
  decode = { routeNames: engineRouteNames(data.dir) };
});

const cmd = (code: number, indent: number, parameters: unknown[] = []): RawCommand => ({ code, indent, parameters });
const CE: ListSource = { kind: "common", id: 0 };
const wait = (indent: number) => cmd(230, indent, [1]);
const sw = (indent: number, id: number) => cmd(121, indent, [id, id, 0]);
const ifSwitch = (indent: number, id: number) => cmd(111, indent, [0, id, 0]);
const name = (t: number) => (t === EXIT ? "END" : t === GAMEOVER ? "OVER" : t === ENTRY ? "ENTRY" : String(t));
/** Edges as "from>to kind", sorted. */
const edges = (cfg: Cfg) =>
  [...cfg.succ.values()]
    .flat()
    .map((e) => `${name(e.from)}>${name(e.to)} ${e.kind}${e.option !== undefined ? e.option : ""}${e.stale ? " stale" : ""}${e.dynamic ? " dyn" : ""}`)
    .sort();
const build = (list: RawCommand[], source: ListSource = CE, c: CfgContext = ctx) => buildCfg(source, list, c);

describe("CFG semantics (follows Game_Interpreter)", () => {
  it("if/else: both branches, markers resolved inside the edges", () => {
    // 0 if S1 { 1 S2=ON } else { 4 S3=ON } 7 wait
    const g = build([ifSwitch(0, 1), sw(1, 2), cmd(0, 1), cmd(411, 0), sw(1, 3), cmd(0, 1), cmd(412, 0), wait(0), cmd(0, 0)]);
    expect(edges(g)).toEqual(["0>1 then", "0>4 else", "1>7 seq", "4>7 seq", "7>END seq", "ENTRY>0 seq"].sort());
    expect(g.nodes).toEqual([0, 1, 4, 7]);
  });

  it("choices: one edge per option; cancel only with a cancel branch; text absorbs the choice", () => {
    // 0 text, 2 choose [a, b] cancel → branch; when 0 { 4 } when 1 { 7 } when cancel { 10 }
    const list = [
      cmd(101, 0, ["", 0, 0, 2, ""]),
      cmd(401, 0, ["hi"]),
      cmd(102, 0, [["a", "b"], -2, 0, 2, 0]),
      cmd(402, 0, [0, "a"]),
      sw(1, 1),
      cmd(0, 1),
      cmd(402, 0, [1, "b"]),
      sw(1, 2),
      cmd(0, 1),
      cmd(403, 0, [6, null]),
      sw(1, 3),
      cmd(0, 1),
      cmd(404, 0),
      cmd(0, 0),
    ];
    expect(edges(build(list))).toEqual(["0>2 seq", "10>END seq", "2>10 cancel", "2>4 choice0", "2>7 choice1", "4>END seq", "7>END seq", "ENTRY>0 seq"].sort());
    // Cancel disallowed (-1): no cancel edge.
    const noCancel = list.map((c, i) => (i === 2 ? cmd(102, 0, [["a", "b"], -1, 0, 2, 0]) : c));
    expect(edges(build(noCancel)).filter((e) => e.includes("cancel"))).toEqual([]);
  });

  it("an option without a branch falls past every marker", () => {
    const g = build([cmd(102, 0, [["a", "b"], -1, 0, 2, 0]), cmd(402, 0, [0, "a"]), sw(1, 1), cmd(0, 1), cmd(404, 0), wait(0), cmd(0, 0)]);
    expect(edges(g)).toContain("0>5 choice1");
  });

  it("a jump into a branch body leaves the construct at the body's end (jumpTo resets branch state)", () => {
    // 0 jump L; 1 choose [a, b]; when 0 { 3 label L; 4 S1 }; when 1 { 7 S2 }; 10 wait
    const g = build([
      cmd(119, 0, ["L"]),
      cmd(102, 0, [["a", "b"], -1, 0, 2, 0]),
      cmd(402, 0, [0, "a"]),
      cmd(118, 1, ["L"]),
      sw(1, 1),
      cmd(0, 1),
      cmd(402, 0, [1, "b"]),
      sw(1, 2),
      cmd(0, 1),
      cmd(404, 0),
      wait(0),
      cmd(0, 0),
    ]);
    expect(edges(g)).toContain("4>10 seq");
    expect(edges(g)).not.toContain("4>7 seq");
    expect(g.issues.map((i) => i.key)).toContain("jump enters a block");
    expect(g.unreachable).toEqual([1, 7]);
  });

  it("a marker reached without its opener reads the unknown entry state: both ways, marked stale", () => {
    // A stray else at the top of a list: the reused interpreter's old state decides.
    const g = build([cmd(411, 0), sw(1, 1), cmd(0, 1), cmd(412, 0), wait(0), cmd(0, 0)]);
    expect(edges(g)).toEqual(["1>4 seq", "4>END seq", "ENTRY>1 seq stale", "ENTRY>4 seq stale"].sort());
  });

  it("loops: repeat goes back to the body start, break past the matching 413", () => {
    // 0 loop { 1 if S1 { 2 break } 5 wait } 8 wait
    const g = build([cmd(112, 0), ifSwitch(1, 1), cmd(113, 2), cmd(0, 2), cmd(412, 1), wait(1), cmd(0, 1), cmd(413, 0), wait(0), cmd(0, 0)]);
    expect(edges(g)).toEqual(["0>1 seq", "1>2 then", "1>5 else", "2>8 break", "5>7 seq", "7>1 repeat", "8>END seq", "ENTRY>0 seq"].sort());
    expect(cycles(g)).toEqual([[1, 5, 7]]);
  });

  it("break outside a loop scans to the end of the list", () => {
    const g = build([cmd(113, 0), wait(0), cmd(0, 0)]);
    expect(edges(g)).toEqual(["0>END break", "ENTRY>0 seq"]);
    expect(g.issues.map((i) => i.key)).toContain("break outside a loop (ends the event)");
  });

  it("labels: missing ones do nothing, duplicates resolve to the first", () => {
    const g = build([cmd(119, 0, ["nope"]), cmd(119, 0, ["L"]), cmd(118, 0, ["L"]), wait(0), cmd(118, 0, ["L"]), cmd(0, 0)]);
    expect(edges(g)).toContain("0>1 seq");
    expect(edges(g)).toContain("1>2 jump");
    expect(g.issues.map((i) => i.key).sort()).toEqual(["duplicate label (first wins)", "jump to a missing label (does nothing)"]);
  });

  it("exit event and game over end the list", () => {
    const g = build([ifSwitch(0, 1), cmd(115, 1), cmd(0, 1), cmd(412, 0), cmd(353, 0), cmd(0, 0)]);
    expect(edges(g)).toEqual(["0>1 then", "0>4 else", "1>END exit", "4>OVER seq", "ENTRY>0 seq"].sort());
  });

  it("battles: win/lose branches; losing without 'can lose' may also end the game", () => {
    // 0 battle troop 3 (no escape, can't lose) { win: 2 } { lose: 5 } 8 wait
    const list = [cmd(301, 0, [0, 3, false, false]), cmd(601, 0), sw(1, 1), cmd(0, 1), cmd(603, 0), sw(1, 2), cmd(0, 1), cmd(604, 0), wait(0), cmd(0, 0)];
    expect(edges(build(list))).toEqual(["0>2 win", "0>5 lose", "0>OVER lose", "2>8 seq", "5>8 seq", "8>END seq", "ENTRY>0 seq"].sort());
    // A troop whose pages can abort the battle ends in "escape" even without the escape command.
    expect(edges(build(list, CE, { ...ctx, troopCanAbort: () => true }))).toContain("0>8 escape");
    // Troop from a variable: maybe no battle at all (the old branch state stays).
    const byVar = list.map((c, i) => (i === 0 ? cmd(301, 0, [1, 5, false, true]) : c));
    expect(edges(build(byVar)).filter((e) => e.startsWith("0>"))).toEqual(["0>2 win", "0>5 lose", "0>8 escape", "0>2 noBattle stale", "0>5 noBattle stale", "0>8 noBattle stale"].sort());
    // In a troop page the party is already in battle: Battle Processing does nothing.
    expect(edges(build(list, { kind: "troop", troopId: 3, page: 0 })).filter((e) => e.startsWith("0>"))).toEqual(
      ["0>2 noBattle stale", "0>5 noBattle stale", "0>8 noBattle stale"].sort(),
    );
  });

  it("Skip blocks never run", () => {
    const g = build([cmd(109, 0), sw(1, 1), cmd(0, 1), cmd(409, 0), wait(0), cmd(0, 0)]);
    expect(edges(g)).toEqual(["0>4 skip", "4>END seq", "ENTRY>0 seq"]);
    expect(g.unreachable).toEqual([1]);
  });

  it("scripts: computed jumps resolve to matching labels, with a fallthrough", () => {
    const g = build([
      cmd(355, 0, ["const label = `p${$gameVariables.value(30)}`;"]),
      cmd(655, 0, ["this.command119([label]);"]),
      wait(0),
      cmd(118, 0, ["p1"]),
      cmd(118, 0, ["p2"]),
      cmd(118, 0, ["q1"]),
      cmd(0, 0),
    ]);
    expect(edges(g).filter((e) => e.startsWith("0>"))).toEqual(["0>2 seq dyn", "0>3 jump dyn", "0>4 jump dyn"]);
  });

  it("scripts that set the interpreter's index to the list length end the event", () => {
    const g = build([cmd(355, 0, ["let interpreter = $gameMap._interpreter;"]), cmd(655, 0, ["interpreter._index = interpreter._list.length;"]), wait(0), cmd(0, 0)]);
    expect(edges(g)).toEqual(["0>END exit", "ENTRY>0 seq"]);
  });

  it("a choice with 'hide single-option choices' may never open: no branch is chosen", () => {
    const g = build([
      cmd(357, 0, ["auramz/choices", "setHideSingleOptionChoices", "", {}]),
      cmd(102, 0, [["a", "b"], -1, 0, 2, 0]),
      cmd(402, 0, [0, "a"]),
      sw(1, 1),
      cmd(0, 1),
      cmd(402, 0, [1, "b"]),
      sw(1, 2),
      cmd(0, 1),
      cmd(404, 0),
      cmd(0, 0),
    ]);
    expect(edges(g).filter((e) => e.startsWith("1>"))).toEqual(["1>3 choice0", "1>6 choice1", "1>3 noChoice stale", "1>6 noChoice stale", "1>END noChoice stale"].sort());
  });
});

describe("CFG analyses", () => {
  it("dominators and post-dominators", () => {
    // 0 if S1 { 1 } else { 4 } 7 wait
    const g = build([ifSwitch(0, 1), sw(1, 2), cmd(0, 1), cmd(411, 0), sw(1, 3), cmd(0, 1), cmd(412, 0), wait(0), cmd(0, 0)]);
    const idom = dominators(g);
    expect(Object.fromEntries(idom)).toEqual({ 0: ENTRY, 1: 0, 4: 0, 7: 0 });
    const ipdom = postDominators(g);
    expect(ipdom.get(0)).toBe(7);
    expect(ipdom.get(1)).toBe(7);
    expect(ipdom.get(7)).toBe(EXIT);
    expect(ipdom.get(EXIT)).toBeUndefined();
    expect(SINK).toBeLessThan(0);
  });
});

describe("whole project", () => {
  it("builds every list, with no unmodelled control; stale reads only after a choice or battle that may not happen", () => {
    const keys = new Map<string, number>();
    const staleKinds = new Set<string>();
    for (const l of allLists(data)) {
      const g = buildCfg(l.source, l.list, ctx);
      for (const i of g.issues) keys.set(i.key, (keys.get(i.key) ?? 0) + 1);
      for (const es of g.succ.values()) for (const e of es) if (e.stale) staleKinds.add(e.kind);
    }
    // A game update that adds new interpreter tricks fails here: see `npm run cfg`.
    expect(keys.get("script touches interpreter state (not modelled)")).toBeUndefined();
    expect([...keys.keys()].sort()).toEqual(
      [
        "dynamic jump",
        "dynamic jump (label not resolved)",
        "duplicate label (first wins)",
        "jump enters a block",
        "jump to a missing label (does nothing)",
        "unreachable commands",
      ].sort(),
    );
    // Markers otherwise always read a state their own opener set (jumps into blocks included,
    // thanks to jumpTo's resets). A stale edge of another kind is worth a look.
    expect([...staleKinds].sort()).toEqual(["noBattle", "noChoice"]);
  });
});

describe("reference outputs (hand-checked against the raw data)", () => {
  const text = (mapId: number | undefined, source: ListSource, list: RawCommand[]) => {
    const names = new Names(data);
    if (mapId !== undefined) names.currentMap = data.map(mapId);
    return renderCfgText(buildCfg(source, list, ctx), list, decode, names);
  };

  it("Map265/E8 François p0: labels and jumps into a choice branch", () => {
    const list = data.map(265).events[8]!.pages[0].list;
    expect(text(265, { kind: "map", mapId: 265, eventId: 8, page: 0 }, list)).toMatchSnapshot();
  });

  it("CE11 endDay", () => {
    expect(text(undefined, { kind: "common", id: 11 }, data.commonEvents[11]!.list)).toMatchSnapshot();
  });
});
