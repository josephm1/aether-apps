import { hostedRequest } from "./hosted-client.mjs";
export { LocalStore } from "./db.mjs";
export const info = () => hostedRequest("app.info");
export const selection = () => hostedRequest("ai.selection");
export const configureAi = (kind = "thinking") => hostedRequest("ai.configure", { kind });
export async function complete(context, { maxTokens = 2048, signal } = {}) {
  const chosen = await selection();
  return hostedRequest(
    "ai.complete",
    {
      context,
      maxTokens,
      expected: {
        provider: chosen.model.provider,
        id: chosen.model.id,
        thinkingLevel: chosen.thinkingLevel,
        selectionId: chosen.selectionId,
      },
    },
    signal,
  );
}
export const discoverTools = () => hostedRequest("tools.discover");
export const invokeTool = (name, args, signal) =>
  hostedRequest("tools.invoke", { name, arguments: args }, signal);
export const resource = (url, signal) =>
  hostedRequest("resource.fetch", { url }, signal);
