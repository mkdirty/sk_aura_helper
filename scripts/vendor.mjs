#!/usr/bin/env node
// Restores the freely downloadable parts of the game (NW.js runtime, third-party
// JS libraries) that are gitignored rather than committed. Every source in
// vendor.json is pinned by SHA-256 and was verified byte-identical to the
// game's shipped copy.
//
//   node scripts/vendor.mjs install [--force] [--platform linux-x64]
//   node scripts/vendor.mjs check    # installed files match the pinned sources + are gitignored
//   node scripts/vendor.mjs detect   # report the NW.js version the game files contain

import { createHash } from "node:crypto";
import { spawnSync } from "node:child_process";
import { createReadStream, createWriteStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const CACHE = path.join(ROOT, ".cache", "vendor");
const config = JSON.parse(await fs.readFile(path.join(ROOT, "vendor.json"), "utf8"));
const GAME = path.join(ROOT, config.gameDir);

const args = process.argv.slice(2);
const command = args.find((a) => !a.startsWith("--")) ?? "install";
const force = args.includes("--force");
const platformKey = flagValue("--platform") ?? `${process.platform}-${process.arch}`;

function flagValue(name) {
  const i = args.indexOf(name);
  return i === -1 ? undefined : args[i + 1];
}

/** Sources applicable to the selected platform (platform-less sources always apply). */
function sources() {
  const all = config.sources;
  const platformSpecific = all.filter((s) => s.platform);
  if (platformSpecific.length && !platformSpecific.some((s) => s.platform === platformKey)) {
    const known = [...new Set(platformSpecific.map((s) => s.platform))].join(", ");
    throw new Error(`No sources configured for ${platformKey} (known: ${known}). Pass --platform.`);
  }
  return all.filter((s) => !s.platform || s.platform === platformKey);
}

async function sha256File(file) {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
}

async function exists(p) {
  return fs.access(p).then(() => true, () => false);
}

/** Download the archive into the cache (once) and verify its checksum. */
async function fetchArchive({ url, sha256 }) {
  await fs.mkdir(CACHE, { recursive: true });
  const archive = path.join(CACHE, path.basename(new URL(url).pathname));

  if (await exists(archive)) {
    if ((await sha256File(archive)) === sha256) return archive;
    console.warn(`Cached ${path.basename(archive)} failed checksum; re-downloading.`);
    await fs.rm(archive);
  }

  console.log(`Downloading ${url}`);
  const res = await fetch(url);
  if (!res.ok) throw new Error(`Download failed: HTTP ${res.status} ${res.statusText}`);
  const partial = `${archive}.partial`;
  await pipeline(Readable.fromWeb(res.body), createWriteStream(partial));

  const actual = await sha256File(partial);
  if (actual !== sha256) {
    await fs.rm(partial);
    throw new Error(`Checksum mismatch for ${url}\n  expected ${sha256}\n  actual   ${actual}`);
  }
  await fs.rename(partial, archive);
  return archive;
}

function run(cmd, cmdArgs) {
  const r = spawnSync(cmd, cmdArgs, { stdio: ["ignore", "ignore", "inherit"] });
  if (r.error || r.status !== 0) throw new Error(`${cmd} failed (${r.error?.message ?? `exit ${r.status}`})`);
}

/** Extract the archive into a fresh cache directory; returns that directory. */
async function extract(archive, { stripComponents = 0 }) {
  const dir = `${archive}.d`;
  await fs.rm(dir, { recursive: true, force: true });
  await fs.mkdir(dir, { recursive: true });
  if (archive.endsWith(".zip")) {
    if (stripComponents) throw new Error("stripComponents is not supported for .zip sources");
    run("unzip", ["-q", archive, "-d", dir]);
  } else {
    const tarArgs = ["-xf", archive, "-C", dir];
    if (stripComponents) tarArgs.push(`--strip-components=${stripComponents}`);
    run("tar", tarArgs);
  }
  return dir;
}

async function* walk(dir, base = dir) {
  for (const entry of await fs.readdir(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) yield* walk(full, base);
    else if (entry.isFile()) yield path.relative(base, full).split(path.sep).join("/");
  }
}

/** [{ src, dest, rel, source }] for every vendored file, with mappings applied. */
async function vendoredFiles() {
  const files = [];
  for (const source of sources()) {
    const dir = await extract(await fetchArchive(source), source);
    const mapping = [];
    if (source.files === "*") {
      for await (const rel of walk(dir)) mapping.push([rel, source.rename?.[rel] ?? rel]);
    } else {
      mapping.push(...Object.entries(source.files));
    }
    for (const [from, to] of mapping) {
      const src = path.join(dir, from);
      if (!(await exists(src))) throw new Error(`${source.name}: ${from} not found in ${source.url}`);
      files.push({ src, dest: path.join(GAME, to), rel: to, source: source.name });
    }
  }
  return files.sort((a, b) => a.rel.localeCompare(b.rel));
}

async function sameFile(a, b) {
  if (!(await exists(b))) return false;
  const [sa, sb] = await Promise.all([fs.stat(a), fs.stat(b)]);
  if (sa.size !== sb.size) return false;
  return (await sha256File(a)) === (await sha256File(b));
}

async function assertGameDir() {
  if (!(await exists(path.join(GAME, "package.json")))) {
    throw new Error(`${config.gameDir}/package.json not found. Copy the game files into ${GAME} first.`);
  }
}

async function install() {
  await assertGameDir();
  const counts = {};
  for (const { src, dest, source } of await vendoredFiles()) {
    const c = (counts[source] ??= { installed: 0, current: 0 });
    if (!force && (await sameFile(src, dest))) {
      c.current++;
      continue;
    }
    await fs.mkdir(path.dirname(dest), { recursive: true });
    await fs.copyFile(src, dest);
    await fs.chmod(dest, (await fs.stat(src)).mode);
    c.installed++;
  }
  for (const s of sources()) {
    const c = counts[s.name];
    console.log(`${s.name} ${s.version}: ${c.installed} installed, ${c.current} already up to date.`);
  }
}

async function check() {
  await assertGameDir();
  const files = await vendoredFiles();
  const drift = [];
  for (const { src, dest, rel, source } of files) {
    if (!(await sameFile(src, dest))) drift.push(`${rel} (${source})`);
  }

  // Every vendored file must be gitignored by the game repository so it can never be committed.
  const problems = [];
  const toplevel = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd: GAME, encoding: "utf8" });
  const gameRepo = toplevel.status === 0 ? path.resolve(toplevel.stdout.trim()) : null;
  if (gameRepo !== (await fs.realpath(GAME))) {
    problems.push(`${config.gameDir}/ is not its own git repository (clone the game repo there, or \`git init\` it).`);
  } else {
    const relPaths = files.map((f) => f.rel);
    const git = spawnSync("git", ["check-ignore", "--no-index", "--stdin"], {
      cwd: GAME,
      input: relPaths.join("\n"),
      encoding: "utf8",
    });
    if (git.status > 1 || git.error) throw new Error(`git check-ignore failed: ${git.stderr || git.error?.message}`);
    const ignored = new Set(git.stdout.split("\n").filter(Boolean));
    const unignored = relPaths.filter((p) => !ignored.has(p));
    if (unignored.length) problems.push(`Not ignored by ${config.gameDir}/.gitignore:\n  ${unignored.join("\n  ")}`);
  }

  if (drift.length) problems.unshift(`Differs from pinned sources:\n  ${drift.join("\n  ")}`);
  if (problems.length) {
    console.log(problems.join("\n"));
    process.exit(1);
  }
  const names = sources().map((s) => `${s.name} ${s.version}`).join(", ");
  console.log(`OK: ${files.length} vendored files match (${names}) and are gitignored.`);
}

async function detect() {
  const pinned = config.sources.find((s) => s.name === "nwjs")?.version;
  // NW.js embeds `process.versions['nw'] = 'X.Y.Z'` in libnw.so (nw.dll on Windows).
  const candidates = ["lib/libnw.so", "nw.dll", "nwjs Framework.framework/nwjs Framework"];
  for (const rel of candidates) {
    const file = path.join(GAME, rel);
    if (!(await exists(file))) continue;
    const text = (await fs.readFile(file)).toString("latin1");
    const nw = text.match(/process\.versions\['nw'\] = '([\d.]+)'/)?.[1];
    if (!nw) continue;
    console.log(`Detected NW.js ${nw} in ${config.gameDir}/${rel}`);
    if (nw !== pinned) {
      console.log(`vendor.json pins ${pinned} -- update the nwjs source (url, sha256 from https://dl.nwjs.io/v${nw}/SHASUMS256.txt).`);
      process.exit(1);
    }
    console.log("Matches vendor.json.");
    return;
  }
  throw new Error(`No NW.js library found in ${config.gameDir} (looked for ${candidates.join(", ")}).`);
}

const commands = { install, check, detect };
if (!commands[command]) {
  console.error(`Unknown command "${command}". Use one of: ${Object.keys(commands).join(", ")}.`);
  process.exit(2);
}
try {
  await commands[command]();
} catch (err) {
  console.error(`Error: ${err.message}`);
  process.exit(1);
}
