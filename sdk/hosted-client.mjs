// Request/reply bridge for the NEW origin-checked host capability. Not a stock API claim.
let workerResourcePort;
export const isHosted = () =>
  typeof globalThis.AetherHosted?.postMessage === "function" ||
  !!workerResourcePort;
const KEY = Symbol.for("aether.hosted.app.channel.v1");
function channel() {
  if (!isHosted())
    throw new Error("This view has no native hosted-app capability.");
  if (globalThis[KEY]) return globalThis[KEY];
  const pending = new Map(),
    bridge = globalThis.AetherHosted;
  bridge.onmessage = (event) => {
    let value;
    try {
      if (typeof event.data !== "string" || event.data.length > 1048576) return;
      value = JSON.parse(event.data);
    } catch {
      return;
    }
    const request = pending.get(value.id);
    if (!request) return;
    pending.delete(value.id);
    request.finish();
    value.ok
      ? request.resolve(value.result)
      : request.reject(
          new Error(value.error || "Aether rejected this app request."),
        );
  };
  const request = (op, args = {}, signal) => {
    if (pending.size >= 8)
      return Promise.reject(new Error("Wait for the current app operation."));
    const id = crypto.randomUUID(),
      text = JSON.stringify({ id, op, args });
    if (new TextEncoder().encode(text).length > 1048576)
      return Promise.reject(
        new Error(
          "Native app request exceeds 1 MiB. No context was silently dropped.",
        ),
      );
    return new Promise((resolve, reject) => {
      let timer;
      const started = performance.now();
      const abort = () => {
        if (!pending.delete(id)) return;
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
        bridge.postMessage(
          JSON.stringify({ id: crypto.randomUUID(), op: "cancel", target: id }),
        );
        reject(new DOMException("App request cancelled", "AbortError"));
      };
      const finish = () => {
        if (op === "files.begin") {
          if (!performance.getEntriesByName("aether.files.firstSession").length)
            performance.measure("aether.files.firstSession", {
              start: started,
              end: performance.now(),
            });
          performance.clearMeasures("aether.files.begin");
          performance.measure("aether.files.begin", {
            start: started,
            end: performance.now(),
          });
        }
        clearTimeout(timer);
        signal?.removeEventListener("abort", abort);
      };
      pending.set(id, { resolve, reject, finish });
      timer = setTimeout(abort, 125000);
      signal?.addEventListener("abort", abort, { once: true });
      if (signal?.aborted) {
        abort();
        return;
      }
      bridge.postMessage(text);
    });
  };
  globalThis[KEY] = { request };
  return globalThis[KEY];
}
export const hostedRequest = (op, args = {}, signal) =>
  workerResourcePort
    ? workerResourcePort(op, args, signal)
    : channel().request(op, args, signal);

// A dedicated port grants a worker scoped storage and resource GETs. It cannot relay AI,
// installer, source, permission or credential operations.
export function relayWorkerResources(worker) {
  if (!isHosted()) return () => {};
  const { port1, port2 } = new MessageChannel(),
    active = new Map();
  port1.onmessage = async ({ data }) => {
    if (data?.cancel) {
      active.get(data.cancel)?.abort();
      return;
    }
    if (
      typeof data?.id !== "string" ||
      !/^[a-f0-9-]{36}$/i.test(data.id) ||
      active.has(data.id)
    )
      return;
    const id = data.id;
    if (active.size >= 4) {
      port1.postMessage({ id, error: "Resource queue is full." });
      return;
    }
    const controller = new AbortController();
    active.set(id, controller);
    try {
      if (data.op !== "resource.fetch" && !/^files\.[a-zA-Z]+$/.test(data.op))
        throw new Error("Worker operation is not granted.");
      if (JSON.stringify(data.args || {}).length > 100000)
        throw new Error("Worker request exceeds its bound.");
      const result = await channel().request(
        data.op,
        data.args,
        controller.signal,
      );
      port1.postMessage({ id, result });
    } catch (error) {
      port1.postMessage({
        id,
        error: error.message || "Resource request failed.",
      });
    } finally {
      active.delete(id);
    }
  };
  worker.postMessage({ type: "aether-resource-port-v1" }, [port2]);
  return () => {
    for (const controller of active.values()) controller.abort();
    active.clear();
    port1.close();
  };
}
export function acceptWorkerResources() {
  globalThis.addEventListener(
    "message",
    (event) => {
      if (
        event.data?.type !== "aether-resource-port-v1" ||
        workerResourcePort ||
        !event.ports[0]
      )
        return;
      const port = event.ports[0],
        pending = new Map();
      port.onmessage = ({ data }) => {
        const item = pending.get(data?.id);
        if (!item) return;
        pending.delete(data.id);
        item.finish();
        data.error
          ? item.reject(new Error(data.error))
          : item.resolve(data.result);
      };
      workerResourcePort = (op, args, signal) =>
        new Promise((resolve, reject) => {
          if (
            (op !== "resource.fetch" && !/^files\.[a-zA-Z]+$/.test(op)) ||
            pending.size >= 4
          ) {
            reject(new Error("Worker operation refused or queue full."));
            return;
          }
          const id = crypto.randomUUID();
          let timer;
          const finish = () => {
            clearTimeout(timer);
            signal?.removeEventListener("abort", abort);
          };
          const abort = () => {
            if (!pending.delete(id)) return;
            finish();
            port.postMessage({ cancel: id });
            reject(
              new DOMException("Resource request cancelled", "AbortError"),
            );
          };
          pending.set(id, { resolve, reject, finish });
          timer = setTimeout(abort, 45000);
          signal?.addEventListener("abort", abort, { once: true });
          if (signal?.aborted) {
            abort();
            return;
          }
          port.postMessage({ id, op, args });
        });
    },
    { once: false },
  );
}
