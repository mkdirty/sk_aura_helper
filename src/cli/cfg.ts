// Control-flow graphs of event command lists.
//
//   npm run cfg                              build every list; write out/cfg/coverage.{txt,json}
//   npm run cfg -- ce <id…>                  print common events' graphs
//   npm run cfg -- map <id> [event [page]]   print a map's (or one event's / page's) graphs
//   npm run cfg -- troop <id> [page]
//   npm run cfg -- --review                  findings not reviewed (or changed since); exit 1 if any
//   npm run cfg -- --accept KEY… [--note "…"]  record a review of these findings
// Options: --dot (Graphviz), --json

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { GameData, type RawCommand } from "../data/game-data.ts";
import { engineRouteNames } from "../events/decode.ts";
import { allLists, commonEventLists, mapLists, troopLists, type CommandList } from "../events/lists.ts";
import { Names } from "../events/names.ts";
import { buildCfg, cfgContext } from "../graph/cfg.ts";
import { CfgCoverage, cfgJson, formatCfgCoverage, renderCfgDot, renderCfgText, type ReviewedFinding } from "../graph/cfg-print.ts";
import { compareFindings, currentFindings, loadFindingReview, saveFindingReview } from "../graph/cfg-review.ts";
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
    review: { type: "boolean", default: false },
    accept: { type: "boolean", default: false },
    note: { type: "string" },
  },
});
const USAGE = "usage: cfg [ce <id…> | map <id> [event [page]] | troop <id> [page]] [--dot] [--json]";

const data = new GameData();
const ctx = cfgContext(data);
const [command, ...rest] = positionals;
const ids = rest.map(Number);

if (values.review || values.accept) {
  const current = currentFindings(data, ctx);
  const saved = loadFindingReview();
  if (values.accept) {
    for (const key of positionals) {
      if (!current[key]) {
        console.error(`${key}: not a current finding (see npm run cfg -- --review)`);
        process.exit(2);
      }
      saved[key] = { ...current[key], ...(values.note ? { note: values.note } : saved[key]?.note ? { note: saved[key].note } : {}) };
    }
    for (const key of Object.keys(saved)) if (!current[key]) delete saved[key];
    saveFindingReview(saved);
    console.log(`recorded ${positionals.length} finding(s)`);
  } else {
    const p = compareFindings(saved, current);
    const lines = [
      ...p.unreviewed.map((k) => `unreviewed  ${k}  ${current[k].issue}${current[k].detail ? ` (${current[k].detail})` : ""}`),
      ...p.changed.map((k) => `changed     ${k}  (list changed since the review: ${saved[k].note ?? ""})`),
      ...p.gone.map((k) => `gone        ${k}  (no longer found; --accept anything to drop it)`),
    ];
    console.log(lines.length ? lines.join("\n") : `all ${Object.keys(current).length} findings reviewed`);
    process.exitCode = lines.length ? 1 : 0;
  }
} else if (!command) {
  const t0 = performance.now();
  const coverage = new CfgCoverage();
  for (const l of allLists(data)) coverage.add(buildCfg(l.source, l.list, ctx));
  const report = coverage.report();
  const ms = Math.round(performance.now() - t0);
  const version = JSON.parse(fs.readFileSync(path.join(data.dir, "package.json"), "utf8")).version ?? "unknown";
  const out = path.resolve(values.out);
  fs.mkdirSync(out, { recursive: true });
  const current = currentFindings(data, ctx);
  const saved = loadFindingReview();
  const findings: ReviewedFinding[] = Object.entries(current).map(([key, f]) => ({
    key,
    issue: f.issue,
    detail: f.detail,
    status: !saved[key] ? "NEW" : saved[key].listHash !== f.listHash || saved[key].detail !== f.detail ? "CHANGED" : "reviewed",
    note: saved[key]?.note,
  }));
  fs.writeFileSync(path.join(out, "coverage.txt"), formatCfgCoverage(report, findings, `# Control-flow graph coverage (game ${version})`));
  fs.writeFileSync(path.join(out, "coverage.json"), JSON.stringify(report, null, 2) + "\n");
  console.log(`built ${report.lists} graphs in ${ms} ms: ${report.nodes} commands, ${report.edges} edges, ${report.unreachable} unreachable, ${report.staleEdges} stale edges`);
  const open = findings.filter((f) => f.status !== "reviewed");
  console.log(`${findings.length} findings, ${open.length} not reviewed${open.length ? ":" : ""}`);
  for (const f of open) console.log(`  ${f.status.padEnd(8)}  ${f.key}${f.detail ? ` (${f.detail})` : ""}`);
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
