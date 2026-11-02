import { beforeAll, describe, expect, it } from "vitest";
import { gameBlessings } from "../src/analysis/blessing.ts";
import { GameData } from "../src/data/game-data.ts";
import { Harness } from "../src/harness/harness.ts";
import { startGameInProgress } from "../src/harness/trace.ts";

// The static blessing model against the plugin's own TLB.SKABlessMenu.itemValid (empty
// inventory, so the "blessed version at max" check never applies).
describe("blessing model matches the game's eligibility check", () => {
  let g: any;
  beforeAll(async () => {
    const h = await Harness.boot();
    startGameInProgress(h);
    g = h.g;
  });

  const ours = gameBlessings(new GameData());
  for (const skill of [389, 390]) {
    it(`bless skill ${skill}`, () => {
      g.$gameTemp.setLastUsedSkillId(skill);
      const real = g.$dataItems.filter((i: any) => i && g.TLB.SKABlessMenu.itemValid(i)).map((i: any) => `${i.id}→${g.TLB.SKABlessMenu.getBlessedItem(i).id}`);
      const mine = ours.filter((b) => b.skills.includes(skill)).map((b) => `${b.from}→${b.to}`);
      expect(mine.sort()).toEqual(real.sort());
    });
  }
});
