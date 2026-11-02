// Pretty-prints event command lists.
//
//   npm run print                      decode everything into out/events/ (+ coverage report)
//   npm run print -- ce <id...>        print common events to stdout
//   npm run print -- map <id> [event]  print a map (or one of its events) to stdout
//   npm run print -- troop <id...>     print troops to stdout
// Options: --text full|first|none (dialogue), --out DIR, --no-registry (skip booting the
// harness to check plugin command registration).

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { GameData } from "../data/game-data.ts";
import { Coverage, formatCoverage } from "../events/coverage.ts";
import { engineRouteNames } from "../events/decode.ts";
import { renderCommonEvent, renderMap, renderTroop, type DocumentOptions } from "../events/document.ts";
import type { TextMode } from "../events/render.ts";
import { Harness } from "../harness/harness.ts";
import { ROOT } from "../paths.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    text: { type: "string", default: "full" },
    out: { type: "string", default: path.join(ROOT, "out/events") },
    "no-registry": { type: "boolean", default: false },
  },
});
const text = values.text as TextMode;
if (!["full", "first", "none"].includes(text)) throw new Error(`--text must be full, first or none`);

const data = new GameData();
const coverage = new Coverage();
const options: DocumentOptions = {
  data,
  decode: { routeNames: engineRouteNames(data.dir) },
  text,
  onDecoded: (list, decoded) => coverage.add(list, decoded),
};

/** Filesystem-safe name fragment. */
const safe = (s: string) => s.replace(/[^\w.-]+/g, "_").replace(/^_+|_+$/g, "").slice(0, 60);
const pad = (n: number, w: number) => String(n).padStart(w, "0");

const [command, ...rest] = positionals;
const ids = rest.map(Number);

if (!command) {
  const out = path.resolve(values.out);
  fs.rmSync(out, { recursive: true, force: true });
  for (const sub of ["common", "maps", "troops"]) fs.mkdirSync(path.join(out, sub), { recursive: true });
  for (const ce of data.commonEvents) {
    if (ce) fs.writeFileSync(path.join(out, "common", `CE${pad(ce.id, 4)}_${safe(ce.name)}.txt`), renderCommonEvent(ce, options));
  }
  for (const mapId of data.mapIds()) {
    fs.writeFileSync(path.join(out, "maps", `Map${pad(mapId, 3)}_${safe(data.mapName(mapId))}.txt`), renderMap(mapId, options));
  }
  for (const troop of data.troops) {
    if (troop) fs.writeFileSync(path.join(out, "troops", `Troop${pad(troop.id, 4)}_${safe(troop.name)}.txt`), renderTroop(troop, options));
  }
  let registered: Set<string> | undefined;
  if (!values["no-registry"]) {
    const h = await Harness.boot();
    registered = new Set(Object.keys(h.g.PluginManager._commands));
  }
  const version = JSON.parse(fs.readFileSync(path.join(data.dir, "package.json"), "utf8")).version ?? "unknown";
  const report = coverage.report({ registered, gameDir: data.dir });
  fs.writeFileSync(path.join(out, "coverage.txt"), formatCoverage(report, `# Event command coverage (game ${version})`));
  fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(report, null, 2) + "\n");
  const gaps = report.gaps.reduce((s, g) => s + g.count, 0);
  console.log(`wrote ${report.lists} lists (${report.commands} commands) to ${path.relative(process.cwd(), out) || out}; ${gaps} gaps in ${report.gaps.length} categories`);
  for (const g of report.gaps.slice(0, 10)) console.log(`  ${String(g.count).padStart(7)}  ${g.key}`);
} else if (command === "ce") {
  for (const id of ids) {
    const ce = data.commonEvents[id];
    if (!ce) throw new Error(`no common event ${id}`);
    process.stdout.write(renderCommonEvent(ce, options));
  }
} else if (command === "map") {
  const [mapId, eventId] = ids;
  let doc = renderMap(mapId, options);
  if (eventId !== undefined) {
    const start = doc.indexOf(`=== E${eventId} `);
    if (start < 0) throw new Error(`no event ${eventId} on map ${mapId}`);
    const end = doc.indexOf("\n=== E", start + 1);
    doc = doc.slice(start, end < 0 ? undefined : end + 1);
  }
  process.stdout.write(doc);
} else if (command === "troop") {
  for (const id of ids) {
    const troop = data.troops[id];
    if (!troop) throw new Error(`no troop ${id}`);
    process.stdout.write(renderTroop(troop, options));
  }
} else {
  console.error("usage: print [ce <id...> | map <id> [event] | troop <id...>] [--text full|first|none] [--out DIR]");
  process.exitCode = 2;
}
