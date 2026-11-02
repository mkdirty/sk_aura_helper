// Runtime cross-check of the cross-reference index against the headless harness.
//
//   npm run crosscheck [-- --ce 12 --ce 785] [--pages] [--map 7 …] [--frames 3000] [--out DIR]
// Default: every common event. --pages: every map event page instead (or those of --map).
// --rerun-unexplained: only the entries that had unexplained changes in the previous results.json.
// Writes out/crosscheck/report.txt (+ results.json) and prints a summary.

import fs from "node:fs";
import path from "node:path";
import { parseArgs } from "node:util";
import { analysisContext } from "../analysis/context.ts";
import { XrefIndex } from "../analysis/xref.ts";
import { commonEventEntries, crossCheck, entryLabel, pageEntries, StaticWrites, type Entry, type RunCheck } from "../check/crosscheck.ts";
import { GameData } from "../data/game-data.ts";
import { Names } from "../events/names.ts";
import { formatChange } from "../harness/format.ts";
import { Harness } from "../harness/harness.ts";
import { ROOT } from "../paths.ts";

// Exit quietly when piped into something that closes early (e.g. `| head`).
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const { values } = parseArgs({
  options: {
    ce: { type: "string", multiple: true },
    pages: { type: "boolean", default: false },
    "rerun-unexplained": { type: "boolean", default: false },
    map: { type: "string", multiple: true },
    frames: { type: "string", default: "3000" },
    out: { type: "string", default: path.join(ROOT, "out/crosscheck") },
  },
});

const data = new GameData();
const names = new Names(data);
const index = XrefIndex.build(analysisContext(data));
const h = await Harness.boot();
const started = performance.now();
const previous = path.join(path.resolve(values.out), "results.json");
const entries: Entry[] = values["rerun-unexplained"]
  ? (JSON.parse(fs.readFileSync(previous, "utf8")) as RunCheck[]).filter((r) => r.changes.some((c) => c.verdict === "unexplained")).map((r) => r.entry)
  : values.ce
  ? values.ce.map((id) => ({ kind: "ce" as const, id: Number(id) }))
  : values.pages || values.map
    ? pageEntries(data, values.map?.map(Number))
    : commonEventEntries(data);
const results = crossCheck(h, data, new StaticWrites(index), { maxFrames: Number(values.frames), entries });
const seconds = ((performance.now() - started) / 1000).toFixed(1);

const stopKey = (r: RunCheck) => (typeof r.stop === "string" ? r.stop : `scene ${r.stop.scene}`);
const count = <T>(xs: T[], key: (x: T) => string) => {
  const m = new Map<string, number>();
  for (const x of xs) m.set(key(x), (m.get(key(x)) ?? 0) + 1);
  return [...m].sort((a, b) => b[1] - a[1]);
};

const all = results.flatMap((r) => r.changes.map((c) => ({ ...c, entry: r.entry })));
const lines: string[] = [];
lines.push(`# Runtime cross-check: ${results.length} runs in ${seconds}s`, "");
lines.push("## Runs by outcome");
for (const [k, n] of count(results, stopKey)) lines.push(`  ${String(n).padStart(6)}  ${k}`);
lines.push("", `## Observed changes: ${all.length}`);
for (const [k, n] of count(all, (c) => c.verdict)) lines.push(`  ${String(n).padStart(6)}  ${k}`);

// Unexplained, grouped by what changed.
const groups = new Map<string, { ces: Set<string>; sample: string }>();
for (const c of all.filter((c) => c.verdict === "unexplained")) {
  const ch = c.change;
  const key = ch.kind === "selfSwitch" ? `selfSwitch ${ch.key.join(",")}` : ch.kind === "gold" ? "gold" : `${ch.kind} ${ch.id}`;
  const g = groups.get(key) ?? { ces: new Set(), sample: formatChange(ch) };
  g.ces.add(entryLabel(c.entry));
  groups.set(key, g);
}
lines.push("", `## Unexplained (${groups.size} distinct; ranked by how many runs)`);
for (const [, g] of [...groups].sort((a, b) => b[1].ces.size - a[1].ces.size)) {
  const ces = [...g.ces];
  lines.push(`  ${String(ces.length).padStart(4)}  ${g.sample}    in ${ces.slice(0, 6).map((c) => (/^CE\d+$/.test(c) ? names.commonEvent(Number(c.slice(2))) : c)).join(", ")}${ces.length > 6 ? ", …" : ""}`);
}

const errors = results.filter((r) => r.stop === "error");
lines.push("", `## Errors (${errors.length})`);
for (const [msg, n] of count(errors, (r) => r.error ?? "")) {
  const which = errors.filter((r) => r.error === msg).map((r) => entryLabel(r.entry));
  lines.push(`  ${String(n).padStart(4)}  ${msg.slice(0, 140)}    e.g. ${which.slice(0, 5).join(", ")}`);
}

const out = path.resolve(values.out);
fs.mkdirSync(out, { recursive: true });
fs.writeFileSync(path.join(out, "report.txt"), lines.join("\n") + "\n");
fs.writeFileSync(path.join(out, "results.json"), JSON.stringify(results, null, 1) + "\n");
console.log(lines.slice(0, lines.indexOf(`## Unexplained (${groups.size} distinct; ranked by how many runs)`) + 16).join("\n"));
console.log(`\n(full report: ${path.relative(process.cwd(), path.join(out, "report.txt"))})`);
