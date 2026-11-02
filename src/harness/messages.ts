// Answers messages, choices and input prompts without any windows, following the rules of
// Window_Message / Window_ChoiceList as modified by the auramz `choices` plugin.

export type Button = "ok" | "cancel" | "up" | "down" | "left" | "right" | (string & {});

export interface Press {
  button: Button;
  /** Frames after the previous press, as written in the event (informational only). */
  time?: number;
  duration?: number;
}

/**
 * Scripted button presses, consumed in order by the message driver. Timing is ignored:
 * a press is applied to the next message or choice that needs input.
 */
export class InputQueue {
  private presses: Press[] = [];
  push(...presses: Press[]) {
    this.presses.push(...presses);
  }
  shift(): Press | undefined {
    return this.presses.shift();
  }
  clear() {
    this.presses = [];
  }
  get length() {
    return this.presses.length;
  }
}

export interface ChoiceInfo {
  /** All choice texts, including hidden ones. */
  choices: string[];
  /** Indices of visible choices, in display order. */
  visible: number[];
  /** Whether each choice (by index) is enabled. */
  enabled: boolean[];
  /** Cursor position (index into `visible`) after scripted input ran out, or -1. */
  cursor: number;
  defaultChoice: number;
  cancelChoice: number;
}

/** Decides a choice when scripted input runs out. Returns a choice index (not a visible index). */
export type ChoicePolicy = (info: ChoiceInfo) => number;

/** The cursor's choice if enabled, otherwise the first enabled visible choice. */
export const defaultChoicePolicy: ChoicePolicy = (info) => {
  const atCursor = info.visible[info.cursor];
  if (atCursor !== undefined && info.enabled[atCursor]) return atCursor;
  return info.visible.find((i) => info.enabled[i]) ?? info.visible[0] ?? 0;
};

export type TranscriptEntry =
  | { frame: number; kind: "text"; speaker: string; text: string }
  | { frame: number; kind: "choice"; text: string; choices: string[]; visible: number[]; chosen: number; by: "input" | "policy" }
  | { frame: number; kind: "number"; variableId: number }
  | { frame: number; kind: "item"; variableId: number };

export class MessageDriver {
  readonly transcript: TranscriptEntry[] = [];
  choicePolicy: ChoicePolicy = defaultChoicePolicy;

  private readonly g: any;
  private readonly input: InputQueue;

  constructor(g: any, input: InputQueue) {
    this.g = g;
    this.input = input;
  }

  /** Handles at most one pending message. Call once per frame. */
  update(frame: number) {
    const m = this.g.$gameMessage;
    if (!m.isBusy()) return;
    const text: string = m.allText();
    const speaker: string = m.speakerName?.() ?? "";
    if (m.isChoice()) {
      const chosen = this.answerChoice(m);
      this.transcript.push({ frame, kind: "choice", text, ...chosen });
    } else if (m.isNumberInput()) {
      // Window_NumberInput starts from the variable's value; confirming leaves it unchanged.
      this.transcript.push({ frame, kind: "number", variableId: m.numInputVariableId() });
      this.consumeUntilOk();
    } else if (m.isItemChoice()) {
      this.g.$gameVariables.setValue(m.itemChoiceVariableId(), 0);
      this.transcript.push({ frame, kind: "item", variableId: m.itemChoiceVariableId() });
      this.consumeUntilOk();
    } else {
      this.transcript.push({ frame, kind: "text", speaker, text });
      this.consumeUntilOk();
    }
    // Window_Message.terminateMessage
    m.clear();
  }

  private consumeUntilOk() {
    for (let press = this.input.shift(); press; press = this.input.shift()) {
      if (press.button === "ok") return;
    }
  }

  private answerChoice(m: any) {
    const choices: string[] = m.choices();
    const all = choices.map((_, i) => i);
    const visible = all.filter((i) => (m.isChoiceVisible ? m.isChoiceVisible(i) : true));
    const enabled = all.map((i) => (m.isChoiceEnabled ? !!m.isChoiceEnabled(i) : true));
    const defaultChoice: number = m.choiceDefaultType();
    const cancelChoice: number = m.choiceCancelType();
    const n = visible.length;

    // Window_ChoiceList.selectDefault (choices plugin version)
    let cursor = m.getVisibleChoiceIndex ? m.getVisibleChoiceIndex(defaultChoice) : defaultChoice;
    if (defaultChoice < 0) cursor = -1;

    const finish = (chosen: number, by: "input" | "policy") => {
      m.onChoice(chosen);
      return { choices, visible, chosen, by };
    };

    for (let press = this.input.shift(); press; press = this.input.shift()) {
      // Window_Selectable.cursorDown/cursorUp with wrap (a fresh press is "triggered"), maxCols = 1
      if (press.button === "down" && n > 0) cursor = (cursor + 1) % n;
      else if (press.button === "up" && n > 0) cursor = (cursor - 1 + n) % n;
      else if (press.button === "ok") {
        const choice = visible[cursor];
        if (choice !== undefined && enabled[choice]) return finish(choice, "input");
      } else if (press.button === "cancel") {
        if (cancelChoice !== -1 && (cancelChoice < 0 || enabled[cancelChoice])) return finish(cancelChoice, "input");
      }
    }
    return finish(this.choicePolicy({ choices, visible, enabled, cursor, defaultChoice, cancelChoice }), "policy");
  }
}
