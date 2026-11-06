import fs from "node:fs/promises";

export const creationGuidancePrompt =
  'When creating a web app or adapting an existing project into one, call app_project with {"action":"guide"} and apply the extension\'s WEB-APP-GUIDE.md. It covers minimal startup/lazy resources, web-owned shared-folder records, bounded AI context, accessible Material UI, source/build freshness and validation. For new apps, use app_project create with template app and edit its generated files rather than rewriting the SDK or boilerplate. Read the guide once for this coding task; never attach it to the web app\'s own AI requests.';

export async function readCreationGuide() {
  return {
    file: "WEB-APP-GUIDE.md",
    text: await fs.readFile(
      new URL("./WEB-APP-GUIDE.md", import.meta.url),
      "utf8",
    ),
  };
}
