// Human-readable rendering of harness results.

import type { EventTestRun } from "./event-test.ts";
import type { StopReason } from "./harness.ts";
import type { TranscriptEntry } from "./messages.ts";
import type { Change } from "./tracker.ts";

const value = (v: unknown) => (typeof v === "string" ? JSON.stringify(v) : JSON.stringify(v) ?? String(v));
const label = (prefix: string, id: number, name: string) => `${prefix}${id}${name ? ` ${name}` : ""}`;

export function formatChange(c: Change): string {
  switch (c.kind) {
    case "switch":
      return `${label("S", c.id, c.name)}: ${c.before} → ${c.after}`;
    case "variable":
      return `${label("V", c.id, c.name)}: ${value(c.before)} → ${value(c.after)}`;
    case "selfSwitch": {
      const [mapId, eventId, letter] = c.key;
      return `self switch ${letter} of Map${String(mapId).padStart(3, "0")}/E${eventId}: ${c.before} → ${c.after}`;
    }
    case "item":
    case "weapon":
    case "armor":
      return `${c.kind} ${c.id} ${c.name}: ${c.before} → ${c.after}`;
    case "gold":
      return `gold: ${c.before} → ${c.after}`;
  }
}

export function formatStop(stop: StopReason): string {
  if (typeof stop === "string") return stop;
  return `stopped: the game asked for ${stop.scene}, which the harness doesn't emulate`;
}

export function formatTranscript(t: TranscriptEntry): string {
  const oneLine = (s: string) => s.replace(/\n/g, " / ");
  switch (t.kind) {
    case "text":
      return `${t.speaker ? `${t.speaker}: ` : ""}${oneLine(t.text)}`;
    case "choice": {
      const options = t.visible.map((i) => (i === t.chosen ? `[${t.choices[i]}]` : t.choices[i])).join(" | ");
      return `${t.text ? `${oneLine(t.text)} ` : ""}choice: ${options} (by ${t.by})`;
    }
    case "number":
      return `number input → V${t.variableId}`;
    case "item":
      return `item choice → V${t.variableId}`;
  }
}

export function formatEventTests(run: EventTestRun): string[] {
  const lines = [`Map${String(run.mapId).padStart(3, "0")}: ${run.frames} frames, ${formatStop(run.stop)}`];
  for (const r of run.results) {
    lines.push(`  ${r.status.padEnd(10)} ${r.name} (Map${String(r.mapId).padStart(3, "0")}/E${r.eventId})`);
    for (const a of r.assertions) if (!a.ok) lines.push(`      ✗ ${a.description}: ${a.detail}`);
  }
  return lines;
}
