// Plugin command review status: which reviewed handlers changed since their review.
//
//   npm run plugins                       report changes; exit 1 if anything needs review
//   npm run plugins -- --accept KEY…      record a fresh review of these commands
//   npm run plugins -- --accept-all       record every command (after reviewing them all)
//
// See src/analysis/plugin-review.ts.

import { parseArgs } from "node:util";
import { compareReview, currentReview, loadReview, saveReview, usedPluginCommands } from "../analysis/plugin-review.ts";
import { GameData } from "../data/game-data.ts";
import { Harness } from "../harness/harness.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { accept: { type: "boolean", default: false }, "accept-all": { type: "boolean", default: false } },
});

const data = new GameData();
const h = await Harness.boot();
const current = currentReview(data, h.g.PluginManager._commands);
const saved = loadReview();

if (values["accept-all"]) {
  saveReview(current);
  console.log(`recorded ${Object.keys(current).length} commands`);
} else if (values.accept) {
  for (const key of positionals) {
    if (!current[key]) {
      console.error(`${key}: no verdict in effects.ts (add it to PLUGIN_EFFECTS, PRESENTATION or UNANALYZED_NOTES first)`);
      process.exit(2);
    }
    saved[key] = current[key];
  }
  for (const key of Object.keys(saved)) if (!current[key]) delete saved[key];
  saveReview(saved);
  console.log(`recorded ${positionals.length} command(s)`);
} else {
  const p = compareReview(saved, current, usedPluginCommands(data));
  const lines: string[] = [];
  for (const c of p.changed) lines.push(`changed     ${c.key} (${c.what.join(", ")}; ${current[c.key].file ?? "no file"})`);
  for (const k of p.unrecorded) lines.push(`unrecorded  ${k} (${current[k].verdict}; review it, then --accept)`);
  for (const k of p.stale) lines.push(`stale       ${k} (no longer in effects.ts)`);
  for (const u of p.unreviewed) lines.push(`unreviewed  ${u.key} (used ${u.count}×; no verdict in effects.ts)`);
  console.log(lines.length ? lines.join("\n") : `all ${Object.keys(current).length} reviewed plugin commands unchanged`);
  process.exit(lines.length ? 1 : 0);
}
