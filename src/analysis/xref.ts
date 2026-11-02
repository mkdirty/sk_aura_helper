// Cross-reference index: every read, write and call in the game, with where it happens.
//
// Common events that take arguments in variables (Obtain_Item: V650 = item, V651 = amount)
// are handled generically: an effect whose id or amount is "the value of variable N" stays
// symbolic, each common event gets a summary of its symbolic effects (including callees'),
// and at each call site the summary is filled in from constants assigned to those variables
// just before, in the same straight-line block. "current map"/"this event" in common events
// are filled in from the calling map event the same way.

import type { GameData } from "../data/game-data.ts";
import { decodeList, type DecodeOptions } from "../events/decode.ts";
import { allLists, type ListSource } from "../events/lists.ts";
import type { Comparison, Op } from "../events/ops.ts";
import { databaseRefs } from "./database.ts";
import { opEffects, type Effect, type EffectContext, type Entity, type Id } from "./effects.ts";

export interface Site {
  source: ListSource;
  index: number;
  /** Inside a Skip block: never executes. */
  dead: boolean;
  /** Common events this effect came through, outermost first (e.g. [785] for Obtain_Item). */
  via: number[];
}

export interface Ref {
  effect: Effect;
  site: Site;
}

/** A condition on a variable along the path to an effect: `V[var] op value`. */
interface Guard {
  var: number;
  op: Comparison;
  value: number;
}

/** A common-event effect that depends on its caller, and the path conditions leading to it. */
interface Pending {
  effect: Effect;
  via: number[];
  guards: Guard[];
}

interface CallSite {
  source: ListSource;
  index: number;
  dead: boolean;
  callee: number;
  env: Env;
  /** Conditions on the path to the call (within its own list). */
  guards: Guard[];
}

const NEGATE: Record<Comparison, Comparison> = { "==": "!=", "!=": "==", ">=": "<", "<": ">=", "<=": ">", ">": "<=" };

function holds(g: Guard, x: number): boolean {
  switch (g.op) {
    case "==":
      return x === g.value;
    case "!=":
      return x !== g.value;
    case ">=":
      return x >= g.value;
    case "<=":
      return x <= g.value;
    case ">":
      return x > g.value;
    case "<":
      return x < g.value;
  }
}

/** Drops guards decided by `env`; returns undefined if one is false (the path can't happen). */
function checkGuards(guards: Guard[], env: Env): Guard[] | undefined {
  const open: Guard[] = [];
  for (const g of guards) {
    const x = env.get(g.var);
    if (typeof x === "number") {
      if (!holds(g, x)) return undefined;
    } else if (x && "var" in x) open.push({ ...g, var: x.var });
    else open.push(g);
  }
  return open;
}

/** Variable id → what it's known to hold here: a constant, or a copy of another variable. */
type Env = Map<number, Id>;

interface Context {
  mapId?: number;
  eventId?: number;
}

const isSymbolic = (x: unknown): boolean => typeof x === "object" && x !== null && "var" in x;

function hasSymbols(e: Effect): boolean {
  const ent = e.entity as Record<string, unknown>;
  return Object.values(ent).some((v) => isSymbolic(v) || v === "current" || v === "self") || isSymbolic(e.amount);
}

/** Substitutes known variable values and the calling event's map/id. */
function resolve(e: Effect, env: Env, ctx: Context): Effect {
  const sub = (v: unknown) => {
    if (isSymbolic(v)) {
      const known = env.get((v as { var: number }).var);
      return known === undefined ? v : known;
    }
    if (v === "current" && ctx.mapId !== undefined) return ctx.mapId;
    if (v === "self" && ctx.eventId !== undefined) {
      selfRelative = true;
      return ctx.eventId;
    }
    return v;
  };
  let selfRelative = false;
  const entity = Object.fromEntries(Object.entries(e.entity).map(([k, v]) => [k, k === "kind" ? v : sub(v)])) as Entity;
  return { ...e, entity, ...(e.amount !== undefined ? { amount: sub(e.amount) as Id } : {}), ...(selfRelative ? { selfRelative: true as const } : {}) };
}

export interface XrefOptions {
  data: GameData;
  decode: DecodeOptions;
  effects: EffectContext;
}

interface Tally {
  count: number;
  samples: Site[];
}

export class XrefIndex {
  readonly refs: Ref[] = [];
  /** Why some ops' effects are incomplete, with counts and sample sites. */
  readonly unanalyzed = new Map<string, Tally>();
  private readonly calls: CallSite[] = [];
  /** Per common event: effects that still depend on caller-provided values. */
  private readonly ceSymbolic = new Map<number, Pending[]>();

  static build(o: XrefOptions): XrefIndex {
    const x = new XrefIndex();
    for (const list of allLists(o.data)) {
      const { ops } = decodeList(list.list, o.decode);
      const ctx: Context = list.source.kind === "map" ? { mapId: list.source.mapId, eventId: list.source.eventId } : {};
      x.walk(ops, list.source, ctx, new Map(), [], false, o.effects);
    }
    x.autonomousRoutes(o);
    x.instantiateCalls();
    x.instantiateLocalCalls();
    x.refs.push(...databaseRefs(o.data));
    return x;
  }

  /**
   * Event pages with a custom autonomous move route run its steps while the page is active,
   * outside any command list. Recorded at the page with index -1.
   */
  private autonomousRoutes(o: XrefOptions) {
    for (const mapId of o.data.mapIds()) {
      if (mapId === o.data.templateMapId()) continue;
      for (const event of o.data.map(mapId).events) {
        if (!event) continue;
        o.data.effectivePages(event).forEach((page, p) => {
          if (page.moveType !== 3 || !page.moveRoute?.list?.length) return;
          const steps = page.moveRoute.list
            .filter((s: { code: number }) => s.code !== 0)
            .map((s: { code: number; parameters: unknown[] }) => ({ code: s.code, name: o.decode.routeNames.get(s.code) ?? `step${s.code}`, params: s.parameters ?? [] }));
          const op: Op = { code: 205, index: -1, kind: "moveRoute", character: { kind: "this" }, repeat: !!page.moveRoute.repeat, skippable: !!page.moveRoute.skippable, wait: false, steps };
          this.walk([op], { kind: "map", mapId, eventId: event.id, page: p }, { mapId, eventId: event.id }, new Map(), [], false, o.effects);
        });
      }
    }
  }

  private note(reason: string, site: Site) {
    const t = this.unanalyzed.get(reason) ?? { count: 0, samples: [] };
    t.count++;
    if (t.samples.length < 5) t.samples.push(site);
    this.unanalyzed.set(reason, t);
  }

  private walk(ops: Op[], source: ListSource, ctx: Context, env: Env, guards: Guard[], dead: boolean, effectCtx: EffectContext) {
    for (const op of ops) {
      const site: Site = { source, index: op.index, dead, via: [] };
      const { effects, unanalyzed } = opEffects(op, effectCtx);
      for (const reason of unanalyzed) this.note(reason, site);
      for (const raw of effects) {
        const effect = resolve(raw, env, ctx);
        this.refs.push({ effect, site });
        if (source.kind === "common" && !dead && hasSymbols(effect)) this.symbolic(source.id).push({ effect, via: [], guards });
      }

      // Calls: remember the variables known at the call for instantiating the callee.
      for (const e of effects) {
        if (e.access === "call" && e.entity.kind === "commonEvent" && typeof e.entity.id === "number") {
          // Reserved common events run later, when these values may be gone.
          this.calls.push({ source, index: op.index, dead, callee: e.entity.id, env: e.how === "call" ? new Map(env) : new Map(), guards });
        }
      }

      // Update what's known about variables. Writing V invalidates V and any copies of V.
      const forget = (v: number) => {
        env.delete(v);
        for (const [k, x] of env) if (typeof x === "object" && "var" in x && x.var === v) env.delete(k);
      };
      for (const e of effects) {
        if (e.access === "write" && e.entity.kind === "variable") {
          if (typeof e.entity.id === "number") forget(e.entity.id);
          else env.clear();
        }
      }
      if (op.kind === "setVariables" && op.op === "=" && op.from === op.to && op.from !== (op.operand as { id?: number }).id) {
        if (op.operand.kind === "const") env.set(op.from, op.operand.value);
        // A copy: whatever the source holds (known, or "the source's value").
        else if (op.operand.kind === "var") env.set(op.from, env.get(op.operand.id) ?? { var: op.operand.id });
      }
      // A callee, a jump target, or code we can't see may change anything.
      if (op.kind === "callCommon" || op.kind === "label" || unanalyzed.length) env.clear();

      // Nested blocks: each sees the current values; afterwards nothing is assumed.
      const nested = (body: Op[] | undefined, isDead = dead, g = guards) => body && this.walk(body, source, ctx, new Map(env), g, isDead, effectCtx);
      switch (op.kind) {
        case "if": {
          // Comparisons of a variable with a constant become path conditions; the branch is
          // also skipped right away if the condition is already decided.
          const c = op.condition;
          if (c.kind === "variable" && c.rhs.kind === "const") {
            const g: Guard = { var: c.id, op: c.op, value: c.rhs.value };
            const notG: Guard = { ...g, op: NEGATE[g.op] };
            nested(op.then, dead, [...guards, g]);
            nested(op.else, dead, [...guards, notG]);
          } else {
            nested(op.then);
            nested(op.else);
          }
          env.clear();
          break;
        }
        case "choice":
          for (const b of op.branches) nested(b.body);
          env.clear();
          break;
        case "loop":
          // The body may run again after it changes things.
          this.walk(op.body, source, ctx, new Map(), guards, dead, effectCtx);
          env.clear();
          break;
        case "battle":
          nested(op.win);
          nested(op.escape);
          nested(op.lose);
          env.clear();
          break;
        case "skip":
          nested(op.body, true);
          break;
      }
    }
  }

  private symbolic(ce: number) {
    let list = this.ceSymbolic.get(ce);
    if (!list) this.ceSymbolic.set(ce, (list = []));
    return list;
  }

  /**
   * A common event's caller-dependent effects, including those of the common events it calls
   * (with their path conditions; callees' conditions decided by the call site are dropped).
   */
  private summary(ce: number, visiting = new Set<number>()): Pending[] {
    if (visiting.has(ce)) return [];
    visiting.add(ce);
    const out = [...(this.ceSymbolic.get(ce) ?? [])];
    for (const call of this.calls) {
      if (call.source.kind !== "common" || call.source.id !== ce || call.dead) continue;
      for (const s of this.summary(call.callee, visiting)) {
        const open = checkGuards(s.guards, call.env);
        if (!open) continue;
        const effect = resolve(s.effect, call.env, {});
        if (hasSymbols(effect) || open.length) out.push({ effect, via: [call.callee, ...s.via], guards: [...call.guards, ...open] });
      }
    }
    visiting.delete(ce);
    return out;
  }

  private instantiateCalls() {
    const memo = new Map<number, Pending[]>();
    for (const call of this.calls) {
      let summary = memo.get(call.callee);
      if (!summary) memo.set(call.callee, (summary = this.summary(call.callee)));
      const ctx: Context = call.source.kind === "map" ? { mapId: call.source.mapId, eventId: call.source.eventId } : {};
      for (const s of summary) {
        // Paths the call site's known values rule out (e.g. Obtain_Item's quantity <= 0 branch).
        if (!checkGuards(s.guards, call.env)) continue;
        const effect = resolve(s.effect, call.env, ctx);
        const site: Site = { source: call.source, index: call.index, dead: call.dead, via: [call.callee, ...s.via] };
        if (!hasSymbols(effect)) this.refs.push({ effect, site });
        // Still open in a common event: passed up through that event's own summary.
        // Still open elsewhere: the value isn't a constant we can see.
        else if (call.source.kind !== "common") this.note(`argument not constant at call (${effect.entity.kind} via CE${call.callee})`, site);
      }
    }
  }

  /**
   * `callLocalEventInline` runs another event's page as the calling event, so that page's
   * "this event" effects land on the caller. (One level: an inline call inside the called page
   * is not followed further.)
   */
  private instantiateLocalCalls() {
    const selfRefs = new Map<string, Ref[]>();
    for (const r of this.refs) {
      const s = r.site.source;
      if (s.kind !== "map" || !r.effect.selfRelative) continue;
      const key = `${s.mapId}/${(r.effect.entity as { eventId?: unknown }).eventId}`;
      if (!selfRefs.has(key)) selfRefs.set(key, []);
      selfRefs.get(key)!.push(r);
    }
    const added: Ref[] = [];
    for (const r of this.refs) {
      const s = r.site.source;
      const e = r.effect.entity;
      if (s.kind !== "map" || r.effect.how !== "local event (as caller)" || e.kind !== "mapEvent" || typeof e.eventId !== "number") continue;
      for (const callee of selfRefs.get(`${s.mapId}/${e.eventId}`) ?? []) {
        const cs = callee.site.source as Extract<ListSource, { kind: "map" }>;
        // Only the called page (or every page, if the current page is called).
        if (cs.eventId !== e.eventId || cs.original || (e.page !== undefined && cs.page !== e.page)) continue;
        added.push({
          effect: { ...callee.effect, entity: { ...callee.effect.entity, eventId: s.eventId } as Entity, how: `${callee.effect.how} (via E${e.eventId} as caller)` },
          site: { ...r.site, via: callee.site.via },
        });
      }
    }
    this.refs.push(...added);
  }

  /** Refs whose entity matches `kind` and (if given) `id`, live ones first. */
  find(kind: Entity["kind"], match: (e: Entity) => boolean = () => true): Ref[] {
    return this.refs.filter((r) => r.effect.entity.kind === kind && match(r.effect.entity));
  }
}
