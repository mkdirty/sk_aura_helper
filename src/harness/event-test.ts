// Runs the author's automated event tests (Map019/020/050: events named test_*).
//
// The shipped game registers no `event_test` plugin, so its commands are no-ops in the real
// build. This stub implements them from how the test events use them:
//   start                       begin the test (the event running it)
//   assertTrue {condition}      JS expression must be truthy
//   assertEquals {expected, actual}  JS expressions must be loosely equal
//   pressButton {button, time, duration}  queue a button press for the next message/choice
//   success                     end the test
// The helpers the assertions call (valueOfSwitch, numItems, …) are defined here too.
//
// Tests are chained autorun events: with switch `automaticTest` (S3) on, each test sets
// V25 to unlock the next one. In the game they are launched from a game in progress
// (CE5 `startTest` → Map019 hub, whose `automatic_tests` event visits Map020 then Map050),
// so they assume Aura is in the party; a brand-new game's party is empty until the intro.

import type { Harness, StopReason } from "./harness.ts";

export interface Assertion {
  ok: boolean;
  description: string;
  detail: string;
}

export interface EventTestResult {
  mapId: number;
  eventId: number;
  name: string;
  status: "passed" | "failed" | "incomplete";
  assertions: Assertion[];
}

export interface EventTestRun {
  mapId: number;
  results: EventTestResult[];
  stop: StopReason;
  frames: number;
}

const AUTOMATIC_TEST_SWITCH = "automaticTest";

export function installEventTestPlugin(h: Harness): EventTestResult[] {
  const g = h.g;
  const results: EventTestResult[] = [];
  let current: EventTestResult | undefined;

  const byName = <T extends { name: string }>(list: Array<T | null>, name: string, what: string): T => {
    const found = list.find((x) => x?.name === name);
    if (!found) throw new Error(`no ${what} named ${JSON.stringify(name)}`);
    return found;
  };
  const idByName = (names: string[], name: string, what: string) => {
    const id = names.indexOf(name);
    if (id < 0) throw new Error(`no ${what} named ${JSON.stringify(name)}`);
    return id;
  };
  Object.assign(g, {
    valueOfSwitch: (name: string) => g.$gameSwitches.value(idByName(g.$dataSystem.switches, name, "switch")),
    valueOfVariable: (name: string) => g.$gameVariables.value(idByName(g.$dataSystem.variables, name, "variable")),
    hasSkill: (name: string) => g.$gameParty.leader().hasSkill(byName<any>(g.$dataSkills, name, "skill").id),
    numItems: (name: string) =>
      g.$gameParty.numItems(
        [g.$dataItems, g.$dataWeapons, g.$dataArmors].flat().find((x: any) => x?.name === name) ?? byName([], name, "item"),
      ),
  });

  const evaluate = (code: string) => h.eval(code);
  const assert = (description: string, check: () => [boolean, string]) => {
    if (!current) throw new Error("event_test assertion outside a test");
    let result: [boolean, string];
    try {
      result = check();
    } catch (e) {
      result = [false, `threw: ${e instanceof Error ? e.message : String(e)}`];
    }
    current.assertions.push({ ok: result[0], description, detail: result[1] });
  };

  const register = (command: string, fn: (this: any, args: any) => void) => g.PluginManager.registerCommand("event_test", command, fn);

  register("start", function (this: any) {
    const eventId = this.eventId();
    current = {
      mapId: g.$gameMap.mapId(),
      eventId,
      name: g.$dataMap.events[eventId]?.name ?? `event ${eventId}`,
      status: "incomplete",
      assertions: [],
    };
    results.push(current);
    h.input.clear();
  });
  register("assertTrue", (args) =>
    assert(args.description, () => {
      const value = evaluate(args.condition);
      return [!!value, `${args.condition} → ${JSON.stringify(value)}`];
    }),
  );
  register("assertEquals", (args) =>
    assert(args.description, () => {
      const expected = evaluate(args.expected);
      const actual = evaluate(args.actual);
      // eslint-disable-next-line eqeqeq
      return [expected == actual, `expected ${JSON.stringify(expected)}, actual ${args.actual} → ${JSON.stringify(actual)}`];
    }),
  );
  register("pressButton", (args) =>
    h.input.push({ button: args.button, time: Number(args.time), duration: Number(args.duration) }),
  );
  register("success", () => {
    if (!current) return;
    current.status = current.assertions.every((a) => a.ok) ? "passed" : "failed";
    current = undefined;
  });

  return results;
}

export interface EventTestOptions {
  /** Actors in the party when the tests start (default: Aura, actor 1). */
  party?: number[];
  /** Common events run before the tests, on the empty map (default: CE16 `initGame`). */
  setup?: number[];
}

/**
 * Approximates "a game in progress": new game, the setup common events, the party; then
 * turns automatic testing on, moves to `mapId` and runs until the game goes idle.
 */
export function runEventTests(h: Harness, mapId: number, options: EventTestOptions = {}): EventTestRun {
  const results = installEventTestPlugin(h);
  h.newGame({ mapId: 0 });
  for (const id of options.setup ?? [16]) {
    const run = h.runCommonEvent(id);
    if (run.stop !== "completed") throw new Error(`setup common event ${id} did not complete: ${JSON.stringify(run.stop)}`);
  }
  for (const actorId of options.party ?? [1]) {
    // Create the actor before adding it: adding refreshes the player, which reads the
    // leader, and constructing an actor that is already in the party recurses forever
    // (MPP_CharacterMake's setup refreshes the player too). The game's intro does the same.
    h.g.$gameActors.actor(actorId);
    h.g.$gameParty.addActor(actorId);
  }
  const switchId = h.g.$dataSystem.switches.indexOf(AUTOMATIC_TEST_SWITCH);
  if (switchId < 0) throw new Error(`no switch named ${AUTOMATIC_TEST_SWITCH}`);
  h.g.$gameSwitches.setValue(switchId, true);
  h.transfer(mapId);
  const { stop, frames } = h.runUntilIdle();
  return { mapId, results, stop, frames };
}
