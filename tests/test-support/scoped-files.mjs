// Desktop adapter for the native file protocol. It deliberately has no Apps
// extension/record-store implementation: actual project web code owns that work.
import assert from "node:assert/strict";
export class ScopedFiles {
  constructor(io, appId = "aether-lidl-food") {
    this.io = io;
    this.appId = appId;
    this.sessions = new Map();
    this.enabled = true;
    this.rootIdentity = "fixture:tree";
    this.calls = [];
  }
  async invoke(op, args = {}) {
    assert.ok(op.startsWith("files."), "Unexpected extension request: " + op);
    this.calls.push(op);
    const method = op.slice(6);
    if (method === "begin") {
      assert.ok(this.sessions.size<40,"Too many file sessions");
      assert.ok(this.enabled);
      const session = crypto.randomUUID();
      this.sessions.set(session, {
        readers: new Set(),
        writes: new Set(),
        root: this.rootIdentity,
      });
      return { session, appId: this.appId, rootIdentity: this.rootIdentity };
    }
    const session = this.sessions.get(args.session);
    if (method === "end") {
      if (session) {
        for (const reader of session.readers)
          await this.io.invoke("closeRead", { reader });
        for (const transfer of session.writes)
          await this.io.invoke("cancel", { transfer });
        this.sessions.delete(args.session);
      }
      return { ended: true };
    }
    assert.ok(
      session && this.enabled && session.root === this.rootIdentity,
      "File session expired or revoked",
    );
    if (
      ["stat", "readFile", "openRead", "beginWrite", "remove"].includes(method)
    ) {
      assert.ok(
        args.path.startsWith(this.appId + "/data/") &&
          args.path
            .split("/")
            .every((part) => part && part !== "." && part !== "..") &&
          !args.path.includes("\\"),
        "Path outside app data",
      );
    } else if (["readNext", "closeRead"].includes(method))
      assert.ok(session.readers.has(args.reader));
    else if (["chunk", "commit", "cancel"].includes(method))
      assert.ok(session.writes.has(args.transfer));
    else throw new Error("Unsupported file method " + method);
    const result = await this.io.invoke(method, args);
    if (method === "openRead") session.readers.add(result.reader);
    if (method === "closeRead") session.readers.delete(args.reader);
    if (method === "beginWrite") session.writes.add(result.transfer);
    if (method === "commit" || method === "cancel")
      session.writes.delete(args.transfer);
    return result;
  }
  async close() {
    for (const session of [...this.sessions.keys()])
      await this.invoke("files.end", { session });
  }
}
