// Review snapshot for CFG findings (missing or duplicate labels, unmodelled interpreter tricks…).
//
// Each finding was looked at against the game; `cfg-review.json` records it with a hash of the
// command list it is in, so the review expires when a game update changes that list. Like the
// plugin reviews (src/analysis/plugin-review.ts): `npm run cfg -- --review` lists findings that
// are new or changed, `npm run cfg -- --accept KEY…` records a review. What each finding means
// for the game goes in docs/GAME-NOTES.md "Bugs and quirks"; the `note` here is a short reminder.

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { GameData } from "../data/game-data.ts";
import { allLists, sourceLabel } from "../events/lists.ts";
import { ROOT } from "../paths.ts";
import { buildCfg, type CfgContext } from "./cfg.ts";

export const CFG_REVIEW_FILE = path.join(ROOT, "src/graph/cfg-review.json");

export interface FindingEntry {
  issue: string;
  detail: string;
  /** sha256 (first 16 hex) of the command list the finding is in. */
  listHash: string;
  /** Short verdict, e.g. "bug: …" or "harmless: …". */
  note?: string;
}

export type FindingSnapshot = Record<string, FindingEntry>;

const hash = (s: string) => crypto.createHash("sha256").update(s).digest("hex").slice(0, 16);

/** Stable key: `Map175/E22/p0#441 duplicate-label`. */
export const findingKey = (site: string, issue: string) =>
  `${site} ${issue.replace(/\(.*\)/, "").trim().toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}`;

/** Every finding in the game, keyed. */
export function currentFindings(data: GameData, ctx: CfgContext): FindingSnapshot {
  const out: FindingSnapshot = {};
  for (const l of allLists(data)) {
    const cfg = buildCfg(l.source, l.list, ctx);
    const findings = cfg.issues.filter((i) => i.severity === "finding");
    if (!findings.length) continue;
    const listHash = hash(JSON.stringify(l.list));
    for (const i of findings) {
      out[findingKey(`${sourceLabel(l.source)}#${i.index}`, i.key)] = { issue: i.key, detail: i.detail, listHash };
    }
  }
  return out;
}

export interface FindingProblems {
  /** Not reviewed yet. */
  unreviewed: string[];
  /** Reviewed, but the list changed since. */
  changed: string[];
  /** Reviewed, but no longer found. */
  gone: string[];
}

export function compareFindings(saved: FindingSnapshot, current: FindingSnapshot): FindingProblems {
  const p: FindingProblems = { unreviewed: [], changed: [], gone: [] };
  for (const [key, cur] of Object.entries(current)) {
    const old = saved[key];
    if (!old) p.unreviewed.push(key);
    else if (old.listHash !== cur.listHash || old.detail !== cur.detail) p.changed.push(key);
  }
  for (const key of Object.keys(saved)) if (!(key in current)) p.gone.push(key);
  return p;
}

export const loadFindingReview = (): FindingSnapshot => (fs.existsSync(CFG_REVIEW_FILE) ? JSON.parse(fs.readFileSync(CFG_REVIEW_FILE, "utf8")) : {});

export function saveFindingReview(s: FindingSnapshot) {
  const sorted = Object.fromEntries(Object.entries(s).sort(([a], [b]) => a.localeCompare(b)));
  fs.writeFileSync(CFG_REVIEW_FILE, JSON.stringify(sorted, null, 2) + "\n");
}
