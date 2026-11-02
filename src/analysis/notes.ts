// Database note tags (`<key:value>` / `<key>`), parsed as the engine does.

/** DataManager.extractMetadata: `<key:value>` → "value", `<key>` → true. */
export function noteMeta(note: string): Record<string, string | true> {
  const meta: Record<string, string | true> = {};
  for (const m of note.matchAll(/<([^<>:]+)(:?)([^>]*)>/g)) meta[m[1]] = m[2] === ":" ? m[3] : true;
  return meta;
}
