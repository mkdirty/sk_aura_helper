import fs from "node:fs";
import path from "node:path";

/** A filesystem write the game attempted and the sandbox swallowed. */
export interface BlockedWrite {
  op: string;
  path: string;
}

// Anything that creates, changes or removes files. Reads pass through untouched.
const WRITE_OPS = new Set([
  "writeFile", "writeFileSync", "appendFile", "appendFileSync",
  "mkdir", "mkdirSync", "mkdtemp", "mkdtempSync",
  "rm", "rmSync", "rmdir", "rmdirSync", "unlink", "unlinkSync",
  "rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync",
  "symlink", "symlinkSync", "link", "linkSync",
  "truncate", "truncateSync", "ftruncate", "ftruncateSync",
  "chmod", "chmodSync", "chown", "chownSync", "utimes", "utimesSync",
  "createWriteStream",
]);

// Operations whose first two arguments are both paths.
const TWO_PATHS = new Set(["rename", "renameSync", "copyFile", "copyFileSync", "cp", "cpSync", "symlink", "symlinkSync", "link", "linkSync"]);

/**
 * A read-only view of `node:fs` for game code.
 *
 * - Relative paths resolve against `cwd` (the game dir), as they do in NW.js.
 * - Write operations become no-ops and are recorded instead, so the harness never touches
 *   saves, exports or config in the game dir.
 * - Directories the game tried to create look like empty, existing directories afterwards,
 *   so code that does "mkdir if missing, then readdir" keeps working.
 */
export function createSandboxFs(cwd: string, blocked: BlockedWrite[]): typeof fs {
  const virtualDirs = new Set<string>();
  const resolve = (p: unknown) => (typeof p === "string" ? path.resolve(cwd, p) : p);

  const wrap = <T extends object>(target: T, prefix: string): T =>
    new Proxy(target, {
      get(obj, key, receiver) {
        const value = Reflect.get(obj, key, receiver);
        if (typeof key !== "string") return value;
        if (key === "promises" && prefix === "") return wrap(fs.promises, "promises.");
        if (typeof value !== "function" || /^[A-Z]/.test(key)) return value;

        if (WRITE_OPS.has(key)) {
          return (...args: unknown[]) => {
            const target = String(resolve(args[0]));
            blocked.push({ op: prefix + key, path: target });
            if (key.startsWith("mkdir")) virtualDirs.add(target);
            const callback = args.at(-1);
            if (typeof callback === "function") callback(null);
            return prefix === "promises." ? Promise.resolve() : undefined;
          };
        }
        return (...args: unknown[]) => {
          args[0] = resolve(args[0]);
          if (TWO_PATHS.has(key)) args[1] = resolve(args[1]);
          const p = args[0];
          if (typeof p === "string" && virtualDirs.has(p) && !fs.existsSync(p)) {
            if (key === "existsSync") return true;
            if (key === "readdirSync") return [];
          }
          return (value as (...a: unknown[]) => unknown).apply(obj, args);
        };
      },
    });
  return wrap(fs, "");
}
