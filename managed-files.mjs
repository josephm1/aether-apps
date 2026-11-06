import fs from "node:fs/promises";
import path from "node:path";
import { createHash } from "node:crypto";
export const hash = (data) => createHash("sha256").update(data).digest("hex");
export function validPath(name) {
  if (
    typeof name !== "string" ||
    name.length > 512 ||
    name.includes("\\") ||
    name.includes("\0") ||
    name.includes(":") ||
    name.split("/").some((p) => !p || p === "." || p === "..")
  )
    throw new Error("Unsafe managed path.");
  return name;
}
// Check every existing parent, including dangling links. realpath alone misses
// links when the final file does not yet exist.
export async function safePath(root, name) {
  validPath(name);
  let current = root;
  for (const part of name.split("/")) {
    current = path.join(current, part);
    try {
      if ((await fs.lstat(current)).isSymbolicLink())
        throw new Error("Managed paths cannot contain symbolic links: " + name);
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
  }
  return current;
}
export async function readRegular(root, name, maximum = 12 * 1048576) {
  const file = await safePath(root, name),
    stat = await fs.lstat(file);
  if (!stat.isFile() || stat.size > maximum)
    throw new Error(
      "Managed file is not regular or exceeds its budget: " + name,
    );
  return fs.readFile(file);
}
export async function verifyAssets(root, appId) {
  const build = JSON.parse(await readRegular(root, "BUILD.json", 1048576));
  const entries = Object.entries(build.files || {});
  if (
    build.app_id !== appId ||
    entries.length < 1 ||
    entries.length > 2048 ||
    !entries.some(([name]) => name === "index.html")
  )
    throw new Error("Wrong or incomplete asset manifest.");
  let total = 0;
  for (const [name, digest] of entries) {
    const bytes = await readRegular(root, name);
    total += bytes.length;
    if (total > 32 * 1048576 || hash(bytes) !== digest)
      throw new Error("Asset integrity/budget failed: " + name);
  }
  return build;
}
