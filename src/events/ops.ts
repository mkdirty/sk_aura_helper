// The structured form of decoded event commands.
//
// Field meanings follow the engine's Game_Interpreter.commandNNN implementations
// (js/rmmz_objects.js). Commands without a dedicated shape decode to `GenericOp`, with
// parameters named from the spec table in decode.ts.

/** A number given directly or read from a variable. */
export type Value = { kind: "const"; value: number } | { kind: "var"; id: number };

/** Which character a command targets: the player, this event, or event N on the current map. */
export type CharacterRef = { kind: "player" } | { kind: "this" } | { kind: "event"; id: number };

/** Which actors: a fixed actor, the actor whose id is in a variable, or the whole party. */
export type ActorRef = { kind: "actor"; id: number } | { kind: "actorVar"; id: number } | { kind: "party" };

/** Which enemies (troop member index, 0-based), or all. */
export type EnemyRef = { kind: "enemy"; index: number } | { kind: "allEnemies" };

export type ItemKind = "item" | "weapon" | "armor";

export type Comparison = "==" | ">=" | "<=" | ">" | "<" | "!=";

/** Game data readable by Control Variables (gameDataOperand). */
export type GameDataRef =
  | { kind: "itemCount"; itemKind: ItemKind; id: number }
  | { kind: "actorStat"; actorId: number; stat: string }
  | { kind: "enemyStat"; index: number; stat: string }
  | { kind: "characterStat"; character: CharacterRef; stat: string }
  | { kind: "partyMember"; index: number }
  | { kind: "other"; what: string }
  | { kind: "last"; what: string }
  | { kind: "unknown"; type: number; param1: unknown; param2: unknown };

export type Operand =
  | Value
  | { kind: "random"; min: number; max: number }
  | { kind: "gameData"; data: GameDataRef }
  | { kind: "script"; code: string };

export type Condition =
  | { kind: "switch"; id: number; value: boolean }
  | { kind: "variable"; id: number; op: Comparison; rhs: Value }
  | { kind: "selfSwitch"; letter: string; value: boolean }
  | { kind: "timer"; op: ">=" | "<="; seconds: number }
  | { kind: "actor"; actorId: number; test: string; arg?: unknown }
  | { kind: "enemy"; index: number; test: "appeared" | "state"; stateId?: number }
  | { kind: "character"; character: CharacterRef; direction: number }
  | { kind: "gold"; op: ">=" | "<=" | "<"; amount: number }
  | { kind: "hasItem"; itemKind: ItemKind; id: number; includeEquip: boolean }
  | { kind: "button"; button: string; mode: "pressed" | "triggered" | "repeated" }
  | { kind: "script"; code: string }
  | { kind: "vehicle"; vehicle: number }
  | { kind: "unknown"; params: unknown[] };

export interface MoveStep {
  code: number;
  name: string;
  params: unknown[];
}

/** Every op knows the command code it came from and its index in the list. */
interface Base {
  code: number;
  index: number;
}

export type Op = Base &
  (
    | { kind: "text"; speaker: string; face: string; faceIndex: number; background: number; position: number; lines: string[] }
    | { kind: "choice"; choices: string[]; cancelType: number; defaultType: number; branches: Array<{ choice: number; label: string; body: Op[] }> }
    | { kind: "numberInput"; variableId: number; digits: number }
    | { kind: "itemChoice"; variableId: number; itemType: number }
    | { kind: "scrollText"; speed: number; noFast: boolean; lines: string[] }
    | { kind: "comment"; lines: string[] }
    | { kind: "if"; condition: Condition; then: Op[]; else?: Op[] }
    | { kind: "loop"; body: Op[] }
    /** Editor "Skip" block (109 … 409): the body never runs (command109 skips it). */
    | { kind: "skip"; body: Op[] }
    | { kind: "breakLoop" }
    | { kind: "exitEvent" }
    | { kind: "callCommon"; id: number }
    | { kind: "label"; name: string }
    | { kind: "jump"; name: string }
    | { kind: "setSwitches"; from: number; to: number; value: boolean }
    | { kind: "setVariables"; from: number; to: number; op: "=" | "+=" | "-=" | "*=" | "/=" | "%="; operand: Operand }
    | { kind: "setSelfSwitch"; letter: string; value: boolean }
    | { kind: "changeGold"; delta: Value; sign: 1 | -1 }
    | { kind: "changeItems"; itemKind: ItemKind; id: number; delta: Value; sign: 1 | -1; includeEquip: boolean }
    | { kind: "changeParty"; actorId: number; add: boolean; initialize: boolean }
    | { kind: "transfer"; mapId: Value; x: Value; y: Value; direction: number; fade: number }
    | { kind: "moveRoute"; character: CharacterRef; repeat: boolean; skippable: boolean; wait: boolean; steps: MoveStep[] }
    | { kind: "battle"; troop: Value | { kind: "random" }; canEscape: boolean; canLose: boolean; win?: Op[]; escape?: Op[]; lose?: Op[] }
    | { kind: "shop"; goods: Array<{ itemKind: ItemKind; id: number; price?: number }>; purchaseOnly: boolean }
    | { kind: "changeSkill"; actor: ActorRef; learn: boolean; skillId: number }
    | { kind: "changeState"; actor: ActorRef; add: boolean; stateId: number }
    | { kind: "changeActorValue"; actor: ActorRef; stat: "hp" | "mp" | "tp" | "exp" | "level"; delta: Value; sign: 1 | -1; flag?: boolean }
    | { kind: "changeParam"; actor: ActorRef; param: number; delta: Value; sign: 1 | -1 }
    | { kind: "recoverAll"; actor: ActorRef }
    | { kind: "changeEquipment"; actorId: number; slot: number; itemId: number }
    | { kind: "changeClass"; actorId: number; classId: number; keepExp: boolean }
    | { kind: "changeActorText"; actorId: number; field: "name" | "nickname" | "profile"; value: string }
    | { kind: "enemyCommand"; command: string; enemy: EnemyRef; args: Record<string, unknown> }
    | { kind: "script"; js: string }
    | { kind: "plugin"; plugin: string; command: string; display: string; args: Record<string, unknown> }
    | { kind: "legacyPlugin"; text: string }
    | { kind: "generic"; name: string; args: Record<string, unknown> }
    | { kind: "unknown"; params: unknown[] }
  );

export type OpKind = Op["kind"];

/**
 * Something notable found while decoding.
 * - "gap": the decoder may be wrong or incomplete here (what the coverage report ranks).
 * - "anomaly": unusual data that is nonetheless decoded the way the engine executes it
 *   (e.g. a missing closer: the engine delimits blocks by indentation alone).
 */
export interface Issue {
  severity: "gap" | "anomaly";
  /** Category, e.g. "unknown code 123", "shape 122", "missing 412". */
  key: string;
  index: number;
  detail: string;
}
