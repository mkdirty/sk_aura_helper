import { beforeAll, describe, expect, it } from "vitest";
import { gameBlessings } from "../src/analysis/blessing.ts";
import { gameCarryOverSkills } from "../src/analysis/newgame-plus.ts";
import { GameData } from "../src/data/game-data.ts";
import { Harness } from "../src/harness/harness.ts";
import { startGameInProgress } from "../src/harness/trace.ts";

// Static models of plugin data checked against the plugins' own code in the harness.
describe("plugin models match the running game", () => {
  let g: any;
  beforeAll(async () => {
    const h = await Harness.boot();
    startGameInProgress(h);
    g = h.g;
  });

  const data = new GameData();

  it("New Game+ carry-over skills = AuraMZ.carryOverSkills (built at boot)", () => {
    expect(gameCarryOverSkills(data)).toEqual(g.AuraMZ.carryOverSkills.map((s: any) => s.id));
  });

  // Blessing vs TLB.SKABlessMenu.itemValid (empty inventory, so the "blessed version at max"
  // check never applies).
  const ours = gameBlessings(data);
  for (const skill of [389, 390]) {
    it(`blessable items with bless skill ${skill}`, () => {
      g.$gameTemp.setLastUsedSkillId(skill);
      const real = g.$dataItems.filter((i: any) => i && g.TLB.SKABlessMenu.itemValid(i)).map((i: any) => `${i.id}→${g.TLB.SKABlessMenu.getBlessedItem(i).id}`);
      const mine = ours.filter((b) => b.skills.includes(skill)).map((b) => `${b.from}→${b.to}`);
      expect(mine.sort()).toEqual(real.sort());
    });
  }
});
