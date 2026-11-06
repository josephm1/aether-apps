import path from "node:path";
export function validateDefinition(value) {
  if (!value || !/^[a-z0-9][a-z0-9-]{0,63}$/.test(value.id))
    throw new Error("The app needs a valid lowercase ID.");
  if (
    typeof value.label !== "string" ||
    !value.label.trim() ||
    value.label.length > 64
  )
    throw new Error("App names must contain 1–64 characters.");
  if (value.format !== "aether-web-app")
    throw new Error("Import an aether-web-app version 1 project manifest.");
  if (
    value.version !== 1 ||
    !value.build ||
    !["static", "command"].includes(value.build.type)
  )
    throw new Error("Unsupported web-app manifest/build adapter.");
  relativeFile(value.entry || "index.html");
  const caps = value.capabilities || {};
  if (
    typeof caps !== "object" ||
    Array.isArray(caps) ||
    ["ai", "storage"].some(
      (key) => caps[key] !== undefined && typeof caps[key] !== "boolean",
    )
  )
    throw new Error("Invalid app capability flags.");
  if (
    caps.networkOrigins &&
    (!Array.isArray(caps.networkOrigins) ||
      caps.networkOrigins.length > 8 ||
      caps.networkOrigins.some((origin) => {
        try {
          const url = new URL(origin);
          return (
            url.protocol !== "https:" ||
            url.origin !== origin ||
            url.username ||
            url.password ||
            (url.port && url.port !== "443")
          );
        } catch {
          return true;
        }
      }))
  )
    throw new Error("Invalid app network scopes.");
  if (
    caps.tools &&
    (!Array.isArray(caps.tools) ||
      caps.tools.length > 16 ||
      caps.tools.some((tool) => tool !== "project_read"))
  )
    throw new Error("Unsupported app tool declaration.");
  return { ...value, kind: "web", pwa: true };
}

function relativeFile(file) {
  if (
    typeof file !== "string" ||
    !file ||
    path.isAbsolute(file) ||
    /[\\\x00-\x1f]/.test(file) ||
    file.split("/").some((part) => !part || part === "." || part === "..")
  )
    throw new Error("Choose a file inside this app.");
}
