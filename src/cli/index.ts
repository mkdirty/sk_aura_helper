// Builds the cross-reference index and writes generated artifacts to out/index/:
//   symbols.json     every switch/variable/item/…: id, the author's name verbatim, flags, usage counts
//   unanalyzed.txt   what the index couldn't see, ranked
//
//   npm run index [-- --out DIR]

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analysisContext } from "../analysis/context.ts";
import type { Entity } from "../analysis/effects.ts";
import { XrefIndex } from "../analysis/xref.ts";
import { GameData } from "../data/game-data.ts";
import { sourceLabel } from "../events/lists.ts";
import { ROOT } from "../paths.ts";

const { values } = parseArgs({ options: { out: { type: "string", default: path.join(ROOT, "out/index") } } });
const out = path.resolve(values.out);
fs.mkdirSync(out, { recursive: true });

const data = new GameData();
const index = XrefIndex.build(analysisContext(data));

interface Usage {
  reads: number;
  writes: number;
  calls: number;
}
const usage = new Map<string, Usage>();
for (const r of index.refs) {
  if (r.site.dead) continue;
  const e = r.effect.entity as Record<string, unknown>;
  if (typeof e.id !== "number") continue;
  const key = `${e.kind}:${e.id}`;
  const u = usage.get(key) ?? { reads: 0, writes: 0, calls: 0 };
  u[r.effect.access === "read" ? "reads" : r.effect.access === "write" ? "writes" : "calls"]++;
  usage.set(key, u);
}

type Kind = Entity["kind"];
const table = (kind: Kind, names: Array<string | null | undefined>) =>
  names.flatMap((name, id) => {
    if (id === 0) return [];
    const u = usage.get(`${kind}:${id}`) ?? { reads: 0, writes: 0, calls: 0 };
    const flags = [!name && "unnamed", name?.startsWith("--") && "section header", !u.reads && !u.writes && !u.calls && "unused"].filter(
      (f): f is string => typeof f === "string",
    );
    return [{ id, name: name ?? "", ...(flags.length ? { flags } : {}), ...u }];
  });
const named = (rows: Array<{ name?: string } | null>) => rows.map((r) => r?.name);

const symbols = {
  switch: table("switch", data.system.switches),
  variable: table("variable", data.system.variables),
  item: table("item", named(data.items)),
  weapon: table("weapon", named(data.weapons)),
  armor: table("armor", named(data.armors)),
  skill: table("skill", named(data.skills)),
  state: table("state", named(data.states)),
  class: table("class", named(data.classes)),
  actor: table("actor", named(data.actors)),
  commonEvent: table("commonEvent", named(data.commonEvents)),
  map: table("map", named(data.mapInfos)),
  troop: table("troop", named(data.troops)),
};
fs.writeFileSync(path.join(out, "symbols.json"), JSON.stringify(symbols, null, 1) + "\n");

const rows = [...index.unanalyzed].sort((a, b) => b[1].count - a[1].count);
fs.writeFileSync(
  path.join(out, "unanalyzed.txt"),
  rows.map(([reason, t]) => `${String(t.count).padStart(7)}  ${reason}    e.g. ${t.samples.map((s) => `${sourceLabel(s.source)}#${s.index}`).join(", ")}`).join("\n") + "\n",
);

const used = (rows: Array<{ flags?: string[] }>, flag: string) => rows.filter((r) => r.flags?.includes(flag) && !r.flags.includes("unused")).length;
console.log(`indexed ${index.refs.length} references; wrote ${path.relative(process.cwd(), out) || out}/symbols.json and unanalyzed.txt`);
for (const [label, rowsK] of [["switches", symbols.switch], ["variables", symbols.variable]] as const) {
  console.log(`  ${label}: ${rowsK.length}, unused ${rowsK.filter((r) => r.flags?.includes("unused")).length}; used but unnamed ${used(rowsK, "unnamed")}; used section headers ${used(rowsK, "section header")}`);
}
