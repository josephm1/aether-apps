import https from "node:https";
import { readProjectResource } from "./project-resources.mjs";
import { ProjectStore } from "./project-store.mjs";
const recordsTool = {
  name: "project_read",
  description:
    "Read one JSON record from this app’s shared data folder. No device-wide filesystem access.",
  parameters: {
    type: "object",
    properties: {
      store: { type: "string" },
      kind: { type: "string" },
      id: { type: "string" },
    },
    required: ["store", "kind", "id"],
    additionalProperties: false,
  },
};
export function installCapabilities(api, projects) {
  const storage = new ProjectStore(projects),
    active = new Map(),
    recent = new Map();
  let aiBusy = false, configuring = false;
  const selections = new Map();
  const invoke = (service, method, args = {}) =>
    api.services.invoke(service, method, args);
  const resource = (app, args, signal) =>
    new Promise((resolve, reject) => {
      const url = new URL(args.url);
      if (
        url.protocol !== "https:" ||
        url.username ||
        url.password ||
        url.hash ||
        (url.port && url.port !== "443") ||
        !app.networkOrigins?.includes(url.origin)
      ) {
        reject(
          new Error("This app has not been granted that resource origin."),
        );
        return;
      }
      const request = https.get(
        url,
        {
          headers: {
            Accept: "application/json",
            "Accept-Language": "en",
            "User-Agent": "Aether-Apps/1.4 (explicit local app resource)",
          },
          signal,
          timeout: 30000,
        },
        (response) => {
          if (response.statusCode < 200 || response.statusCode >= 300) {
            response.destroy();
            reject(
              new Error(
                "Resource HTTP request failed; previous records were retained.",
              ),
            );
            return;
          }
          const chunks = [];
          let total = 0;
          response.on("data", (chunk) => {
            total += chunk.length;
            if (total > 1048576) {
              response.destroy(new Error("Resource exceeds 1 MiB."));
              return;
            }
            chunks.push(chunk);
          });
          response.on("error", reject);
          response.on("end", () => {
            try {
              resolve({
                payload: JSON.parse(Buffer.concat(chunks).toString("utf8")),
              });
            } catch (error) {
              reject(error);
            }
          });
        },
      );
      request.on("timeout", () =>
        request.destroy(new Error("Resource request timed out.")),
      );
      request.on("error", reject);
    });
  async function prepareSelection(id, preference, current) {
    current ||= await invoke("model_access", "selection", { preference });
    const catalog = (await invoke("model_access", "catalog")).models || [];
    let model = catalog.find(model => model.key === preference.modelKey);
    if (!model) {
      // Prioritise likely IDs but verify the exact native identity before use.
      const candidates = [...catalog].sort((a,b) => Number(String(b.label).endsWith(" / " + current.model?.id)) - Number(String(a.label).endsWith(" / " + current.model?.id)));
      for (const candidate of candidates) {
        try {
          const resolved = await invoke("model_access", "selection", { preference: { ...preference, modelKey: candidate.key } });
          if (resolved.selectionId === current.selectionId) { model = candidate; break; }
        } catch { /* Unavailable configured models are not fallbacks. */ }
      }
    }
    return { current, catalog, model };
  }
  async function configure(request, signal) {
    if (configuring) throw new Error("Close the current AI picker first.");
    configuring = true;
    const {app,args}=request;
    try {
      if (aiBusy) throw new Error("Wait for the active AI request before changing its selection.");
      const original = api.storage.get("appModelPreferences", {})[app.id] || {};
      const key = JSON.stringify(original);
      const cached = selections.get(app.id);
      const prepared = cached?.key === key && Date.now() - cached.time < 300000
        ? await cached.prepared
        : await prepareSelection(app.id, original);
      const { current, catalog, model } = prepared;
      const kind = args.kind === "model" ? "model" : "thinking";
      let preference;
      if (kind === "model") {
        const options = ["Follow Aether", ...catalog.map((model, i) => `${i + 1}. ${model.label}`)];
        const result = await api.host.invoke("pi_extension_select", { title: `${app.label || app.id}: model`, options });
        if (signal.aborted) throw new Error("Selection cancelled.");
        const index = options.indexOf(result.value);
        if (index < 0) return current;
        preference = index === 0 ? {} : { modelKey: catalog[index - 1].key };
      } else {
        const levels = [...new Set(model?.thinkingLevels || [])];
        if (!levels.length) throw new Error("No supported thinking levels are cached for this model. Refresh the model catalogue in Aether first.");
        const options = ["Follow Aether", ...levels.map(level => `Thinking: ${level}`)];
        const result = await api.host.invoke("pi_extension_select", { title: `${current.model?.name || current.model?.id || app.label || app.id} · Thinking: ${current.thinkingLevel}`, options });
        if (signal.aborted) throw new Error("Selection cancelled.");
        const index = options.indexOf(result.value);
        if (index < 0) return current;
        preference = original.modelKey ? { modelKey: original.modelKey } : {};
        if (index > 0) preference.thinkingLevel = levels[index - 1];
      }
      const project = await projects.project(app.id);
      if (!project.definition.capabilities?.ai) throw new Error("This project no longer requests AI access.");
      const latest = await invoke("model_access", "selection", { preference: original });
      if (latest.selectionId !== current.selectionId) throw new Error("Aether's selection changed. Refresh the selection and choose again.");
      const resolved = await invoke("model_access", "selection", { preference });
      // Only the native picker result writes private preferences; web arguments
      // cannot set model keys, effort, authentication, or another app's choice.
      if (signal.aborted || !api.storage.get("appGrants", {})[app.id]?.ai || api.storage.get("appAiEnabled", {})[app.id] === false)
        throw new Error("App selection was cancelled or AI access was revoked.");
      const saved = api.storage.get("appModelPreferences", {});
      if (JSON.stringify(saved[app.id] || {}) !== JSON.stringify(original)) throw new Error("Selection changed elsewhere. Open the picker again.");
      api.storage.set("appModelPreferences", { ...saved, [app.id]: preference });
      selections.delete(app.id);
      return resolved;
    } finally { configuring = false; }
  }
  async function handle(request, signal) {
    const { app, method, args } = request;
    const reviewed = api.storage.get("appGrants", {})[app.id];
    if (!reviewed)
      throw new Error(
        "Review this app’s capabilities and choose Grant access and open in Apps.",
      );
    if (method === "ai.configure" && selections.has(app.id)) {
      if (!reviewed.ai || api.storage.get("appAiEnabled", {})[app.id] === false) throw new Error("App AI is disabled in Apps.");
      return configure(request, signal);
    }
    // Continuation tokens pin a bounded operation to the project/grant checked
    // at its start. Revoking the private grant still takes effect immediately.
    if (
      /^storage\.(readChunk|readDone|writeChunk|finishWrite|cancelWrite)$/.test(
        method,
      )
    ) {
      if (!reviewed.storage)
        throw new Error("App data access was not granted.");
      return storage.invoke(app.id, method.slice(8), args, signal);
    }
    const project = await projects.project(app.id);
    const requested = project.definition.capabilities || {};
    const grant = {
      ai:
        reviewed.ai &&
        requested.ai &&
        api.storage.get("appAiEnabled", {})[app.id] !== false,
      storage: reviewed.storage && requested.storage,
      networkOrigins: (reviewed.networkOrigins || []).filter((origin) =>
        (requested.networkOrigins || []).includes(origin),
      ),
      tools: (reviewed.tools || []).filter((tool) =>
        (requested.tools || []).includes(tool),
      ),
    };
    if (method.startsWith("storage.") && !grant.storage)
      throw new Error("App data access was not granted.");
    if (method.startsWith("storage."))
      return storage.invoke(app.id, method.slice(8), args, signal, project);
    if (method === "ai.selection") {
      if (!grant.ai) throw new Error("App AI is disabled in Apps.");
      const preference = api.storage.get("appModelPreferences", {})[app.id] || {};
      const current = await invoke("model_access", "selection", { preference });
      const existing = selections.get(app.id);
      const key = JSON.stringify(preference);
      if (!existing || existing.key !== key || existing.selectionId !== current.selectionId || Date.now() - existing.time >= 300000) {
        for (const [id, entry] of selections) if (Date.now() - entry.time >= 300000) selections.delete(id);
        if (selections.size >= 32) selections.delete(selections.keys().next().value);
        const prepared = prepareSelection(app.id, preference, current);
        selections.set(app.id, { key, selectionId: current.selectionId, time: Date.now(), prepared });
        void prepared.catch(() => { if (selections.get(app.id)?.prepared === prepared) selections.delete(app.id); });
      }
      return current;
    }
    if (method === "ai.configure") {
      if (!grant.ai) throw new Error("App AI is disabled in Apps.");
      return configure(request, signal);
    }
    if (method === "ai.complete") {
      if (!grant.ai || aiBusy)
        throw new Error(
          "App AI is disabled or another app completion is active.",
        );
      if (
        !args.context ||
        Buffer.byteLength(JSON.stringify(args.context)) > 900000 ||
        (args.context.messages || []).length > 128 ||
        (args.context.tools || []).length > 16
      )
        throw new Error(
          "App context/tool budget exceeded; no history was silently removed.",
        );
      const now = Date.now(),
        calls = (recent.get(app.id) || []).filter((t) => now - t < 600000);
      if (calls.length >= 60)
        throw new Error("App rolling AI budget reached. No retry was started.");
      calls.push(now);
      recent.set(app.id, calls);
      aiBusy = true;
      // Cancellation uses a request handle so closing an app does not leave a paid
      // completion running. A generic model service supplies selection/auth only.
      const tag = request.requestId;
      try {
        return await invoke("model_access", "complete", {
          ...args,
          preference: api.storage.get("appModelPreferences", {})[app.id] || {},
          caller: app.id,
          request_handle: tag,
        });
      } finally {
        aiBusy = false;
      }
    }
    if (method === "resource.read") {
      if (!grant.storage) throw new Error("App resource access was not granted.");
      return readProjectResource(project, args, signal);
    }
    if (method === "resource.fetch")
      return resource(
        {
          ...app,
          networkOrigins: grant.networkOrigins,
        },
        args,
        signal,
      );
    if (method === "tools.discover")
      return {
        tools:
          grant.storage && grant.tools?.includes("project_read")
            ? [recordsTool]
            : [],
      };
    if (method === "tools.invoke") {
      if (
        !grant.storage ||
        !grant.tools?.includes("project_read") ||
        args.name !== "project_read"
      )
        throw new Error(
          "Tool not granted. No shell/MCP inventory or Alpine tool was enabled.",
        );
      const body = args.arguments || {},
        info = await storage.invoke(app.id, "get", body, signal);
      if (!info.exists)
        return {
          content: [{ type: "text", text: "Record not found." }],
          isError: true,
        };
      if (info.format !== "json" || info.bytes > 32768)
        throw new Error("Select a JSON record up to 32 KiB for this tool.");
      try {
        const value = await storage.invoke(
          app.id,
          "readChunk",
          { ...body, readToken: info.readToken, offset: 0 },
          signal,
        );
        return {
          content: [
            {
              type: "text",
              text: Buffer.from(value.base64, "base64").toString("utf8"),
            },
          ],
        };
      } finally {
        await storage.invoke(
          app.id,
          "readDone",
          { ...body, readToken: info.readToken },
          signal,
        );
      }
    }
    throw new Error(
      "Unsupported app capability. No extra privileges were granted.",
    );
  }
  api.on("hosted_apps.request", (request) => {
    if (typeof request.requestId !== "string" || !request.app?.id) return;
    if (active.size >= 16) {
      void invoke("hosted_apps", "reply", {
        requestId: request.requestId,
        ok: false,
        error: "App capability queue is full. Retry the chosen action.",
      }).catch(() => {});
      return;
    }
    const controller = new AbortController();
    active.set(request.requestId, controller);
    // Do not await in the extension dispatch queue: cancellations and native host
    // replies must remain deliverable while a provider/IO operation is pending.
    void handle(request, controller.signal)
      .then(
        (result) =>
          invoke("hosted_apps", "reply", {
            requestId: request.requestId,
            ok: true,
            result,
          }),
        (error) =>
          invoke("hosted_apps", "reply", {
            requestId: request.requestId,
            ok: false,
            error: String(error.message || error).slice(0, 600),
          }),
      )
      .catch(() => {})
      .finally(() => active.delete(request.requestId));
  });
  api.on("hosted_apps.cancel", ({ requestId }) => {
    active.get(requestId)?.abort();
    void invoke("model_access", "cancel", { request_handle: requestId }).catch(
      () => {},
    );
  });
  return async () => {
    for (const [id, controller] of active) {
      controller.abort();
      void invoke("model_access", "cancel", { request_handle: id }).catch(
        () => {},
      );
    }
    await storage.close();
  };
}
