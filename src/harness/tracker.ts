// Records game-state changes by wrapping the engine's setters (after plugins have loaded,
// so plugin overrides run inside the wrapper).

export type Change =
  | { frame: number; kind: "switch" | "variable"; id: number; name: string; before: unknown; after: unknown }
  | { frame: number; kind: "selfSwitch"; key: [number, number, string]; before: boolean; after: boolean }
  | { frame: number; kind: "item" | "weapon" | "armor"; id: number; name: string; before: number; after: number }
  | { frame: number; kind: "gold"; before: number; after: number };

// Variables can hold arrays or objects; snapshot them so later mutation doesn't rewrite history.
const snapshot = (v: unknown) => (v !== null && typeof v === "object" ? structuredClone(v) : v);
const same = (a: unknown, b: unknown) => a === b || JSON.stringify(a) === JSON.stringify(b);

export class ChangeTracker {
  readonly changes: Change[] = [];

  constructor(g: any, frame: () => number) {
    const record = (c: Change) => this.changes.push(c);
    const { DataManager } = g;
    const names = () => g.$dataSystem;

    wrap(g.Game_Switches.prototype, "setValue", function (this: any, orig, id: number) {
      const before = this.value(id);
      orig();
      const after = this.value(id);
      if (before !== after) record({ frame: frame(), kind: "switch", id, name: names().switches[id] ?? "", before, after });
    });
    wrap(g.Game_Variables.prototype, "setValue", function (this: any, orig, id: number) {
      const before = snapshot(this.value(id));
      orig();
      const after = snapshot(this.value(id));
      if (!same(before, after)) record({ frame: frame(), kind: "variable", id, name: names().variables[id] ?? "", before, after });
    });
    wrap(g.Game_SelfSwitches.prototype, "setValue", function (this: any, orig, key: [number, number, string]) {
      const before = !!this.value(key);
      orig();
      const after = !!this.value(key);
      if (before !== after) record({ frame: frame(), kind: "selfSwitch", key: [...key], before, after });
    });
    wrap(g.Game_Party.prototype, "gainItem", function (this: any, orig, item: any) {
      if (!item) return orig();
      const before = this.numItems(item);
      orig();
      const after = this.numItems(item);
      const kind = DataManager.isItem(item) ? "item" : DataManager.isWeapon(item) ? "weapon" : "armor";
      if (before !== after) record({ frame: frame(), kind, id: item.id, name: item.name, before, after });
    });
    wrap(g.Game_Party.prototype, "gainGold", function (this: any, orig) {
      const before = this.gold();
      orig();
      const after = this.gold();
      if (before !== after) record({ frame: frame(), kind: "gold", before, after });
    });
  }

  clear() {
    this.changes.length = 0;
  }
}

/** Replaces `proto[name]` with `body`, which receives a thunk that calls the original. */
function wrap(proto: any, name: string, body: (this: any, orig: () => any, ...args: any[]) => any) {
  const original = proto[name];
  proto[name] = function (this: any, ...args: any[]) {
    let result: unknown;
    body.call(this, () => (result = original.apply(this, args)), ...args);
    return result;
  };
}
