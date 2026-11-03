// Control-flow graph of one event command list, built by abstractly running the engine's own
// interpreter control logic (Game_Interpreter in js/rmmz_objects.js) over the raw list.
//
// Why not the decoded tree: the engine has no block structure, only indentation and a per-indent
// "branch state" (`_branch[indent]`). Openers (111 if, 102 choice, 301 battle) record a value
// there, and the branch markers that follow (411 else, 402/403 choice branches, 601-603 battle
// results) compare against it to decide whether to enter their body or skip it. `jumpTo` resets
// the state of the indents it crosses, and the state is never cleared between runs of a reused
// interpreter (`clear()` doesn't touch `_branch`). A jump into a block, a choice that never
// opens (choices:setHideSingleOptionChoices) or a battle that never starts therefore makes
// markers read whatever value is there. Tracking that state is the only way to follow the
// engine exactly, so the builder explores (index, branch state) pairs and projects them onto
// command indices.
//
// Nodes are raw command indices of commands that do something. Markers and commands without an
// interpreter handler (code 0, closers, continuation lines) are resolved inside the edges that
// pass through them: an edge leads from one command that runs to the next one that runs.
//
// The graph over-approximates: an edge exists if some (index, state) pair takes it. The entry
// branch state is unknown (a map or troop interpreter is reused with stale state, and a common
// event can be run either way), so markers reached before their opener can go both ways; such
// edges are marked `stale`.

import * as acorn from "acorn";
import fs from "node:fs";
import path from "node:path";
import type { GameData, RawCommand } from "../data/game-data.ts";
import type { ListSource } from "../events/lists.ts";

export const ENTRY = -1;
/** The interpreter finishes (end of list, Exit Event Processing). */
export const EXIT = -2;
/** The game goes to the game-over scene (353, or losing a battle that can't be lost). */
export const GAMEOVER = -3;
/** The game returns to the title screen (354). */
export const TITLE = -4;

export type EdgeKind =
  | "seq"
  | "then"
  | "else"
  | "choice"
  | "cancel"
  /** A choice with "hide single-option choices" whose window never opens: no branch is chosen. */
  | "noChoice"
  | "win"
  | "escape"
  | "lose"
  /** Battle Processing that starts no battle (troop from a variable or random, or already in battle). */
  | "noBattle"
  | "skip"
  | "jump"
  | "break"
  | "repeat"
  | "exit";

export interface CfgEdge {
  from: number;
  to: number;
  kind: EdgeKind;
  /** Choice index (`choice`). */
  option?: number;
  /** Label name (`jump`). */
  label?: string;
  /** A jump whose label is computed by a script; or the fallthrough when no label matches. */
  dynamic?: true;
  /**
   * Only taken when a branch marker reads a branch state this list didn't set (unknown at
   * entry). Normally a sign of a jump into a block.
   */
  stale?: true;
}

export interface CfgIssue {
  key: string;
  index: number;
  detail: string;
}

export interface Cfg {
  source: ListSource;
  /** Length of the raw list. */
  length: number;
  /** Indices of commands that run on some path, ascending. */
  nodes: number[];
  /** Commands with an interpreter handler that never run (dead code; Skip bodies included). */
  unreachable: number[];
  succ: Map<number, CfgEdge[]>;
  pred: Map<number, CfgEdge[]>;
  issues: CfgIssue[];
  /** Number of (index, branch state) pairs explored. */
  states: number;
}

/** What the builder needs to know beyond the list itself. */
export interface CfgContext {
  /** Command codes with a Game_Interpreter handler (engine and enabled plugins). */
  handlers: Set<number>;
  /** Whether troop N exists. */
  troopExists(id: number): boolean;
  /** Whether a battle with troop N can end in "escape" without the escape command (Abort Battle). */
  troopCanAbort(id: number): boolean;
}

/**
 * A branch-state value, tagged with the command that set it:
 * - `t@17`, `f@17` (111 at index 17), `2@40` (choice or battle result set at 40);
 * - `2@?`: a value only known from a marker test on an unknown state;
 * - "n": null, set by jumpTo for the indents a jump crosses;
 * - "*": unknown (the entry state, including the `undefined` of a fresh interpreter);
 * - "-": dead (never read before being overwritten; see liveness).
 * A marker reading "*", or a value its own opener didn't set, makes the edge `stale`.
 */
type BV = string;
const tok = (v: "t" | "f" | number, origin: number | "?"): BV => `${v}@${origin}`;
function untok(t: BV): { v: "t" | "f" | number; origin: number | undefined } {
  const at = t.indexOf("@");
  const v = t.slice(0, at);
  const o = t.slice(at + 1);
  return { v: v === "t" || v === "f" ? v : Number(v), origin: o === "?" ? undefined : Number(o) };
}

const MARKERS = new Set([402, 403, 411, 601, 602, 603]);
const MAX_INDENT_TRACKED = 64;

/** Interpreter command codes with a handler, read from the engine and the enabled plugins. */
export function interpreterHandlers(data: GameData): Set<number> {
  const codes = new Set<number>();
  const scan = (file: string) => {
    const src = fs.readFileSync(file, "utf8");
    for (const m of src.matchAll(/Game_Interpreter\.prototype\.command(\d+)\s*=/g)) codes.add(Number(m[1]));
  };
  scan(path.join(data.dir, "js/rmmz_objects.js"));
  for (const p of data.plugins()) if (p.status) scan(path.join(data.dir, "js/plugins", `${p.name}.js`));
  return codes;
}

/** The context for a game: handlers, and which troops can be aborted (340 in their pages or common events they call). */
export function cfgContext(data: GameData): CfgContext {
  const ceAborts = new Map<number, boolean>();
  const ceCanAbort = (id: number, seen = new Set<number>()): boolean => {
    if (ceAborts.has(id)) return ceAborts.get(id)!;
    if (seen.has(id)) return false;
    seen.add(id);
    const list = data.commonEvents[id]?.list ?? [];
    const result = list.some((c) => c.code === 340 || (c.code === 117 && ceCanAbort(c.parameters[0], seen)));
    ceAborts.set(id, result);
    return result;
  };
  return {
    handlers: interpreterHandlers(data),
    troopExists: (id) => !!data.troops[id],
    troopCanAbort: (id) =>
      !!data.troops[id]?.pages.some((p) => p.list.some((c) => c.code === 340 || (c.code === 117 && ceCanAbort(c.parameters[0])))),
  };
}

/** Indices the engine's skipBranch would end on: the last command indented deeper than `i`. */
function skipEnd(list: RawCommand[], i: number): number {
  const indent = list[i].indent;
  let j = i;
  while (j + 1 < list.length && list[j + 1].indent > indent) j++;
  return j;
}

/** What a script does to the interpreter's control flow. */
interface ScriptControl {
  /** Label candidates of `this.command119(...)` / `jumpTo` calls; `all` if unresolved. */
  jumps: Array<{ labels: string[] | "all"; exact: boolean }>;
  /** Sets an interpreter's `_index` to its list length: this interpreter (and its parents) end. */
  exitsAll: boolean;
  /** Touches interpreter control state in a way not modelled. */
  unknown: string[];
}

const nodeAt = (n: any) => n as acorn.Node & Record<string, any>;

function scriptControl(code: string, labels: string[]): ScriptControl | undefined {
  if (!/command119|jumpTo|_index|_branch|skipBranch/.test(code)) return undefined;
  const out: ScriptControl = { jumps: [], exitsAll: false, unknown: [] };
  let ast: acorn.Node;
  try {
    ast = acorn.parse(code, { ecmaVersion: "latest", allowReturnOutsideFunction: true });
  } catch {
    out.unknown.push("unparsable script");
    return out;
  }
  const decls = new Map<string, any>();
  const visit = (n: any, fn: (n: any) => void) => {
    if (!n || typeof n.type !== "string") return;
    fn(n);
    for (const k of Object.keys(n)) {
      const v = n[k];
      if (Array.isArray(v)) v.forEach((c) => visit(c, fn));
      else if (v && typeof v === "object" && typeof v.type === "string") visit(v, fn);
    }
  };
  visit(ast, (n) => {
    if (n.type === "VariableDeclarator" && n.id.type === "Identifier" && n.init) decls.set(n.id.name, n.init);
  });
  const candidates = (e: any, depth = 0): { labels: string[] | "all"; exact: boolean } => {
    if (!e || depth > 5) return { labels: "all", exact: false };
    if (e.type === "Literal") return typeof e.value === "string" ? { labels: labels.filter((l) => l === e.value), exact: true } : { labels: [], exact: true };
    if (e.type === "TemplateLiteral") {
      const prefix = e.quasis[0].value.cooked ?? "";
      const suffix = e.quasis.length > 1 ? (e.quasis[e.quasis.length - 1].value.cooked ?? "") : "";
      if (e.expressions.length === 0) return { labels: labels.filter((l) => l === prefix), exact: true };
      return { labels: labels.filter((l) => l.length >= prefix.length + suffix.length && l.startsWith(prefix) && l.endsWith(suffix)), exact: false };
    }
    if (e.type === "BinaryExpression" && e.operator === "+" && e.left.type === "Literal" && typeof e.left.value === "string") {
      return { labels: labels.filter((l) => l.startsWith(e.left.value)), exact: false };
    }
    if (e.type === "Identifier" && decls.has(e.name)) return candidates(decls.get(e.name), depth + 1);
    return { labels: "all", exact: false };
  };
  visit(ast, (n) => {
    if (n.type === "CallExpression" && n.callee.type === "MemberExpression") {
      const name = n.callee.property?.name;
      if (name === "command119") {
        const arg = n.arguments[0];
        out.jumps.push(arg?.type === "ArrayExpression" ? candidates(arg.elements[0]) : { labels: "all", exact: false });
      } else if (name === "jumpTo" || name === "skipBranch") out.unknown.push(`calls ${name}`);
    }
    if (n.type === "AssignmentExpression" && n.left.type === "MemberExpression") {
      const prop = n.left.property?.name;
      if (prop === "_index") {
        const r = nodeAt(n.right);
        if (r.type === "MemberExpression" && r.property?.name === "length" && r.object?.property?.name === "_list") out.exitsAll = true;
        else out.unknown.push("assigns _index");
      } else if (prop === "_branch" || (n.left.object?.type === "MemberExpression" && n.left.object.property?.name === "_branch")) {
        out.unknown.push("assigns _branch");
      }
    }
  });
  return out.jumps.length || out.exitsAll || out.unknown.length ? out : undefined;
}

/**
 * Indents whose branch state may be read before being overwritten, per index (a backward
 * liveness analysis over every successor the engine could take, regardless of state). States
 * keep only live values, which keeps the exploration to about one state per command.
 */
function liveness(list: RawCommand[], succs: number[][], defines: (i: number) => number | undefined): Array<Set<number>> {
  const n = list.length;
  const use: Array<number | undefined> = list.map((c) => (MARKERS.has(c.code) ? c.indent : undefined));
  const live: Array<Set<number>> = Array.from({ length: n }, () => new Set());
  const preds: number[][] = Array.from({ length: n }, () => []);
  succs.forEach((ss, i) => ss.forEach((s) => s < n && preds[s].push(i)));
  const work = Array.from({ length: n }, (_, i) => n - 1 - i);
  const queued = new Uint8Array(n).fill(1);
  while (work.length) {
    const i = work.pop()!;
    queued[i] = 0;
    const out = new Set<number>();
    for (const s of succs[i]) if (s < n) for (const j of live[s]) out.add(j);
    const def = defines(i);
    if (def !== undefined) out.delete(def);
    if (use[i] !== undefined) out.add(use[i]!);
    if (out.size !== live[i].size) {
      live[i] = out;
      for (const p of preds[i]) if (!queued[p]) {
        queued[p] = 1;
        work.push(p);
      }
    }
  }
  return live;
}

/** Whether a choice at `i` has "hide single-option choices" set in the plugin commands just before its message. */
function hidesSingleOption(list: RawCommand[], i: number): boolean {
  for (let k = i - 1; k >= 0; k--) {
    const c = list[k];
    if (c.code === 357 && c.parameters[0]?.endsWith?.("choices") && c.parameters[1] === "setHideSingleOptionChoices") return true;
    if (![357, 657, 101, 401, 108, 408].includes(c.code)) return false;
  }
  return false;
}

/** The index after the 413 that Break Loop (113) at `i` lands on, as command113 scans. */
function breakTarget(list: RawCommand[], i: number): number {
  let depth = 0;
  let j = i;
  while (j < list.length - 1) {
    j++;
    if (list[j].code === 112) depth++;
    if (list[j].code === 413) {
      if (depth > 0) depth--;
      else break;
    }
  }
  return j + 1;
}

/** The index Repeat Above (413) at `i` continues at: after the previous command at its indent. */
function repeatTarget(list: RawCommand[], i: number): number | undefined {
  for (let j = i - 1; j >= 0; j--) if (list[j].indent === list[i].indent) return j + 1;
  return undefined;
}

/** Indents whose state jumpTo resets when jumping from `from` (at `indent`) to `to`. */
function jumpResets(list: RawCommand[], from: number, indent: number, to: number): number[] {
  const resets: number[] = [];
  let cur = indent;
  for (let i = Math.min(from, to); i <= Math.max(from, to); i++) {
    const ni = list[i].indent;
    if (ni !== cur) {
      resets.push(cur);
      cur = ni;
    }
  }
  return resets;
}

export function buildCfg(source: ListSource, rawList: RawCommand[], ctx: CfgContext): Cfg {
  // Generated lists (e.g. Map158/E1) can omit `indent`; treat it as 0 like the decoder does.
  const list = rawList.some((c) => c.indent === undefined) ? rawList.map((c) => ({ ...c, indent: c.indent ?? 0 })) : rawList;
  const n = list.length;
  const issues: CfgIssue[] = [];
  const issueKeys = new Set<string>();
  // Exploration visits a command once per branch state, so issues are deduplicated.
  const issue = (key: string, index: number, detail = "") => {
    const k = `${key}@${index}:${detail}`;
    if (issueKeys.has(k)) return;
    issueKeys.add(k);
    issues.push({ key, index, detail });
  };

  const labels: string[] = [];
  const labelIndex = new Map<string, number>();
  list.forEach((c, i) => {
    if (c.code !== 118) return;
    const name = c.parameters[0];
    labels.push(name);
    if (labelIndex.has(name)) issue("duplicate label (first wins)", i, String(name));
    else labelIndex.set(name, i);
  });

  const isNode = (i: number) => {
    const c = list[i];
    return !MARKERS.has(c.code) && ctx.handlers.has(c.code);
  };

  // Script control, the index command355 is at when the script runs (after its 655 lines),
  // and per-command static successors (for liveness).
  const scripts = new Map<number, { control: ScriptControl; lastLine: number }>();
  const succs: number[][] = list.map(() => []);
  for (let i = 0; i < n; i++) {
    const c = list[i];
    const s = succs[i];
    switch (c.code) {
      case 111:
      case 402:
      case 403:
      case 411:
      case 601:
      case 602:
      case 603:
        s.push(i + 1, skipEnd(list, i) + 1);
        break;
      case 109:
        s.push(skipEnd(list, i) + 1);
        break;
      case 113:
        s.push(breakTarget(list, i));
        break;
      case 413: {
        const t = repeatTarget(list, i);
        if (t !== undefined) s.push(t);
        break;
      }
      case 115:
      case 353:
      case 354:
        break;
      case 119: {
        const t = labelIndex.get(c.parameters[0]);
        s.push(t !== undefined ? t : i + 1);
        break;
      }
      case 355: {
        let last = i;
        let code = String(c.parameters[0] ?? "");
        while (list[last + 1]?.code === 655) code += "\n" + String(list[++last].parameters[0] ?? "");
        const control = scriptControl(code, labels);
        if (control) {
          scripts.set(i, { control, lastLine: last });
          for (const u of control.unknown) issue("script touches interpreter state (not modelled)", i, u);
          if (control.exitsAll) break;
          for (const j of control.jumps) for (const l of j.labels === "all" ? labels : j.labels) s.push(labelIndex.get(l)!);
        }
        s.push(i + 1);
        break;
      }
      default:
        s.push(i + 1);
    }
  }
  // The indent whose branch state a command always overwrites: 111 always; a choice unless its
  // window may not open; a battle when one always starts.
  const always301 = (i: number) => source.kind !== "troop" && list[i].parameters[0] === 0 && ctx.troopExists(list[i].parameters[1]);
  const defines = (i: number) => {
    const c = list[i];
    if (c.code === 111 || (c.code === 102 && !hidesSingleOption(list, i)) || (c.code === 301 && always301(i))) return c.indent;
    return undefined;
  };
  const live = liveness(list, succs, defines);

  // --- Exploration over (index, branch state). ---
  const succ = new Map<number, CfgEdge[]>();
  const pred = new Map<number, CfgEdge[]>();
  const edgeKeys = new Set<string>();
  /** Edges taken on some path without a stale marker read; the rest are stale. */
  const definite = new Set<string>();
  const addEdge = (e: CfgEdge, stale: boolean) => {
    const key = `${e.from}>${e.to}:${e.kind}:${e.option ?? ""}:${e.label ?? ""}`;
    if (!stale) definite.add(key);
    if (edgeKeys.has(key)) return;
    edgeKeys.add(key);
    (succ.get(e.from) ?? succ.set(e.from, []).get(e.from)!).push(e);
    (pred.get(e.to) ?? pred.set(e.to, []).get(e.to)!).push(e);
  };

  const seen = new Set<string>();
  const work: Array<[number, BV[]]> = [];
  const keyOf = (i: number, b: BV[]) => `${i}|${b.join(",")}`;

  /** Keeps only live entries (others become "-") and trims trailing ones. */
  const canonical = (i: number, b: BV[]): BV[] => {
    const l = i < n ? live[i] : undefined;
    const out: BV[] = [];
    for (let k = 0; k < b.length; k++) out.push(l?.has(k) ? b[k] : "-");
    while (out.length && out[out.length - 1] === "-") out.pop();
    return out;
  };
  const get = (b: BV[], k: number): BV => {
    const v = k < b.length ? b[k] : "-";
    if (v === "-") throw new Error(`cfg: read of a dead branch state at indent ${k} (liveness bug)`);
    return v;
  };
  const set = (b: BV[], k: number, v: BV): BV[] => {
    if (k >= MAX_INDENT_TRACKED) return b;
    const out = b.slice();
    while (out.length <= k) out.push("-");
    out[k] = v;
    return out;
  };

  /** The opener (111, 102, 301) a marker belongs to: the previous command at its indent that isn't a marker. */
  const owners = new Map<number, number | undefined>();
  const ownerOf = (p: number): number | undefined => {
    if (owners.has(p)) return owners.get(p);
    const k = list[p].indent;
    let j = p - 1;
    while (j >= 0 && (list[j].indent > k || (list[j].indent === k && MARKERS.has(list[j].code)))) j--;
    const owner = j >= 0 && list[j].indent === k && [111, 102, 301].includes(list[j].code) ? j : undefined;
    owners.set(p, owner);
    return owner;
  };

  /**
   * Follows the engine from position `pos` with state `b` through markers and handler-less
   * commands to the next command that runs. Returns each possible landing (several when a
   * marker reads an unknown state).
   */
  const resolve = (pos: number, b: BV[]): Array<{ to: number; b: BV[]; stale: boolean }> => {
    const out: Array<{ to: number; b: BV[]; stale: boolean }> = [];
    const go = (p: number, st: BV[], stale: boolean, guard: number) => {
      for (;;) {
        if (guard++ > n + 2) throw new Error("cfg: marker resolution does not terminate");
        if (p >= n) return out.push({ to: EXIT, b: st, stale });
        const c = list[p];
        if (!MARKERS.has(c.code)) {
          if (ctx.handlers.has(c.code)) return out.push({ to: p, b: st, stale });
          p++;
          continue;
        }
        const k = c.indent;
        if (k >= MAX_INDENT_TRACKED) {
          issue("indent too deep to track", p);
          return;
        }
        const v = get(st, k);
        const enter = p + 1;
        const skip = skipEnd(list, p) + 1;
        if (v === "*") {
          // Unknown: both ways, refining the state where the test pins it down.
          const refined = c.code === 402 ? tok(c.parameters[0], "?") : c.code === 411 ? tok("f", "?") : c.code >= 601 ? tok(c.code - 601, "?") : "*";
          go(enter, set(st, k, refined), true, guard);
          p = skip;
          stale = true;
          continue;
        }
        let value: "n" | "t" | "f" | number = "n";
        if (v !== "n") {
          const u = untok(v);
          value = u.v;
          if (u.origin === undefined || u.origin !== ownerOf(p)) stale = true;
        }
        let entered: boolean;
        switch (c.code) {
          case 402:
            entered = value === c.parameters[0];
            break;
          case 403:
            // `_branch >= 0` skips: null and false compare as 0, true as 1. (undefined >= 0 is
            // false, but undefined only occurs as part of "*".)
            entered = !((value === "n" || value === "f" ? 0 : value === "t" ? 1 : value) >= 0);
            break;
          case 411:
            entered = value === "f";
            break;
          default:
            entered = value === c.code - 601;
        }
        p = entered ? enter : skip;
      }
    };
    go(pos, b, false, 0);
    return out;
  };

  const visit = (from: number, kind: EdgeKind, pos: number, b: BV[], extra: Partial<CfgEdge> = {}, stale = false) => {
    for (const r of resolve(pos, b)) {
      addEdge({ from, to: r.to, kind, ...extra }, stale || r.stale);
      if (r.to < 0) continue;
      const st = canonical(r.to, r.b);
      const key = keyOf(r.to, st);
      if (!seen.has(key)) {
        seen.add(key);
        work.push([r.to, st]);
      }
    }
  };
  const toTerminal = (from: number, to: number, kind: EdgeKind, extra: Partial<CfgEdge> = {}) => addEdge({ from, to, kind, ...extra }, false);

  // Entry: the branch state is unknown at every indent.
  const entryState: BV[] = [];
  for (let k = 0; k <= Math.min(MAX_INDENT_TRACKED - 1, Math.max(0, ...list.map((c) => c.indent))); k++) entryState.push("*");
  visit(ENTRY, "seq", 0, canonical(0, entryState));

  while (work.length) {
    const [i, b] = work.pop()!;
    const c = list[i];
    const k = c.indent;
    const p = c.parameters ?? [];
    switch (c.code) {
      case 111:
        visit(i, "then", i + 1, set(b, k, tok("t", i)));
        visit(i, "else", skipEnd(list, i) + 1, set(b, k, tok("f", i)));
        break;
      case 102: {
        const choices: unknown[] = Array.isArray(p[0]) ? p[0] : [];
        const cancelType = p[1] < choices.length ? p[1] : -2;
        choices.forEach((_, opt) => visit(i, "choice", i + 1, set(b, k, tok(opt, i)), { option: opt }));
        if (cancelType === -2) visit(i, "cancel", i + 1, set(b, k, tok(-2, i)));
        if (hidesSingleOption(list, i)) visit(i, "noChoice", i + 1, b);
        break;
      }
      case 301: {
        const constant = p[0] === 0;
        const troop = constant ? p[1] : undefined;
        const inBattle = source.kind === "troop";
        const battles = !inBattle && (!constant || ctx.troopExists(troop));
        if (battles) {
          visit(i, "win", i + 1, set(b, k, tok(0, i)));
          if (p[2] || !constant || ctx.troopCanAbort(troop)) visit(i, "escape", i + 1, set(b, k, tok(1, i)));
          // Losing continues the event (with "can lose", or when ska_battle's defeat handling
          // revives the leader); without "can lose" it may also end in a game over.
          visit(i, "lose", i + 1, set(b, k, tok(2, i)));
          if (!p[3]) toTerminal(i, GAMEOVER, "lose");
        }
        if (inBattle || !constant || !ctx.troopExists(troop)) visit(i, "noBattle", i + 1, b);
        break;
      }
      case 109:
        visit(i, "skip", skipEnd(list, i) + 1, b);
        break;
      case 113: {
        const t = breakTarget(list, i);
        if (list[t - 1]?.code !== 413) issue("break outside a loop (ends the event)", i);
        visit(i, "break", t, b);
        break;
      }
      case 413: {
        const t = repeatTarget(list, i);
        if (t === undefined) {
          issue("repeat without a command at its indent (engine error)", i);
          break;
        }
        if (list[t - 1].code !== 112) issue("repeat target is not a loop", i, `continues after code ${list[t - 1].code} at ${t - 1}`);
        visit(i, "repeat", t, b);
        break;
      }
      case 115:
        toTerminal(i, EXIT, "exit");
        break;
      case 353:
        toTerminal(i, GAMEOVER, "seq");
        break;
      case 354:
        toTerminal(i, TITLE, "seq");
        break;
      case 119: {
        const name = p[0];
        const t = labelIndex.get(name);
        if (t === undefined) {
          issue("jump to a missing label (does nothing)", i, String(name));
          visit(i, "seq", i + 1, b);
          break;
        }
        visit(i, "jump", t, applyResets(b, jumpResets(list, i, k, t)), { label: String(name) });
        break;
      }
      case 355: {
        const s = scripts.get(i);
        if (!s) {
          visit(i, "seq", i + 1, b);
          break;
        }
        if (s.control.exitsAll) {
          toTerminal(i, EXIT, "exit");
          break;
        }
        let fallthrough = s.control.jumps.length === 0;
        for (const j of s.control.jumps) {
          const targets = j.labels === "all" ? [...labelIndex.keys()] : [...new Set(j.labels)];
          if (j.labels === "all") issue("dynamic jump (label not resolved)", i);
          else issue("dynamic jump", i, targets.join(", ") || "(no matching label)");
          for (const name of targets) {
            const t = labelIndex.get(name)!;
            // The script runs on after the jump, then the interpreter steps past the label (a
            // no-op, as for 119); jumpTo starts from the script's last line.
            visit(i, "jump", t, applyResets(b, jumpResets(list, s.lastLine, k, t)), { label: name, dynamic: true });
          }
          if (!j.exact || targets.length === 0) fallthrough = true;
        }
        if (fallthrough) visit(i, "seq", i + 1, b, s.control.jumps.length ? { dynamic: true } : {});
        break;
      }
      default:
        visit(i, "seq", i + 1, b);
    }
  }

  // Mark stale edges.
  for (const edges of succ.values())
    for (const e of edges) if (!definite.has(`${e.from}>${e.to}:${e.kind}:${e.option ?? ""}:${e.label ?? ""}`)) e.stale = true;

  const reached = new Set<number>();
  for (const key of seen) reached.add(Number(key.slice(0, key.indexOf("|"))));
  const nodes = [...reached].sort((a, b) => a - b);
  const unreachable: number[] = [];
  for (let i = 0; i < n; i++) if (isNode(i) && !reached.has(i)) unreachable.push(i);

  // Jumps that enter a block: some block body contains the label but not the jump.
  for (let i = 0; i < n; i++) {
    const c = list[i];
    const jumpTargets: number[] = [];
    if (c.code === 119 && labelIndex.has(c.parameters[0])) jumpTargets.push(labelIndex.get(c.parameters[0])!);
    for (const j of scripts.get(i)?.control.jumps ?? []) for (const l of j.labels === "all" ? [] : j.labels) jumpTargets.push(labelIndex.get(l)!);
    for (const t of jumpTargets) {
      if (enclosingBodies(list, t).some((body) => i < body[0] || i > body[1])) issue("jump enters a block", i, `to ${list[t].parameters[0]} at ${t}`);
    }
  }
  if (unreachable.length) issue("unreachable commands", unreachable[0], `${unreachable.length} commands`);

  return { source, length: n, nodes, unreachable, succ, pred, issues, states: seen.size };
}

function applyResets(b: BV[], resets: number[]): BV[] {
  if (!resets.length) return b;
  const out = b.slice();
  for (const k of resets) {
    while (out.length <= k) out.push("-");
    out[k] = "n";
  }
  return out;
}

/** Body ranges [start, end] (inclusive) of the blocks enclosing index t. */
function enclosingBodies(list: RawCommand[], t: number): Array<[number, number]> {
  const out: Array<[number, number]> = [];
  let indent = list[t].indent;
  for (let i = t - 1; i >= 0 && indent > 0; i--) {
    if (list[i].indent < indent) {
      out.push([i + 1, skipEnd(list, i)]);
      indent = list[i].indent;
    }
  }
  return out;
}
