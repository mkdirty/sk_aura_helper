// Minimal stand-ins for the browser / NW.js environment the game expects. Rendering,
// audio and input devices are absent: anything graphical resolves to an inert proxy.

const noop = () => {};

/** An object where every property access and call returns another inert proxy. */
export function inert(): any {
  return new Proxy(function () {}, {
    get: (_t, key) => (key === Symbol.toPrimitive ? () => 0 : key === "then" ? undefined : inert()),
    apply: () => inert(),
    construct: () => inert(),
  });
}

/** Called for `<script>` elements appended to the document (the engine's plugin loader). */
export type ScriptLoader = (src: string) => void;

export function createDom(loadScript: ScriptLoader) {
  class HTMLElement {
    style: Record<string, unknown> = {};
    classList = { add: noop, remove: noop, contains: () => false };
    children: HTMLElement[] = [];
    width = 0;
    height = 0;
    id = "";
    tagName: string;
    onload: ((ev?: unknown) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    protected _src = "";
    constructor(tagName = "div") {
      this.tagName = tagName;
    }
    get src() {
      return this._src;
    }
    set src(value: string) {
      this._src = value;
    }
    appendChild(child: HTMLElement) {
      if (child.tagName === "script" && child.src) {
        loadScript(child.src);
        child.onload?.({ target: child });
      } else {
        this.children.push(child);
      }
      return child;
    }
    removeChild(child: HTMLElement) {
      this.children = this.children.filter((c) => c !== child);
      return child;
    }
    getContext() {
      return inert();
    }
    addEventListener(_type: string, _fn: () => void) {}
    removeEventListener(_type: string, _fn: () => void) {}
    setAttribute(_name: string, _value: string) {}
    getBoundingClientRect() {
      return { left: 0, top: 0, width: 0, height: 0 };
    }
    focus = noop;
  }
  class HTMLCanvasElement extends HTMLElement {}
  /** Images "load" as soon as `src` is set, with no pixels. */
  class HTMLImageElement extends HTMLElement {
    naturalWidth = 0;
    naturalHeight = 0;
    complete = false;
    private listeners: Array<() => void> = [];
    constructor(tag = "img") {
      super(tag);
    }
    get src() {
      return this._src;
    }
    set src(value: string) {
      this._src = value;
      if (!value) return;
      this.complete = true;
      this.onload?.({ target: this });
      for (const fn of this.listeners) fn();
    }
    addEventListener(type: string, fn: () => void) {
      if (type === "load") this.listeners.push(fn);
    }
    decode() {
      return Promise.resolve();
    }
  }
  class HTMLVideoElement extends HTMLElement {}
  class HTMLAudioElement extends HTMLElement {}

  const create = (tag: string) => {
    if (tag === "canvas") return new HTMLCanvasElement(tag);
    if (tag === "img") return new HTMLImageElement(tag);
    if (tag === "video") return new HTMLVideoElement(tag);
    return new HTMLElement(tag);
  };

  const document = {
    body: create("body"),
    head: create("head"),
    documentElement: create("html"),
    currentScript: { src: "" },
    createElement: create,
    getElementById: () => null,
    querySelector: () => null,
    querySelectorAll: () => [],
    addEventListener: noop,
    removeEventListener: noop,
    fonts: { add: noop },
    hidden: false,
  };

  return { document, HTMLElement, HTMLCanvasElement, HTMLImageElement, HTMLVideoElement, HTMLAudioElement };
}

/** Timers that never fire on their own: the harness owns the clock. */
export function createFakeTimers() {
  const pending = new Map<number, () => void>();
  let next = 1;
  const add = (fn: unknown) => {
    const id = next++;
    if (typeof fn === "function") pending.set(id, fn as () => void);
    return id;
  };
  const clear = (id: number) => void pending.delete(id);
  return {
    pending,
    setTimeout: add,
    setInterval: add,
    clearTimeout: clear,
    clearInterval: clear,
    requestAnimationFrame: add,
    cancelAnimationFrame: clear,
  };
}

/** mulberry32: small, fast, seedable PRNG. */
export function seededRandom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
