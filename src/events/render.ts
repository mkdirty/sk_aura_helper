// Renders decoded ops as indented, Python-like pseudo-code with names resolved.

import type { Condition, GameDataRef, Op, Operand, Value, ActorRef, EnemyRef } from "./ops.ts";
import type { Names } from "./names.ts";

export type TextMode = "full" | "first" | "none";

export interface RenderOptions {
  names: Names;
  /** Dialogue: every line, the first line only, or just a line count. */
  text: TextMode;
}

const IND = "    ";
const DIRECTIONS: Record<number, string> = { 2: "down", 4: "left", 6: "right", 8: "up" };
const PARAMS = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"];
const json = (v: unknown) => JSON.stringify(v);

/** One-line form of a possibly multi-line script. */
const inlineJs = (code: string) => code.replace(/\s*\n\s*/g, " ⏎ ").trim();

export function renderOps(ops: Op[], o: RenderOptions, depth = 0): string[] {
  const out: string[] = [];
  for (const op of ops) renderOp(op, o, depth, out);
  return out;
}

function renderOp(op: Op, o: RenderOptions, depth: number, out: string[]) {
  const n = o.names;
  const pre = IND.repeat(depth);
  const line = (s: string) => out.push(pre + s);
  const block = (header: string, body: Op[]) => {
    line(header);
    if (body.length) out.push(...renderOps(body, o, depth + 1));
    else out.push(pre + IND + "pass");
  };
  const lines = (header: string, text: string[]) => {
    if (o.text === "none") return line(`${header} (${text.length} line${text.length === 1 ? "" : "s"})`);
    if (o.text === "first" || text.length <= 1) return line(`${header} ${text[0] ?? ""}${text.length > 1 ? " …" : ""}`);
    line(header);
    for (const t of text) out.push(pre + IND + "| " + t);
  };

  switch (op.kind) {
    case "text": {
      const who = op.speaker ? op.speaker : op.face ? `[${op.face}#${op.faceIndex}]` : "";
      return lines(`say${who ? ` ${who}` : ""}:`, op.lines);
    }
    case "scrollText":
      return lines("scroll text:", op.lines);
    case "comment":
      for (const c of op.lines) line(`# ${c}`);
      return;
    case "choice": {
      const extras = [op.defaultType >= 0 ? `default ${op.defaultType}` : "no default", op.cancelType === -1 ? "no cancel" : op.cancelType === -2 ? "cancel → branch" : `cancel → ${op.cancelType}`];
      line(`choose (${extras.join(", ")}):`);
      for (const b of op.branches) {
        out.push(pre + IND + (b.choice === -2 ? "when cancel:" : `when ${b.choice} ${json(b.label)}:`));
        out.push(...(b.body.length ? renderOps(b.body, o, depth + 2) : [pre + IND + IND + "pass"]));
      }
      return;
    }
    case "numberInput":
      return line(`${n.variable(op.variableId)} = input number (${op.digits} digits)`);
    case "itemChoice":
      return line(`${n.variable(op.variableId)} = select item (item type ${op.itemType})`);
    case "if":
      block(`if ${condition(op.condition, o)}:`, op.then);
      if (op.else) block("else:", op.else);
      return;
    case "loop":
      return block("loop:", op.body);
    case "skip":
      return block("skip (never runs):", op.body);
    case "breakLoop":
      return line("break loop");
    case "exitEvent":
      return line("exit event");
    case "callCommon":
      return line(`call ${n.commonEvent(op.id)}`);
    case "label":
      return line(`label ${json(op.name)}`);
    case "jump":
      return line(`jump to ${json(op.name)}`);
    case "setSwitches":
      return line(`${n.switchRange(op.from, op.to)} = ${op.value ? "ON" : "OFF"}`);
    case "setVariables":
      return line(`${n.variableRange(op.from, op.to)} ${op.op} ${operand(op.operand, o)}`);
    case "setSelfSwitch":
      return line(`self ${op.letter} = ${op.value ? "ON" : "OFF"}`);
    case "changeGold":
      return line(`gold ${op.sign > 0 ? "+=" : "-="} ${value(op.delta, o)}`);
    case "changeItems":
      return line(`${n.item(op.itemKind, op.id)} ${op.sign > 0 ? "+=" : "-="} ${value(op.delta, o)}${op.includeEquip ? " (incl. equipped)" : ""}`);
    case "changeParty":
      return line(`party ${op.add ? "add" : "remove"} ${n.actor(op.actorId)}${op.initialize ? " (initialize)" : ""}`);
    case "transfer": {
      const where = op.mapId.kind === "const" ? n.map(op.mapId.value) : `map ${value(op.mapId, o)}`;
      const extras = [op.direction ? `facing ${DIRECTIONS[op.direction] ?? op.direction}` : "", op.fade === 1 ? "white fade" : op.fade === 2 ? "no fade" : ""].filter(Boolean);
      return line(`transfer to ${where} (${value(op.x, o)}, ${value(op.y, o)})${extras.length ? ` ${extras.join(", ")}` : ""}`);
    }
    case "moveRoute": {
      const flags = [op.repeat && "repeat", op.skippable && "skippable", op.wait && "wait"].filter(Boolean);
      const steps = op.steps.map((s) => {
        if (s.name === "script") return `script(${inlineJs(String(s.params[0] ?? ""))})`;
        if (s.name === "switch_on" || s.name === "switch_off") return `${s.name}(${n.switch(Number(s.params[0]))})`;
        return s.params.length ? `${s.name}(${s.params.map((p) => (typeof p === "object" ? json(p) : String(p))).join(", ")})` : s.name;
      });
      return line(`move ${n.character(op.character)}${flags.length ? ` [${flags.join(", ")}]` : ""}: ${steps.join(", ") || "(no steps)"}`);
    }
    case "battle": {
      const troop = op.troop.kind === "random" ? "random encounter" : op.troop.kind === "const" ? n.troop(op.troop.value) : `troop ${value(op.troop, o)}`;
      const flags = [op.canEscape && "can escape", op.canLose && "can lose"].filter(Boolean);
      const header = `battle ${troop}${flags.length ? ` [${flags.join(", ")}]` : ""}`;
      if (!op.win && !op.escape && !op.lose) return line(header);
      line(`${header}:`);
      const branch = (label: string, body: Op[] | undefined) => {
        if (!body) return;
        out.push(pre + IND + label);
        out.push(...(body.length ? renderOps(body, o, depth + 2) : [pre + IND + IND + "pass"]));
      };
      branch("on win:", op.win);
      branch("on escape:", op.escape);
      branch("on lose:", op.lose);
      return;
    }
    case "shop":
      return line(`shop${op.purchaseOnly ? " (purchase only)" : ""}: ${op.goods.map((g) => `${n.item(g.itemKind, g.id)}${g.price !== undefined ? ` @${g.price}` : ""}`).join(", ")}`);
    case "changeSkill":
      return line(`${actor(op.actor, o)} ${op.learn ? "learns" : "forgets"} ${n.skill(op.skillId)}`);
    case "changeState":
      return line(`${actor(op.actor, o)} ${op.add ? "add" : "remove"} ${n.state(op.stateId)}`);
    case "changeActorValue": {
      const flag = op.flag ? (op.stat === "hp" ? " (allow death)" : op.stat === "exp" || op.stat === "level" ? " (show level up)" : "") : "";
      return line(`${actor(op.actor, o)}.${op.stat} ${op.sign > 0 ? "+=" : "-="} ${value(op.delta, o)}${flag}`);
    }
    case "changeParam":
      return line(`${actor(op.actor, o)}.${PARAMS[op.param] ?? `param${op.param}`} ${op.sign > 0 ? "+=" : "-="} ${value(op.delta, o)}`);
    case "recoverAll":
      return line(`recover all: ${actor(op.actor, o)}`);
    case "changeEquipment": {
      const what = op.itemId === 0 ? "nothing" : n.item(op.slot === 1 ? "weapon" : "armor", op.itemId);
      return line(`${n.actor(op.actorId)} equips ${what} (slot ${op.slot})`);
    }
    case "changeClass":
      return line(`${n.actor(op.actorId)} class = ${n.class(op.classId)}${op.keepExp ? " (keep exp)" : ""}`);
    case "changeActorText":
      return line(`${n.actor(op.actorId)} ${op.field} = ${json(op.value)}`);
    case "enemyCommand":
      return line(`${enemy(op.enemy)} ${op.command}(${args(op.args, o)})`);
    case "script": {
      const code = op.js.split("\n");
      if (code.length === 1) return line(`js: ${code[0]}`);
      line("js:");
      for (const c of code) out.push(pre + IND + "| " + c);
      return;
    }
    case "plugin":
      return line(`plugin ${op.plugin}::${op.command}(${args(op.args, o)})`);
    case "legacyPlugin":
      return line(`plugin command: ${op.text}`);
    case "generic":
      return line(`${op.name}(${args(op.args, o)})`);
    case "unknown":
      return line(`?? code ${op.code} ${json(op.params)}`);
  }
}

function args(a: Record<string, unknown>, o: RenderOptions): string {
  return Object.entries(a)
    .map(([k, v]) => {
      // Ids that generic commands share with dedicated ones.
      if (k === "character" && typeof v === "number") return `${k}=${o.names.character(v < 0 ? { kind: "player" } : v === 0 ? { kind: "this" } : { kind: "event", id: v })}`;
      if (k === "animationId" && typeof v === "number") return `${k}=${o.names.animation(v)}`;
      if (v && typeof v === "object" && "kind" in (v as object)) return `${k}=${value(v as Value, o)}`;
      if (v && typeof v === "object" && "name" in (v as object) && "volume" in (v as object)) return `${k}=${json((v as { name: string }).name)}`;
      return `${k}=${typeof v === "string" ? json(v) : json(v)}`;
    })
    .join(", ");
}

function value(v: Value, o: RenderOptions): string {
  return v.kind === "const" ? String(v.value) : o.names.variable(v.id);
}

function actor(a: ActorRef, o: RenderOptions): string {
  return a.kind === "party" ? "party" : a.kind === "actor" ? o.names.actor(a.id) : `actor[${o.names.variable(a.id)}]`;
}

function enemy(e: EnemyRef): string {
  return e.kind === "allEnemies" ? "all enemies" : `enemy #${e.index}`;
}

function gameData(d: GameDataRef, o: RenderOptions): string {
  const n = o.names;
  switch (d.kind) {
    case "itemCount":
      return `count(${n.item(d.itemKind, d.id)})`;
    case "actorStat":
      return `${n.actor(d.actorId)}.${d.stat}`;
    case "enemyStat":
      return `enemy #${d.index}.${d.stat}`;
    case "characterStat":
      return `${n.character(d.character)}.${d.stat}`;
    case "partyMember":
      return `party[${d.index}].actorId`;
    case "other":
      return d.what;
    case "last":
      return `last.${d.what}`;
    case "unknown":
      return `gameData?(${d.type}, ${json(d.param1)}, ${json(d.param2)})`;
  }
}

function operand(x: Operand, o: RenderOptions): string {
  switch (x.kind) {
    case "const":
    case "var":
      return value(x, o);
    case "random":
      return `random(${x.min}..${x.max})`;
    case "gameData":
      return gameData(x.data, o);
    case "script":
      return `js(${inlineJs(x.code)})`;
  }
}

export function condition(c: Condition, o: RenderOptions): string {
  const n = o.names;
  switch (c.kind) {
    case "switch":
      return `${n.switch(c.id)} is ${c.value ? "ON" : "OFF"}`;
    case "variable":
      return `${n.variable(c.id)} ${c.op} ${value(c.rhs, o)}`;
    case "selfSwitch":
      return `self ${c.letter} is ${c.value ? "ON" : "OFF"}`;
    case "timer":
      return `timer ${c.op} ${c.seconds}s`;
    case "actor": {
      const who = n.actor(c.actorId);
      const arg = Number(c.arg);
      switch (c.test) {
        case "inParty":
          return `${who} in party`;
        case "name":
          return `${who} name is ${json(c.arg)}`;
        case "class":
          return `${who} is ${n.class(arg)}`;
        case "skill":
          return `${who} has ${n.skill(arg)}`;
        case "weapon":
          return `${who} has ${n.item("weapon", arg)} equipped`;
        case "armor":
          return `${who} has ${n.item("armor", arg)} equipped`;
        case "state":
          return `${who} has ${n.state(arg)}`;
      }
      return `${who} ${c.test} ${json(c.arg)}`;
    }
    case "enemy":
      return c.test === "appeared" ? `enemy #${c.index} appeared` : `enemy #${c.index} has ${n.state(c.stateId ?? 0)}`;
    case "character":
      return `${n.character(c.character)} faces ${DIRECTIONS[c.direction] ?? c.direction}`;
    case "gold":
      return `gold ${c.op} ${c.amount}`;
    case "hasItem":
      return `has ${n.item(c.itemKind, c.id)}${c.includeEquip ? " (incl. equipped)" : ""}`;
    case "button":
      return `button ${c.button} ${c.mode}`;
    case "script":
      return `js(${inlineJs(c.code)})`;
    case "vehicle":
      return `in vehicle ${c.vehicle}`;
    case "unknown":
      return `?? ${json(c.params)}`;
  }
}
