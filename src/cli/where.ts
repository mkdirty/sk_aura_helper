// "Where is X used?" over the cross-reference index.
//
//   npm run where -- item 23            also: weapon, armor, skill, state, class, actor, troop
//   npm run where -- switch 22          variable 2, gold
//   npm run where -- selfswitch 7 8 A   (map, event, letter)
//   npm run where -- ce 785             who calls a common event
//   npm run where -- map 7              transfers into a map
//   npm run where -- event 7 8          calls of a map event (start, local event calls)
//   npm run where -- quest 51 [objective]
//   npm run where -- unanalyzed         what the index couldn't see, ranked
// Options: --dead (include code in Skip blocks), --json, --callers N (how many callers to show
// for references inside common events; "all" for every one)

import { parseArgs } from "node:util";
import { analysisContext } from "../analysis/context.ts";
import type { Entity, Id } from "../analysis/effects.ts";
import { XrefIndex, type Ref, type Site } from "../analysis/xref.ts";
import { GameData } from "../data/game-data.ts";
import { sourceLabel } from "../events/lists.ts";
import { Names } from "../events/names.ts";

// Exit quietly when piped into something that closes early (e.g. `| head`).
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dead: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    callers: { type: "string", default: "3" },
  },
});
const [kindArg, ...args] = positionals;
const USAGE = "usage: where <item|weapon|armor|skill|state|class|actor|troop|switch|variable|gold|selfswitch|ce|map|event|quest|unanalyzed> [ids…] [--dead] [--json]";
if (!kindArg) {
  console.error(USAGE);
  process.exit(2);
}

const data = new GameData();
const index = XrefIndex.build(analysisContext(data));
const names = new Names(data);

const num = (s: string | undefined) => Number(String(s ?? "").replace(/^[SVsv]/, ""));
const eq = (a: Id | string | undefined, b: number | string) => a === b;

function dbName(table: string, id: number): string {
  const rows = (data as any)[table] as Array<{ name?: string } | null> | undefined;
  const name = rows?.[id]?.name;
  return name ? ` ${JSON.stringify(name)}` : "";
}

function describeSite(site: Site): string {
  const s = site.source;
  let where: string;
  if (s.kind === "map") {
    const event = data.map(s.mapId).events[s.eventId];
    const at = site.index < 0 ? "autonomous route" : `#${site.index}`;
    where = `${names.map(s.mapId)} / E${s.eventId}${event ? ` ${JSON.stringify(event.name)}` : ""} / page ${s.page} ${at}`;
  } else if (s.kind === "common") where = `${names.commonEvent(s.id)} #${site.index}`;
  else if (s.kind === "troop") where = `${names.troop(s.troopId)} / page ${s.page} #${site.index}`;
  else where = `database: ${s.table} ${s.id}${dbName(s.table, s.id)}`;
  const via = site.via.length ? `   via ${site.via.map((c) => names.commonEvent(c)).join(" → ")}` : "";
  return `${where}${via}${site.dead ? "   [dead: Skip block]" : ""}`;
}

if (kindArg === "unanalyzed") {
  const rows = [...index.unanalyzed].sort((a, b) => b[1].count - a[1].count);
  if (values.json) console.log(JSON.stringify(rows.map(([reason, t]) => ({ reason, count: t.count, samples: t.samples.map((s) => `${sourceLabel(s.source)}#${s.index}`) })), null, 2));
  else for (const [reason, t] of rows) console.log(`${String(t.count).padStart(7)}  ${reason}    e.g. ${t.samples.map((s) => `${sourceLabel(s.source)}#${s.index}`).join(", ")}`);
  process.exit(0);
}

let title: string;
let kind: Entity["kind"];
let match: (e: Entity) => boolean;
const byId = (k: Entity["kind"], id: number) => {
  kind = k;
  match = (e) => eq((e as { id: Id }).id, id);
};

switch (kindArg) {
  case "item":
  case "weapon":
  case "armor":
    byId(kindArg, num(args[0]));
    title = names.item(kindArg, num(args[0]));
    break;
  case "switch":
    byId("switch", num(args[0]));
    title = names.switch(num(args[0]));
    break;
  case "variable":
    byId("variable", num(args[0]));
    title = names.variable(num(args[0]));
    break;
  case "skill":
  case "state":
  case "class":
  case "actor":
  case "troop":
    byId(kindArg, num(args[0]));
    title = (names as any)[kindArg](num(args[0]));
    break;
  case "ce":
    byId("commonEvent", num(args[0]));
    title = names.commonEvent(num(args[0]));
    break;
  case "map":
    byId("map", num(args[0]));
    title = names.map(num(args[0]));
    break;
  case "gold":
    kind = "gold";
    match = () => true;
    title = "gold";
    break;
  case "selfswitch": {
    const [m, e, letter] = [num(args[0]), num(args[1]), (args[2] ?? "A").toUpperCase()];
    kind = "selfSwitch";
    match = (x) => x.kind === "selfSwitch" && eq(x.mapId, m) && eq(x.eventId, e) && x.letter === letter;
    title = `self switch ${letter} of ${names.map(m)} / E${e}`;
    break;
  }
  case "event": {
    const [m, e] = [num(args[0]), num(args[1])];
    kind = "mapEvent";
    match = (x) => x.kind === "mapEvent" && eq(x.mapId, m) && eq(x.eventId, e);
    title = `${names.map(m)} / E${e}`;
    break;
  }
  case "quest": {
    const [q, o] = [num(args[0]), args[1] === undefined ? undefined : num(args[1])];
    kind = "quest";
    match = (x) => x.kind === "quest" && eq(x.id, q) && (o === undefined || eq(x.objective, o));
    title = `quest ${q}${o !== undefined ? ` objective ${o}` : ""}`;
    break;
  }
  default:
    console.error(USAGE);
    process.exit(2);
}

const refs = index.find(kind!, match!).filter((r) => values.dead || !r.site.dead);
const dynamic = index.find(kind!, (e) => Object.values(e).some((v) => typeof v === "object" && v !== null)).filter((r) => !r.site.dead).length;

if (values.json) {
  console.log(JSON.stringify({ title: title!, refs, dynamicElsewhere: dynamic }, null, 2));
  process.exit(0);
}

/** Where a common event is ultimately run from: map events, troops and the database. */
function entryPoints(ce: number, seen = new Set<number>()): Site[] {
  if (seen.has(ce)) return [];
  seen.add(ce);
  const out: Site[] = [];
  for (const r of index.find("commonEvent", (e) => eq((e as { id: Id }).id, ce))) {
    if (r.effect.access !== "call" || r.site.dead || r.site.via.length) continue;
    if (r.site.source.kind === "common") out.push(...entryPoints(r.site.source.id, seen));
    else out.push(r.site);
  }
  return out;
}
const shortSite = (site: Site) => {
  const s = site.source;
  if (s.kind === "map") return `${sourceLabel(s)} ${JSON.stringify(data.map(s.mapId).events[s.eventId]?.name ?? "")}`;
  if (s.kind === "database") return `${s.table} ${s.id}${dbName(s.table, s.id)}`;
  return sourceLabel(s);
};

// Group by what happens: "write gain", "read has?", "call transfer", …
const groups = new Map<string, Ref[]>();
for (const r of refs) {
  const key = r.effect.access === "call" ? `called: ${r.effect.how}` : `${r.effect.access} ${r.effect.how}`;
  if (!groups.has(key)) groups.set(key, []);
  groups.get(key)!.push(r);
}
console.log(`${title!}: ${refs.length} reference${refs.length === 1 ? "" : "s"}`);
for (const [key, list] of [...groups].sort((a, b) => b[1].length - a[1].length)) {
  console.log(`\n  ${key} (${list.length})`);
  for (const r of list) {
    const amount = r.effect.amount === undefined ? "" : typeof r.effect.amount === "number" ? `${r.effect.sign === -1 ? "-" : "+"}${r.effect.amount}  ` : `${r.effect.sign === -1 ? "-" : "+"}${"var" in r.effect.amount ? `V${r.effect.amount.var}` : "?"}  `;
    console.log(`    ${amount}${describeSite(r.site)}`);
    if (r.site.source.kind === "common") {
      const entries = entryPoints(r.site.source.id);
      const limit = values.callers === "all" ? entries.length : Number(values.callers);
      if (entries.length && limit > 0) {
        const shown = entries.slice(0, limit).map(shortSite).join(", ");
        console.log(`        ← run from ${entries.length} place${entries.length === 1 ? "" : "s"}: ${shown}${entries.length > limit ? ", …" : ""}`);
      } else if (!entries.length) console.log("        ← not run from any map event, troop or database entry (unreferenced, or reached another way)");
    }
  }
}
if (dynamic) console.log(`\n  (+ ${dynamic} references to ${kind!} ids that aren't constant here; see \`where unanalyzed\`)`);
