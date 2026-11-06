import { createHash } from "node:crypto";
export const digest = (bytes) =>
  createHash("sha256").update(bytes).digest("hex");
export function relative(name) {
  if (
    typeof name !== "string" ||
    name.length > 2048 ||
    name.includes("\\") ||
    name.includes("\0") ||
    name
      .split("/")
      .some(
        (part) => !part || part === "." || part === ".." || part.length > 200,
      )
  )
    throw new Error("Use a relative project file path.");
  return name;
}
export class Documents {
  constructor(api, tree) {
    this.api = api;
    this.tree = tree;
  }
  invoke(method, args = {}) {
    return this.api.services.invoke("documents", method, {
      tree: this.tree,
      ...args,
    });
  }
  stat(path, hash = true) {
    return this.invoke("stat", { path, hash });
  }
  async read(path, maximum = 32 * 1048576) {
    if (path) relative(path);
    let info;
    if (maximum <= 1048576) {
      const record = await this.invoke("readFile", { path, maximum });
      if (!record.exists) return null;
      if (record.bytes > maximum)
        throw new Error("File exceeds its read budget: " + path);
      if (record.base64 === undefined) info = record;
      else {
        const bytes = Buffer.from(record.base64, "base64");
        if (
          bytes.length !== record.bytes ||
          bytes.length > maximum ||
          digest(bytes) !== record.version
        )
          throw new Error(
            "Small document read failed its byte/hash check: " + path,
          );
        return { bytes, version: record.version };
      }
    }
    info ||= await this.stat(path);
    if (!info.exists) return null;
    if (info.directory || info.bytes > maximum)
      throw new Error("File exceeds its read budget: " + path);
    const chunks = [];
    let offset = 0;
    for (;;) {
      const reply = await this.invoke("read", { path, offset, limit: 65536 }),
        chunk = Buffer.from(reply.base64, "base64");
      if (!chunk.length) break;
      offset += chunk.length;
      if (offset > maximum)
        throw new Error("File grew beyond its read budget.");
      chunks.push(chunk);
      if (chunk.length < 65536) break;
    }
    const bytes = Buffer.concat(chunks);
    if (digest(bytes) !== info.version)
      throw new Error(
        "File changed during reading; reload before continuing: " + path,
      );
    return { bytes, version: info.version };
  }
  async json(path, maximum = 1048576) {
    const value = await this.read(path, maximum);
    return value
      ? {
          value: JSON.parse(value.bytes.toString("utf8")),
          version: value.version,
        }
      : null;
  }
  async write(path, bytes, expected = null) {
    relative(path);
    bytes = Buffer.from(bytes);
    const { transfer } = await this.invoke("beginWrite", {
      path,
      bytes: bytes.length,
      expected,
    });
    try {
      for (let offset = 0; offset < bytes.length; offset += 65536) {
        await this.invoke("chunk", {
          transfer,
          offset,
          base64: bytes.subarray(offset, offset + 65536).toString("base64"),
        });
      }
      return await this.invoke("commit", { transfer });
    } catch (error) {
      await this.invoke("cancel", { transfer }).catch(() => {});
      throw error;
    }
  }
  async list(path = "") {
    const result = [];
    for (let offset = 0; ; offset += 100) {
      const reply = await this.invoke("list", { path, offset });
      result.push(...(reply.entries || []));
      if (result.length > 8192)
        throw new Error("Directory entry limit reached.");
      if (!reply.more) return result;
    }
  }
  async walk(path, { limit = 3000 } = {}) {
    const result = [];
    const walk = async (prefix) => {
      for (const item of await this.list(prefix)) {
        if (item.name.startsWith(".aether-")) continue;
        const name = prefix ? prefix + "/" + item.name : item.name;
        if (item.directory) await walk(name);
        else {
          if (result.length >= limit)
            throw new Error("Project file count limit reached.");
          result.push({ path: name, bytes: item.bytes });
        }
      }
    };
    await walk(path);
    return result;
  }
}
