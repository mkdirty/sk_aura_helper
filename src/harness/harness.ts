import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import { inspect } from "node:util";
import vm from "node:vm";
import { gameDir as defaultGameDir } from "../paths.ts";
import { createDom, createFakeTimers, inert, seededRandom } from "./browser.ts";
import { InputQueue, MessageDriver, type TranscriptEntry } from "./messages.ts";
import { createSandboxFs, type BlockedWrite } from "./sandbox-fs.ts";
import { ChangeTracker } from "./tracker.ts";
import { createXhrClass } from "./xhr.ts";

export interface HarnessOptions {
  /** Game directory (defaults to `gameDir()`). */
  gameDir?: string;
  /** Seed for the game's `Math.random` (default 1). */
  seed?: number;
  /**
   * Directory to read saves, config and global info from (never written). Default: none,
   * i.e. a fresh profile, so results don't depend on whoever runs the harness.
   */
  saveDir?: string;
  /** Echo the game's console output to stderr (it is always recorded in `logs`). */
  echoConsole?: boolean;
}

export interface LoadFailure {
  file: string;
  error: string;
}

// Errors from the game come from the context's realm, so `instanceof Error` won't match.
const formatLogArg = (a: unknown) =>
  typeof a === "string" ? a : a && typeof a === "object" && "stack" in a ? String((a as Error).stack) : inspect(a);

/** Why a run of frames ended. */
export type StopReason =
  | "completed" // the work finished
  | "idle" // nothing has run for a while (event tests)
  | "maxFrames"
  | { scene: string }; // the game asked for a scene the harness doesn't emulate (battle, menu, …)

export interface RunResult {
  frames: number;
  stop: StopReason;
}

// Engine scripts with no headless role (audio decoding, particle effects). They spin up
// workers / WASM asynchronously, so they are skipped rather than stubbed.
const SKIPPED_SCRIPTS = new Set(["js/libs/vorbisdecoder.js", "js/libs/effekseer.min.js"]);

class SceneRequest extends Error {
  readonly scene: string;
  constructor(scene: string) {
    super(`scene requested: ${scene}`);
    this.scene = scene;
  }
}

/**
 * The game engine running headless in a Node `vm` context.
 *
 * Boot goes through the game's own code: the script list from `js/main.js`,
 * `PluginManager.setup($plugins)`, and `DataManager.loadDatabase()`. Rendering and audio are
 * inert; file writes are swallowed (see `blockedWrites`); `Math.random` is seeded; timers
 * never fire. The harness owns the frame loop and answers messages via `MessageDriver`.
 */
export class Harness {
  readonly gameDir: string;
  readonly context: vm.Context;
  /** The context's global object, untyped: everything in it is game code. */
  readonly g: any;
  readonly failures: LoadFailure[] = [];
  readonly blockedWrites: BlockedWrite[] = [];
  readonly requests: string[] = [];
  readonly sceneRequests: string[] = [];
  /** The game's console output. */
  readonly logs: Array<{ level: string; text: string }> = [];
  /** Maps the player has been transferred to, in order (map 0 included). */
  readonly visitedMaps: number[] = [];
  /** Frames at which the game requested an autosave (not performed). */
  readonly autosaves: number[] = [];
  /** Image URLs the game asked for (bitmaps load instantly, empty). */
  readonly images: string[] = [];
  readonly input = new InputQueue();
  readonly tracker: ChangeTracker;
  readonly messages: MessageDriver;
  private frameCount = 0;

  /** Loads the engine, plugins and database. */
  static async boot(options: HarnessOptions = {}): Promise<Harness> {
    const harness = new Harness(options);
    await harness.runBootScene(options.saveDir);
    return harness;
  }

  private constructor(options: HarnessOptions) {
    this.gameDir = options.gameDir ?? defaultGameDir();
    const timers = createFakeTimers();
    const dom = createDom((src) => this.loadScript(src));
    const sandboxFs = createSandboxFs(this.gameDir, this.blockedWrites);
    const gameRequire = createRequire(path.join(this.gameDir, "index.html"));
    const require = (id: string) => {
      const name = id.replace(/^node:/, "");
      if (name === "fs") return sandboxFs;
      if (name === "fs/promises") return sandboxFs.promises;
      if (name === "child_process" || id.includes("greenworks")) throw new Error(`${id} is unavailable in the harness`);
      if (name === "nw.gui") return inert();
      return gameRequire(id);
    };
    // In NW.js the working directory and main module are the game dir; StorageManager
    // derives the save directory from the main module's location.
    const proc = Object.create(process, {
      mainModule: { value: { filename: path.join(this.gameDir, "index.html") } },
      cwd: { value: () => this.gameDir },
    });
    const storage = new Map<string, string>();
    const echo = new console.Console({ stdout: process.stderr, stderr: process.stderr });
    const gameConsole = Object.fromEntries(
      ["log", "info", "warn", "error", "debug", "trace"].map((level) => [
        level,
        (...args: unknown[]) => {
          this.logs.push({ level, text: args.map(formatLogArg).join(" ") });
          if (options.echoConsole) (echo as any)[level](...args);
        },
      ]),
    );

    const globals: Record<string, unknown> = {
      ...timers,
      ...dom,
      console: { ...console, ...gameConsole },
      require,
      process: proc,
      Buffer,
      Blob,
      URL,
      TextDecoder,
      TextEncoder,
      atob,
      btoa,
      performance,
      XMLHttpRequest: createXhrClass(this.gameDir, this.requests),
      navigator: { userAgent: "Node.js harness", platform: "linux", language: "en", languages: ["en"] },
      location: { search: "", href: "file://" + path.join(this.gameDir, "index.html"), hostname: "" },
      localStorage: {
        getItem: (k: string) => storage.get(k) ?? null,
        setItem: (k: string, v: string) => void storage.set(k, String(v)),
        removeItem: (k: string) => void storage.delete(k),
      },
      Image: dom.HTMLImageElement,
      Audio: dom.HTMLAudioElement,
      FontFace: class {
        load() {
          return Promise.resolve(this);
        }
      },
      WebGLRenderingContext: class {},
      AudioContext: undefined,
      addEventListener: () => {},
      removeEventListener: () => {},
      nw: { App: { argv: [], dataPath: path.join(this.gameDir, ".harness-nw-data"), quit() {} }, Window: { get: () => inert() } },
    };
    // The context gets its own microtask queue, drained explicitly (see `drain`), so the
    // game's promises settle deterministically without making the frame loop async.
    this.context = vm.createContext(globals, { microtaskMode: "afterEvaluate" });
    this.g = vm.runInContext("globalThis", this.context);
    this.g.window = this.g;
    this.g.self = this.g;
    const random = seededRandom(options.seed ?? 1);
    this.g.Math.random = random;

    this.loadMainScripts();
    this.g.PluginManager.setup(this.g.$plugins);
    this.hookScenes();
    this.stubBitmapLoading();

    this.tracker = new ChangeTracker(this.g, () => this.frameCount);
    this.messages = new MessageDriver(this.g, this.input);
  }

  /** Runs the game's pending promise callbacks. */
  drain() {
    vm.runInContext("undefined", this.context);
  }

  /** Evaluates code in the game context. */
  eval<T = unknown>(code: string): T {
    return vm.runInContext(code, this.context) as T;
  }

  get transcript(): TranscriptEntry[] {
    return this.messages.transcript;
  }

  /** Runs a script file from the game dir in the context, recording (not throwing) errors. */
  private loadScript(src: string): boolean {
    const file = src.replace(/^file:\/\//, "");
    const rel = path.isAbsolute(file) ? path.relative(this.gameDir, file) : file;
    try {
      const code = fs.readFileSync(path.join(this.gameDir, rel), "utf8");
      this.g.document.currentScript = { src: rel };
      vm.runInContext(code, this.context, { filename: rel });
      return true;
    } catch (e) {
      this.failures.push({ file: rel, error: String(e instanceof Error ? e.message : e) });
      return false;
    }
  }

  /** Loads the engine scripts in the order `js/main.js` lists them. */
  private loadMainScripts() {
    const main = fs.readFileSync(path.join(this.gameDir, "js/main.js"), "utf8");
    const list = /const scriptUrls\s*=\s*\[([\s\S]*?)\];/.exec(main);
    if (!list) throw new Error("could not find scriptUrls in js/main.js");
    const urls = [...list[1].matchAll(/"([^"]+)"/g)].map((m) => m[1]);
    for (const url of urls) if (!SKIPPED_SCRIPTS.has(url)) this.loadScript(url);
    for (const required of ["js/rmmz_core.js", "js/rmmz_managers.js", "js/rmmz_objects.js", "js/plugins.js"]) {
      const failure = this.failures.find((f) => f.file === required);
      if (failure) throw new Error(`failed to load ${required}: ${failure.error}`);
    }
  }

  /**
   * Runs the real Scene_Boot lifecycle (create → isReady polling → start), so every plugin
   * hook on it runs: database loading (promise-based; the mod loader goes first), template
   * events, notetag processing, player data. `start` ends by asking for the title scene,
   * which is where boot stops.
   */
  private async runBootScene(saveDir: string | undefined) {
    const { Scene_Boot, StorageManager } = this.g;
    // Read player data from `saveDir`, or from an empty profile.
    const dir = saveDir ? path.resolve(saveDir) : path.join(this.gameDir, ".harness-empty-profile");
    StorageManager.fileDirectoryPath = () => dir + path.sep;

    // SceneManager.initialize's input setup (listeners attach to the inert document).
    this.g.Input.initialize();
    this.g.TouchInput.initialize();

    const boot = new Scene_Boot();
    boot.create();
    await this.waitFor(() => boot.isReady(), "boot scene");
    try {
      boot.start();
    } catch (e) {
      if (!(e instanceof SceneRequest)) throw e;
    }
    this.sceneRequests.length = 0;

    // Plugins reach for the live scene. A Scene_Map that was never created (no windows or
    // sprites) stands in for it; autosaves are recorded instead of written.
    const { Scene_Base, Scene_Map, SceneManager } = this.g;
    Scene_Base.prototype.executeAutosave = () => void this.autosaves.push(this.frameCount);
    SceneManager._scene = new Scene_Map();
  }

  /** Polls `ready` across event-loop turns, letting the game's promises and I/O settle. */
  private async waitFor(ready: () => boolean, what: string) {
    for (let tick = 0; (this.drain(), !ready()); tick++) {
      if (tick > 1000) throw new Error(`${what} did not load`);
      await new Promise((resolve) => setImmediate(resolve));
    }
  }

  /** Bitmaps never fetch or decode: they're ready immediately, with no pixels. */
  private stubBitmapLoading() {
    const images = this.images;
    const load = function (this: any) {
      images.push(this._url);
      this._loadingState = "loaded";
    };
    this.g.Bitmap.prototype._startLoading = load;
    this.g.Bitmap.prototype._startDecrypting = load;
  }

  /** Scene changes can't happen headless: record them and stop the current run. */
  private hookScenes() {
    const { SceneManager } = this.g;
    const intercept = (Scene: { name?: string } | null) => {
      const name = Scene?.name ?? String(Scene);
      this.sceneRequests.push(name);
      throw new SceneRequest(name);
    };
    SceneManager.push = intercept;
    SceneManager.goto = intercept;
  }

  /**
   * Fresh game state, as "New Game" does. The player is placed on the start map, or at
   * `at` instead. Map 0 is the engine's empty map (no events), useful for running common
   * events in isolation.
   */
  newGame(at?: { mapId: number; x?: number; y?: number }) {
    // setupNewGame replaces every $game* object, so look them up afterwards.
    this.g.DataManager.setupNewGame();
    if (at) this.g.$gamePlayer.reserveTransfer(at.mapId, at.x ?? 0, at.y ?? 0, 2, 0);
    this.performTransfer();
  }

  /** Moves the player to a map immediately. */
  transfer(mapId: number, x = 0, y = 0) {
    this.g.$gamePlayer.reserveTransfer(mapId, x, y, 2, 0);
    this.performTransfer();
  }

  /** What Scene_Map does when the player is transferring. */
  private performTransfer() {
    const { $gamePlayer, DataManager } = this.g;
    if (!$gamePlayer.isTransferring()) return;
    const mapId = $gamePlayer.newMapId();
    DataManager.loadMapData(mapId);
    this.drain();
    if (!DataManager.isMapLoaded()) throw new Error(`map ${mapId} did not load`);
    if (mapId === 0) {
      // makeEmptyMap leaves out fields Game_Map.setup reads, and a fresh Game_Map already
      // reports id 0, so force the setup.
      Object.assign(this.g.$dataMap, { tilesetId: 1, encounterList: [], parallaxName: "", note: "", meta: {} });
      $gamePlayer.requestMapReload();
    }
    $gamePlayer.performTransfer();
    this.visitedMaps.push(mapId);
  }

  /** One frame of Scene_Map.updateMain, then message handling and transfers. */
  frame() {
    const { $gameMap, $gamePlayer, $gameTimer, $gameScreen, Graphics, Input, TouchInput } = this.g;
    this.frameCount++;
    Graphics.frameCount++;
    Input.update();
    TouchInput.update();
    $gameMap.update(true);
    $gamePlayer.update(true);
    $gameTimer.update(true);
    $gameScreen.update();
    this.finishEffects();
    this.messages.update(this.frameCount);
    this.drain();
    this.performTransfer();
  }

  /** Animations and balloons end as soon as they're requested (sprites would end them). */
  private finishEffects() {
    const { $gameTemp } = this.g;
    for (let r = $gameTemp.retrieveAnimation(); r; r = $gameTemp.retrieveAnimation()) {
      for (const target of r.targets) target.endAnimation?.();
    }
    for (let r = $gameTemp.retrieveBalloon(); r; r = $gameTemp.retrieveBalloon()) {
      r.target.endBalloon?.();
    }
  }

  /**
   * Runs a common event on the map interpreter (so plugins that look up "the current
   * interpreter" find it) inside full map frames: characters move, parallel events tick,
   * and no other event can start until it finishes, as in the game.
   */
  runCommonEvent(id: number, maxFrames = 100_000): RunResult {
    const { $dataCommonEvents, $gameMap } = this.g;
    const ce = $dataCommonEvents[id];
    if (!ce) throw new Error(`no common event ${id}`);
    const interpreter = $gameMap._interpreter;
    if (interpreter.isRunning()) throw new Error("the map interpreter is busy");
    interpreter.setup(ce.list, 0);
    // Done when the interpreter leaves this list (another event may start in the same frame).
    const list = interpreter._list;
    return this.runUntil(() => interpreter._list !== list, maxFrames, () => this.frame());
  }

  /**
   * Moves to `mapId` and runs one page of one of its events on the map interpreter, as if the
   * event had started (page conditions and trigger are not checked). The player stands just
   * below the event.
   */
  runEventPage(mapId: number, eventId: number, page: number, maxFrames = 100_000): RunResult {
    this.transfer(mapId, 0, 0);
    const { $gameMap, $gamePlayer } = this.g;
    const event = $gameMap.event(eventId);
    if (!event) throw new Error(`no event ${eventId} on map ${mapId}`);
    const list = event.event().pages[page]?.list;
    if (!list) throw new Error(`no page ${page} on map ${mapId} event ${eventId}`);
    $gamePlayer.locate(event.x, event.y + 1);
    const interpreter = $gameMap._interpreter;
    if (interpreter.isRunning()) throw new Error("the map interpreter is busy");
    interpreter.setup(list, eventId);
    const running = interpreter._list;
    return this.runUntil(() => interpreter._list !== running, maxFrames, () => this.frame());
  }

  /** Runs full map frames until no event has been running for `idleFrames` frames. */
  runUntilIdle(idleFrames = 120, maxFrames = 200_000): RunResult {
    let idle = 0;
    const result = this.runUntil(
      () => {
        const { $gameMap, $gameMessage, $gamePlayer, $gameTemp } = this.g;
        const busy =
          $gameMap.isEventRunning() || $gameMessage.isBusy() || $gamePlayer.isTransferring() || $gameTemp.isCommonEventReserved();
        idle = busy ? 0 : idle + 1;
        return idle >= idleFrames;
      },
      maxFrames,
      () => this.frame(),
    );
    return result.stop === "completed" ? { ...result, stop: "idle" } : result;
  }

  private runUntil(done: () => boolean, maxFrames: number, step: () => void): RunResult {
    let frames = 0;
    try {
      while (!done()) {
        if (frames >= maxFrames) return { frames, stop: "maxFrames" };
        step();
        frames++;
      }
    } catch (e) {
      if (e instanceof SceneRequest) return { frames, stop: { scene: e.scene } };
      throw e;
    }
    return { frames, stop: "completed" };
  }

  /** Name lookups for display. */
  switchName(id: number): string {
    return this.g.$dataSystem.switches[id] ?? "";
  }
  variableName(id: number): string {
    return this.g.$dataSystem.variables[id] ?? "";
  }
}
