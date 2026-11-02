// Command line for the headless harness.
//
//   npm run harness -- ce <id...> [--map N] [--seed N] [--transcript] [--json] [--verbose]
//       New game on map N (default 0, the engine's empty map), then run each common event
//       in order and print the state changes it made.
//   npm run harness -- test <mapId...> [--json] [--verbose]
//       Run the author's automated event tests on each map (e.g. 50).

import { parseArgs } from "node:util";
import { runEventTests } from "../harness/event-test.ts";
import { formatChange, formatEventTests, formatStop, formatTranscript } from "../harness/format.ts";
import { Harness } from "../harness/harness.ts";

const USAGE = `usage:
  harness ce <id...> [--map N] [--seed N] [--transcript] [--json] [--verbose]
  harness test <mapId...> [--seed N] [--json] [--verbose]`;

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
if (values.help || !command || !ids.length || ids.some((n) => !Number.isInteger(n))) {
  console.error(USAGE);
  process.exit(values.help ? 0 : 2);
}

const boot = () => Harness.boot({ seed: Number(values.seed), echoConsole: values.verbose });

if (command === "ce") {
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
