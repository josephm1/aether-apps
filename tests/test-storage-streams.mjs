import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { ProjectStore } from "../project-store.mjs";
import { installCapabilities } from "../capabilities.mjs";
import { LocalDocuments } from "./test-support/local-documents.mjs";

test("stream continuations are scoped, sequential, closeable and revoked with private grants", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aether-stream-"));
  const io = new LocalDocuments(tmp),
    definition = {
      capabilities: { storage: true, ai: false, tools: [], networkOrigins: [] },
    },
    projects = { project: async () => ({ io, definition }) };
  const seed = new ProjectStore(projects),
    args = { store: "test", kind: "state", id: "large" },
    bytes = Buffer.from(JSON.stringify({ text: "x".repeat(600000) }));
  let transfer = await seed.invoke("app", "writeStart", {
    ...args,
    bytes: bytes.length,
  });
  for (let offset = 0; offset < bytes.length; offset += 49152)
    await seed.invoke("app", "writeChunk", {
      ...args,
      ...transfer,
      offset,
      base64: bytes.subarray(offset, offset + 49152).toString("base64"),
    });
  await seed.invoke("app", "finishWrite", { ...args, ...transfer });
  await seed.invoke("app", "commit", {
    store: "test",
    entries: [{ kind: "state", id: "large", ...transfer }],
  });
  let granted = true,
    handler;
  const waiting = new Map();
  const close = installCapabilities(
    {
      storage: {
        get: (key, fallback) =>
          key === "appGrants"
            ? granted
              ? { app: definition.capabilities, other: definition.capabilities }
              : {}
            : fallback,
      },
      on: (name, fn) => {
        if (name === "hosted_apps.request") handler = fn;
      },
      services: {
        invoke: async (service, method, reply) => {
          assert.equal(service, "hosted_apps");
          assert.equal(method, "reply");
          const item = waiting.get(reply.requestId);
          reply.ok
            ? item.resolve(reply.result)
            : item.reject(new Error(reply.error));
          waiting.delete(reply.requestId);
        },
      },
    },
    projects,
  );
  const request = (app, op, body) =>
    new Promise((resolve, reject) => {
      const id = crypto.randomUUID();
      waiting.set(id, { resolve, reject });
      handler({
        requestId: id,
        app: { id: app },
        method: "storage." + op,
        args: body,
      });
    });
  try {
    const record = await request("app", "get", args),
      read = { store: "test", readToken: record.readToken, offset: 0 };
    await assert.rejects(request("other", "readChunk", read), /expired/);
    await assert.rejects(
      request("app", "readChunk", { ...read, store: "wrong" }),
      /expired/,
    );
    const first = await request("app", "readChunk", read);
    assert.equal(first.bytes, 262144);
    assert.equal(io.readers.size, 1);
    await assert.rejects(request("app", "readChunk", read), /equal/);
    granted = false;
    await assert.rejects(
      request("app", "readChunk", { ...read, offset: 262144 }),
      /Review/,
    );
    granted = true;
    await request("app", "readDone", read);
    assert.equal(io.readers.size, 0);
    await assert.rejects(request("app", "readChunk", read), /expired/);
    const again = await request("app", "get", args);
    await request("app", "readChunk", { ...read, readToken: again.readToken });
    assert.equal(io.readers.size, 1);
    await close();
    assert.equal(io.readers.size, 0);
  } finally {
    await close();
    await seed.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("staged writes cannot be committed into a newly chosen project root", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aether-root-"));
  const old = new LocalDocuments(path.join(tmp, "old")),
    next = new LocalDocuments(path.join(tmp, "next"));
  let io = old;
  const store = new ProjectStore({ project: async () => ({ io }) }),
    args = { store: "test", kind: "state", id: "small" };
  try {
    const transfer = await store.invoke("app", "writeStart", {
      ...args,
      bytes: 2,
    });
    await store.invoke("app", "writeChunk", {
      ...args,
      ...transfer,
      offset: 0,
      base64: Buffer.from("{}").toString("base64"),
    });
    await store.invoke("app", "finishWrite", { ...args, ...transfer });
    io = next;
    await assert.rejects(
      store.invoke("app", "commit", {
        store: "test",
        entries: [{ ...args, ...transfer }],
      }),
      /folder changed/,
    );
    await store.invoke("app", "cancelWrite", { ...args, ...transfer });
    assert.equal(await next.read("app/data/test/index.json"), null);
  } finally {
    await store.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("batched reads keep edit detection, bounded inline bodies and token cleanup", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aether-batch-")),
    io = new LocalDocuments(tmp),
    store = new ProjectStore({ project: async () => ({ io }) });
  const entries = {},
    keys = [
      { kind: "state", id: "one" },
      { kind: "state", id: "two" },
      { kind: "state", id: "large" },
    ];
  for (const key of keys) {
    const value = Buffer.from(
        JSON.stringify({
          text: key.id === "large" ? "x".repeat(300000) : key.id,
        }),
      ),
      file = "app/data/test/records/state/" + key.id + ".json";
    const written = await io.write(file, value, null);
    entries[key.kind + ":" + key.id] = {
      ...key,
      file,
      version: written.version,
      bytes: value.length,
      format: "json",
      type: "application/json",
      summary: {},
    };
  }
  await io.write(
    "app/data/test/index.json",
    JSON.stringify({ version: 1, entries }),
    null,
  );
  try {
    const body = { store: "test", keys };
    const read = await store.invoke("app", "getMany", body);
    assert.equal(read.records.length, 3);
    assert.equal(
      JSON.parse(Buffer.from(read.records[0].inlineBase64, "base64")).text,
      "one",
    );
    assert.ok(read.records[2].readToken);
    assert.equal(store.reads.size, 1);
    await store.invoke("app", "readDone", {
      store: "test",
      readToken: read.records[2].readToken,
    });
    assert.equal(store.reads.size, 0);
    for (const key of keys.slice(0, 2)) {
      const entry = entries[key.kind + ":" + key.id];
      await io.write(
        entry.file,
        JSON.stringify({ text: "edited " + key.id }),
        entry.version,
      );
    }
    const edited = await store.invoke("app", "getMany", {
      ...body,
      keys: keys.slice(0, 2),
    });
    assert.deepEqual(
      edited.records.map(
        (r) => JSON.parse(Buffer.from(r.inlineBase64, "base64")).text,
      ),
      ["edited one", "edited two"],
    );
    assert.deepEqual(
      (await store.invoke("app", "getMany", { ...body, metadataOnly: true }))
        .records,
      [{ exists: true }, { exists: true }, { exists: true }],
    );
    assert.equal(store.reads.size, 0);
    await assert.rejects(
      store.invoke("app", "getMany", { ...body, keys: [] }),
      /1 and 16/,
    );
    await assert.rejects(
      store.invoke("app", "getMany", {
        ...body,
        keys: Array(17).fill(keys[0]),
      }),
      /1 and 16/,
    );
    await fs.rm(path.join(tmp, entries["state:two"].file));
    await assert.rejects(
      store.invoke("app", "getMany", { ...body, keys: [keys[2], keys[1]] }),
      /missing/,
    );
    assert.equal(store.reads.size, 0);
  } finally {
    await store.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("web client rejects tampered inline batch bytes", async () => {
  const { ProjectFileStore } = await import(
    "../sdk/project-file-store.mjs"
  );
  await assert.rejects(
    ProjectFileStore.prototype.decodeRecord({
      exists: true,
      format: "json",
      bytes: 2,
      inlineBase64: Buffer.from("{}").toString("base64"),
      version: "0".repeat(64),
    }),
    /changed/,
  );
});

test("dashboard views read records and bounded lists from one index", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aether-view-")),
    io = new LocalDocuments(tmp),
    store = new ProjectStore({ project: async () => ({ io }) });
  try {
    const entries = {};
    for (let i = 0; i < 55; i++)
      entries["plan:p" + String(i).padStart(2, "0")] = {
        kind: "plan",
        id: "p" + String(i).padStart(2, "0"),
        file: "app/data/test/records/plan/p" + i + ".json",
        version: "a".repeat(64),
        bytes: 2,
        format: "json",
        summary: { recipes: 5 },
      };
    await io.write(
      "app/data/test/index.json",
      JSON.stringify({ version: 1, entries }),
      null,
    );
    let reads = 0;
    const json = io.json.bind(io);
    io.json = async (...args) => {
      reads++;
      return json(...args);
    };
    const result = await store.invoke("app", "getMany", {
      store: "test",
      keys: [{ kind: "state", id: "preferences" }],
      lists: [{ kind: "plan", limit: 50 }],
    });
    assert.equal(reads, 1);
    assert.equal(result.records[0].exists, false);
    assert.equal(result.pages[0].records.length, 50);
    assert.equal(result.pages[0].records[0].id, "p00");
    assert.equal(
      (
        await store.invoke("app", "list", {
          store: "test",
          kind: "plan",
          offset: 50,
        })
      ).records.length,
      5,
    );
    await assert.rejects(
      store.invoke("app", "getMany", {
        store: "test",
        keys: [{ kind: "state", id: "preferences" }],
        lists: Array(5).fill({ kind: "plan" }),
      }),
      /four/,
    );
  } finally {
    await store.close();
    await fs.rm(tmp, { recursive: true, force: true });
  }
});

test("small document read uses one service call, enforces hashes and budgets, and streams larger JSON", async () => {
  const { Documents } = await import("../documents.mjs");
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "aether-readfile-")),
    io = new LocalDocuments(tmp);
  let calls = [],
    tamper = false;
  const docs = new Documents(
    {
      services: {
        invoke: async (service, method, args) => {
          assert.equal(service, "documents");
          calls.push(method);
          const result = await io.invoke(method, args);
          if (tamper && result.base64) result.version = "0".repeat(64);
          return result;
        },
      },
    },
    "fixture:tree",
  );
  try {
    await io.write("small.json", "{}", null);
    const small = await docs.json("small.json");
    assert.deepEqual(small.value, {});
    assert.deepEqual(calls, ["readFile"]);
    tamper = true;
    await assert.rejects(docs.read("small.json", 10), /hash/);
    tamper = false;
    await assert.rejects(docs.read("small.json", 1), /budget/);
    assert.equal(await docs.read("absent.json", 10), null);
    await io.write(
      "large.json",
      JSON.stringify({ text: "x".repeat(70000) }),
      null,
    );
    calls = [];
    assert.equal((await docs.json("large.json")).value.text.length, 70000);
    assert.deepEqual(calls, ["readFile", "read", "read"]);
  } finally {
    await fs.rm(tmp, { recursive: true, force: true });
  }
});
