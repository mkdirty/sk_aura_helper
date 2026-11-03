// Text, DOT and JSON renderings of a Cfg, plus the whole-project coverage report.

import type { RawCommand } from "../data/game-data.ts";
import { decodeList, type DecodeOptions } from "../events/decode.ts";
import { sourceLabel } from "../events/lists.ts";
import type { Names } from "../events/names.ts";
import type { Op } from "../events/ops.ts";
import { renderOps } from "../events/render.ts";
import { basicBlocks, cycles } from "./cfg-analysis.ts";
import { ENTRY, EXIT, GAMEOVER, TITLE, type Cfg, type CfgEdge } from "./cfg.ts";

/** Every decoded op by raw index, nested bodies included. */
export function opsByIndex(ops: Op[], out = new Map<number, Op>()): Map<number, Op> {
  for (const op of ops) {
    out.set(op.index, op);
    switch (op.kind) {
      case "if":
        opsByIndex(op.then, out);
        if (op.else) opsByIndex(op.else, out);
        break;
      case "choice":
        for (const b of op.branches) opsByIndex(b.body, out);
        break;
      case "loop":
      case "skip":
        opsByIndex(op.body, out);
        break;
      case "battle":
        for (const body of [op.win, op.escape, op.lose]) if (body) opsByIndex(body, out);
        break;
    }
  }
  return out;
}

/** One line for an op, without the bodies of block ops. */
export function opHeader(op: Op | undefined, names: Names): string {
  if (!op) return "?";
  let shallow: Op = op;
  switch (op.kind) {
    case "if":
      shallow = { ...op, then: [], else: undefined };
      break;
    case "choice":
      shallow = { ...op, branches: [] };
      break;
    case "loop":
    case "skip":
      shallow = { ...op, body: [] };
      break;
    case "battle":
      shallow = { ...op, win: undefined, escape: undefined, lose: undefined };
      break;
  }
  return (renderOps([shallow], { names, text: "first" })[0] ?? "").trim().replace(/:$/, "");
}

const terminalName = (t: number) => (t === EXIT ? "END" : t === GAMEOVER ? "GAME OVER" : t === TITLE ? "TITLE" : t === ENTRY ? "ENTRY" : `#${t}`);

/** Short edge label, e.g. `then`, `choice 1 "Leave."`, `jump EndLewdScene`. */
export function edgeLabel(e: CfgEdge, op?: Op): string {
  let s: string = e.kind;
  if (e.kind === "choice" && e.option !== undefined) {
    const label = op?.kind === "choice" ? op.choices[e.option] : undefined;
    s = `choice ${e.option}${label !== undefined ? ` ${JSON.stringify(label)}` : ""}`;
  }
  if (e.kind === "jump") s = `jump ${e.label}`;
  if (e.dynamic) s += " (dynamic)";
  if (e.stale) s += " (stale branch state)";
  return s;
}

export function renderCfgText(cfg: Cfg, list: RawCommand[], decode: DecodeOptions, names: Names): string {
  const ops = opsByIndex(decodeList(list, decode).ops);
  const out: string[] = [];
  const edgesOut = cfg.succ.get(ENTRY) ?? [];
  out.push(`=== ${sourceLabel(cfg.source)}: ${cfg.nodes.length} commands run, ${[...cfg.succ.values()].reduce((s, e) => s + e.length, 0)} edges, ${cfg.states} states`);
  for (const i of cfg.issues) out.push(`  issue: ${i.key} at #${i.index}${i.detail ? ` (${i.detail})` : ""}`);
  const loops = cycles(cfg);
  if (loops.length) out.push(`  loops: ${loops.map((l) => `{#${l[0]}…#${l[l.length - 1]}, ${l.length} commands}`).join(", ")}`);
  out.push(`  ENTRY → ${edgesOut.map((e) => terminalName(e.to)).join(", ")}`);
  for (const block of basicBlocks(cfg)) {
    out.push("");
    for (const i of block) out.push(`  #${String(i).padEnd(5)} ${opHeader(ops.get(i), names)}`);
    const last = block[block.length - 1];
    for (const e of cfg.succ.get(last) ?? []) out.push(`         → ${terminalName(e.to).padEnd(10)} ${edgeLabel(e, ops.get(last))}`);
  }
  if (cfg.unreachable.length) {
    out.push("", `  unreachable: ${cfg.unreachable.map((i) => `#${i}`).join(" ")}`);
  }
  return out.join("\n") + "\n";
}

export function renderCfgDot(cfg: Cfg, list: RawCommand[], decode: DecodeOptions, names: Names): string {
  const ops = opsByIndex(decodeList(list, decode).ops);
  const id = (n: number) => (n < 0 ? `T${-n}` : `n${n}`);
  const esc = (s: string) => s.replace(/\\/g, "\\\\").replace(/"/g, '\\"');
  const out = [`digraph "${esc(sourceLabel(cfg.source))}" {`, "  node [shape=box, fontname=monospace, fontsize=10];"];
  const blocks = basicBlocks(cfg);
  const blockOf = new Map<number, number>();
  for (const b of blocks) for (const i of b) blockOf.set(i, b[0]);
  for (const t of [ENTRY, EXIT, GAMEOVER, TITLE]) out.push(`  ${id(t)} [label="${terminalName(t)}", shape=oval];`);
  for (const b of blocks) {
    const text = b.map((i) => `#${i} ${opHeader(ops.get(i), names)}`.slice(0, 80)).join("\\l");
    out.push(`  ${id(b[0])} [label="${esc(text).replace(/\\\\l/g, "\\l")}\\l"];`);
  }
  for (const [from, edges] of [[ENTRY, cfg.succ.get(ENTRY) ?? []] as const, ...blocks.map((b) => [b[b.length - 1], cfg.succ.get(b[b.length - 1]) ?? []] as const)]) {
    const src = from < 0 ? id(from) : id(blockOf.get(from)!);
    for (const e of edges) {
      const dst = e.to < 0 ? id(e.to) : id(blockOf.get(e.to)!);
      const label = e.kind === "seq" ? "" : edgeLabel(e, ops.get(from));
      out.push(`  ${src} -> ${dst}${label ? ` [label="${esc(label)}"${e.stale ? ", style=dashed" : ""}]` : ""};`);
    }
  }
  out.push("}");
  return out.join("\n") + "\n";
}

export function cfgJson(cfg: Cfg) {
  return {
    source: sourceLabel(cfg.source),
    length: cfg.length,
    nodes: cfg.nodes,
    edges: [...cfg.succ.values()].flat(),
    unreachable: cfg.unreachable,
    issues: cfg.issues,
    states: cfg.states,
  };
}

/** Whole-project tally, ranked like the decoder's coverage report. */
export class CfgCoverage {
  lists = 0;
  commands = 0;
  nodes = 0;
  edges = 0;
  states = 0;
  staleEdges = 0;
  unreachable = 0;
  private issues = new Map<string, { count: number; samples: string[] }>();

  add(cfg: Cfg) {
    this.lists++;
    this.commands += cfg.length;
    this.nodes += cfg.nodes.length;
    this.states += cfg.states;
    this.unreachable += cfg.unreachable.length;
    for (const es of cfg.succ.values()) {
      this.edges += es.length;
      this.staleEdges += es.filter((e) => e.stale).length;
    }
    for (const i of cfg.issues) {
      const t = this.issues.get(i.key) ?? this.issues.set(i.key, { count: 0, samples: [] }).get(i.key)!;
      t.count++;
      if (t.samples.length < 5) t.samples.push(`${sourceLabel(cfg.source)}#${i.index}`);
    }
  }

  report() {
    return {
      lists: this.lists,
      commands: this.commands,
      nodes: this.nodes,
      edges: this.edges,
      states: this.states,
      staleEdges: this.staleEdges,
      unreachable: this.unreachable,
      issues: [...this.issues].map(([key, t]) => ({ key, ...t })).sort((a, b) => b.count - a.count || a.key.localeCompare(b.key)),
    };
  }
}

export function formatCfgCoverage(r: ReturnType<CfgCoverage["report"]>, title: string): string {
  const out = [
    title,
    "",
    `${r.lists} lists, ${r.commands} raw commands; ${r.nodes} commands run on some path, ${r.edges} edges, ${r.states} (index, branch state) pairs.`,
    `${r.unreachable} commands never run (Skip bodies and code after unconditional jumps).`,
    `${r.staleEdges} edges depend on branch state the list didn't set (stale).`,
    "",
    "Issues (per list and command), most frequent first:",
  ];
  for (const i of r.issues) out.push(`${String(i.count).padStart(7)}  ${i.key}    e.g. ${i.samples.join(", ")}`);
  return out.join("\n") + "\n";
}
