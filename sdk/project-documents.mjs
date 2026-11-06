import { hostedRequest } from "./hosted-client.mjs";
import { ProjectStore } from "./record-store-core.mjs";
const encode = (value) =>
  typeof value === "string" ? new TextEncoder().encode(value) : value;
const base64 = (bytes) => {
  let value = "";
  for (let at = 0; at < bytes.length; at += 8192)
    value += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(value);
};
const decode = (value) =>
  Uint8Array.from(atob(value), (char) => char.charCodeAt(0));
async function digest(bytes) {
  return [...new Uint8Array(await crypto.subtle.digest("SHA-256", bytes))]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");
}
class ProjectDocuments {
  constructor(scope) {
    this.scope = scope;
    this.tree = scope.rootIdentity;
  }
  invoke(method, args = {}) {
    return hostedRequest("files." + method, {
      ...args,
      session: this.scope.session,
    });
  }
  stat(path, hash = true) {
    return this.invoke("stat", { path, hash });
  }
  async read(path, maximum = 32 * 1048576) {
    let info;
    if (maximum <= 1048576) {
      info = await this.invoke("readFile", { path, maximum });
      if (!info.exists) return null;
      if (info.base64 !== undefined) {
        const bytes = decode(info.base64);
        if (
          bytes.length !== info.bytes ||
          bytes.length > maximum ||
          (await digest(bytes)) !== info.version
        )
          throw new Error("Shared file failed its byte/hash check.");
        return { bytes, version: info.version };
      }
    } else info = await this.stat(path);
    if (!info.exists) return null;
    if (info.directory || info.bytes > maximum)
      throw new Error("Shared file exceeds its read budget.");
    const chunks = [];
    let offset = 0;
    const { reader } = await this.invoke("openRead", { path });
    try {
      while (offset < info.bytes) {
        const result = await this.invoke("readNext", {
            reader,
            offset,
            limit: 262144,
          }),
          bytes = decode(result.base64);
        if (!bytes.length || offset + bytes.length > info.bytes)
          throw new Error("Shared file changed during reading.");
        chunks.push(bytes);
        offset += bytes.length;
      }
    } finally {
      await this.invoke("closeRead", { reader }).catch(() => {});
    }
    const bytes = new Uint8Array(offset);
    let at = 0;
    for (const chunk of chunks) {
      bytes.set(chunk, at);
      at += chunk.length;
    }
    if ((await digest(bytes)) !== info.version)
      throw new Error("Shared file changed during reading.");
    return { bytes, version: info.version };
  }
  async json(path, maximum = 1048576) {
    const record = await this.read(path, maximum);
    return (
      record && {
        value: JSON.parse(new TextDecoder().decode(record.bytes)),
        version: record.version,
      }
    );
  }
  async write(path, value, expected = null) {
    const bytes = encode(value),
      { transfer } = await this.invoke("beginWrite", {
        path,
        bytes: bytes.length,
        expected,
      });
    try {
      for (let offset = 0; offset < bytes.length; offset += 65536)
        await this.invoke("chunk", {
          transfer,
          offset,
          base64: base64(bytes.subarray(offset, offset + 65536)),
        });
      return await this.invoke("commit", { transfer });
    } catch (error) {
      await this.invoke("cancel", { transfer }).catch(() => {});
      throw error;
    }
  }
  end() {
    return hostedRequest("files.end", { session: this.scope.session });
  }
}
class BrowserRecords {
  constructor() {
    this.sessions = new Set();
    this.running = 0;
    this.waiters = [];
    this.core = new ProjectStore({
      project: async () => {
        const scope = this.initialScope || (await hostedRequest("files.begin"));
        this.initialScope = null;
        const io = new ProjectDocuments(scope);
        this.sessions.add(io);
        return { io };
      },
    });
  }
  async invoke(method, args) {
    if (this.running >= 1) {
      if (this.waiters.length >= 64)
        throw new Error(
          "Too many queued storage actions. Wait for the current view to finish.",
        );
      await new Promise((resolve) => this.waiters.push(resolve));
    } else this.running++;
    try {
      return await this.execute(method, args);
    } finally {
      const next = this.waiters.shift();
      if (next) next();
      else this.running--;
    }
  }
  async execute(method, args) {
    if (!this.init)
      this.init = hostedRequest("files.begin")
        .then((scope) => {
          this.appId = scope.appId;
          this.initialScope = scope;
        })
        .catch((error) => {
          this.init = null;
          throw error;
        });
    await this.init;
    const started = performance.now();
    try {
      return await this.core.invoke(this.appId, method, args);
    } finally {
      if (method === "getMany") {
        if (!performance.getEntriesByName("aether.storage.firstRead").length)
          performance.measure("aether.storage.firstRead", {
            start: started,
            end: performance.now(),
          });
        performance.clearMeasures("aether.storage.getMany");
        performance.measure("aether.storage.getMany", {
          start: started,
          end: performance.now(),
        });
      }
      await this.prune();
    }
  }
  async prune() {
    const retained = new Set(
      [...this.core.reads.values(), ...this.core.transfers.values()].map(
        (item) => item.ctx.io,
      ),
    );
    for (const io of [...this.sessions])
      if (!retained.has(io)) {
        this.sessions.delete(io);
        await io.end().catch(() => {});
      }
  }
  async close() {
    await this.core.close();
    if (this.initialScope) {
      await hostedRequest("files.end", {
        session: this.initialScope.session,
      }).catch(() => {});
      this.initialScope = null;
    }
    for (const io of this.sessions) await io.end().catch(() => {});
    this.sessions.clear();
  }
}
let records;
export const localStorageRequest = (method, args) =>
  (records ||= new BrowserRecords()).invoke(method, args);
if (typeof window !== "undefined")
  window.addEventListener(
    "pagehide",
    () => {
      void records?.close();
    },
    { once: true },
  );
