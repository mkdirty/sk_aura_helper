import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/** Repository root. */
export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

/**
 * The game directory: `$SKA_GAME_DIR` if set, otherwise `gameDir` from vendor.json
 * (relative to the repository root).
 */
export function gameDir(): string {
  if (process.env.SKA_GAME_DIR) return path.resolve(process.env.SKA_GAME_DIR);
  const config = JSON.parse(fs.readFileSync(path.join(ROOT, "vendor.json"), "utf8"));
  return path.join(ROOT, config.gameDir);
}
