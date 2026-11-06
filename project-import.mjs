import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { inflateRawSync } from "node:zlib";
import { Documents, relative } from "./documents.mjs";
import { verifyAssets } from "./managed-files.mjs";
import { validateDefinition } from "./project-definition.mjs";
const crcTable = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let i = 0; i < 8; i++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});
const crc = (bytes) => {
  let c = 0xffffffff;
  for (const byte of bytes) c = crcTable[(c ^ byte) & 255] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
};
export async function importProjectZip(api, projects) {
  await projects.root();
  const chosen = await api.services.invoke("documents", "chooseFile");
  if (!chosen.uri) return null;
  const archive = await new Documents(api, chosen.uri).read("", 32 * 1048576);
  if (!archive) throw new Error("Archive is missing.");
  const bytes = archive.bytes;
  let end = -1;
  for (
    let at = bytes.length - 22;
    at >= Math.max(0, bytes.length - 65557);
    at--
  )
    if (bytes.readUInt32LE(at) === 0x06054b50) {
      end = at;
      break;
    }
  if (
    end < 0 ||
    bytes.readUInt16LE(end + 4) !== 0 ||
    bytes.readUInt16LE(end + 6) !== 0
  )
    throw new Error("Use a single-volume ZIP project.");
  const count = bytes.readUInt16LE(end + 10),
    start = bytes.readUInt32LE(end + 16),
    size = bytes.readUInt32LE(end + 12);
  if (count > 4096 || start + size > end)
    throw new Error("ZIP directory exceeds its bounds.");
  let at = start,
    total = 0;
  const entries = [],
    names = new Set();
  for (let n = 0; n < count; n++) {
    if (at + 46 > bytes.length || bytes.readUInt32LE(at) !== 0x02014b50)
      throw new Error("Invalid ZIP directory.");
    const flags = bytes.readUInt16LE(at + 8),
      method = bytes.readUInt16LE(at + 10),
      checksum = bytes.readUInt32LE(at + 16),
      compressed = bytes.readUInt32LE(at + 20),
      expanded = bytes.readUInt32LE(at + 24),
      nameSize = bytes.readUInt16LE(at + 28),
      extra = bytes.readUInt16LE(at + 30),
      comment = bytes.readUInt16LE(at + 32),
      mode = bytes.readUInt32LE(at + 38) >>> 16,
      offset = bytes.readUInt32LE(at + 42);
    const name = bytes.subarray(at + 46, at + 46 + nameSize).toString("utf8");
    at += 46 + nameSize + extra + comment;
    if (name.endsWith("/")) {
      relative(name.slice(0, -1));
      continue;
    }
    relative(name);
    if (
      names.has(name) ||
      flags & 1 ||
      ![0, 8].includes(method) ||
      (mode & 0xf000) === 0xa000 ||
      expanded > 12 * 1048576 ||
      compressed > 32 * 1048576 ||
      (total += expanded) > 128 * 1048576
    )
      throw new Error(
        "Unsafe, encrypted, linked, duplicate or oversized project entry.",
      );
    names.add(name);
    entries.push({ name, method, checksum, compressed, expanded, offset });
  }
  const candidates = entries.filter(
    (e) => e.name === "web-app.json" || e.name.endsWith("/web-app.json"),
  );
  if (candidates.length !== 1)
    throw new Error(
      "The ZIP must contain exactly one project web-app.json. Repositories without a manifest must be adapted before import.",
    );
  const prefix = candidates[0].name.slice(0, -"web-app.json".length),
    stage = path.join(os.tmpdir(), "aether-project-import-" + randomUUID());
  await fs.mkdir(stage);
  try {
    for (const entry of entries) {
      if (!entry.name.startsWith(prefix))
        throw new Error("Archive contains files outside its project.");
      const name = entry.name.slice(prefix.length);
      relative(name);
      if (
        name.split("/")[0] === "data" ||
        name
          .split("/")
          .some((p) => ["node_modules", ".git", "runtime"].includes(p)) ||
        name.split("/").some((p) => p.startsWith(".env")) ||
        /\.(jks|keystore|p12)$/.test(name) ||
        ["auth.json", "credentials.json", "local.properties"].includes(
          name.split("/").at(-1),
        )
      )
        throw new Error(
          "Import public app code/assets only; exclude personal data, credentials and dependencies.",
        );
      const offset = entry.offset;
      if (
        offset + 30 > bytes.length ||
        bytes.readUInt32LE(offset) !== 0x04034b50
      )
        throw new Error("Invalid ZIP entry.");
      const contentStart =
        offset +
        30 +
        bytes.readUInt16LE(offset + 26) +
        bytes.readUInt16LE(offset + 28);
      if (contentStart + entry.compressed > start)
        throw new Error("ZIP entry crosses its data boundary.");
      const input = bytes.subarray(
          contentStart,
          contentStart + entry.compressed,
        ),
        content =
          entry.method === 0
            ? input
            : inflateRawSync(input, { maxOutputLength: 12 * 1048576 });
      if (content.length !== entry.expanded || crc(content) !== entry.checksum)
        throw new Error("ZIP integrity check failed.");
      const target = path.join(stage, name);
      await fs.mkdir(path.dirname(target), { recursive: true });
      await fs.writeFile(target, content, { flag: "wx" });
    }
    const definition = validateDefinition(
        JSON.parse(await fs.readFile(path.join(stage, "web-app.json"), "utf8")),
      ),
      app = { definition, directory: stage };
    const build = path.join(stage, "pwa/dist");
    const hasBuild = await fs.stat(path.join(build, "BUILD.json")).then(
      (st) => st.isFile(),
      (error) => {
        if (error.code === "ENOENT") return false;
        throw error;
      },
    );
    if (hasBuild) await verifyAssets(build, definition.id);
    const published = await projects.publish(app);
    // Retain optional verified prebuilt assets only in the private build cache.
    try {
      await fs.access(path.join(build, "BUILD.json"));
      await fs.mkdir(path.join(published.directory, "pwa"), {
        recursive: true,
      });
      await fs.cp(build, path.join(published.directory, "pwa/dist"), {
        recursive: true,
        errorOnExist: true,
        force: false,
      });
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    return published;
  } finally {
    await fs.rm(stage, { recursive: true, force: true });
  }
}
