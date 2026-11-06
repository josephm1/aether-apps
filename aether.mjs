import { renderAppsView, screenTitle } from "./views.mjs";
import { ensureManagedBuild } from "./managed-build.mjs";
import { verifyAssets } from "./managed-files.mjs";
import path from "node:path";
import { creationGuidancePrompt } from "./creation-guidance.mjs";
import { SharedProjects } from "./shared-projects.mjs";
import { importProjectZip } from "./project-import.mjs";
import { installCapabilities } from "./capabilities.mjs";
import { createManagedHost } from "./managed-host.mjs";
import { attachController, detachController } from "./runtime.mjs";

/** Native Script API v2 library: never embeds a WebView to list or edit projects.
 * Activation registers UI and delegated capabilities; builds start only on explicit Open.
 */
export const activateAether = async (api, options = {}) => {
  const host = options.host ?? new SharedProjects(api);
  const closeCapabilities = installCapabilities(api, host);
  const managed = createManagedHost(api);
  const ui = api.ui;
  const state = {
    visible: false,
    busy: false,
    progress: "",
    error: "",
    notice: "",
    rows: [],
    mode: "library",
    app: null,
    files: [],
    page: 0,
    file: null,
    text: "",
    original: "",
    folder: "",
    name: "",
    managedRows: [],
    managedSupported: false,
    managedReason: "",
    uiSupported: false,
    hostingEnabled: true,
    appAiAllowed: true,
    modelChoices: [],
    modelFilter: "",
    modelPreference: {},
  };
  const invalidate = () => api.invalidate();
  const dirty = () => state.file && state.text !== state.original;
  const refresh = async () => {
    state.rows = await host.list();
    try {
      const capability = await managed.capabilities();
      state.uiSupported = capability.nativeUiVersion === 1;
      state.hostingEnabled = capability.enabled !== false;
      state.managedSupported = capability.supported === true;
      state.managedReason = capability.reason || "";
      state.managedRows = state.managedSupported
        ? (await managed.list()).apps || []
        : [];
    } catch (error) {
      state.managedSupported = false;
      state.managedReason = error.message;
    }
  }; // metadata/files only, NEVER start/readiness
  const closeOverlay = () => {
    state.visible = false;
    invalidate();
  };
  const perform = async (work) => {
    if (state.busy) return;
    state.busy = true;
    state.error = "";
    invalidate();
    try {
      await work();
    } catch (error) {
      state.error = String(error.message || error).slice(0, 1200);
    } finally {
      state.busy = false;
      state.progress = "";
      invalidate();
    }
  };
  const mustSave = () => {
    if (dirty())
      throw new Error(
        "This source file has unsaved changes. Save it or choose Discard edits before leaving.",
      );
  };
  const editingRequest = async (app, instruction) => {
    const prompt = `\n\nChange my on-device app “${app.definition.label}”.\nShared project ID: ${JSON.stringify(app.definition.id)}. Use the app_project tool to read/write canonical shared source; the private build cache ${JSON.stringify(app.directory)} is disposable and must not be edited directly.\nApp ID: ${app.definition.id}\n\n${instruction}\n\n${creationGuidancePrompt} Read that project's pwa/HOSTED.md first, then PWA.md/AETHER.md and AGENTS.md if present. Preserve its saved data and launch definition, and follow its rebuild instructions. Do not assume source edits update generated PWA/runtime output automatically.`;
    await api.host.invoke("app.openScreen", { screen: "chat" });
    await api.host.invoke("app.appendDraftInput", { text: prompt });
    api.storage.set("editingApp", {
      id: app.definition.id,
      label: app.definition.label,
      directory: app.directory,
    });
    closeOverlay();
  };
  const controller = {
    async source(args) {
      if (args.action === "create") {
        const app = await host.create(
          args.name || args.id,
          args.template || "app",
        );
        api.storage.set("editingApp", {
          id: app.definition.id,
          label: app.definition.label,
          directory: app.directory,
        });
        return {
          id: app.definition.id,
          next: creationGuidancePrompt,
          starter:
            "Use app_project list/read to inspect the generated app-specific files; reuse the copied SDK and edit only what the requested workflows need.",
        };
      }
      if (args.action === "build") {
        const app = await host.prepare(await host.app(args.id));
        await ensureManagedBuild(app);
        const build = await verifyAssets(
          path.join(app.directory, "pwa/dist"),
          app.definition.id,
        );
        return {
          id: app.definition.id,
          status: "compiled and assets verified; not opened or device tested",
          version: build.version,
          files: Object.keys(build.files).length,
        };
      }
      if (args.action === "list" && !args.id)
        return {
          projects: (await host.list()).map((row) => ({
            id: row.definition.id,
            label: row.definition.label,
          })),
        };
      if (args.action === "list") return { files: await host.files(args.id) };
      if (args.action === "read") return host.read(args.id, args.file);
      if (args.action === "write")
        return host.save(args.id, args.file, args.revision, args.text);
      throw new Error("Unknown source operation.");
    },
    selected: () => api.storage.get("editingApp", null),
    async open(appId = "") {
      state.visible = true;
      state.error = "";
      invalidate();
      await perform(async () => {
        mustSave();
        await refresh();
        state.mode = "library";
        state.app = null;
        if (appId) {
          state.app = await host.app(appId);
          state.mode = "details";
        }
        // app.overlay is global; listing projects needs no host navigation call.
      });
    },
    async pause() {
      managed.cancel();
    },
    async shutdown() {
      managed.cancel();
      closeOverlay();
    },
  };
  attachController(controller);
  api.registerAction("open-apps", () => controller.open());
  api.registerAction("close-apps", async () => {
    if (dirty()) {
      state.error = "Save or discard the unsaved source edit before closing.";
      invalidate();
      return;
    }
    managed.cancel();
    closeOverlay();
  });
  api.registerAction("refresh-library", () => perform(refresh));
  api.registerAction("library", () =>
    perform(async () => {
      mustSave();
      state.mode = "library";
      state.app = null;
      await refresh();
    }),
  );
  api.registerAction("details", ({ id }) =>
    perform(async () => {
      mustSave();
      state.app = await host.app(String(id));
      state.mode = "details";
    }),
  );
  api.registerAction("choose-project-folder", () =>
    perform(async () => {
      mustSave();
      await host.chooseRoot();
      await refresh();
    }),
  );
  api.registerAction("import-project-zip", () =>
    perform(async () => {
      mustSave();
      const app = await importProjectZip(api, host);
      if (app) {
        state.notice =
          "Imported editable source into the shared folder. No app or provider request was started.";
        await refresh();
      }
    }),
  );
  api.registerAction("hosting-toggle", ({ enabled }) =>
    perform(async () => {
      await managed.setEnabled(enabled === true);
      await refresh();
    }),
  );
  api.registerAction("add-hosted", ({ id }) =>
    perform(async () => {
      mustSave();
      const app = await host.app(String(id));
      const prepared = await host.prepare(app);
      const grants = api.storage.get("appGrants", {});
      grants[app.definition.id] = prepared.definition.capabilities || {};
      api.storage.set("appGrants", grants);
      const result = await managed.add(prepared);
      state.notice = result.shortcut?.requested
        ? "Added and opened. Confirm the single Android home-icon request if shown. Storage and AI initialize automatically."
        : "Added and opened; no browser, pairing or server setup is needed. The launcher did not confirm a home icon; it can be requested under Advanced.";
      closeOverlay();
    }),
  );
  api.registerAction("open-hosted", ({ id }) =>
    perform(async () => {
      mustSave();
      state.progress = "Checking shared source for changes…";
      invalidate();
      const app = await host.prepare(await host.app(String(id)));
      state.progress =
        "Preparing " + app.definition.label + " and opening its local build…";
      invalidate();
      await managed.open(app);
      closeOverlay();
    }),
  );
  api.registerAction("advanced", ({ id }) =>
    perform(async () => {
      mustSave();
      state.app = await host.app(String(id));
      state.mode = "advanced";
    }),
  );
  api.registerAction("review-access", ({ id }) =>
    perform(async () => {
      mustSave();
      state.app = await host.app(String(id));
      state.mode = "permissions";
    }),
  );
  api.registerAction("library-settings", () => {
    mustSave();
    state.mode = "library-settings";
    invalidate();
  });
  api.registerAction("back-page", () =>
    perform(async () => {
      mustSave();
      const current = state.mode;
      state.mode =
        current === "editor"
          ? "source"
          : ["model-picker", "effort-picker"].includes(current)
            ? "ai-settings"
            : ["source", "details", "permissions", "ai-settings"].includes(
                  current,
                )
              ? "advanced"
              : "library";
      if (current === "editor") {
        state.file = null;
        state.text = "";
        state.original = "";
      }
      if (state.mode === "library") await refresh();
    }),
  );
  api.registerAction("ai-settings", () =>
    perform(async () => {
      state.modelPreference =
        api.storage.get("appModelPreferences", {})[state.app.definition.id] ||
        {};
      state.appAiAllowed =
        api.storage.get("appAiEnabled", {})[state.app.definition.id] !== false;
      state.modelChoices =
        (await api.services.invoke("model_access", "catalog")).models || [];
      state.modelFilter = "";
      state.mode = "ai-settings";
    }),
  );
  api.registerAction("show-models", () => {
    state.mode = "model-picker";
    state.modelFilter = "";
    invalidate();
  });
  api.registerAction("show-efforts", () => {
    state.mode = "effort-picker";
    invalidate();
  });
  api.registerAction("hosted-ai-toggle", ({ checked }) =>
    perform(async () => {
      await managed.permission(state.app.definition.id, checked === true);
      state.appAiAllowed = checked === true;
    }),
  );
  api.registerAction("hosting-toggle-ui", ({ checked }) =>
    perform(async () => {
      await managed.setEnabled(checked === true);
      await refresh();
    }),
  );
  const saveModelPreference = async (preference) => {
    await api.services.invoke("model_access", "selection", { preference });
    const saved = api.storage.get("appModelPreferences", {});
    saved[state.app.definition.id] = preference;
    api.storage.set("appModelPreferences", saved);
    state.modelPreference = preference;
    state.mode = "ai-settings";
    state.notice =
      "Saved for this app only. In-flight requests keep their original selection.";
  };
  api.registerAction("app-model-filter", ({ value }) => {
    state.modelFilter = String(value ?? "").slice(0, 200);
    invalidate();
  });
  api.registerAction("app-model-default", () =>
    perform(() => saveModelPreference({})),
  );
  api.registerAction("app-model", ({ key }) =>
    perform(() => saveModelPreference({ modelKey: String(key) })),
  );
  api.registerAction("app-effort", ({ level }) =>
    perform(() =>
      saveModelPreference({
        ...state.modelPreference,
        thinkingLevel: String(level),
      }),
    ),
  );
  api.registerAction("app-effort-default", () =>
    perform(() =>
      saveModelPreference(
        state.modelPreference.modelKey
          ? { modelKey: state.modelPreference.modelKey }
          : {},
      ),
    ),
  );
  api.registerAction("hosted-pin", () =>
    perform(async () => {
      await managed.pin(state.app.definition.id);
      state.notice =
        "Home-icon request sent to Android; confirmation remains with the launcher.";
    }),
  );
  api.registerAction("hosted-ai", ({ allowed }) =>
    perform(async () => {
      await managed.permission(state.app.definition.id, allowed === true);
      state.notice =
        "App AI permission updated. No account/model settings were changed.";
      await refresh();
    }),
  );
  api.registerAction("source", ({ id }) =>
    perform(async () => {
      mustSave();
      state.app = await host.app(String(id));
      state.files = await host.files(state.app.definition.id);
      state.page = 0;
      state.file = null;
      state.text = "";
      state.original = "";
      state.mode = "source";
    }),
  );
  api.registerAction("files-page", ({ delta }) =>
    perform(async () => {
      mustSave();
      state.page = Math.max(
        0,
        Math.min(
          Math.max(0, Math.ceil(state.files.length / 20) - 1),
          state.page + (Number(delta) || 0),
        ),
      );
      state.file = null;
    }),
  );
  api.registerAction("read-source", ({ file }) =>
    perform(async () => {
      mustSave();
      const result = await host.read(state.app.definition.id, String(file));
      if (Buffer.byteLength(result.text) > 32768)
        throw new Error(
          "Native editor limit is 32 KiB to bound UI snapshots. Use Change with Aether or the app_project tool for this larger file. It was not truncated or edited.",
        );
      state.file = result;
      state.text = result.text;
      state.original = result.text;
      state.mode = "editor";
    }),
  );
  api.registerAction("source-text", ({ value }) => {
    if (!state.file) return;
    const text = String(value ?? "");
    if (Buffer.byteLength(text) > 32768) {
      state.error =
        "Native editor limit is 32 KiB; the oversized edit was not accepted.";
      invalidate();
      return;
    }
    state.text = text;
  });
  api.registerAction("save-source", () =>
    perform(async () => {
      if (!state.file) throw new Error("Choose a file first.");
      const result = await host.save(
        state.app.definition.id,
        state.file.file,
        state.file.revision,
        state.text,
      );
      state.file.revision = result.revision;
      state.original = state.text;
      state.notice =
        "Saved with revision/conflict protection and the existing Apps backup. Open recompiles changed source automatically; the previous hosted version remains if compilation fails.";
    }),
  );
  api.registerAction("discard-source", () => {
    state.text = state.original;
    state.error = "";
    invalidate();
  });
  api.registerAction("edit-with-aether", ({ id }) =>
    perform(async () => {
      mustSave();
      await editingRequest(await host.app(String(id)), "Requested change: ");
    }),
  );
  api.registerAction("show-add", () =>
    perform(async () => {
      mustSave();
      state.mode = "add";
      state.folder = "";
      state.name = "";
    }),
  );
  api.registerAction("adapt-repository", () =>
    perform(async () => {
      const url = new URL(state.folder.trim());
      if (
        url.protocol !== "https:" ||
        url.hostname !== "github.com" ||
        url.username ||
        url.password ||
        url.search ||
        url.hash ||
        !/^\/[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+\/?$/.test(url.pathname)
      )
        throw new Error(
          "Use a public https://github.com/owner/repository URL.",
        );
      await api.host.invoke("app.appendDraftInput", {
        text:
          "\n\nCreate an editable local web app based on " +
          url.href +
          ". " +
          creationGuidancePrompt +
          " Inspect its source and licences, preserve its actual workflows, and adapt it to the generic Apps contract without a web server or per-app provider login. Use app_project create/list/read/write for shared source; generated builds/dependencies stay private. Request only necessary app capabilities; preserve applicable licences and report unsupported workflows. This prepares a draft only; do not run app/device tests or paid background calls.",
      });
      await api.host.invoke("app.openScreen", { screen: "chat" });
      closeOverlay();
    }),
  );
  api.registerAction("folder-text", ({ value }) => {
    state.folder = String(value ?? "").slice(0, 2000);
  });
  api.registerAction("name-text", ({ value }) => {
    state.name = String(value ?? "").slice(0, 64);
  });
  for (const template of ["app", "notes", "blank"])
    api.registerAction("create-" + template, () =>
      perform(async () => {
        await host.create(state.name, template);
        state.mode = "library";
        state.notice =
          "Created and registered the source project without starting it.";
        await refresh();
      }),
    );
  api.registerAction("finish-editing", () => api.storage.delete("editingApp"));

  const button = (label, action, args = {}, extra = {}) =>
    ui.button(label, action, {
      args,
      enabled: !state.busy,
      tone: "neutral",
      ...extra,
    });
  const row = (children) =>
    ui.row(children, { wrap: true, rowSpacing: 8, width: "fill" });
  const renderContent = () => renderAppsView({ api, state, button, row });
  api.registerComposerMenuItem({
    id: "apps",
    title: "Apps",
    subtitle: "Native library · offline PWAs · editable source",
    icon: "code",
    order: 35,
    action: "open-apps",
  });
  api.registerSurface("drawer.header", {
    id: "apps-library",
    order: 35,
    render: () =>
      ui.button("Apps", "open-apps", {
        icon: "code",
        tone: "neutral",
        width: "fill",
      }),
  });
  api.registerSurface("app.overlay", {
    id: "apps-workspace",
    order: 90,
    render: () =>
      !state.visible
        ? null
        : !state.uiSupported
          ? ui.column(
              [
                ui.text(
                  state.busy
                    ? "Opening Apps…"
                    : "This Apps version needs the matching host UI update.",
                ),
                ui.button("Close Apps", "close-apps"),
              ],
              {
                height: "fill",
                width: "fill",
                background: "background",
                padding: 24,
              },
            )
          : ui.node("screen", {
              id: "apps-" + state.mode + (state.app?.definition.id || ""),
              title: screenTitle(state.mode),
              backAction: state.mode === "library" ? "" : "back-page",
              closeAction: "close-apps",
              enabled: !state.busy,
              children: [
                ...(state.busy
                  ? [
                      ui.card(
                        [
                          ui.progress(),
                          ui.text(state.progress || "Working…", {
                            style: "small",
                          }),
                        ],
                        { radius: 16 },
                      ),
                    ]
                  : []),
                ...(state.error
                  ? [
                      ui.card(
                        [
                          ui.text("Couldn’t complete this action", {
                            weight: "semibold",
                          }),
                          ui.text(state.error),
                        ],
                        { tone: "error", radius: 20 },
                      ),
                    ]
                  : []),
                ...(state.notice
                  ? [ui.text(state.notice, { style: "small", color: "muted" })]
                  : []),
                ...renderContent(),
              ],
            }),
  });
  api.registerSurface("chat.composer.top", {
    id: "editing-app",
    order: 35,
    render: (context) => {
      const selected = context.storage.editingApp;
      if (!selected) return null;
      return ui.card(
        [
          ui.text("Working on " + selected.label),
          row([
            button("Open Apps", "open-apps"),
            button("Finish", "finish-editing"),
          ]),
        ],
        { radius: 16 },
      );
    },
  });
  api.registerSettings({
    id: "apps",
    title: "Apps",
    subtitle: "Native library · offline PWAs",
    icon: "code",
    order: 35,
    sections: [
      {
        title: "Your app projects",
        settings: [
          {
            id: "open",
            type: "button",
            label: "Open native app library",
            action: "open-apps",
          },
          {
            id: "hosting-on",
            type: "button",
            label: "Enable optional native hosting",
            action: "hosting-toggle",
            args: { enabled: true },
          },
          {
            id: "hosting-off",
            type: "button",
            label: "Disable native hosting",
            action: "hosting-toggle",
            args: { enabled: false },
          },
          {
            id: "storage",
            type: "label",
            label:
              "Shared projects keep source and data in your chosen folder; private build caches are disposable. This version uses the shared project format only.",
          },
        ],
      },
    ],
  });
  return async () => {
    detachController(controller);
    await closeCapabilities();
    await controller.shutdown();
  };
};
