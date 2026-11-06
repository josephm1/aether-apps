// NEW hosted_apps v1 service client. Explicitly unavailable on stock hosts.
import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { verifyAssets } from "./managed-files.mjs";
import { ensureManagedBuild, cancelManagedBuilds } from "./managed-build.mjs";

const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crcUpdate = (value, buffer) => {
  for (const byte of buffer)
    value = crcTable[(value ^ byte) & 255] ^ (value >>> 8);
  return value >>> 0;
};
async function fileInfo(file) {
  const hash = createHash("sha256");
  let crc = 0xffffffff,
    size = 0;
  const handle = await fs.open(file, "r");
  try {
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      const chunk = buffer.subarray(0, bytesRead);
      size += bytesRead;
      if (size > 12 * 1048576) throw new Error("An app asset exceeds 12 MiB.");
      hash.update(chunk);
      crc = crcUpdate(crc, chunk);
    }
  } finally {
    await handle.close();
  }
  return { size, crc: (crc ^ 0xffffffff) >>> 0, sha256: hash.digest("hex") };
}
async function archiveAssets(app) {
  const root = await fs.realpath(path.join(app.directory, "pwa/dist"));
  const buildFile = path.join(root, "BUILD.json");
  const stat = await fs.stat(buildFile);
  if (stat.size > 1048576) throw new Error("Build manifest too large.");
  const build = JSON.parse(await fs.readFile(buildFile, "utf8"));
  if (
    build.app_id !== app.definition.id ||
    !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,79}$/.test(build.version || "")
  )
    throw new Error("Wrong/invalid static app build identity.");
  const entries = Object.entries(build.files || {});
  if (
    !entries.length ||
    entries.length > 2048 ||
    !entries.some(([name]) => name === "index.html")
  )
    throw new Error("Static app manifest is incomplete or too large.");
  const output = path.join(
      os.tmpdir(),
      "aether-hosted-" + randomUUID() + ".zip",
    ),
    zip = await fs.open(output, "wx", 0o600);
  let offset = 0,
    total = 0;
  const central = [];
  const write = async (buffer) => {
    let at = 0;
    while (at < buffer.length) {
      const result = await zip.write(buffer, at, buffer.length - at, null);
      if (!result.bytesWritten) throw new Error("Short asset archive write.");
      at += result.bytesWritten;
    }
    offset += buffer.length;
  };
  try {
    for (const [name, digest] of entries) {
      if (
        typeof name !== "string" ||
        name.length > 512 ||
        name.startsWith("/") ||
        name.includes("\\") ||
        name.includes("\0") ||
        name.split("/").some((p) => !p || p === "." || p === "..") ||
        !/^[a-f0-9]{64}$/.test(digest)
      )
        throw new Error("Unsafe static app manifest entry.");
      const input = path.join(root, name),
        infoStat = await fs.lstat(input),
        resolved = await fs.realpath(input);
      if (
        infoStat.isSymbolicLink() ||
        !infoStat.isFile() ||
        !resolved.startsWith(root + path.sep)
      )
        throw new Error(
          "Static assets must be regular files inside this build.",
        );
      const info = await fileInfo(input);
      if (info.sha256 !== digest)
        throw new Error(
          "App assets changed after compilation. Rebuild before Add/Open: " +
            name,
        );
      total += info.size;
      if (total > 32 * 1048576)
        throw new Error("Static app assets exceed 32 MiB.");
      const filename = Buffer.from(name),
        header = Buffer.alloc(30),
        start = offset;
      header.writeUInt32LE(0x04034b50, 0);
      header.writeUInt16LE(20, 4);
      header.writeUInt16LE(0x800, 6);
      header.writeUInt16LE(0, 8);
      header.writeUInt32LE(info.crc, 14);
      header.writeUInt32LE(info.size, 18);
      header.writeUInt32LE(info.size, 22);
      header.writeUInt16LE(filename.length, 26);
      await write(header);
      await write(filename);
      const handle = await fs.open(input, "r");
      try {
        const buffer = Buffer.alloc(65536);
        for (;;) {
          const { bytesRead } = await handle.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (!bytesRead) break;
          await write(buffer.subarray(0, bytesRead));
        }
      } finally {
        await handle.close();
      }
      const directory = Buffer.alloc(46);
      directory.writeUInt32LE(0x02014b50, 0);
      directory.writeUInt16LE(20, 4);
      directory.writeUInt16LE(20, 6);
      directory.writeUInt16LE(0x800, 8);
      directory.writeUInt32LE(info.crc, 16);
      directory.writeUInt32LE(info.size, 20);
      directory.writeUInt32LE(info.size, 24);
      directory.writeUInt16LE(filename.length, 28);
      directory.writeUInt32LE(start, 42);
      central.push(Buffer.concat([directory, filename]));
    }
    const directoryStart = offset;
    for (const entry of central) await write(entry);
    const directorySize = offset - directoryStart,
      end = Buffer.alloc(22);
    end.writeUInt32LE(0x06054b50, 0);
    end.writeUInt16LE(entries.length, 8);
    end.writeUInt16LE(entries.length, 10);
    end.writeUInt32LE(directorySize, 12);
    end.writeUInt32LE(directoryStart, 16);
    await write(end);
  } catch (error) {
    await zip.close();
    await fs.rm(output, { force: true });
    throw error;
  }
  await zip.close();
  return { file: output, build, ...(await fileInfoArchive(output)) };
}
async function fileInfoArchive(file) {
  const handle = await fs.open(file, "r"),
    hash = createHash("sha256");
  let bytes = 0;
  try {
    const buffer = Buffer.alloc(65536);
    for (;;) {
      const { bytesRead } = await handle.read(buffer, 0, buffer.length, null);
      if (!bytesRead) break;
      bytes += bytesRead;
      hash.update(buffer.subarray(0, bytesRead));
    }
  } finally {
    await handle.close();
  }
  return { bytes, sha256: hash.digest("hex") };
}
export function createManagedHost(api) {
  const invoke = (method, args = {}) =>
    api.services.invoke("hosted_apps", method, args);
  async function capabilities() {
    const catalog = await api.services.list();
    const service = (catalog.services || []).find(
      (s) => s.id === "hosted_apps",
    );
    if (!service)
      return {
        supported: false,
        reason:
          "This Aether build lacks the new hosted-app capability. A matching host update is required. The library remains available; native Open needs the matching host adapters.",
      };
    const result = await invoke("capabilities");
    if (
      result.protocol !== 1 ||
      result.extensionGateway !== 1 ||
      result.directFiles !== 1
    )
      return {
        supported: false,
        reason: "Incompatible hosted-app protocol. No app/data was changed.",
      };
    return result;
  }
  async function prepare(app, { grant = false } = {}) {
    const cap = await capabilities();
    if (!cap.supported)
      throw new Error(cap.reason || "Host-managed apps are unavailable.");
    await ensureManagedBuild(app);
    const manifest = await verifyAssets(
      await fs.realpath(path.join(app.directory, "pwa/dist")),
      app.definition.id,
    );
    if (manifest.hosted_protocol !== 1)
      throw new Error(
        "This source needs the hosted-app adapter build. Change with Aether can prepare it; no manual browser/pairing path was substituted.",
      );
    const existing = (await invoke("list")).apps?.find(
      (item) => item.id === app.definition.id,
    );
    const requested = app.definition.capabilities || {};
    const reviewed = api.storage.get("appGrants", {})[app.definition.id] || {};
    if (
      !grant &&
      ((requested.ai && !reviewed.ai) ||
        (requested.storage && !reviewed.storage) ||
        (requested.networkOrigins || []).some(
          (origin) => !(reviewed.networkOrigins || []).includes(origin),
        ) ||
        (requested.tools || []).some(
          (tool) => !(reviewed.tools || []).includes(tool),
        ))
    )
      throw new Error(
        "Review changed capabilities and choose Grant listed access and open.",
      );
    await invoke("configureData", {
      id: app.definition.id,
      tree: api.storage.get("sharedProjectsTree", ""),
      enabled: !!(requested.storage && reviewed.storage),
    });
    if (existing?.version === manifest.version && !grant) return existing;
    const archive = await archiveAssets(app);
    let upload;
    try {
      const begin = await invoke("begin", {
        id: app.definition.id,
        label: app.definition.label,
        version: archive.build.version,
        bytes: archive.bytes,
        sha256: archive.sha256,
      });
      upload = begin.upload;
      const input = await fs.open(archive.file, "r");
      let offset = 0;
      try {
        const buffer = Buffer.alloc(65536);
        for (;;) {
          const { bytesRead } = await input.read(
            buffer,
            0,
            buffer.length,
            null,
          );
          if (!bytesRead) break;
          const result = await invoke("chunk", {
            upload,
            offset,
            base64: buffer.subarray(0, bytesRead).toString("base64"),
          });
          offset += bytesRead;
          if (result.offset !== offset)
            throw new Error(
              "Native asset upload did not acknowledge the expected offset.",
            );
        }
      } finally {
        await input.close();
      }
      return await invoke("commit", { upload });
    } catch (error) {
      if (upload) await invoke("cancel", { upload }).catch(() => {});
      throw error;
    } finally {
      await fs.rm(archive.file, { force: true });
    }
  }
  return {
    capabilities,
    prepare,
    cancel: cancelManagedBuilds,
    async add(app) {
      const record = await prepare(app, { grant: true });
      let shortcut;
      try {
        shortcut = await invoke("pin", { id: app.definition.id });
      } catch {
        shortcut = {
          requested: false,
          reason:
            "The app is added, but the launcher did not accept the icon request. You can retry under Advanced.",
        };
      }
      await invoke("open", { id: app.definition.id });
      return { ...record, shortcut };
    },
    async open(app) {
      await prepare(app);
      return invoke("open", { id: app.definition.id });
    },
    setEnabled: (enabled) => invoke("setEnabled", { enabled }),
    list: () => invoke("list"),
    pin: (id) => invoke("pin", { id }),
    permission: (id, allowed) => {
      const enabled = api.storage.get("appAiEnabled", {});
      enabled[id] = allowed;
      api.storage.set("appAiEnabled", enabled);
    },
  };
}
