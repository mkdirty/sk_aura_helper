// "Who wrote this?": runs an entry point in the harness and reports, for every write to a target
// switch / variable / self switch, the game-code stack and which parallel event interpreters were
// mid-command at that moment. This is how unexplained cross-check changes get diagnosed.

import type { Harness } from "./harness.ts";

export type TraceTarget = { kind: "switch" | "variable"; id: number } | { kind: "selfSwitch"; key: [number, number, string] };

export interface TracedWrite {
  value: unknown;
  /** Parallel map events whose interpreters were running, as "E<id>#<index> code <code>". */
  parallel: string[];
  mapId: number;
  /** Game-code stack frames (harness frames removed). */
  stack: string[];
}

/** Hooks writes to `target` until the returned function is called; collects them in `writes`. */
export function traceWrites(h: Harness, target: TraceTarget, writes: TracedWrite[], maxStack = 14): () => void {
  const g = h.g;
  const proto = target.kind === "switch" ? g.Game_Switches.prototype : target.kind === "variable" ? g.Game_Variables.prototype : g.Game_SelfSwitches.prototype;
  const matches = (k: unknown) =>
    target.kind === "selfSwitch"
      ? Array.isArray(k) && Number(k[0]) === target.key[0] && Number(k[1]) === target.key[1] && String(k[2]) === target.key[2]
      : k === target.id;
  const original = proto.setValue;
  const limit = g.Error.stackTraceLimit;
  g.Error.stackTraceLimit = 60;
  proto.setValue = function (this: unknown, key: unknown, value: unknown) {
    if (matches(key)) {
      const stack = String(new g.Error().stack)
        .split("\n")
        .slice(1)
        .filter((l: string) => !/src\/harness\//.test(l))
        .slice(0, maxStack)
        .map((l: string) => l.trim());
      const parallel = g.$gameMap
        .events()
        .filter((e: any) => e._interpreter?.isRunning())
        .map((e: any) => `E${e.eventId()}#${e._interpreter._index} code ${e._interpreter._list[e._interpreter._index]?.code}`);
      writes.push({ value, parallel, mapId: g.$gameMap.mapId(), stack });
    }
    return original.call(this, key, value);
  };
  return () => {
    proto.setValue = original;
    g.Error.stackTraceLimit = limit;
  };
}

/** Starts the "game in progress" the cross-check uses: new game, CE16 initGame, Aura in the party. */
export function startGameInProgress(h: Harness) {
  h.newGame({ mapId: 0 });
  h.runCommonEvent(16);
  h.g.$gameActors.actor(1); // construct before adding (see event-test.ts)
  h.g.$gameParty.addActor(1);
}
