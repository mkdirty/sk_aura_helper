// Command line for the headless harness.
//
//   npm run harness -- ce <id...> [--map N] [--seed N] [--transcript] [--json] [--verbose]
//       New game on map N (default 0, the engine's empty map), then run each common event
//       in order and print the state changes it made.
//   npm run harness -- test <mapId...> [--json] [--verbose]
//       Run the author's automated event tests on each map (e.g. 50).
//   npm run harness -- who <switch N | variable N | self M,E,L> (ce <id> | page <map> <event> <page>)
//       From the cross-check's "game in progress", run the entry and show who writes the target
//       (stack + running parallel events). Diagnoses unexplained cross-check changes.
//   npm run harness -- handler <plugin:command...>
//       Print the source of registered plugin command handlers (e.g. selfswitches_utils:setLocalSelfSwitch).

import { parseArgs } from "node:util";
import { runEventTests } from "../harness/event-test.ts";
import { formatChange, formatEventTests, formatStop, formatTranscript } from "../harness/format.ts";
import { Harness } from "../harness/harness.ts";
import { startGameInProgress, traceWrites, type TracedWrite, type TraceTarget } from "../harness/trace.ts";

// Exit quietly when piped into something that closes early (e.g. `| head`).
process.stdout.on("error", (e: NodeJS.ErrnoException) => {
  if (e.code === "EPIPE") process.exit(0);
  throw e;
});

const USAGE = `usage:
  harness ce <id...> [--map N] [--seed N] [--transcript] [--json] [--verbose]
  harness test <mapId...> [--seed N] [--json] [--verbose]
  harness who <switch N | variable N | self M,E,L> (ce <id> | page <map> <event> <page>)
  harness handler <plugin:command...>`;

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    map: { type: "string", default: "0" },
    seed: { type: "string", default: "1" },
    transcript: { type: "boolean", default: false },
    json: { type: "boolean", default: false },
    verbose: { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [command, ...rest] = positionals;
const ids = rest.map(Number);
const numeric = command === "ce" || command === "test";
if (values.help || !command || !rest.length || (numeric && ids.some((n) => !Number.isInteger(n)))) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 2);
}

const boot = () => Harness.boot({ seed: Number(values.seed), echoConsole: values.verbose });

if (command === "who") {
  const [kind, spec, entry, ...where] = rest;
  const target: TraceTarget | undefined =
    kind === "switch" || kind === "variable"
      ? { kind, id: Number(spec) }
      : kind === "self"
        ? { kind: "selfSwitch", key: [Number(spec.split(",")[0]), Number(spec.split(",")[1]), String(spec.split(",")[2])] }
        : undefined;
  if (!target || (entry !== "ce" && entry !== "page")) {
    console.error(USAGE);
    process.exit(2);
  }
  const h = await boot();
  startGameInProgress(h);
  const writes: TracedWrite[] = [];
  traceWrites(h, target, writes);
  const [a, b, c] = where.map(Number);
  const run = entry === "ce" ? h.runCommonEvent(a, 3000) : h.runEventPage(a, b, c, 3000);
  console.log(`run: ${formatStop(run.stop)} after ${run.frames} frames; ${writes.length} write(s)`);
  for (const w of writes) {
    console.log(`\n= ${JSON.stringify(w.value)} on map ${w.mapId}${w.parallel.length ? `; parallel events running: ${w.parallel.join(", ")}` : ""}`);
    for (const line of w.stack) console.log(`    ${line}`);
  }
} else if (command === "handler") {
  const h = await boot();
  for (const key of rest) {
    const fn = h.g.PluginManager._commands[key];
    console.log(`== ${key}\n${fn ? String(fn) : "(not registered)"}\n`);
  }
} else if (command === "ce") {
  const h = await boot();
  h.newGame({ mapId: Number(values.map) });
  const runs = [];
  for (const id of ids) {
    h.tracker.clear();
    const transcriptStart = h.transcript.length;
    const ce = h.g.$dataCommonEvents[id];
    const result = h.runCommonEvent(id);
    runs.push({ id, name: ce?.name ?? "", ...result, changes: [...h.tracker.changes], transcript: h.transcript.slice(transcriptStart) });
    if (typeof result.stop !== "string") break;
  }
  if (values.json) {
    console.log(JSON.stringify(runs, null, 2));
  } else {
    for (const run of runs) {
      console.log(`CE${run.id} ${run.name}: ${formatStop(run.stop)} after ${run.frames} frames, ${run.changes.length} changes`);
      for (const c of run.changes) console.log(`  ${formatChange(c)}`);
      if (values.transcript) for (const t of run.transcript) console.log(`  > ${formatTranscript(t)}`);
    }
  }
  process.exitCode = runs.every((r) => r.stop === "completed") ? 0 : 1;
} else if (command === "test") {
  const runs = [];
  for (const mapId of ids) runs.push(runEventTests(await boot(), mapId));
  if (values.json) console.log(JSON.stringify(runs, null, 2));
  else for (const run of runs) console.log(formatEventTests(run).join("\n"));
  const failed = runs.flatMap((r) => r.results).some((r) => r.status === "failed");
  process.exitCode = failed ? 1 : 0;
} else {
  console.error(USAGE);
  process.exitCode = 2;
}
