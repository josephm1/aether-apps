import fs from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { safePath, readRegular } from "./managed-files.mjs";
import { validateDefinition } from "./project-definition.mjs";
import { Documents, digest, relative } from "./documents.mjs";
const omitted = new Set([
  "node_modules",
  ".git",
  "build",
  "dist",
  "runtime",
  "__pycache__",
  ".next",
  ".aether-hosted-backups",
]);
const idOf = (id) => {
  if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id)) throw new Error("Invalid app ID.");
  return id;
};
export class SharedProjects {
  constructor(api) {
    this.api = api;
    this.cache = path.join(
      os.homedir(),
      ".aether",
      "apps",
      "shared-build-cache",
    );
  }
  async root(required = true) {
    let tree = this.api.storage.get("sharedProjectsTree", "");
    if (!tree && required) {
      if (!(await this.chooseRoot()))
        throw new Error("Folder selection cancelled; no project/data changed.");
      tree = this.api.storage.get("sharedProjectsTree", "");
    }
    return tree ? new Documents(this.api, tree) : null;
  }
  async chooseRoot() {
    const result = await this.api.services.invoke("documents", "chooseTree");
    if (result.uri) {
      this.api.storage.set("sharedProjectsTree", result.uri);
      return true;
    }
    return false;
  }
  async project(id) {
    idOf(id);
    const io = await this.root();
    const record = await io.read(id + "/web-app.json", 65536);
    if (!record)
      throw new Error(
        "This app has no shared project manifest. Import a valid project ZIP or create a project first.",
      );
    const definition = validateDefinition(
      JSON.parse(record.bytes.toString("utf8")),
    );
    if (definition.id !== id)
      throw new Error("Shared project identity mismatch.");
    return {
      id,
      io,
      definition,
      manifestBytes: record.bytes,
      manifestVersion: record.version,
    };
  }
  async list() {
    const io = await this.root(false);
    if (!io) return [];
    const rows = [];
    for (const item of await io.list(""))
      if (item.directory && /^[a-z0-9][a-z0-9-]{0,63}$/.test(item.name)) {
        try {
          const p = await this.project(item.name);
          rows.push({
            definition: p.definition,
            directory: path.join(this.cache, p.id),
            shared: true,
            status: "ready",
          });
        } catch (error) {
          rows.push({
            definition: { id: item.name, label: item.name },
            directory: path.join(this.cache, item.name),
            shared: true,
            status: "attention",
            error: error.message,
          });
        }
      }
    return rows;
  }
  async app(id) {
    const p = await this.project(idOf(id));
    return {
      definition: p.definition,
      directory: path.join(this.cache, id),
      shared: true,
    };
  }
  async publish(app) {
    const id = idOf(app.definition.id),
      io = await this.root(),
      exists = await io.stat(id + "/web-app.json", false);
    if (exists.exists)
      throw new Error(
        "A shared project with this ID already exists; import stopped without replacing it.",
      );
    const root = await fs.realpath(app.directory);
    const manifestBytes = await readRegular(root, "web-app.json", 65536);
    const manifestDefinition = validateDefinition(
      JSON.parse(manifestBytes.toString("utf8")),
    );
    if (manifestDefinition.id !== id)
      throw new Error("Imported manifest identity mismatch.");
    let count = 0,
      total = 0;
    const walk = async (dir) => {
      for (const item of await fs.readdir(path.join(root, dir), {
        withFileTypes: true,
      })) {
        if (
          omitted.has(item.name) ||
          item.name.startsWith(".managed-build-") ||
          item.name === "bundle-meta.json" ||
          (dir === "" && item.name === "web-app.json") ||
          (dir === "" && item.name === "data") ||
          item.name.startsWith(".env") ||
          /\.(jks|keystore)$/.test(item.name)
        )
          continue;
        if (item.isSymbolicLink())
          throw new Error(
            "Project source contains a link; review it before import.",
          );
        const name = dir ? dir + "/" + item.name : item.name;
        if (item.isDirectory()) await walk(name);
        else if (item.isFile()) {
          const bytes = await fs.readFile(path.join(root, name));
          total += bytes.length;
          if (
            ++count > 3000 ||
            total > 48 * 1048576 ||
            bytes.length > 12 * 1048576
          )
            throw new Error("Public source exceeds the import budget.");
          await io.write(id + "/source/" + relative(name), bytes, null);
        }
      }
    };
    // Manifest is the commit marker. A partial source copy remains visible but is
    // never registered/opened as complete or overwritten on a subsequent import.
    if ((await io.list(id).catch(() => [])).length)
      throw new Error(
        "The destination is not empty. Existing source/data was retained.",
      );
    await walk("");
    await io.write(id + "/web-app.json", manifestBytes, null);
    return this.app(id);
  }
  async prepare(app) {
    const project = await this.project(app.definition.id),
      root = app.directory;
    await fs.mkdir(root, { recursive: true });
    const statePath = path.join(root, ".shared-source-hashes.json");
    let previous = {};
    try {
      previous = JSON.parse(await fs.readFile(statePath, "utf8"));
    } catch (error) {
      if (error.code !== "ENOENT") throw error;
    }
    const files = await project.io.walk(project.id + "/source"),
      next = {};
    for (const item of files) {
      const name = item.path.slice((project.id + "/source/").length);
      relative(name);
      if (name.split("/").some((part) => omitted.has(part))) continue;
      const info = await project.io.stat(item.path),
        target = await safePath(root, name);
      if (!info.exists || info.directory)
        throw new Error(
          "Shared source changed during preparation: " + name + ". Retry Open.",
        );
      next[name] = info.version;
      let cached = null;
      try {
        const stat = await fs.lstat(target);
        if (stat.isSymbolicLink() || !stat.isFile())
          throw new Error("Build cache must contain regular files: " + name);
        cached = await fs.readFile(target);
      } catch (error) {
        if (error.code !== "ENOENT") throw error;
      }
      // The shared folder is authoritative. A private cache is never an editable
      // source location and cannot block updates or require a merge workflow.
      if (!cached || digest(cached) !== info.version) {
        const input = await project.io.read(item.path, 12 * 1048576);
        if (!input || input.version !== info.version)
          throw new Error(
            "Shared source changed during preparation: " +
              name +
              ". Retry Open.",
          );
        await fs.mkdir(path.dirname(target), { recursive: true });
        await fs.writeFile(target, input.bytes);
      }
    }
    for (const name of Object.keys(previous))
      if (!(name in next)) {
        const target = await safePath(root, relative(name));
        await fs.rm(target, { force: true });
      }
    await fs.writeFile(path.join(root, "web-app.json"), project.manifestBytes);
    await fs.writeFile(statePath, JSON.stringify(next));
    return { ...app, definition: project.definition };
  }
  async files(id) {
    const p = await this.project(id);
    return [
      "web-app.json",
      ...(await p.io.walk(id + "/source"))
        .map((item) => item.path.slice((id + "/source/").length))
        .filter((name) => !name.split("/").some((part) => omitted.has(part))),
    ].sort();
  }
  async read(id, file) {
    const p = await this.project(id),
      value = await p.io.read(
        id + "/" + (file === "web-app.json" ? "" : "source/") + relative(file),
        1048576,
      );
    if (!value) throw new Error("Source file no longer exists.");
    return {
      file,
      text: new TextDecoder("utf-8", { fatal: true }).decode(value.bytes),
      revision: value.version,
    };
  }
  async save(id, file, revision, text) {
    if (
      file === "web-app.json" &&
      validateDefinition(JSON.parse(text)).id !== id
    )
      throw new Error("Keep this project’s ID unchanged.");
    if (Buffer.byteLength(text) > 1048576)
      throw new Error("Source editor limit is 1 MiB.");
    const p = await this.project(id),
      target =
        id + "/" + (file === "web-app.json" ? "" : "source/") + relative(file),
      old = await p.io.read(target, 1048576);
    if ((old?.version || null) !== (revision || null))
      throw new Error("Source changed in another app; reload before saving.");
    if (old)
      await p.io.write(
        id + "/backups/" + randomUUID() + "/" + file,
        old.bytes,
        null,
      );
    const result = await p.io.write(target, text, revision || null);
    return { revision: result.version };
  }
  async create(name, template = "app") {
    name = String(name || "").trim();
    if (!name || name.length > 64)
      throw new Error("Choose a name up to 64 characters.");
    const io = await this.root(),
      base =
        name
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 48) || "my-app";
    let id = base;
    const existing = new Set(
      (await this.list()).map((row) => row.definition.id),
    );
    for (let n = 2; existing.has(id) || (await io.stat(id, false)).exists; n++)
      id = base + "-" + n;
    const definition = {
      format: "aether-web-app",
      version: 1,
      id,
      label: name,
      kind: "web",
      pwa: true,
      entry: "index.html",
      build: { type: "static" },
      capabilities: {
        ai: false,
        storage: template !== "blank",
        networkOrigins: [],
        tools: [],
      },
    };
    const source = path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "sdk",
    );
    for (const filename of await fs.readdir(source))
      await io.write(
        id + "/source/" + filename,
        await fs.readFile(path.join(source, filename)),
        null,
      );
    const html =
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>' +
      name.replace(/[<>&"']/g, "") +
      "</title><style>body{font:18px system-ui;margin:24px;background:#fffbfe;color:#1c1b1f}button,textarea{font:inherit;min-height:48px}textarea{display:block;width:95%;min-height:160px}button{margin-top:12px;padding:8px 24px}p{white-space:pre-wrap}</style><h1>" +
      name.replace(/[<>&"']/g, "") +
      '</h1><label>Local notes<textarea id="notes"></textarea></label><button id="save">Save in project folder</button><p id="status" role="status"></p><script type="module">import {LocalStore} from "./db.mjs"; const db=new LocalStore("notes"); const notes=document.getElementById("notes"),save=document.getElementById("save"),feedback=document.getElementById("status"); try{notes.value=await db.get("state","notes")||"";}catch(e){feedback.textContent=e.message;} save.onclick=async()=>{try{await db.put("state","notes",notes.value);feedback.textContent="Saved";}catch(e){feedback.textContent=e.message;}};</script></html>';
    const blank =
      '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>My app</title><style>body{font:18px system-ui;margin:24px;background:#fffbfe;color:#1c1b1f}button{font:inherit;min-height:48px}</style><h1>My app</h1><p>Edit this project with Aether. Import capabilities from ./aether-sdk.mjs when needed.</p></html>';
    if (template === "app") {
      const directory = new URL("./templates/app/", import.meta.url);
      for (const filename of await fs.readdir(directory)) {
        let text = await fs.readFile(new URL(filename, directory), "utf8");
        if (filename === "index.html")
          text = text.replaceAll("My app", name.replace(/[<>&"']/g, ""));
        await io.write(id + "/source/" + filename, text, null);
      }
    } else
      await io.write(
        id + "/source/index.html",
        template === "blank" ? blank : html,
        null,
      );
    await io.write(
      id + "/source/SDK-LICENSE.txt",
      await fs.readFile(new URL("./LICENSE", import.meta.url)),
      null,
    );
    await io.write(
      id + "/web-app.json",
      JSON.stringify(definition, null, 2),
      null,
    );
    return this.app(id);
  }
}
