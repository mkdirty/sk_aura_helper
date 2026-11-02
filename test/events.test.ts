import { beforeAll, describe, expect, it } from "vitest";
import { GameData, type RawCommand } from "../src/data/game-data.ts";
import { Coverage } from "../src/events/coverage.ts";
import { decodeList, engineRouteNames, type DecodeOptions } from "../src/events/decode.ts";
import { renderCommonEvent, renderMap, type DocumentOptions } from "../src/events/document.ts";
import { allLists } from "../src/events/lists.ts";

let data: GameData;
let decode: DecodeOptions;
beforeAll(() => {
  data = new GameData();
  decode = { routeNames: engineRouteNames(data.dir) };
});

const cmd = (code: number, indent: number, parameters: unknown[] = []): RawCommand => ({ code, indent, parameters });

describe("whole project", () => {
  it("decodes every command with no gaps", () => {
    const coverage = new Coverage();
    for (const list of allLists(data)) coverage.add(list, decodeList(list.list, decode));
    const report = coverage.report({ gameDir: data.dir });
    expect(report.consumed).toBe(report.commands);
    // A game update that introduces a new command shape fails here: look at the coverage
    // report (`npm run print`) and teach the decoder.
    expect(report.gaps).toEqual([]);
  });
});

describe("reference outputs (hand-checked against the raw data)", () => {
  const options = (): DocumentOptions => ({ data, decode, text: "full" });

  it("CE11 endDay", () => {
    expect(renderCommonEvent(data.commonEvents[11]!, options())).toMatchSnapshot();
  });

  it("Map265/E8 François: choices, labels, jumps, item select", () => {
    const doc = renderMap(265, options());
    const start = doc.indexOf("=== E8 ");
    expect(doc.slice(start, doc.indexOf("\n=== E", start + 1))).toMatchSnapshot();
  });
});

describe("decoder", () => {
  it("delimits blocks by indentation, like the engine, when a closer is missing", () => {
    // if S1 { if S2 { A } (no 412, no terminator)  B } — B still belongs to the outer if.
    const list = [cmd(111, 0, [0, 1, 0]), cmd(111, 1, [0, 2, 0]), cmd(230, 2, [1]), cmd(230, 1, [2]), cmd(0, 1), cmd(412, 0), cmd(0, 0)];
    const { ops, issues } = decodeList(list, decode);
    expect(ops).toHaveLength(1);
    const outer = ops[0] as Extract<(typeof ops)[0], { kind: "if" }>;
    expect(outer.then.map((o) => o.kind)).toEqual(["if", "generic"]);
    expect(issues.every((i) => i.severity === "anomaly")).toBe(true);
    expect(issues.map((i) => i.key)).toContain("missing 412");
  });

  it("decodes Skip (109 … 409) as a block that never runs", () => {
    const list = [cmd(109, 0), cmd(121, 1, [5, 5, 0]), cmd(0, 1), cmd(409, 0), cmd(0, 0)];
    const { ops, issues } = decodeList(list, decode);
    expect(issues).toEqual([]);
    expect(ops).toMatchObject([{ kind: "skip", body: [{ kind: "setSwitches", from: 5, value: true }] }]);
  });

  it("records unknown codes and bad shapes as gaps", () => {
    const { issues } = decodeList([cmd(999, 0, [1]), cmd(121, 0, [1]), cmd(0, 0)], decode);
    expect(issues.map((i) => [i.severity, i.key])).toEqual([
      ["gap", "unknown code 999"],
      ["gap", "shape 121"],
    ]);
  });
});
