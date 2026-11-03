import { beforeAll, describe, expect, it } from "vitest";
import { compareReview, currentReview, loadReview, usedPluginCommands, type ReviewProblems } from "../src/analysis/plugin-review.ts";
import { GameData } from "../src/data/game-data.ts";
import { Harness } from "../src/harness/harness.ts";

// Fails after a game update that changes a reviewed plugin handler (or its plugin file), and when
// the events use a plugin command with no verdict. Fix: re-read the handler (`npm run harness --
// handler KEY`), update effects.ts if needed, then `npm run plugins -- --accept KEY`.
describe("plugin command reviews are current", () => {
  let problems: ReviewProblems;
  beforeAll(async () => {
    const data = new GameData();
    const h = await Harness.boot();
    problems = compareReview(loadReview(), currentReview(data, h.g.PluginManager._commands), usedPluginCommands(data));
  });

  it("no reviewed handler or plugin file changed", () => expect(problems.changed).toEqual([]));
  it("every verdict in effects.ts is recorded in plugin-review.json", () => {
    expect(problems.unrecorded).toEqual([]);
    expect(problems.stale).toEqual([]);
  });
  it("every plugin command used in events has a verdict", () => expect(problems.unreviewed).toEqual([]));
});
