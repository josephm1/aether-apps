import { ProjectFileStore } from "./project-file-store.mjs";
import { isHosted, hostedRequest } from "./hosted-client.mjs";
const MiB = 1024 * 1024;
export const LIMITS = Object.freeze({
  budget: 128 * MiB,
  json: 8 * MiB,
  blob: 32 * MiB,
  records: 2000,
  page: 50,
});
export class LocalStore extends ProjectFileStore {
  constructor(name, limits = {}) {
    super(name, { ...LIMITS, ...limits });
  }
}
export async function readJSONFile(file, max = LIMITS.json) {
  if (file.size > max)
    throw new Error("JSON import exceeds the 8 MiB per-file limit.");
  return JSON.parse(await file.text());
}
export async function download(name, value, type = "application/json") {
  const blob =
    value instanceof Blob
      ? value
      : new Blob(
          [typeof value === "string" ? value : JSON.stringify(value, null, 2)],
          { type },
        );
  if (isHosted()) {
    if (blob.size > 32 * 1048576) throw new Error("Export exceeds 32 MiB.");
    const { transfer } = await hostedRequest("export.begin", {
      name,
      bytes: blob.size,
    });
    try {
      for (let offset = 0; offset < blob.size; offset += 49152) {
        const bytes = new Uint8Array(
          await blob.slice(offset, offset + 49152).arrayBuffer(),
        );
        let binary = "";
        for (const byte of bytes) binary += String.fromCharCode(byte);
        await hostedRequest("export.chunk", {
          transfer,
          offset,
          base64: btoa(binary),
        });
      }
      const result = await hostedRequest("export.finish", { transfer });
      if (!result.saved)
        throw new Error("Export cancelled; local records retained.");
      return;
    } catch (error) {
      await hostedRequest("export.cancel", { transfer }).catch(() => {});
      throw error;
    }
  }
  throw new Error("Open this app through Aether to export files.");
}
export function safeImportName(name) {
  if (/(^|\/)(auth\.json|\.env[^/]*|[^/]*credentials[^/]*)$/i.test(name))
    throw new Error("Authentication/credential files are not imported.");
  return name;
}
