import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { safePath, verifyAssets, readRegular } from "./managed-files.mjs";
import { spawn } from "node:child_process";
const jobs = new Set();
export function cancelManagedBuilds() {
  for (const controller of jobs) controller.abort();
}
async function run(command, args, cwd, signal, output) {
  return new Promise((resolve, reject) => {
    const env = {};
    for (const key of [
      "PATH",
      "HOME",
      "TMPDIR",
      "TMP",
      "TEMP",
      "LANG",
      "LC_ALL",
      "TZ",
      "PREFIX",
      "LD_LIBRARY_PATH",
      "LD_PRELOAD",
    ])
      if (process.env[key]) env[key] = process.env[key];
    Object.assign(env, {
      AETHER_BUILD_OUTPUT: output,
      NEXT_TELEMETRY_DISABLED: "1",
      ELECTRON_SKIP_BINARY_DOWNLOAD: "1",
      NODE_OPTIONS: "--max-old-space-size=1536",
    });
    const child = spawn(command, args, {
      cwd,
      detached: true,
      stdio: ["ignore", "pipe", "pipe"],
      env,
    });
    let log = "",
      done = false,
      timedOut = false;
    const record = (chunk) => {
      log = (log + String(chunk)).slice(-32768);
    };
    child.stdout.on("data", record);
    child.stderr.on("data", record);
    const kill = () => {
      if (!child.pid) return;
      try {
        process.kill(-child.pid, "SIGTERM");
      } catch {}
      const timer = setTimeout(() => {
        if (done) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      }, 1000);
      timer.unref();
    };
    const timer = setTimeout(() => {
      timedOut = true;
      kill();
    }, 12 * 60000);
    signal.addEventListener("abort", kill, { once: true });
    if (signal.aborted) kill();
    const finish = (error) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      signal.removeEventListener("abort", kill);
      error ? reject(error) : resolve();
    };
    child.once("spawn", () => {
      if (signal.aborted) kill();
    });
    child.once("error", (error) =>
      finish(
        Object.assign(
          new Error("Automatic source build could not start: " + error.message),
          { code: error.code },
        ),
      ),
    );
    child.once("close", (code) => {
      if (child.pid)
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {}
      finish(
        code === 0 && !signal.aborted && !timedOut
          ? null
          : new Error(
              "Automatic source rebuild failed/cancelled; previous hosted assets and app data were retained. " +
                log.slice(-2400),
            ),
      );
    });
  });
}
// Provision only a tool needed by an actual source rebuild. Imported unchanged
// prebuilt apps never enter this path. No server, daemon or provider calls.
let pythonSetup;
async function ensurePython(root, signal, output) {
  try {
    await run("python3", ["--version"], root, signal, output);
    return;
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
  }
  if (!pythonSetup)
    pythonSetup = (async () => {
      try {
        await fs.access("/etc/alpine-release");
        await fs.access("/sbin/apk");
      } catch {
        throw new Error(
          "This runtime cannot provision the declared Python build tool. Existing assets and source were retained.",
        );
      }
      try {
        await run(
          "/sbin/apk",
          ["add", "--no-cache", "python3"],
          root,
          signal,
          output,
        );
      } catch (error) {
        throw new Error(
          "Automatic Python build-tool setup failed. A network connection to the runtime package repository may be needed; previous app assets and data were retained. " +
            error.message,
        );
      }
    })().finally(() => {
      pythonSetup = undefined;
    });
  await pythonSetup;
  await run("python3", ["--version"], root, signal, output);
}
const projects = new Set();
export async function ensureManagedBuild(app) {
  const root = await fs.realpath(app.directory);
  if (projects.has(root)) throw new Error("This project is already compiling.");
  projects.add(root);
  let stage;
  try {
    let manifest;
    try {
      manifest = JSON.parse(
        await readRegular(root, "pwa/dist/BUILD.json", 1048576),
      );
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
      manifest = { source_hashes: {} };
    }
    const actual =
        app.definition.build?.type === "static"
          ? await staticSources(root)
          : await commandSources(root),
      expected = manifest.source_hashes || {};
    const names = Object.keys(actual);
    if (
      names.length === Object.keys(expected).length &&
      names.every((name) => actual[name] === expected[name])
    )
      return;
    const controller = new AbortController();
    jobs.add(controller);
    stage = await safePath(root, "pwa/.managed-build-" + randomUUID());
    try {
      const before =
        app.definition.build?.type === "static"
          ? await staticSources(root)
          : await commandSources(root);
      const spec = app.definition.build;
      if (!spec)
        throw new Error(
          "This project needs a generic build descriptor. Change with Aether can adapt it; source/data were retained.",
        );
      if (spec.type === "static") {
        const inventory = await staticSources(root);
        await fs.mkdir(stage);
        for (const name of Object.keys(inventory)) {
          const target = path.join(stage, name);
          await fs.mkdir(path.dirname(target), { recursive: true });
          await fs.copyFile(path.join(root, name), target);
        }
        const entry = app.definition.entry || "index.html";
        if (entry !== "index.html")
          await fs.copyFile(
            path.join(stage, entry),
            path.join(stage, "index.html"),
          );
        const files = {};
        for (const name of new Set([...Object.keys(inventory), "index.html"]))
          files[name] = createHash("sha256")
            .update(await fs.readFile(path.join(stage, name)))
            .digest("hex");
        const version = createHash("sha256")
          .update(JSON.stringify(files))
          .digest("hex")
          .slice(0, 16);
        await fs.writeFile(
          path.join(stage, "BUILD.json"),
          JSON.stringify({
            app_id: app.definition.id,
            hosted_protocol: 1,
            version,
            files,
            source_hashes: inventory,
          }),
        );
      } else if (spec.type === "command") {
        if (spec.dependencies === "npm-lock") {
          const lock = await readRegular(root, "package-lock.json");
          const fingerprint = createHash("sha256")
            .update(lock)
            .update(process.version + process.platform + process.arch)
            .digest("hex");
          const stamp = path.join(root, ".aether-dependencies");
          const ready = await fs.readFile(stamp, "utf8").catch(() => "");
          const modulesExist = await fs
            .stat(path.join(root, "node_modules"))
            .then(
              (st) => st.isDirectory(),
              () => false,
            );
          if (ready !== fingerprint || !modulesExist) {
            await run(
              "npm",
              [
                "ci",
                "--ignore-scripts",
                "--legacy-peer-deps",
                "--no-audit",
                "--no-fund",
              ],
              root,
              controller.signal,
              stage,
            );
            await fs.writeFile(stamp, fingerprint);
          }
        }

        if (
          !Array.isArray(spec.commands) ||
          !spec.commands.length ||
          spec.commands.length > 4
        )
          throw new Error("Invalid build command list.");
        for (const item of spec.commands) {
          if (
            !["node", "python3", "npm"].includes(item.command) ||
            !Array.isArray(item.args) ||
            item.args.some((a) => typeof a !== "string" || a.includes("\0"))
          )
            throw new Error(
              "Build commands must use the declared Node/Python/npm toolchain.",
            );
          if (item.command === "python3")
            await ensurePython(root, controller.signal, stage);
          await run(
            item.command === "node" ? process.execPath : item.command,
            item.args,
            root,
            controller.signal,
            stage,
          );
        }
      } else throw new Error("Unsupported build descriptor.");
      if (controller.signal.aborted) throw new Error("Build cancelled.");
      const built = await verifyAssets(stage, app.definition.id),
        now =
          app.definition.build?.type === "static"
            ? await staticSources(root)
            : await commandSources(root);
      if (
        Object.keys(now).length !== Object.keys(before).length ||
        Object.keys(now).some((name) => now[name] !== before[name])
      )
        throw new Error(
          "Source changed during compilation; previous assets retained.",
        );
      built.source_hashes = now;
      await fs.writeFile(
        path.join(stage, "BUILD.json"),
        JSON.stringify(built, null, 2),
      );
      const dist = await safePath(root, "pwa/dist"),
        backup = await safePath(
          root,
          "pwa/.aether-hosted-backups/" + randomUUID() + "/previous-dist",
        );
      await fs.mkdir(path.dirname(backup), { recursive: true });
      let moved = false;
      try {
        await fs.rename(dist, backup);
        moved = true;
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      try {
        await fs.mkdir(path.dirname(dist), { recursive: true });
        await fs.rename(stage, dist);
      } catch (error) {
        if (moved) await fs.rename(backup, dist);
        throw error;
      }
    } finally {
      jobs.delete(controller);
    }
  } finally {
    if (stage) await fs.rm(stage, { recursive: true, force: true });
    projects.delete(root);
  }
}

async function staticSources(root) {
  const files = {};
  let total = 0;
  const walk = async (prefix) => {
    for (const entry of await fs.readdir(path.join(root, prefix), {
      withFileTypes: true,
    })) {
      if (
        entry.name.startsWith(".") ||
        [
          "node_modules",
          "pwa",
          "build",
          "dist",
          "data",
          "backups",
          "web-app.json",
        ].includes(entry.name)
      )
        continue;
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink())
        throw new Error("Source link requires review.");
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const bytes = await readRegular(root, name, 12 * 1048576);
        total += bytes.length;
        if (total > 32 * 1048576 || Object.keys(files).length >= 2048)
          throw new Error("Static source budget exceeded.");
        files[name] = createHash("sha256").update(bytes).digest("hex");
      }
    }
  };
  await walk("");
  return files;
}

async function commandSources(root) {
  const files = {};
  let total = 0;
  const walk = async (prefix) => {
    for (const entry of await fs.readdir(path.join(root, prefix), {
      withFileTypes: true,
    })) {
      if (
        entry.name.startsWith(".") ||
        [
          "node_modules",
          "build",
          "dist",
          "runtime",
          "__pycache__",
          "bundle-meta.json",
        ].includes(entry.name)
      )
        continue;
      const name = prefix ? prefix + "/" + entry.name : entry.name;
      if (entry.isSymbolicLink())
        throw new Error("Source link requires review.");
      if (entry.isDirectory()) await walk(name);
      else if (entry.isFile()) {
        const bytes = await readRegular(root, name, 12 * 1048576);
        total += bytes.length;
        if (total > 48 * 1048576 || Object.keys(files).length >= 3000)
          throw new Error("Build-source budget exceeded.");
        files[name] = createHash("sha256").update(bytes).digest("hex");
      }
    }
  };
  await walk("");
  return files;
}
