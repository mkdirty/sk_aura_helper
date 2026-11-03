// Control-flow graphs of event command lists.
//
//   npm run cfg                              build every list; write out/cfg/coverage.{txt,json}
//   npm run cfg -- ce <id…>                  print common events' graphs
//   npm run cfg -- map <id> [event [page]]   print a map's (or one event's / page's) graphs
//   npm run cfg -- troop <id> [page]
// Options: --dot (Graphviz), --json

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { GameData, type RawCommand } from "../data/game-data.ts";
import { engineRouteNames } from "../events/decode.ts";
import { allLists, commonEventLists, mapLists, troopLists, type CommandList } from "../events/lists.ts";
import { Names } from "../events/names.ts";
import { buildCfg, cfgContext } from "../graph/cfg.ts";
import { CfgCoverage, cfgJson, formatCfgCoverage, renderCfgDot, renderCfgText } from "../graph/cfg-print.ts";
import { ROOT } from "../paths.ts";

process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    dot: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    out: { type: "string", default: path.join(ROOT, "out/cfg") },
  },
});
const USAGE = "usage: cfg [ce <id…> | map <id> [event [page]] | troop <id> [page]] [--dot] [--json]";

const data = new GameData();
const ctx = cfgContext(data);
const [command, ...rest] = positionals;
const ids = rest.map(Number);

if (!command) {
  const t0 = performance.now();
  const coverage = new CfgCoverage();
  for (const l of allLists(data)) coverage.add(buildCfg(l.source, l.list, ctx));
  const report = coverage.report();
  const ms = Math.round(performance.now() - t0);
  const version = JSON.parse(fs.readFileSync(path.join(data.dir, "package.json"), "utf8")).version ?? "unknown";
  const out = path.resolve(values.out);
  fs.mkdirSync(out, { recursive: true });
  fs.writeFileSync(path.join(out, "coverage.txt"), formatCfgCoverage(report, `# Control-flow graph coverage (game ${version})`));
  fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`built ${report.lists} graphs in ${ms} ms: ${report.nodes} commands, ${report.edges} edges, ${report.unreachable} unreachable, ${report.staleEdges} stale edges`);
  for (const i of report.issues) console.log(`  ${String(i.count).padStart(7)}  ${i.key}`);
  console.log(`wrote ${path.relative(process.cwd(), out) || out}/coverage.txt`);
} else {
  const names = new Names(data);
  let lists: CommandList[];
  if (command === "ce") lists = [...commonEventLists(data)].filter((l) => l.source.kind === "common" && ids.includes(l.source.id));
  else if (command === "map") {
    const [mapId, eventId, page] = ids;
    names.currentMap = data.map(mapId);
    lists = [...mapLists(data, mapId)].filter(
      (l) => l.source.kind === "map" && !l.source.original && (eventId === undefined || l.source.eventId === eventId) && (page === undefined || l.source.page === page),
    );
  } else if (command === "troop") {
    const [troopId, page] = ids;
    lists = [...troopLists(data)].filter((l) => l.source.kind === "troop" && l.source.troopId === troopId && (page === undefined || l.source.page === page));
  } else {
    console.error(USAGE);
    process.exitCode = 2;
    lists = [];
  }
  if (command && !lists.length && process.exitCode === undefined) {
    console.error(`no matching lists`);
    process.exitCode = 1;
  }
  const decode = { routeNames: engineRouteNames(data.dir) };
  const render = (list: RawCommand[], l: CommandList) => {
    const cfg = buildCfg(l.source, list, ctx);
    if (values.json) return JSON.stringify(cfgJson(cfg));
    return values.dot ? renderCfgDot(cfg, list, decode, names) : renderCfgText(cfg, list, decode, names);
  };
  // Write with process.stdout.write and let the process end on its own: process.exit() right
  // after a large write truncates piped output.
  if (values.json) process.stdout.write("[\n" + lists.map((l) => render(l.list, l)).join(",\n") + "\n]\n");
  else process.stdout.write(lists.map((l) => render(l.list, l)).join("\n"));
}
