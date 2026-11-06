import fs from "node:fs";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
const root = new URL(".", import.meta.url);
for (const dir of ["", "sdk/"])
  for (const name of fs
    .readdirSync(new URL(dir, root))
    .filter((name) => name.endsWith(".mjs") && name !== "check.mjs")) {
    const file = new URL(dir + name, root),
      result = spawnSync(process.execPath, ["--check", fileURLToPath(file)], {
        stdio: "inherit",
      });
    if (result.status !== 0) process.exit(result.status || 1);
  }
