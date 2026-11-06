const randomUUID = () => globalThis.crypto.randomUUID();
const text = (bytes) => new TextDecoder().decode(bytes);
const byteLength = (value) => new TextEncoder().encode(value).byteLength;
const base64 = (bytes) => {
  let value = "";
  for (let at = 0; at < bytes.length; at += 8192)
    value += String.fromCharCode(...bytes.subarray(at, at + 8192));
  return btoa(value);
};
const queues = new Map();
async function locked(key, work) {
  const previous = queues.get(key) || Promise.resolve();
  const next = previous.catch(() => {}).then(work);
  queues.set(key, next);
  try {
    return await next;
  } finally {
    if (queues.get(key) === next) queues.delete(key);
  }
}
const keyOf = (kind, id) => {
  if (
    !/^[a-z][a-z0-9-]{0,40}$/.test(kind) ||
    typeof id !== "string" ||
    !id ||
    id.length > 300
  )
    throw new Error("Invalid storage key.");
  return kind + ":" + id;
};
const validStore = (store) => {
  if (!/^[a-zA-Z0-9_-]{1,100}$/.test(store))
    throw new Error("Invalid record store.");
  return store;
};
export class ProjectStore {
  constructor(projects) {
    this.projects = projects;
    this.transfers = new Map();
    this.reads = new Map();
  }
  async context(appId, store, checkedProject) {
    validStore(store);
    const project = checkedProject || (await this.projects.project(appId));
    return { ...project, prefix: appId + "/data/" + store };
  }
  async index(ctx) {
    return (
      (await ctx.io.json(ctx.prefix + "/index.json")) || {
        version: null,
        value: { version: 1, entries: {} },
      }
    );
  }
  async discard(item) {
    const ctx = item.ctx;
    if (!item.ready) {
      await item.ctx.io
        .invoke("cancel", { transfer: item.native })
        .catch(() => {});
      return;
    }
    // An acknowledgement can be lost after the index committed. Never delete a
    // staged record that the current authoritative index already references.
    const index = await this.index(ctx);
    if (
      !Object.values(index.value.entries || {}).some(
        (entry) => entry.file === item.file,
      )
    )
      await ctx.io
        .invoke("remove", { path: item.file, expected: item.version })
        .catch(() => {});
  }
  async invoke(appId, op, args, signal, checkedProject) {
    for (const [token, item] of this.transfers)
      if (Date.now() - item.touched > 600000) {
        this.transfers.delete(token);
        await this.discard(item).catch(() => {});
      }
    validStore(args.store);
    if (op === "readChunk" || op === "readDone") {
      const item = this.reads.get(args.readToken);
      if (
        !item ||
        item.appId !== appId ||
        item.store !== args.store ||
        item.expires < Date.now()
      )
        throw new Error("Read expired; reload the record.");
      if (op === "readDone") {
        await this.releaseRead(args.readToken);
        return { ok: true };
      }
      item.expires = Date.now() + 120000;
      if (!item.nativeRead)
        item.nativeRead = (
          await item.ctx.io.invoke("openRead", { path: item.file })
        ).reader;
      return item.ctx.io.invoke("readNext", {
        reader: item.nativeRead,
        offset: args.offset,
        limit: 262144,
      });
    }
    const continued = ["writeChunk", "finishWrite", "cancelWrite"].includes(op),
      transfer = continued ? this.transfers.get(args.transfer) : null;
    if (
      continued &&
      (!transfer || transfer.appId !== appId || transfer.store !== args.store)
    )
      throw new Error("Unknown record transfer.");
    const ctx = continued
        ? transfer.ctx
        : await this.context(appId, args.store, checkedProject),
      indexPath = ctx.prefix + "/index.json";
    const native = (method, body) => ctx.io.invoke(method, body);
    if (op === "writeStart") {
      const key = keyOf(args.kind, args.id),
        format = args.format === "blob" ? "blob" : "json",
        size = args.bytes;
      if (
        !Number.isSafeInteger(size) ||
        size < 0 ||
        size > (format === "blob" ? 32 : 8) * 1048576 ||
        this.transfers.size >= 16
      )
        throw new Error("Record transfer size/queue limit exceeded.");
      const extension =
        format === "json"
          ? "json"
          : {
              "application/pdf": "pdf",
              "text/plain": "txt",
              "image/png": "png",
              "image/jpeg": "jpg",
            }[args.type] || "blob";
      const token = randomUUID(),
        file =
          ctx.prefix +
          "/records/" +
          args.kind +
          "/" +
          args.id.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 50) +
          "-" +
          randomUUID() +
          "." +
          extension;
      const begun = await native("beginWrite", {
        path: file,
        bytes: size,
        expected: null,
      });
      this.transfers.set(token, {
        appId,
        ctx,
        store: args.store,
        key,
        file,
        native: begun.transfer,
        bytes: size,
        format,
        type: String(args.type || "").slice(0, 200),
        summary: args.summary || {},
        onlyAbsent: args.onlyAbsent === true,
        offset: 0,
        touched: Date.now(),
      });
      return { transfer: token };
    }
    if (["writeChunk", "finishWrite", "cancelWrite"].includes(op)) {
      const item = this.transfers.get(args.transfer);
      if (!item || item.appId !== appId || item.store !== args.store)
        throw new Error("Unknown record transfer.");
      item.touched = Date.now();
      if (op === "writeChunk") {
        if (
          item.ready ||
          item.offset !== args.offset ||
          typeof args.base64 !== "string" ||
          args.base64.length > 90000
        )
          throw new Error("Invalid record transfer chunk.");
        const result = await native("chunk", {
          transfer: item.native,
          offset: args.offset,
          base64: args.base64,
        });
        item.offset = result.offset;
        return result;
      }
      if (op === "finishWrite") {
        if (item.offset !== item.bytes)
          throw new Error("Incomplete record transfer.");
        const result = await native("commit", { transfer: item.native });
        item.version = result.version;
        item.ready = true;
        if (item.format === "json") {
          const record = await ctx.io.read(item.file, 8 * 1048576);
          JSON.parse(text(record.bytes));
        }
        return { ready: true };
      }
      this.transfers.delete(args.transfer);
      await this.discard(item);
      return { cancelled: true };
    }
    return locked(appId + ":" + args.store, async () => {
      if (signal?.aborted) throw new Error("Storage request cancelled.");
      const index = await this.index(ctx),
        entries = index.value.entries;
      if (
        index.value.version !== 1 ||
        !entries ||
        typeof entries !== "object" ||
        Array.isArray(entries) ||
        Object.keys(entries).length > 2000
      )
        throw new Error(
          "Invalid external store index; existing files were retained.",
        );
      for (const item of Object.values(entries))
        if (
          !item.file?.startsWith(ctx.prefix + "/records/") ||
          item.file.split("/").some((part) => part === ".." || part === ".") ||
          !/^[a-f0-9]{64}$/.test(item.version) ||
          !Number.isFinite(item.bytes)
        )
          throw new Error("Invalid record file reference; access stopped.");
      const listRecords = (options) => {
        const kind = options.kind;
        if (!/^[a-z][a-z0-9-]{0,40}$/.test(kind))
          throw new Error("Invalid record kind.");
        const offset = Math.max(0, Math.floor(options.offset || 0)),
          limit = Math.max(1, Math.min(50, Math.floor(options.limit || 50)));
        return {
          records: Object.values(entries)
            .filter((item) => item.kind === kind)
            .sort((a, b) => a.id.localeCompare(b.id))
            .slice(offset, offset + limit)
            .map(({ kind, id, bytes, updatedAt, summary }) => ({
              kind,
              id,
              bytes,
              updatedAt,
              ...summary,
            })),
        };
      };
      const getRecord = async (key, metadataOnly = false) => {
        const item = entries[keyOf(key.kind, key.id)];
        if (!item) return { exists: false };

        const stat = await ctx.io.stat(item.file);
        if (!stat.exists)
          throw new Error("A record file is missing; the index was not reset.");
        if (stat.version !== item.version) {
          if (stat.bytes > (item.format === "blob" ? 32 : 8) * 1048576)
            throw new Error("Externally edited record exceeds its bound.");
          if (item.format === "json")
            JSON.parse(text((await ctx.io.read(item.file, 8 * 1048576)).bytes));
          item.version = stat.version;
          item.bytes = stat.bytes;
          item.summary = {};
          index.version = (
            await ctx.io.write(
              indexPath,
              JSON.stringify(index.value, null, 2),
              index.version,
            )
          ).version;
        }
        if (metadataOnly) return { exists: true };
        for (const [id, r] of this.reads)
          if (r.expires < Date.now()) await this.releaseRead(id);
        if (this.reads.size >= 32)
          await this.releaseRead(this.reads.keys().next().value);
        const readToken = randomUUID();
        this.reads.set(readToken, {
          appId,
          ctx,
          store: args.store,
          file: item.file,
          expires: Date.now() + 120000,
        });
        return { exists: true, ...item, readToken };
      };
      if (op === "list") return listRecords(args);
      if (op === "get") return getRecord(args);
      if (op === "getMany") {
        if (
          !Array.isArray(args.keys) ||
          args.keys.length < 1 ||
          args.keys.length > 16
        )
          throw new Error("Select between 1 and 16 records.");
        if (
          args.lists !== undefined &&
          (!Array.isArray(args.lists) || args.lists.length > 4)
        )
          throw new Error("Select up to four record lists.");
        const inlineLimit = Math.min(
          65536,
          Math.floor(524288 / args.keys.length),
        );
        const pages = (args.lists || []).map(listRecords);
        const records = [];
        try {
          for (const key of args.keys) {
            const record = await getRecord(key, args.metadataOnly === true);
            if (!record.exists || args.metadataOnly === true) {
              records.push(record);
              continue;
            }
            const { exists, bytes, format, type, version, readToken } = record;
            records.push({ exists, bytes, format, type, version, readToken });
            if (format === "json" && bytes <= inlineLimit) {
              const value = await ctx.io.read(record.file, inlineLimit);
              if (!value || value.version !== version)
                throw new Error(
                  "Record changed during reading; retry the action.",
                );
              records.at(-1).inlineBase64 = base64(value.bytes);
              await this.releaseRead(readToken);
              delete records.at(-1).readToken;
            }
          }
          if (byteLength(JSON.stringify({ records, pages })) > 800000)
            throw new Error("Record batch exceeds its response budget.");
          return { records, pages };
        } catch (error) {
          for (const record of records)
            if (record.readToken) await this.releaseRead(record.readToken);
          throw error;
        }
      }
      if (op === "stats")
        return {
          count: Object.keys(entries).length,
          bytes: Object.values(entries).reduce(
            (sum, item) => sum + item.bytes,
            0,
          ),
          budget: 128 * 1048576,
          storage: "shared-project-files",
        };
      if (
        op !== "commit" ||
        !Array.isArray(args.entries) ||
        args.entries.length < 1 ||
        args.entries.length > 16
      )
        throw new Error("Invalid record transaction.");
      const next = { ...entries },
        used = [],
        seen = new Set();
      for (const change of args.entries) {
        const key = keyOf(change.kind, change.id);
        if (seen.has(key)) throw new Error("Duplicate transaction key.");
        seen.add(key);
        const previous = entries[key];
        if (previous) {
          const stat = await ctx.io.stat(previous.file);
          if (stat.version !== previous.version)
            throw new Error(
              "Record changed externally; reload before saving. Existing bytes were retained.",
            );
        }
        if (change.delete) {
          delete next[key];
          continue;
        }
        const item = this.transfers.get(change.transfer);
        if (
          !item?.ready ||
          item.appId !== appId ||
          item.store !== args.store ||
          item.key !== key
        )
          throw new Error("Record is not ready to commit.");
        if (
          (item.ctx.io.tree || item.ctx.io.directory) !==
          (ctx.io.tree || ctx.io.directory)
        )
          throw new Error(
            "Project folder changed during the write; retry the chosen action.",
          );
        used.push([change.transfer, item]);
        if (previous && item.onlyAbsent) continue;
        next[key] = {
          kind: change.kind,
          id: change.id,
          file: item.file,
          version: item.version,
          bytes: item.bytes,
          format: item.format,
          type: item.type,
          summary: item.summary,
          updatedAt: new Date().toISOString(),
        };
      }
      const bytes = Object.values(next).reduce(
        (sum, item) => sum + item.bytes,
        0,
      );
      if (bytes > 128 * 1048576 || Object.keys(next).length > 2000)
        throw new Error("Shared record budget reached; nothing was evicted.");
      const encoded = JSON.stringify(
        { ...index.value, version: 1, entries: next },
        null,
        2,
      );
      if (byteLength(encoded) > 1048576)
        throw new Error("Record metadata budget reached.");
      await ctx.io.write(indexPath, encoded, index.version);
      for (const [token, item] of used) this.transfers.delete(token);
      // Retire only our superseded immutable files with matching hashes, after the
      // index commit. External edits are never silently garbage-collected.
      const live = new Set(Object.values(next).map((item) => item.file));
      for (const old of [
        ...Object.values(entries),
        ...used.map(([, item]) => item),
      ])
        if (!live.has(old.file))
          await native("remove", {
            path: old.file,
            expected: old.version,
          }).catch(() => {});
      return { committed: true };
    });
  }
  async releaseRead(token) {
    const item = this.reads.get(token);
    this.reads.delete(token);
    if (item?.nativeRead)
      await item.ctx.io
        .invoke("closeRead", { reader: item.nativeRead })
        .catch(() => {});
  }
  async close() {
    for (const item of this.transfers.values())
      await this.discard(item).catch(() => {});
    this.transfers.clear();
    for (const token of this.reads.keys()) await this.releaseRead(token);
  }
}
