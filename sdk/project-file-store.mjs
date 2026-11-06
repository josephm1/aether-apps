import { localStorageRequest } from "./project-documents.mjs";
function b64(bytes) {
  let text = "";
  for (const byte of bytes) text += String.fromCharCode(byte);
  return btoa(text);
}
function un64(text) {
  const bytes = atob(text);
  return Uint8Array.from(bytes, (c) => c.charCodeAt(0));
}
export class ProjectFileStore {
  constructor(name, limits) {
    this.name = name;
    this.limits = limits;
    this.channel =
      typeof BroadcastChannel === "function"
        ? new BroadcastChannel(name)
        : null;
  }
  request(method, args = {}) {
    return localStorageRequest(method, { store: this.name, ...args });
  }
  async open() {
    return this;
  }
  async get(kind, id) {
    return (await this.getMany([{ kind, id }]))[0];
  }
  async getMany(keys) {
    return (await this.readView({ keys })).values;
  }
  async readView({ keys, lists = [] }) {
    const { records, pages } = await this.request("getMany", { keys, lists });
    const output = [];
    try {
      for (const record of records)
        output.push(await this.decodeRecord(record));
      return { values: output, pages };
    } finally {
      await Promise.all(
        records
          .filter((r) => r.readToken)
          .map((r) =>
            this.request("readDone", { readToken: r.readToken }).catch(
              () => {},
            ),
          ),
      );
    }
  }
  async decodeRecord(record) {
    if (!record.exists) return undefined;
    const chunks = [];
    let total = 0;
    if (record.inlineBase64 !== undefined) {
      const bytes = un64(record.inlineBase64);
      chunks.push(bytes);
      total = bytes.length;
    } else {
      for (let offset = 0; offset < record.bytes; ) {
        const reply = await this.request("readChunk", {
            readToken: record.readToken,
            offset,
          }),
          bytes = un64(reply.base64);
        if (!bytes.length) throw new Error("Incomplete shared record.");
        offset += bytes.length;
        total += bytes.length;
        if (total > record.bytes)
          throw new Error("Record changed during read.");
        chunks.push(bytes);
      }
    }
    if (total !== record.bytes) throw new Error("Incomplete shared record.");
    const blob = new Blob(chunks, {
        type: record.type || "application/octet-stream",
      }),
      hash = new Uint8Array(
        await crypto.subtle.digest("SHA-256", await blob.arrayBuffer()),
      );
    if (
      [...hash].map((x) => x.toString(16).padStart(2, "0")).join("") !==
      record.version
    )
      throw new Error("Shared record changed; reload before continuing.");
    return record.format === "blob" ? blob : JSON.parse(await blob.text());
  }
  async hasMany(keys) {
    return (
      await this.request("getMany", { keys, metadataOnly: true })
    ).records.map((r) => r.exists);
  }
  async has(kind, id) {
    return (await this.hasMany([{ kind, id }]))[0];
  }
  async stage(kind, id, value, { onlyAbsent = false, summary } = {}) {
    const blob =
      value instanceof Blob
        ? value
        : new Blob([JSON.stringify(value)], { type: "application/json" });
    if (
      blob.size > (value instanceof Blob ? this.limits.blob : this.limits.json)
    )
      throw new Error("Record exceeds its per-file limit.");
    const format = value instanceof Blob ? "blob" : "json",
      metadata =
        summary ||
        (format === "blob"
          ? { size: blob.size, type: blob.type }
          : summarize(value));
    const { transfer } = await this.request("writeStart", {
      kind,
      id,
      format,
      bytes: blob.size,
      type: blob.type,
      summary: metadata,
      onlyAbsent,
    });
    try {
      for (let offset = 0; offset < blob.size; offset += 49152)
        await this.request("writeChunk", {
          transfer,
          offset,
          base64: b64(
            new Uint8Array(
              await blob.slice(offset, offset + 49152).arrayBuffer(),
            ),
          ),
        });
      await this.request("finishWrite", { transfer });
      return { kind, id, transfer };
    } catch (error) {
      await this.request("cancelWrite", { transfer }).catch(() => {});
      throw error;
    }
  }
  async putRaw(kind, id, value, options = {}) {
    const item = await this.stage(kind, id, value, options);
    try {
      await this.request("commit", { entries: [item] });
    } catch (error) {
      await this.request("cancelWrite", { transfer: item.transfer }).catch(
        () => {},
      );
      throw error;
    }
    this.channel?.postMessage({ kind, id });
    globalThis.dispatchEvent?.(
      new CustomEvent("local-db-change", { detail: { kind, id } }),
    );
    return value;
  }
  async put(kind, id, value, options = {}) {
    return this.putRaw(kind, id, value, options);
  }
  async batch(entries) {
    if (!Array.isArray(entries) || !entries.length || entries.length > 16)
      throw new Error("Use 1–16 records in a transaction.");
    const staged = [];
    try {
      for (const item of entries)
        staged.push(
          item.delete
            ? { kind: item.kind, id: item.id, delete: true }
            : await this.stage(item.kind, item.id, item.value),
        );
      await this.request("commit", { entries: staged });
    } catch (error) {
      for (const item of staged)
        if (item.transfer)
          await this.request("cancelWrite", { transfer: item.transfer }).catch(
            () => {},
          );
      throw error;
    }
    for (const item of entries)
      this.channel?.postMessage({ kind: item.kind, id: item.id });
  }
  async remove(kind, id) {
    await this.batch([{ kind, id, delete: true }]);
  }
  async list(kind, options = {}) {
    return (await this.request("list", { kind, ...options })).records;
  }
  async stats() {
    return this.request("stats");
  }
  close() {
    this.channel?.close();
  }
}
function summarize(value) {
  if (!value || typeof value !== "object") return {};
  return {
    title: String(value.title || value.name || "").slice(0, 300),
    kind: value.kind,
    name: typeof value.name === "string" ? value.name.slice(0, 300) : undefined,
    path:
      typeof value.path === "string" ? value.path.slice(0, 1000) : undefined,
    type: value.type,
    size: value.size,
    messageCount: Array.isArray(value.messages)
      ? value.messages.length
      : undefined,
    recipes: Array.isArray(value.recipe_ids)
      ? value.recipe_ids.length
      : undefined,
    saved_at_utc: value.saved_at_utc,
    createdAt: value.createdAt,
    updatedAt: value.updatedAt,
  };
}
