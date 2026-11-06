const key = Symbol.for("aether.apps.controller.v1");
export const activeController = () => globalThis[key];
export const attachController = (controller) => {
  globalThis[key] = controller;
};
export const detachController = (controller) => {
  if (globalThis[key] === controller) delete globalThis[key];
};
