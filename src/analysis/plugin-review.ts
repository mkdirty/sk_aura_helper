// Review snapshot for plugin command handlers.
//
// Every plugin command the analysis has a verdict for (effects.ts: modelled, no effect, or
// unanalyzed) was reviewed against the game's code. `plugin-review.json` records what was
// reviewed: a hash of the registered handler's source and of the plugin file that defines it
// (handlers often delegate to scenes and helpers in the same file). When a game update changes
// either, the command needs re-reading; `npm run plugins` lists what changed and
// `npm run plugins -- --accept KEY…` records a new review.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GameData } from "../data/game-data.ts";
import { allLists } from "../events/lists.ts";
import { ROOT } from "../paths.ts";
import { pluginVerdict, reviewedPluginCommands, type PluginVerdict } from "./effects.ts";

export const REVIEW_FILE = path.join(ROOT, "src/analysis/plugin-review.json");

export interface ReviewEntry {
  verdict: PluginVerdict;
  /** sha256 (first 16 hex) of the registered handler's source; null if not registered. */
  handler: string | null;
  /** The enabled plugin file registering under this name, and its hash; null if none. */
  file: string | null;
  fileHash: string | null;
}

export type ReviewSnapshot = Record<string, ReviewEntry>;

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** The current state of every reviewed command, from the running game's command registry. */
export function currentReview(data: GameData, registry: Record<string, unknown>): ReviewSnapshot {
  const files = new Map(data.plugins().filter((p) => p.status).map((p) => [p.name.split("/").pop()!, `js/plugins/${p.name}.js`]));
  const out: ReviewSnapshot = {};
  for (const key of reviewedPluginCommands()) {
    const fn = registry[key];
    const file = files.get(key.split(":")[0]) ?? null;
    const abs = file && path.join(data.dir, file);
    out[key] = {
      verdict: pluginVerdict(key)!,
      handler: typeof fn === "function" ? hash(String(fn)) : null,
      file,
      fileHash: abs && fs.existsSync(abs) ? hash(fs.readFileSync(abs, "utf8")) : null,
    };
  }
  return out;
}

/** `plugin:command` keys used by event command lists (code 357), with use counts. */
export function usedPluginCommands(data: GameData): Map<string, number> {
  const used = new Map<string, number>();
  for (const { list } of allLists(data)) {
    for (const cmd of list) {
      if (cmd.code !== 357) continue;
      const key = `${String(cmd.parameters[0]).split("/").pop()}:${cmd.parameters[1]}`;
      used.set(key, (used.get(key) ?? 0) + 1);
    }
  }
  return used;
}

export interface ReviewProblems {
  /** Handler or plugin file changed since the review (or verdict moved between lists). */
  changed: Array<{ key: string; what: string[] }>;
  /** Reviewed now but missing from the snapshot. */
  unrecorded: string[];
  /** In the snapshot but no longer reviewed in effects.ts. */
  stale: string[];
  /** Used in the game's events but without a verdict. */
  unreviewed: Array<{ key: string; count: number }>;
}

export function compareReview(saved: ReviewSnapshot, current: ReviewSnapshot, used: Map<string, number>): ReviewProblems {
  const p: ReviewProblems = { changed: [], unrecorded: [], stale: [], unreviewed: [] };
  for (const [key, cur] of Object.entries(current)) {
    const old = saved[key];
    if (!old) {
      p.unrecorded.push(key);
      continue;
    }
    const what = (["verdict", "handler", "file", "fileHash"] as const).filter((f) => old[f] !== cur[f]);
    if (what.length) p.changed.push({ key, what });
  }
  for (const key of Object.keys(saved)) if (!(key in current)) p.stale.push(key);
  for (const [key, count] of used) if (!pluginVerdict(key)) p.unreviewed.push({ key, count });
  return p;
}

export const loadReview = (): ReviewSnapshot => (fs.existsSync(REVIEW_FILE) ? JSON.parse(fs.readFileSync(REVIEW_FILE, "utf8")) : {});

export function saveReview(s: ReviewSnapshot) {
  const sorted = Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(REVIEW_FILE, JSON.stringify(sorted, null, 2) + "\n");
}
