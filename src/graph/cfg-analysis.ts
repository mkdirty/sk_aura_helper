// Structural analyses over a Cfg: basic blocks, loops (cyclic strongly connected components),
// dominators and post-dominators. Later layers use them: path conditions fall back to the
// conditions on dominating edges, and "unavoidable" means post-dominating the entry.

import { ENTRY, EXIT, GAMEOVER, TITLE, type Cfg, type CfgEdge } from "./cfg.ts";

/** Virtual sink joining every way a list can end, for post-dominators. */
export const SINK = -10;

const TERMINALS = new Set([EXIT, GAMEOVER, TITLE]);

/** Basic blocks: maximal runs of nodes joined by single unconditional edges. */
export function basicBlocks(cfg: Cfg): number[][] {
  const single = (es: CfgEdge[] | undefined) => (es?.length === 1 ? es[0] : undefined);
  const continues = (i: number) => {
    const e = single(cfg.succ.get(i));
    return e && e.kind === "seq" && e.to >= 0 && single(cfg.pred.get(e.to)) ? e.to : undefined;
  };
  const inner = new Set<number>();
  for (const i of cfg.nodes) {
    const next = continues(i);
    if (next !== undefined) inner.add(next);
  }
  const blocks: number[][] = [];
  for (const i of cfg.nodes) {
    if (inner.has(i)) continue;
    const block = [i];
    for (let next = continues(i); next !== undefined && next !== i; next = continues(next)) block.push(next);
    blocks.push(block);
  }
  return blocks;
}

/** Strongly connected components with a cycle (loops, backward jumps), as sorted node lists. */
export function cycles(cfg: Cfg): number[][] {
  const index = new Map<number, number>();
  const low = new Map<number, number>();
  const onStack = new Set<number>();
  const stack: number[] = [];
  const out: number[][] = [];
  let counter = 0;
  const succs = (v: number) => (cfg.succ.get(v) ?? []).map((e) => e.to).filter((t) => t >= 0);
  // Iterative Tarjan (lists are long enough to overflow recursion).
  for (const root of cfg.nodes) {
    if (index.has(root)) continue;
    const frames: Array<{ v: number; next: number[]; i: number }> = [];
    const enter = (v: number) => {
      index.set(v, counter);
      low.set(v, counter++);
      stack.push(v);
      onStack.add(v);
      frames.push({ v, next: succs(v), i: 0 });
    };
    enter(root);
    while (frames.length) {
      const f = frames[frames.length - 1];
      if (f.i < f.next.length) {
        const w = f.next[f.i++];
        if (!index.has(w)) enter(w);
        else if (onStack.has(w)) low.set(f.v, Math.min(low.get(f.v)!, index.get(w)!));
        continue;
      }
      frames.pop();
      if (frames.length) {
        const parent = frames[frames.length - 1].v;
        low.set(parent, Math.min(low.get(parent)!, low.get(f.v)!));
      }
      if (low.get(f.v) === index.get(f.v)) {
        const comp: number[] = [];
        let w: number;
        do {
          w = stack.pop()!;
          onStack.delete(w);
          comp.push(w);
        } while (w !== f.v);
        if (comp.length > 1 || succs(f.v).includes(f.v)) out.push(comp.sort((a, b) => a - b));
      }
    }
  }
  return out.sort((a, b) => a[0] - b[0]);
}

/**
 * Immediate dominators (Cooper, Harvey & Kennedy, "A Simple, Fast Dominance Algorithm") of the
 * graph given by `succs`/`preds` from `root`. Nodes not reachable from the root are absent.
 */
export function immediateDominators(root: number, succs: (v: number) => number[], preds: (v: number) => number[]): Map<number, number> {
  // Reverse postorder by iterative DFS.
  const order: number[] = [];
  const seen = new Set<number>([root]);
  const frames: Array<{ v: number; next: number[]; i: number }> = [{ v: root, next: succs(root), i: 0 }];
  while (frames.length) {
    const f = frames[frames.length - 1];
    if (f.i < f.next.length) {
      const w = f.next[f.i++];
      if (!seen.has(w)) {
        seen.add(w);
        frames.push({ v: w, next: succs(w), i: 0 });
      }
      continue;
    }
    frames.pop();
    order.push(f.v);
  }
  order.reverse();
  const rpo = new Map(order.map((v, i) => [v, i]));
  const idom = new Map<number, number>([[root, root]]);
  const intersect = (a: number, b: number) => {
    while (a !== b) {
      while (rpo.get(a)! > rpo.get(b)!) a = idom.get(a)!;
      while (rpo.get(b)! > rpo.get(a)!) b = idom.get(b)!;
    }
    return a;
  };
  for (let changed = true; changed; ) {
    changed = false;
    for (const v of order) {
      if (v === root) continue;
      let next: number | undefined;
      for (const p of preds(v)) {
        if (!idom.has(p)) continue;
        next = next === undefined ? p : intersect(p, next);
      }
      if (next !== undefined && idom.get(v) !== next) {
        idom.set(v, next);
        changed = true;
      }
    }
  }
  idom.delete(root);
  return idom;
}

/** Immediate dominators from ENTRY. */
export function dominators(cfg: Cfg): Map<number, number> {
  return immediateDominators(
    ENTRY,
    (v) => (cfg.succ.get(v) ?? []).map((e) => e.to).filter((t) => t >= 0),
    (v) => (cfg.pred.get(v) ?? []).map((e) => e.from),
  );
}

/**
 * Immediate post-dominators towards SINK (every way the list ends). Nodes that can't reach an
 * end (endless loops) are absent; a node whose ipdom is SINK has none inside the list.
 */
export function postDominators(cfg: Cfg): Map<number, number> {
  // Dominators of the reversed graph, where every terminal leads to SINK.
  const forwardSuccs = (v: number) => (TERMINALS.has(v) ? [SINK] : (cfg.succ.get(v) ?? []).map((e) => e.to));
  const forwardPreds = (v: number) => (v === SINK ? [...TERMINALS] : (cfg.pred.get(v) ?? []).map((e) => e.from));
  const idom = immediateDominators(SINK, forwardPreds, forwardSuccs);
  for (const t of TERMINALS) idom.delete(t);
  return idom;
}

/** Whether `a` dominates `b` given immediate dominators (every node dominates itself). */
export function dominates(idom: Map<number, number>, a: number, b: number): boolean {
  for (let v: number | undefined = b; v !== undefined; v = idom.get(v)) if (v === a) return true;
  return false;
}
