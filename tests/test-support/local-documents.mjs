import fs from "node:fs/promises";
import path from "node:path";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
const hash = (bytes) => createHash("sha256").update(bytes).digest("hex");
export class LocalDocuments {
  constructor(root) {
    this.directory = root;
    this.transfers = new Map();
    this.readers = new Map();
  }
  async read(name) {
    try {
      const bytes = await fs.readFile(path.join(this.directory, name));
      return { bytes, version: hash(bytes) };
    } catch (error) {
      if (error.code === "ENOENT") return null;
      throw error;
    }
  }
  async json(name) {
    const record = await this.read(name);
    return (
      record && { value: JSON.parse(record.bytes), version: record.version }
    );
  }
  async stat(name) {
    try {
      const stat = await fs.stat(path.join(this.directory, name));
      return {
        exists: true,
        directory: stat.isDirectory(),
        bytes: stat.size,
        version: stat.isFile()
          ? hash(await fs.readFile(path.join(this.directory, name)))
          : undefined,
      };
    } catch (error) {
      if (error.code === "ENOENT") return { exists: false };
      throw error;
    }
  }
  async write(name, bytes, expected) {
    assert.equal((await this.read(name))?.version || null, expected);
    const file = path.join(this.directory, name);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, bytes);
    return { version: hash(Buffer.from(bytes)) };
  }
  async list(name = "") {
    return Promise.all(
      (
        await fs.readdir(path.join(this.directory, name), {
          withFileTypes: true,
        })
      ).map(async (entry) => ({
        name: entry.name,
        directory: entry.isDirectory(),
      })),
    );
  }
  async walk(name) {
    const output = [];
    const walk = async (prefix) => {
      for (const item of await this.list(prefix)) {
        const next = prefix + "/" + item.name;
        if (item.directory) await walk(next);
        else output.push({ path: next });
      }
    };
    await walk(name);
    return output;
  }
  async invoke(method, args) {
    if (method === "readFile") {
      assert.ok(args.maximum >= 0 && args.maximum <= 1048576);
      const record=await this.read(args.path);
      if(!record)return {exists:false};
      if(record.bytes.length>args.maximum)throw new Error('File exceeds its read budget.');
      return {exists:true,bytes:record.bytes.length,version:record.version,...(record.bytes.length<=65536?{base64:record.bytes.toString('base64')}:{})};
    }
    if (method === "stat") return this.stat(args.path);
    if (method === "beginWrite") {
      const transfer = crypto.randomUUID();
      this.transfers.set(transfer, { ...args, chunks: [], offset: 0 });
      return { transfer };
    }
    if (method === "openRead") {
      const reader = crypto.randomUUID();
      const record = await this.read(args.path);
      assert.ok(record);
      this.readers.set(reader, { bytes: record.bytes, offset: 0 });
      return { reader };
    }
    if (method === "closeRead") {
      this.readers.delete(args.reader);
      return { closed: true };
    }
    if (method === "readNext") {
      const reader = this.readers.get(args.reader);
      assert.ok(reader);
      assert.equal(args.offset, reader.offset);
      const bytes = reader.bytes.subarray(reader.offset, reader.offset + args.limit);
      reader.offset += bytes.length;
      if (bytes.length < args.limit) this.readers.delete(args.reader);
      return { base64: bytes.toString("base64"), bytes: bytes.length };
    }
    if (method === "read") {
      const record = await this.read(args.path);
      return {
        base64: record.bytes
          .subarray(args.offset, args.offset + args.limit)
          .toString("base64"),
      };
    }
    if (method === "remove") {
      assert.equal((await this.read(args.path)).version, args.expected);
      await fs.rm(path.join(this.directory, args.path));
      return { ok: true };
    }
    const transfer = this.transfers.get(args.transfer);
    assert.ok(transfer);
    if (method === "chunk") {
      assert.equal(transfer.offset, args.offset);
      const bytes = Buffer.from(args.base64, "base64");
      transfer.chunks.push(bytes);
      transfer.offset += bytes.length;
      return { offset: transfer.offset };
    }
    if (method === "commit") {
      assert.equal(transfer.offset, transfer.bytes);
      const result = await this.write(
        transfer.path,
        Buffer.concat(transfer.chunks),
        transfer.expected,
      );
      this.transfers.delete(args.transfer);
      return result;
    }
    if (method === "cancel") {
      this.transfers.delete(args.transfer);
      return { cancelled: true };
    }
    throw new Error("Unexpected fixture operation " + method);
  }
}
