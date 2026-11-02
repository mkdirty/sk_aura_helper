import fs from "node:fs";
import path from "node:path";

/**
 * Builds an `XMLHttpRequest` class that serves relative URLs from the game directory.
 *
 * Requests complete synchronously inside `send()`, so the engine's async loaders
 * (`DataManager.loadDatabase`, `loadMapData`, plugin data files) are done as soon as
 * they return. Absolute URLs (http:, data:, blob:, …) fail: the harness has no network.
 */
export function createXhrClass(gameDir: string, requested: string[]) {
  return class FsXMLHttpRequest {
    status = 0;
    readyState = 0;
    responseType = "";
    response: unknown = null;
    responseText = "";
    onload: ((ev?: unknown) => void) | null = null;
    onerror: ((ev?: unknown) => void) | null = null;
    private url = "";

    open(_method: string, url: string) {
      this.url = url;
      this.readyState = 1;
    }
    overrideMimeType() {}
    setRequestHeader() {}
    addEventListener(type: string, fn: () => void) {
      if (type === "load") this.onload = fn;
      if (type === "error") this.onerror = fn;
    }

    send() {
      requested.push(this.url);
      const file = resolveGameUrl(gameDir, this.url);
      let data: Buffer | undefined;
      try {
        if (file) data = fs.readFileSync(file);
      } catch {
        // missing file: falls through to 404
      }
      this.readyState = 4;
      if (!data) {
        this.status = 404;
        this.onerror?.({ target: this });
        return;
      }
      this.status = 200;
      if (this.responseType === "arraybuffer") {
        this.response = data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
      } else {
        this.responseText = data.toString("utf8");
        this.response = this.responseType === "json" ? JSON.parse(this.responseText) : this.responseText;
      }
      this.onload?.({ target: this });
    }
  };
}

/** Maps a game-relative URL to a file inside the game dir, or undefined if it isn't one. */
export function resolveGameUrl(gameDir: string, url: string): string | undefined {
  let rel = url;
  if (rel.startsWith("file://")) rel = new URL(rel).pathname;
  else if (/^[a-z][a-z0-9+.-]*:/i.test(rel)) return undefined;
  rel = decodeURIComponent(rel.split(/[?#]/)[0]);
  const file = path.isAbsolute(rel) ? path.normalize(rel) : path.join(gameDir, rel);
  const inside = path.relative(gameDir, file);
  if (inside.startsWith("..") || path.isAbsolute(inside)) return undefined;
  return file;
}
