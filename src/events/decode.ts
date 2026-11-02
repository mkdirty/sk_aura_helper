// Decodes an event command list into a tree of structured ops.
//
// Block structure follows the engine, which delimits blocks by indentation alone
// (Game_Interpreter.skipBranch skips while the next command is indented deeper): a block body
// is the run of commands indented deeper than its opener. The editor also writes a code-0
// terminator at the end of each body and closers at the opener's indent (412, 404, 413, 604,
// 409); those are cosmetic, so a missing one is an anomaly, not an error. Branch markers
// (411 else, 402/403 choice branches, 601-603 battle results) sit at the opener's indent.
// Multi-line commands absorb their continuation lines (401, 405, 408, 605, 655, 657, 505).
//
// Anything unexpected becomes an Issue rather than an exception, so a whole-project pass
// always completes and the issues can be counted.

import fs from "node:fs";
import path from "node:path";
import type { RawCommand } from "../data/game-data.ts";
import type { ActorRef, CharacterRef, Comparison, Condition, EnemyRef, GameDataRef, Issue, ItemKind, MoveStep, Op, Operand, Value } from "./ops.ts";

/** Commands with no dedicated shape: display name and parameter names ("?" = optional). */
const GENERIC: Record<number, [string, string[]]> = {
  124: ["Control Timer", ["operation", "seconds?"]],
  132: ["Change Battle BGM", ["audio"]],
  133: ["Change Victory ME", ["audio"]],
  134: ["Change Save Access", ["disable"]],
  135: ["Change Menu Access", ["disable"]],
  136: ["Change Encounter", ["disable"]],
  137: ["Change Formation Access", ["disable"]],
  138: ["Change Window Color", ["tone"]],
  139: ["Change Defeat ME", ["audio"]],
  140: ["Change Vehicle BGM", ["vehicle", "audio"]],
  202: ["Set Vehicle Location", ["vehicle", "designation", "mapId", "x", "y"]],
  203: ["Set Event Location", ["character", "designation", "x", "y", "direction"]],
  204: ["Scroll Map", ["direction", "distance", "speed", "wait?"]],
  206: ["Get on/off Vehicle", []],
  211: ["Change Transparency", ["off"]],
  212: ["Show Animation", ["character", "animationId", "wait"]],
  213: ["Show Balloon Icon", ["character", "balloonId", "wait"]],
  214: ["Erase Event", []],
  216: ["Change Player Followers", ["hide"]],
  217: ["Gather Followers", []],
  221: ["Fadeout Screen", []],
  222: ["Fadein Screen", []],
  223: ["Tint Screen", ["tone", "duration", "wait"]],
  224: ["Flash Screen", ["color", "duration", "wait"]],
  225: ["Shake Screen", ["power", "speed", "duration", "wait"]],
  230: ["Wait", ["frames"]],
  // Map158/E1 PROTECTED_SI_FROM_EXCLUDE lists images as 2-parameter Show Picture commands
  // (keeps them from being excluded at deployment), so only the first two are required.
  231: ["Show Picture", ["pictureId", "name", "origin?", "designation?", "x?", "y?", "scaleX?", "scaleY?", "opacity?", "blendMode?"]],
  232: ["Move Picture", ["pictureId", "unused", "origin", "designation", "x", "y", "scaleX", "scaleY", "opacity", "blendMode", "duration", "wait", "easing?"]],
  233: ["Rotate Picture", ["pictureId", "speed"]],
  234: ["Tint Picture", ["pictureId", "tone", "duration", "wait"]],
  235: ["Erase Picture", ["pictureId"]],
  236: ["Set Weather Effect", ["type", "power", "duration", "wait"]],
  241: ["Play BGM", ["audio"]],
  242: ["Fadeout BGM", ["seconds"]],
  243: ["Save BGM", []],
  244: ["Replay BGM", []],
  245: ["Play BGS", ["audio"]],
  246: ["Fadeout BGS", ["seconds"]],
  249: ["Play ME", ["audio"]],
  250: ["Play SE", ["audio"]],
  251: ["Stop SE", []],
  261: ["Play Movie", ["name"]],
  281: ["Change Map Name Display", ["off"]],
  282: ["Change Tileset", ["tilesetId"]],
  283: ["Change Battle Background", ["name1", "name2"]],
  284: ["Change Parallax", ["name", "loopX", "loopY", "scrollX", "scrollY"]],
  285: ["Get Location Info", ["variableId", "infoType", "designation", "x", "y"]],
  303: ["Name Input Processing", ["actorId", "maxChars"]],
  322: ["Change Actor Images", ["actorId", "characterName", "characterIndex", "faceName", "faceIndex", "battlerName"]],
  323: ["Change Vehicle Image", ["vehicle", "characterName", "characterIndex"]],
  339: ["Force Action", ["subjectType", "subject", "skillId", "targetIndex"]],
  340: ["Abort Battle", []],
  351: ["Open Menu Screen", []],
  352: ["Open Save Screen", []],
  353: ["Game Over", []],
  354: ["Return to Title Screen", []],
};

/** Codes that only appear inside another command or block; seeing one on its own is a gap. */
const DEPENDENT = new Set([401, 402, 403, 404, 405, 408, 409, 411, 412, 413, 505, 601, 602, 603, 604, 605, 655, 657]);

const COMPARISONS: Comparison[] = ["==", ">=", "<=", ">", "<", "!="];
const VARIABLE_OPS = ["=", "+=", "-=", "*=", "/=", "%="] as const;
const ITEM_KINDS: ItemKind[] = ["item", "weapon", "armor"];
const ACTOR_TESTS = ["inParty", "name", "class", "skill", "weapon", "armor", "state"];
const ACTOR_STATS: Record<number, string> = { 0: "level", 1: "exp", 2: "hp", 3: "mp", 12: "tp" };
const PARAMS = ["mhp", "mmp", "atk", "def", "mat", "mdf", "agi", "luk"];
const ENEMY_STATS: Record<number, string> = { 0: "hp", 1: "mp", 10: "tp" };
const CHARACTER_STATS = ["mapX", "mapY", "direction", "screenX", "screenY"];
const OTHER_DATA = ["mapId", "partySize", "gold", "steps", "playtime", "timer", "saveCount", "battleCount", "winCount", "escapeCount"];
const LAST_DATA = ["usedSkillId", "usedItemId", "actingActorId", "actingEnemyIndex", "targetActorId", "targetEnemyIndex"];

/** Move-route step names, read from the engine's Game_Character.ROUTE_* constants. */
export function engineRouteNames(gameDir: string): Map<number, string> {
  const src = fs.readFileSync(path.join(gameDir, "js/rmmz_objects.js"), "utf8");
  const names = new Map<number, string>();
  for (const m of src.matchAll(/Game_Character\.ROUTE_(\w+)\s*=\s*(\d+);/g)) names.set(Number(m[2]), m[1].toLowerCase());
  return names;
}

export interface DecodeOptions {
  routeNames: Map<number, string>;
}

export interface Decoded {
  ops: Op[];
  issues: Issue[];
  /** Commands consumed, including continuation lines and closers (should equal list length). */
  consumed: number;
}

export function decodeList(list: RawCommand[], options: DecodeOptions): Decoded {
  // Generated lists (e.g. Map158/E1) can omit `indent`; the engine then treats it as falsy.
  const normalized = list.some((c) => c.indent === undefined) ? list.map((c) => ({ ...c, indent: c.indent ?? 0 })) : list;
  const d = new Decoder(normalized, options);
  const ops = d.block(0);
  return { ops, issues: d.issues, consumed: d.consumed };
}

const val = (operandType: number, operand: number): Value =>
  operandType === 0 ? { kind: "const", value: operand } : { kind: "var", id: operand };

const character = (param: number): CharacterRef =>
  param < 0 ? { kind: "player" } : param === 0 ? { kind: "this" } : { kind: "event", id: param };

const actorEx = (type: number, id: number): ActorRef =>
  type !== 0 ? { kind: "actorVar", id } : id === 0 ? { kind: "party" } : { kind: "actor", id };

const enemyIndex = (param: number): EnemyRef => (param < 0 ? { kind: "allEnemies" } : { kind: "enemy", index: param });

class Decoder {
  i = 0;
  consumed = 0;
  readonly issues: Issue[] = [];
  private readonly list: RawCommand[];
  private readonly options: DecodeOptions;

  constructor(list: RawCommand[], options: DecodeOptions) {
    this.list = list;
    this.options = options;
  }

  issue(key: string, index: number, detail: string, severity: "gap" | "anomaly" = "gap") {
    this.issues.push({ severity, key, index, detail });
  }

  private peek(): RawCommand | undefined {
    return this.list[this.i];
  }

  private take(): RawCommand {
    this.consumed++;
    return this.list[this.i++];
  }

  /** Consumes the closer `code` at `indent`, or records its absence. */
  private close(code: number, indent: number, opener: number, at: number) {
    const next = this.peek();
    if (next?.code === code && next.indent === indent) this.take();
    else this.issue(`missing ${code}`, at, `${opener} at index ${at} has no ${code}`, "anomaly");
  }

  /** Consumes consecutive continuation lines with `code`. */
  private lines(code: number): string[] {
    const out: string[] = [];
    while (this.peek()?.code === code) out.push(String(this.take().parameters[0] ?? ""));
    return out;
  }

  /** The commands indented at least `indent` from here on (a block body). */
  block(indent: number): Op[] {
    const ops: Op[] = [];
    let terminated = indent === 0;
    while (this.i < this.list.length) {
      const c = this.list[this.i];
      if (c.indent < indent) break;
      if (c.code === 0) {
        // The editor's end-of-body marker; the engine ignores it.
        this.take();
        if (c.indent === indent) terminated = true;
        continue;
      }
      if (terminated && indent > 0) this.issue("commands after end-of-body marker", this.i, `code ${c.code} at indent ${c.indent}`, "anomaly");
      if (c.indent > indent) this.issue("deeper indent without an opener", this.i, `code ${c.code} at indent ${c.indent} in a block at ${indent}`, "anomaly");
      const op = this.command();
      if (op) ops.push(op);
    }
    if (!terminated) this.issue("body without end-of-body marker", this.i, `block at indent ${indent}`, "anomaly");
    return ops;
  }

  /** Decodes the command at `i` (and whatever belongs to it). */
  private command(): Op | undefined {
    const index = this.i;
    const c = this.take();
    const p = c.parameters ?? [];
    const base = { code: c.code, index };
    const shape = (ok: boolean) => {
      if (!ok) this.issue(`shape ${c.code}`, index, JSON.stringify(p).slice(0, 200));
      return ok;
    };

    if (DEPENDENT.has(c.code)) {
      // The engine has no handler (or a branch handler) for these on their own.
      this.issue(`stray ${c.code}`, index, JSON.stringify(p).slice(0, 120), "anomaly");
      return undefined;
    }

    switch (c.code) {
      case 101:
        shape(p.length >= 4);
        return { ...base, kind: "text", face: p[0] ?? "", faceIndex: p[1] ?? 0, background: p[2] ?? 0, position: p[3] ?? 2, speaker: p[4] ?? "", lines: this.lines(401) };
      case 102: {
        shape(Array.isArray(p[0]));
        const choices: string[] = p[0] ?? [];
        const branches: Array<{ choice: number; label: string; body: Op[] }> = [];
        for (let next = this.peek(); next && next.indent === c.indent && (next.code === 402 || next.code === 403); next = this.peek()) {
          const marker = this.take();
          const choice = marker.code === 402 ? marker.parameters[0] : -2;
          const label = marker.code === 402 ? String(marker.parameters[1] ?? choices[choice] ?? "") : "(cancel)";
          branches.push({ choice, label, body: this.block(c.indent + 1) });
        }
        this.close(404, c.indent, 102, index);
        return { ...base, kind: "choice", choices, cancelType: p[1] < choices.length ? p[1] : -2, defaultType: p[2] ?? 0, branches };
      }
      case 103:
        shape(p.length === 2);
        return { ...base, kind: "numberInput", variableId: p[0], digits: p[1] };
      case 104:
        shape(p.length >= 1);
        return { ...base, kind: "itemChoice", variableId: p[0], itemType: p[1] ?? 2 };
      case 105:
        return { ...base, kind: "scrollText", speed: p[0], noFast: !!p[1], lines: this.lines(405) };
      case 108:
        return { ...base, kind: "comment", lines: [String(p[0] ?? ""), ...this.lines(408)] };
      case 111: {
        const condition = this.condition(p, index);
        const then = this.block(c.indent + 1);
        let otherwise: Op[] | undefined;
        const next = this.peek();
        if (next?.code === 411 && next.indent === c.indent) {
          this.take();
          otherwise = this.block(c.indent + 1);
        }
        this.close(412, c.indent, 111, index);
        return { ...base, kind: "if", condition, then, ...(otherwise ? { else: otherwise } : {}) };
      }
      case 112: {
        const body = this.block(c.indent + 1);
        this.close(413, c.indent, 112, index);
        return { ...base, kind: "loop", body };
      }
      case 109: {
        const body = this.block(c.indent + 1);
        this.close(409, c.indent, 109, index);
        return { ...base, kind: "skip", body };
      }
      case 113:
        return { ...base, kind: "breakLoop" };
      case 115:
        return { ...base, kind: "exitEvent" };
      case 117:
        shape(typeof p[0] === "number");
        return { ...base, kind: "callCommon", id: p[0] };
      case 118:
        return { ...base, kind: "label", name: String(p[0]) };
      case 119:
        return { ...base, kind: "jump", name: String(p[0]) };
      case 121:
        shape(p.length === 3);
        return { ...base, kind: "setSwitches", from: p[0], to: p[1], value: p[2] === 0 };
      case 122:
        return this.controlVariables(p, base);
      case 123:
        shape(p.length === 2);
        return { ...base, kind: "setSelfSwitch", letter: p[0], value: p[1] === 0 };
      case 125:
        shape(p.length === 3);
        return { ...base, kind: "changeGold", sign: p[0] === 0 ? 1 : -1, delta: val(p[1], p[2]) };
      case 126:
      case 127:
      case 128:
        shape(p.length >= 4);
        return { ...base, kind: "changeItems", itemKind: ITEM_KINDS[c.code - 126], id: p[0], sign: p[1] === 0 ? 1 : -1, delta: val(p[2], p[3]), includeEquip: !!p[4] };
      case 129:
        shape(p.length >= 2);
        return { ...base, kind: "changeParty", actorId: p[0], add: p[1] === 0, initialize: !!p[2] };
      case 201:
        shape(p.length >= 4);
        return {
          ...base,
          kind: "transfer",
          mapId: val(p[0], p[1]),
          x: val(p[0], p[2]),
          y: val(p[0], p[3]),
          direction: p[4] ?? 0,
          fade: p[5] ?? 0,
        };
      case 205: {
        const route = p[1] ?? {};
        shape(Array.isArray(route.list));
        // 505 lines repeat the route's steps for the editor's display.
        while (this.peek()?.code === 505) this.take();
        const steps: MoveStep[] = (route.list ?? [])
          .filter((s: RawCommand) => s.code !== 0)
          .map((s: RawCommand) => ({ code: s.code, name: this.options.routeNames.get(s.code) ?? `step${s.code}`, params: s.parameters ?? [] }));
        return { ...base, kind: "moveRoute", character: character(p[0]), repeat: !!route.repeat, skippable: !!route.skippable, wait: !!route.wait, steps };
      }
      case 301: {
        shape(p.length >= 4);
        const troop = p[0] === 2 ? ({ kind: "random" } as const) : val(p[0], p[1]);
        const op: Op = { ...base, kind: "battle", troop, canEscape: !!p[2], canLose: !!p[3] };
        let next = this.peek();
        if (next && next.indent === c.indent && next.code >= 601 && next.code <= 603) {
          for (; next && next.indent === c.indent && next.code >= 601 && next.code <= 603; next = this.peek()) {
            const marker = this.take();
            const body = this.block(c.indent + 1);
            if (marker.code === 601) op.win = body;
            else if (marker.code === 602) op.escape = body;
            else op.lose = body;
          }
          this.close(604, c.indent, 301, index);
        }
        return op;
      }
      case 302: {
        const goods: any[][] = [p];
        while (this.peek()?.code === 605) goods.push(this.take().parameters);
        return {
          ...base,
          kind: "shop",
          purchaseOnly: !!p[4],
          goods: goods.map((g) => ({ itemKind: ITEM_KINDS[g[0]] ?? "item", id: g[1], ...(g[2] === 1 ? { price: g[3] } : {}) })),
        };
      }
      case 311:
      case 312:
      case 326: {
        shape(p.length >= 5);
        const stat = c.code === 311 ? "hp" : c.code === 312 ? "mp" : "tp";
        return { ...base, kind: "changeActorValue", actor: actorEx(p[0], p[1]), stat, sign: p[2] === 0 ? 1 : -1, delta: val(p[3], p[4]), ...(c.code === 311 ? { flag: !!p[5] } : {}) };
      }
      case 313:
        shape(p.length === 4);
        return { ...base, kind: "changeState", actor: actorEx(p[0], p[1]), add: p[2] === 0, stateId: p[3] };
      case 314:
        return { ...base, kind: "recoverAll", actor: actorEx(p[0], p[1]) };
      case 315:
      case 316:
        shape(p.length >= 5);
        return { ...base, kind: "changeActorValue", actor: actorEx(p[0], p[1]), stat: c.code === 315 ? "exp" : "level", sign: p[2] === 0 ? 1 : -1, delta: val(p[3], p[4]), flag: !!p[5] };
      case 317:
        shape(p.length === 6);
        return { ...base, kind: "changeParam", actor: actorEx(p[0], p[1]), param: p[2], sign: p[3] === 0 ? 1 : -1, delta: val(p[4], p[5]) };
      case 318:
        shape(p.length === 4);
        return { ...base, kind: "changeSkill", actor: actorEx(p[0], p[1]), learn: p[2] === 0, skillId: p[3] };
      case 319:
        shape(p.length === 3);
        return { ...base, kind: "changeEquipment", actorId: p[0], slot: p[1], itemId: p[2] };
      case 320:
      case 324:
      case 325:
        return { ...base, kind: "changeActorText", actorId: p[0], field: c.code === 320 ? "name" : c.code === 324 ? "nickname" : "profile", value: String(p[1] ?? "") };
      case 321:
        shape(p.length >= 2);
        return { ...base, kind: "changeClass", actorId: p[0], classId: p[1], keepExp: !!p[2] };
      case 331:
      case 332:
      case 342:
        return { ...base, kind: "enemyCommand", command: c.code === 331 ? "changeHp" : c.code === 332 ? "changeMp" : "changeTp", enemy: enemyIndex(p[0]), args: { sign: p[1] === 0 ? 1 : -1, delta: val(p[2], p[3]), ...(c.code === 331 ? { allowDeath: !!p[4] } : {}) } };
      case 333:
        return { ...base, kind: "enemyCommand", command: p[1] === 0 ? "addState" : "removeState", enemy: enemyIndex(p[0]), args: { stateId: p[2] } };
      case 334:
        return { ...base, kind: "enemyCommand", command: "recoverAll", enemy: enemyIndex(p[0]), args: {} };
      case 335:
        return { ...base, kind: "enemyCommand", command: "appear", enemy: enemyIndex(p[0]), args: {} };
      case 336:
        return { ...base, kind: "enemyCommand", command: "transform", enemy: enemyIndex(p[0]), args: { enemyId: p[1] } };
      case 337:
        return { ...base, kind: "enemyCommand", command: "showAnimation", enemy: p[2] ? { kind: "allEnemies" } : enemyIndex(p[0]), args: { animationId: p[1] } };
      case 355:
        return { ...base, kind: "script", js: [String(p[0] ?? ""), ...this.lines(655)].join("\n") };
      case 356:
        return { ...base, kind: "legacyPlugin", text: String(p[0] ?? "") };
      case 357: {
        shape(p.length === 4 && typeof p[3] === "object");
        // 657 lines repeat the arguments for the editor's display.
        while (this.peek()?.code === 657) this.take();
        return { ...base, kind: "plugin", plugin: String(p[0]), command: String(p[1]), display: String(p[2] ?? ""), args: p[3] ?? {} };
      }
    }

    const spec = GENERIC[c.code];
    if (spec) {
      const [name, names] = spec;
      const required = names.filter((n) => !n.endsWith("?")).length;
      shape(p.length >= required && p.length <= names.length);
      const args: Record<string, unknown> = {};
      names.forEach((n, k) => {
        if (k < p.length) args[n.replace("?", "")] = p[k];
      });
      return { ...base, kind: "generic", name, args };
    }

    this.issue(`unknown code ${c.code}`, index, JSON.stringify(p).slice(0, 120));
    return { ...base, kind: "unknown", params: p };
  }

  private controlVariables(p: any[], base: { code: number; index: number }): Op {
    const op = VARIABLE_OPS[p[2]];
    let operand: Operand | undefined;
    switch (p[3]) {
      case 0:
      case 1:
        operand = val(p[3], p[4]);
        break;
      case 2:
        operand = { kind: "random", min: p[4], max: p[5] };
        break;
      case 3:
        operand = { kind: "gameData", data: this.gameData(p[4], p[5], p[6]) };
        break;
      case 4:
        operand = { kind: "script", code: String(p[4]) };
        break;
    }
    if (!op || !operand) {
      this.issue("shape 122", base.index, JSON.stringify(p).slice(0, 200));
      return { ...base, kind: "unknown", params: p };
    }
    return { ...base, kind: "setVariables", from: p[0], to: p[1], op, operand };
  }

  private gameData(type: number, param1: number, param2: number): GameDataRef {
    switch (type) {
      case 0:
      case 1:
      case 2:
        return { kind: "itemCount", itemKind: ITEM_KINDS[type], id: param1 };
      case 3: {
        const stat = ACTOR_STATS[param2] ?? (param2 >= 4 && param2 <= 11 ? PARAMS[param2 - 4] : undefined);
        if (stat) return { kind: "actorStat", actorId: param1, stat };
        break;
      }
      case 4: {
        const stat = ENEMY_STATS[param2] ?? (param2 >= 2 && param2 <= 9 ? PARAMS[param2 - 2] : undefined);
        if (stat) return { kind: "enemyStat", index: param1, stat };
        break;
      }
      case 5:
        if (CHARACTER_STATS[param2]) return { kind: "characterStat", character: character(param1), stat: CHARACTER_STATS[param2] };
        break;
      case 6:
        return { kind: "partyMember", index: param1 };
      case 7:
        if (OTHER_DATA[param1]) return { kind: "other", what: OTHER_DATA[param1] };
        break;
      case 8:
        if (LAST_DATA[param1]) return { kind: "last", what: LAST_DATA[param1] };
        break;
    }
    return { kind: "unknown", type, param1, param2 };
  }

  private condition(p: any[], index: number): Condition {
    const bad = (): Condition => {
      this.issue(`shape 111 (type ${p[0]})`, index, JSON.stringify(p).slice(0, 200));
      return { kind: "unknown", params: p };
    };
    switch (p[0]) {
      case 0:
        return { kind: "switch", id: p[1], value: p[2] === 0 };
      case 1: {
        const op = COMPARISONS[p[4]];
        return op ? { kind: "variable", id: p[1], op, rhs: val(p[2], p[3]) } : bad();
      }
      case 2:
        return { kind: "selfSwitch", letter: p[1], value: p[2] === 0 };
      case 3:
        return { kind: "timer", op: p[2] === 0 ? ">=" : "<=", seconds: p[1] };
      case 4: {
        const test = ACTOR_TESTS[p[2]];
        return test ? { kind: "actor", actorId: p[1], test, ...(p[2] > 0 ? { arg: p[3] } : {}) } : bad();
      }
      case 5:
        return { kind: "enemy", index: p[1], test: p[2] === 0 ? "appeared" : "state", ...(p[2] === 1 ? { stateId: p[3] } : {}) };
      case 6:
        return { kind: "character", character: character(p[1]), direction: p[2] };
      case 7: {
        const op = ([">=", "<=", "<"] as const)[p[2]];
        return op ? { kind: "gold", op, amount: p[1] } : bad();
      }
      case 8:
      case 9:
      case 10:
        return { kind: "hasItem", itemKind: ITEM_KINDS[p[0] - 8], id: p[1], includeEquip: !!p[2] };
      case 11:
        return { kind: "button", button: p[1], mode: (["pressed", "triggered", "repeated"] as const)[p[2] ?? 0] ?? "pressed" };
      case 12:
        return { kind: "script", code: String(p[1]) };
      case 13:
        return { kind: "vehicle", vehicle: p[1] };
    }
    return bad();
  }
}
