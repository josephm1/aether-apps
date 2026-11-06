import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import appsExtension from "../agent.mjs";
import {
  attachController,
  detachController,
} from "../runtime.mjs";
import { creationGuidancePrompt } from "../creation-guidance.mjs";

test("coding guide works without Apps open and stays out of unrelated context", async () => {
  const hooks = new Map(),
    tools = new Map();
  appsExtension({
    registerTool: (tool) => tools.set(tool.name, tool),
    registerCommand() {},
    on: (event, handler) => hooks.set(event, handler),
  });
  const tool = tools.get("app_project");
  assert.ok(tool.parameters.properties.action.enum.includes("guide"));
  const result = JSON.parse(
    (await tool.execute("test", { action: "guide" })).content[0].text,
  );
  assert.equal(result.file, "WEB-APP-GUIDE.md");
  assert.equal(
    result.text,
    await fs.readFile("WEB-APP-GUIDE.md", "utf8"),
  );
  for (const topic of ["LocalStore", "onlyAbsent", "Material", "revision", "AI"])
    assert.ok(result.text.includes(topic), topic);
  assert.ok(!/e-ink|Lidl|LearnHarness|adb|signer|Huion/i.test(result.text));
  assert.equal(hooks.get("before_agent_start")(), undefined);
  const controller = {
    selected: () => ({
      id: "test-app",
      label: "Test app",
      directory: "/private/disposable-cache",
    }),
  };
  attachController(controller);
  try {
    const context = hooks.get("before_agent_start")().message.content;
    assert.ok(context.includes(creationGuidancePrompt));
    assert.ok(
      !context.includes(result.text),
      "full guide is not injected every turn",
    );
  } finally {
    detachController(controller);
  }
  await assert.rejects(
    tool.execute("test", { action: "list", id: "test-app" }),
    /Open Apps first/,
  );
});
