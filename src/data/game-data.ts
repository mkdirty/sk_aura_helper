// Static access to the game's data files (plain JSON reads; no engine needed).

import fs from "node:fs";
import path from "node:path";
import { gameDir as defaultGameDir } from "../paths.ts";

/** One command in an event list, exactly as stored. */
export interface RawCommand {
  code: number;
  indent: number;
  parameters: any[];
}

export interface Named {
  id: number;
  name: string;
}

export interface MapEventPage {
  conditions: Record<string, any>;
  image: { characterName: string; characterIndex: number; tileId: number; direction: number; pattern: number };
  list: RawCommand[];
  trigger: number;
  priorityType: number;
  [key: string]: any;
}

export interface MapEvent extends Named {
  x: number;
  y: number;
  note: string;
  pages: MapEventPage[];
}

export interface GameMap {
  displayName: string;
  events: Array<MapEvent | null>;
  note: string;
  [key: string]: any;
}

export interface CommonEvent extends Named {
  trigger: number;
  switchId: number;
  list: RawCommand[];
}

export interface TroopPage {
  conditions: Record<string, any>;
  span: number;
  list: RawCommand[];
}

export interface Troop extends Named {
  members: Array<{ enemyId: number; x: number; y: number; hidden: boolean }>;
  pages: TroopPage[];
}

export interface MapInfo extends Named {
  parentId: number;
  order: number;
}

type Table<T> = Array<T | null>;

export class GameData {
  readonly dir: string;
  private cache = new Map<string, unknown>();

  constructor(dir: string = defaultGameDir()) {
    this.dir = dir;
  }

  /** Reads `data/<file>` (cached). */
  load<T>(file: string): T {
    let value = this.cache.get(file);
    if (value === undefined) {
      value = JSON.parse(fs.readFileSync(path.join(this.dir, "data", file), "utf8"));
      this.cache.set(file, value);
    }
    return value as T;
  }

  get system(): any {
    return this.load("System.json");
  }
  get commonEvents() {
    return this.load<Table<CommonEvent>>("CommonEvents.json");
  }
  get troops() {
    return this.load<Table<Troop>>("Troops.json");
  }
  get mapInfos() {
    return this.load<Table<MapInfo>>("MapInfos.json");
  }
  get actors() {
    return this.load<Table<Named>>("Actors.json");
  }
  get classes() {
    return this.load<Table<Named>>("Classes.json");
  }
  get skills() {
    return this.load<Table<Named>>("Skills.json");
  }
  get items() {
    return this.load<Table<Named>>("Items.json");
  }
  get weapons() {
    return this.load<Table<Named>>("Weapons.json");
  }
  get armors() {
    return this.load<Table<Named>>("Armors.json");
  }
  get enemies() {
    return this.load<Table<Named>>("Enemies.json");
  }
  get states() {
    return this.load<Table<Named>>("States.json");
  }
  get animations() {
    return this.load<Table<Named>>("Animations.json");
  }

  /** Map ids that have a data file, ascending. */
  mapIds(): number[] {
    return fs
      .readdirSync(path.join(this.dir, "data"))
      .map((f) => /^Map(\d{3,})\.json$/.exec(f)?.[1])
      .filter((id): id is string => id !== undefined)
      .map(Number)
      .sort((a, b) => a - b);
  }

  /** js/plugins.js: the plugin list with parameters, in load order. */
  plugins(): Array<{ name: string; status: boolean; parameters: Record<string, string> }> {
    let value = this.cache.get("plugins.js") as ReturnType<GameData["plugins"]> | undefined;
    if (!value) {
      const src = fs.readFileSync(path.join(this.dir, "js/plugins.js"), "utf8");
      value = JSON.parse(src.slice(src.indexOf("["), src.lastIndexOf("]") + 1));
      this.cache.set("plugins.js", value);
    }
    return value!;
  }

  /** Parameters of an enabled plugin, by file name (e.g. "adult_content_option"). */
  pluginParams(name: string): Record<string, string> {
    return this.plugins().find((p) => p.status && p.name.split("/").pop() === name)?.parameters ?? {};
  }

  map(id: number): GameMap {
    return this.load<GameMap>(`Map${String(id).padStart(3, "0")}.json`);
  }

  mapName(id: number): string {
    return this.mapInfos[id]?.name ?? "";
  }
}
