// Coverage of a whole-project decode: what was understood, what wasn't, ranked by frequency.

import fs from "node:fs";
import path from "node:path";
import type { Decoded } from "./decode.ts";
import { sourceLabel, type CommandList } from "./lists.ts";
import type { Op } from "./ops.ts";

/** Calls `fn` on every op in the tree, depth first. */
export function walkOps(ops: Op[], fn: (op: Op) => void) {
  for (const op of ops) {
    fn(op);
    switch (op.kind) {
      case "if":
        walkOps(op.then, fn);
        if (op.else) walkOps(op.else, fn);
        break;
      case "loop":
      case "skip":
        walkOps(op.body, fn);
        break;
      case "choice":
        for (const b of op.branches) walkOps(b.body, fn);
        break;
      case "battle":
        for (const b of [op.win, op.escape, op.lose]) if (b) walkOps(b, fn);
        break;
    }
  }
}

interface Tally {
  count: number;
  samples: string[];
}

const SAMPLES = 5;
const bump = (m: Map<string, Tally>, key: string, where: string) => {
  const t = m.get(key) ?? { count: 0, samples: [] };
  t.count++;
  if (t.samples.length < SAMPLES) t.samples.push(where);
  m.set(key, t);
};

export interface CoverageReport {
  lists: number;
  commands: number;
  consumed: number;
  byKind: Record<string, number>;
  gaps: Array<{ key: string; count: number; samples: string[] }>;
  anomalies: Array<{ key: string; count: number; samples: string[] }>;
  pluginCommands: Array<{ key: string; count: number; registered: boolean | null; samples: string[] }>;
  scripts: { commands: number; conditions: number; operands: number; routeSteps: number; distinct: number };
  overrides: Array<{ code: number; plugins: string[] }>;
}

export class Coverage {
  private lists = 0;
  private commands = 0;
  private consumed = 0;
  private byKind = new Map<string, number>();
  private gaps = new Map<string, Tally>();
  private anomalies = new Map<string, Tally>();
  private plugins = new Map<string, Tally>();
  private scripts = { commands: 0, conditions: 0, operands: 0, routeSteps: 0 };
  private distinctScripts = new Set<string>();

  add(list: CommandList, decoded: Decoded) {
    this.lists++;
    this.commands += list.list.length;
    this.consumed += decoded.consumed;
    const where = (index: number) => `${sourceLabel(list.source)}#${index}`;
    for (const issue of decoded.issues) bump(issue.severity === "gap" ? this.gaps : this.anomalies, issue.key, where(issue.index));
    walkOps(decoded.ops, (op) => {
      this.byKind.set(op.kind, (this.byKind.get(op.kind) ?? 0) + 1);
      const script = (code: string, kind: keyof typeof this.scripts) => {
        this.scripts[kind]++;
        this.distinctScripts.add(code);
      };
      if (op.kind === "plugin") bump(this.plugins, `${op.plugin}::${op.command}`, where(op.index));
      if (op.kind === "script") script(op.js, "commands");
      if (op.kind === "if" && op.condition.kind === "script") script(op.condition.code, "conditions");
      if (op.kind === "setVariables" && op.operand.kind === "script") script(op.operand.code, "operands");
      if (op.kind === "moveRoute") for (const s of op.steps) if (s.name === "script") script(String(s.params[0]), "routeSteps");
    });
  }

  /**
   * `registered`: plugin command keys as the engine registers them (`plugin:command`, from the
   * harness), or undefined if unknown. `gameDir`: used to find plugin overrides of engine commands.
   */
  report(options: { registered?: Set<string>; gameDir: string }): CoverageReport {
    const ranked = (m: Map<string, Tally>) => [...m].sort((a, b) => b[1].count - a[1].count || a[0].localeCompare(b[0]));
    return {
      lists: this.lists,
      commands: this.commands,
      consumed: this.consumed,
      byKind: Object.fromEntries([...this.byKind].sort((a, b) => b[1] - a[1])),
      gaps: ranked(this.gaps).map(([key, t]) => ({ key, ...t })),
      anomalies: ranked(this.anomalies).map(([key, t]) => ({ key, ...t })),
      pluginCommands: ranked(this.plugins).map(([key, t]) => {
        const [plugin, command] = key.split("::");
        // The engine dispatches on the plugin's file name (Utils.extractFileName).
        const registered = options.registered ? options.registered.has(`${plugin.split("/").pop()}:${command}`) : null;
        return { key, count: t.count, registered, samples: t.samples };
      }),
      scripts: { ...this.scripts, distinct: this.distinctScripts.size },
      overrides: commandOverrides(options.gameDir),
    };
  }
}

/** Engine interpreter commands that enabled plugins replace (static scan of plugin sources). */
export function commandOverrides(gameDir: string): Array<{ code: number; plugins: string[] }> {
  const pluginsJs = fs.readFileSync(path.join(gameDir, "js/plugins.js"), "utf8");
  const list = JSON.parse(pluginsJs.slice(pluginsJs.indexOf("["), pluginsJs.lastIndexOf("]") + 1)) as Array<{ name: string; status: boolean }>;
  const byCode = new Map<number, Set<string>>();
  for (const p of list) {
    if (!p.status) continue;
    const file = path.join(gameDir, "js/plugins", `${p.name}.js`);
    if (!fs.existsSync(file)) continue;
    for (const m of fs.readFileSync(file, "utf8").matchAll(/Game_Interpreter\.prototype\.command(\d+)\s*=/g)) {
      const code = Number(m[1]);
      if (!byCode.has(code)) byCode.set(code, new Set());
      byCode.get(code)!.add(p.name);
    }
  }
  return [...byCode].sort((a, b) => a[0] - b[0]).map(([code, plugins]) => ({ code, plugins: [...plugins].sort() }));
}

export function formatCoverage(r: CoverageReport, header: string): string {
  const pct = (a: number, b: number) => `${((100 * a) / Math.max(b, 1)).toFixed(2)}%`;
  const out = [header, ""];
  out.push(`lists: ${r.lists}   commands: ${r.commands}   consumed by the decoder: ${r.consumed} (${pct(r.consumed, r.commands)})`);
  const gapTotal = r.gaps.reduce((s, g) => s + g.count, 0);
  out.push(`gaps: ${gapTotal} in ${r.gaps.length} categories`, "");

  out.push("## Gaps (ranked)");
  if (!r.gaps.length) out.push("  none");
  for (const g of r.gaps) out.push(`  ${String(g.count).padStart(7)}  ${g.key}    e.g. ${g.samples.join(", ")}`);

  out.push("", "## Data anomalies (decoded as the engine runs them; not gaps)");
  if (!r.anomalies.length) out.push("  none");
  for (const g of r.anomalies) out.push(`  ${String(g.count).padStart(7)}  ${g.key}    e.g. ${g.samples.join(", ")}`);

  const unregistered = r.pluginCommands.filter((p) => p.registered === false);
  out.push("", `## Plugin commands: ${r.pluginCommands.length} distinct, ${r.pluginCommands.reduce((s, p) => s + p.count, 0)} uses`);
  if (unregistered.length) {
    out.push("  Not registered in the harness's fresh profile (no-ops there; e.g. analytics registers only with telemetry on):");
    for (const p of unregistered) out.push(`  ${String(p.count).padStart(7)}  ${p.key}    e.g. ${p.samples.join(", ")}`);
    out.push("  Registered:");
  }
  for (const p of r.pluginCommands) if (p.registered !== false) out.push(`  ${String(p.count).padStart(7)}  ${p.key}`);

  const s = r.scripts;
  out.push(
    "",
    "## Scripts (shown verbatim; not gaps)",
    `  script commands ${s.commands}, script conditions ${s.conditions}, script operands ${s.operands}, route scripts ${s.routeSteps}; ${s.distinct} distinct`,
  );

  out.push("", "## Engine commands overridden by plugins (rendered with engine semantics)");
  for (const o of r.overrides) out.push(`  ${o.code}: ${o.plugins.join(", ")}`);

  out.push("", "## Decoded ops by kind");
  for (const [kind, count] of Object.entries(r.byKind)) out.push(`  ${String(count).padStart(7)}  ${kind}`);
  return out.join("\n") + "\n";
}
