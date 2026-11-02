import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runEventTests } from "../src/harness/event-test.ts";
import { formatChange } from "../src/harness/format.ts";
import { Harness } from "../src/harness/harness.ts";
import { createSandboxFs, type BlockedWrite } from "../src/harness/sandbox-fs.ts";

describe("boot", () => {
  it("loads every engine script and enabled plugin, and writes nothing", async () => {
    const h = await Harness.boot();
    expect(h.failures).toEqual([]);
    expect(h.g.PluginManager._errorUrls).toEqual([]);
    // PluginManager.setup loads each enabled plugin once by name (plugins.js repeats a
    // "-----------" separator entry).
    const enabled = new Set(h.g.$plugins.filter((p: any) => p.status).map((p: any) => p.name.split("/").pop()));
    expect(h.g.PluginManager._scripts.length).toBe(enabled.size);
    expect(h.eval("$dataTemplateEvents.length")).toBeGreaterThan(0);
    // The sandbox would swallow writes; currently boot attempts none. If that changes,
    // look at what the game is trying to write before relaxing this.
    expect(h.blockedWrites).toEqual([]);
  });
});

describe("common events", () => {
  it("initGame then startDay: day 1, deterministic change log", async () => {
    const h = await Harness.boot();
    h.newGame({ mapId: 0 });
    const log: string[] = [];
    for (const id of [16, 12]) {
      h.tracker.clear();
      expect(h.runCommonEvent(id).stop).toBe("completed");
      log.push(`CE${id}`, ...h.tracker.changes.map(formatChange));
    }
    expect(h.g.$gameVariables.value(31)).toBe(1);
    expect(log).toMatchSnapshot();
  });
});

describe("author's event tests", () => {
  it("Map050 interaction tests all pass", async () => {
    const run = runEventTests(await Harness.boot(), 50);
    const onMap50 = run.results.filter((r) => r.mapId === 50);
    expect(onMap50.map((r) => r.name)).toEqual([
      "test_open_chest",
      "test_harvest_ether",
      "test_destroy_rock",
      "test_harvest_pyromantium",
      "test_harvest_star_metal",
      "test_harvest_vine",
      "test_use_rope",
    ]);
    for (const r of onMap50) expect(r, r.name).toMatchObject({ status: "passed" });
    // The chain continues to the battle tests, which need Scene_Battle.
    expect(run.stop).toEqual({ scene: "Scene_Battle" });
  });
});

describe("sandbox fs", () => {
  it("resolves relative paths against its root and swallows writes", () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), "sandbox-fs-"));
    fs.writeFileSync(path.join(root, "a.txt"), "hello");
    const blocked: BlockedWrite[] = [];
    const sfs = createSandboxFs(root, blocked);

    expect(sfs.readFileSync("a.txt", "utf8")).toBe("hello");
    sfs.writeFileSync("a.txt", "changed");
    sfs.mkdirSync("newdir");
    expect(fs.readFileSync(path.join(root, "a.txt"), "utf8")).toBe("hello");
    expect(fs.existsSync(path.join(root, "newdir"))).toBe(false);
    // ...but the directory it "created" now looks empty and present.
    expect(sfs.existsSync("newdir")).toBe(true);
    expect(sfs.readdirSync("newdir")).toEqual([]);
    expect(blocked.map((b) => b.op)).toEqual(["writeFileSync", "mkdirSync"]);
    fs.rmSync(root, { recursive: true });
  });
});
