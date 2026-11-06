// Native Material screens. Rendering stays separate from project/build/AI policy.
export const screenTitle = (mode) =>
  ({
    library: "Apps",
    add: "Add app",
    advanced: "App settings",
    "ai-settings": "AI settings",
    "model-picker": "Choose model",
    "effort-picker": "Thinking level",
    permissions: "App access",
    "library-settings": "Library settings",
    source: "Source files",
    editor: "Edit source",
    details: "About this app",
  })[mode] || "Apps";
export function renderAppsView({ api, state, button, row }) {
  const ui = api.ui,
    id = state.app?.definition.id,
    definition = state.app?.definition;
  const caption = (text) => ui.text(text, { style: "small", color: "muted" });
  const title = (text) =>
    ui.text(text, { style: "subtitle", weight: "semibold" });
  const item = (
    label,
    subtitle,
    action,
    args = {},
    icon = "settings",
    extra = {},
  ) =>
    ui.node("listItem", {
      label,
      subtitle,
      action,
      args,
      icon,
      enabled: !state.busy,
      ...extra,
    });
  const primary = (label, action, args = {}) =>
    button(label, action, args, { tone: "primary", minHeight: 48 });
  const textButton = (label, action, args = {}) =>
    button(label, action, args, { variant: "text", minHeight: 48 });
  const pref = state.modelPreference || {},
    chosen = state.modelChoices.find((m) => m.key === pref.modelKey);
  if (state.mode === "library")
    return [
      row([
        primary("Add app", "show-add"),
        ui.iconButton("refresh", "refresh-library", {
          contentDescription: "Refresh app list",
          enabled: !state.busy,
        }),
        ui.iconButton("settings", "library-settings", {
          contentDescription: "Library settings",
          enabled: !state.busy,
        }),
      ]),
      ...(!state.managedSupported
        ? [
            ui.card(
              [
                title("Native hosting is off"),
                caption("Your source and data are still available."),
                textButton("Library settings", "library-settings"),
              ],
              { radius: 20 },
            ),
          ]
        : []),
      ...(!state.rows.length
        ? [
            ui.card(
              [
                ui.text("Make something useful", { style: "headline" }),
                ui.text(
                  "Start from the app template, import a project, or adapt a repository.",
                ),
                primary("Add your first app", "show-add"),
              ],
              { radius: 24, contentPadding: 24 },
            ),
          ]
        : state.rows.map((app) => {
            const installed = state.managedRows.some(
              (x) => x.id === app.definition.id,
            );
            return ui.card(
              [
                item(
                  app.definition.label,
                  app.error ||
                    (installed ? "Ready to open" : "Ready to set up"),
                  "",
                  {},
                  "extension",
                ),
                row([
                  button(
                    installed ? "Open" : "Set up",
                    installed ? "open-hosted" : "review-access",
                    { id: app.definition.id },
                    {
                      tone: "primary",
                      icon: "play",
                      enabled: state.managedSupported && !state.busy,
                      minHeight: 48,
                    },
                  ),
                  textButton("Settings", "advanced", { id: app.definition.id }),
                ]),
              ],
              { radius: 24, contentPadding: 12, spacing: 4 },
            );
          })),
      caption("Editable apps · source and data stay in your project folder"),
    ];
  if (state.mode === "add")
    return [
      ui.card(
        [
          title("Create an app"),
          ui.text(
            "Start with working storage, layouts and controls. Tell Aether what to change next.",
          ),
          ui.input(state.name, "name-text", {
            id: "new-name",
            placeholder: "App name",
            dispatch: "change",
            singleLine: true,
          }),
          primary("Template", "create-app"),
          row([
            textButton("Notes template", "create-notes"),
            textButton("Blank canvas", "create-blank"),
          ]),
        ],
        { radius: 24, contentPadding: 20 },
      ),
      item(
        "Import a project",
        "Bring an existing Aether app ZIP.",
        "import-project-zip",
        {},
        "add",
      ),
      ui.card(
        [
          title("Adapt a repository"),
          ui.text(
            "Aether prepares an editable app from its source. Review the draft before sending.",
          ),
          ui.input(state.folder, "folder-text", {
            id: "add-folder",
            placeholder: "https://github.com/owner/repository",
            dispatch: "change",
            singleLine: true,
          }),
          button(
            "Prepare adaptation",
            "adapt-repository",
            {},
            { variant: "outlined" },
          ),
        ],
        { radius: 24, contentPadding: 20 },
      ),
    ];
  if (state.mode === "advanced")
    return [
      ui.text(definition.label, { style: "headline" }),
      primary("Open app", "open-hosted", { id }),
      item(
        "AI settings",
        "Model, thinking level and app AI access",
        "ai-settings",
        {},
        "auto",
      ),
      item(
        "Change with Aether",
        "Describe a change to this app",
        "edit-with-aether",
        { id },
        "edit",
      ),
      item(
        "Home-screen icon",
        "Open this app directly from your launcher",
        "hosted-pin",
        {},
        "home",
      ),
      title("Advanced"),
      item(
        "Source files",
        "View and edit the project code",
        "source",
        { id },
        "code",
      ),
      item(
        "Access & permissions",
        "Review what this app can use",
        "review-access",
        { id },
        "settings",
      ),
      item(
        "About this app",
        "Project details and data location",
        "details",
        { id },
        "info",
      ),
    ];
  if (state.mode === "ai-settings")
    return [
      ui.text(definition.label, { style: "title" }),
      ui.switch("Allow AI", state.appAiAllowed, "hosted-ai-toggle", {
        subtitle: "Only explicit app requests can use your account.",
        enabled: !state.busy,
      }),
      item(
        "Model",
        chosen?.label ||
          (pref.modelKey
            ? "Saved model unavailable"
            : "Follow Aether selection"),
        "show-models",
        {},
        "auto",
      ),
      item(
        "Thinking level",
        pref.thinkingLevel || "Follow Aether effort",
        "show-efforts",
        {},
        "settings",
      ),
      caption(
        "Choices apply to this app only. Existing provider authentication is reused; other apps and in-flight requests keep their settings.",
      ),
      ...(!definition.capabilities?.ai
        ? [
            caption(
              "This project does not request AI access. Update its manifest and review access before using AI.",
            ),
          ]
        : []),
    ];
  if (state.mode === "model-picker") {
    const matches = state.modelChoices.filter((m) =>
      m.label.toLowerCase().includes(state.modelFilter.toLowerCase()),
    );
    return [
      ui.input(state.modelFilter, "app-model-filter", {
        id: "app-model-filter",
        placeholder: "Search your configured models",
        dispatch: "change",
        singleLine: true,
      }),
      item(
        "Follow Aether selection",
        "Use the model selected in Aether",
        "app-model-default",
        {},
        "auto",
        { selected: !pref.modelKey },
      ),
      ...matches
        .slice(0, 30)
        .map((m) =>
          item(m.label, "", "app-model", { key: m.key }, "", {
            selected: pref.modelKey === m.key,
          }),
        ),
      caption(
        matches.length > 30
          ? "Showing 30 matches. Keep typing to narrow the list."
          : matches.length + " configured models",
      ),
    ];
  }
  if (state.mode === "effort-picker")
    return [
      item(
        "Follow Aether effort",
        "Use Aether’s current thinking setting",
        "app-effort-default",
        {},
        "settings",
        { selected: !pref.thinkingLevel },
      ),
      ...(chosen?.thinkingLevels || []).map((level) =>
        item(level, "", "app-effort", { level }, "", {
          selected: pref.thinkingLevel === level,
        }),
      ),
      ...(!chosen
        ? [
            caption(
              "Choose a specific model to set a separate thinking level.",
            ),
            textButton("Choose model", "show-models"),
          ]
        : !chosen.thinkingLevels.length
          ? [
              caption(
                "Aether has no supported levels cached for this model. Refresh its model catalog in Aether first.",
              ),
            ]
          : []),
      caption(
        "Unsupported models or levels fail clearly. No automatic substitution.",
      ),
    ];
  if (state.mode === "permissions") {
    const cap = definition.capabilities || {};
    return [
      ui.text(definition.label, { style: "title" }),
      title("Requested access"),
      ui.text(
        cap.storage
          ? "Project data · read and save this app’s records"
          : "No project data access",
      ),
      ui.text(
        cap.ai
          ? "AI · use this app’s selected model when requested"
          : "No AI access",
      ),
      ui.text(
        cap.networkOrigins?.length
          ? "Network · " + cap.networkOrigins.join(", ")
          : "No external resource requests",
      ),
      ui.text(
        cap.tools?.length
          ? "Host tools · " + cap.tools.join(", ")
          : "No host tools",
      ),
      ...(definition.build?.type === "command"
        ? [
            ui.card(
              [
                title("Trust this source before building"),
                ui.text(
                  "Its declared build scripts run locally with Aether’s file access. Only import code you trust.",
                ),
              ],
              { radius: 20 },
            ),
          ]
        : []),
      primary("Grant access and open", "add-hosted", { id }),
      caption(
        "This reviews the listed capabilities. It does not start an AI request.",
      ),
    ];
  }
  if (state.mode === "library-settings")
    return [
      ui.switch("Native hosting", state.hostingEnabled, "hosting-toggle-ui", {
        subtitle: "Open apps in Aether without a web server.",
        enabled: !state.busy,
      }),
      item(
        "Project folder",
        api.storage.get("sharedProjectsTree", "")
          ? "Shared folder selected"
          : "Choose where apps are saved",
        "choose-project-folder",
        {},
        "code",
      ),
      caption(
        "Changing folders leaves existing projects and data in their original location. Source and data remain accessible when hosting is off.",
      ),
    ];
  if (state.mode === "source")
    return [
      ui.text(definition.label, { style: "title" }),
      caption("Editable project source"),
      ...state.files
        .slice(state.page * 20, (state.page + 1) * 20)
        .map((file) =>
          item(
            file.split("/").at(-1),
            file.includes("/")
              ? file.slice(0, file.lastIndexOf("/"))
              : "Project root",
            "read-source",
            { file },
            "code",
          ),
        ),
      row([
        button(
          "Previous",
          "files-page",
          { delta: -1 },
          { variant: "text", enabled: state.page > 0 && !state.busy },
        ),
        caption(`Page ${state.page + 1}`),
        button(
          "Next",
          "files-page",
          { delta: 1 },
          {
            variant: "text",
            enabled: (state.page + 1) * 20 < state.files.length && !state.busy,
          },
        ),
      ]),
      textButton("Change with Aether", "edit-with-aether", { id }),
    ];
  if (state.mode === "editor")
    return [
      title(state.file?.file || "Source"),
      caption(state.text === state.original ? "Saved" : "Unsaved changes"),
      ui.input(state.text, "source-text", {
        id: "source-" + state.file?.file,
        dispatch: "change",
        singleLine: false,
        maxHeight: 480,
      }),
      row([
        primary("Save changes", "save-source"),
        textButton("Discard edits", "discard-source"),
      ]),
      caption("For larger edits, use Change with Aether."),
    ];
  if (state.mode === "details")
    return [
      ui.text(definition.label, { style: "headline" }),
      ui.text(definition.notice || "Editable local web app"),
      title("Project folder"),
      ui.code("WebApps/" + id),
      ui.text(
        "Source and resources are in source/. Saved records are in data/. Generated builds are disposable.",
      ),
      caption(
        "Keep personal records private when sharing or backing up a project.",
      ),
    ];
  return [];
}
