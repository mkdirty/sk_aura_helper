// Shared setup for analyses over the static game data.

import type { GameData } from "../data/game-data.ts";
import { gameBooks } from "./books.ts";
import { engineRouteNames } from "../events/decode.ts";
import type { XrefOptions } from "./xref.ts";

export function analysisContext(data: GameData): XrefOptions {
  return {
    data,
    decode: { routeNames: engineRouteNames(data.dir) },
    effects: { pluginParams: (name) => data.pluginParams(name), books: gameBooks(data) },
  };
}
