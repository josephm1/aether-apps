import {
  creationGuidancePrompt,
  readCreationGuide,
} from "./creation-guidance.mjs";
import { activeController } from "./runtime.mjs";

export default function appsExtension(pi) {
  pi.registerTool({
    name: "app_project",
    label: "Shared web-app source",
    description:
      "Create, read, list or revision-check shared web-app source. Use create with template app for the reusable working starter; customize its files instead of rewriting boilerplate. First use action guide before creating/adapting/improving an app; it returns the engineering guide without needing Apps open. Use action build after edits to compile and verify output on-device without opening it. List without an id discovers projects. Coding only; never injected into web-app inference.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["guide", "create", "list", "read", "write", "build"],
        },
        id: { type: "string" },
        name: { type: "string" },
        template: { type: "string", enum: ["app", "notes", "blank"] },
        file: { type: "string" },
        revision: { type: ["string", "null"] },
        text: { type: "string" },
      },
      required: ["action"],
      additionalProperties: false,
    },
    execute: async (_call, args) => {
      const result =
        args.action === "guide"
          ? await readCreationGuide()
          : await activeController()?.source(args);
      if (result === undefined) throw new Error("Open Apps first.");
      return { content: [{ type: "text", text: JSON.stringify(result) }] };
    },
  });
  pi.registerCommand("apps", {
    description: "Open your on-device app library",
    handler: async (_args, context) => {
      const controller = activeController();
      if (!controller) {
        context.ui.notify(
          "Enable the Apps script extension in Aether first.",
          "warning",
        );
        return;
      }
      await controller.open();
    },
  });
  pi.on("before_agent_start", () => {
    const app = activeController()?.selected();
    if (!app) return;
    return {
      message: {
        customType: "aether-apps-context",
        display: false,
        content: `The user is working on their local app ${JSON.stringify(app.label)} (ID ${app.id}), with canonical source accessible through app_project. The private build cache at ${JSON.stringify(app.directory)} must not be edited directly. ${creationGuidancePrompt} Follow that project's AETHER.md for source/build/PWA instructions. Keep its saved data and launch definition intact. This is context, not an instruction to edit or start it unless requested.`,
      },
    };
  });
  pi.on("session_shutdown", async () => {
    await activeController()?.pause();
  });
}
