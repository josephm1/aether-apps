# Apps — generic shared web-app projects

An independently installable Aether extension. Example apps live in [aether-webapps](https://github.com/josephm1/aether-webapps). Native host support is developed in [aether-host-support](https://github.com/josephm1/aether-host-support), and is not yet part of upstream Aether.

Requires Node 22+. Run `npm test`, then `python3 package.py` to produce the extension ZIP in `dist/`. Import it through Aether’s extension manager. Native hosting currently requires the Android host-support branch; iOS hosting is not implemented.
Normal Android flow: choose a shared WebApps folder once, create or import a project,
review its requested access, then **Grant access and open**. Later use **Open** or its
Android home icon. Android controls the folder and shortcut confirmation dialogs.
No HTTP server, browser installation, pairing code or app-specific provider login is
required for this path. Native hosting can be disabled without removing projects.

The chosen folder is authoritative:

    WebApps/<app-id>/web-app.json
    WebApps/<app-id>/source/             # editable public code/resources/licences
    WebApps/<app-id>/data/<store>/       # plain JSON index and JSON/blob records
    WebApps/<app-id>/backups/            # previous editor revisions, when present

Choose an accessible **local** folder such as Documents/WebApps or a writable SD-card
subfolder in Android's picker. Android restricts granting some storage roots. The
extension has no hardcoded SD path or broad storage permission. Other apps can inspect
or copy the folder according to their Android grants. Data can contain private learning
or food records; keep it private when transferring source. Credentials remain in Aether's
private native settings. Export/import of app data remains an explicit separate operation.
Changing the selected root does not move or erase projects in the previous root.

Build caches, dependencies, generated static assets and staging are private/disposable.
Source editing through `app_project` or the native Source editor writes the shared files,
with revision checks and prior-source backups. Shared files replace stale private cache copies automatically; edit only the shared source. Missing/malformed shared records stop access rather than resetting data.
This version uses one shared-file storage backend. There is no legacy registry,
IndexedDB fallback, automatic data conversion or bundled-extension migration. Existing
installs and old private data are not read, moved or deleted. Import chosen app-data
backups explicitly through the app's existing format-aware controls. JSON values and
Blob types are retained; `index.json` is web-SDK record metadata, not a new app export schema.
Interrupted unreferenced staging records can remain after process death; there is no
background garbage collector that might remove externally edited data.

## Manifest and creation

A simple project manifest:

```json
{"format":"aether-web-app","version":1,"id":"my-app","label":"My app",
 "entry":"index.html","build":{"type":"static"},
 "capabilities":{"ai":true,"storage":true,"networkOrigins":[],"tools":[]}}
```

Notes and blank templates include the small `sdk/` modules. Aether's `app_project`
tool can create, list, read and revision-check writes to canonical source. It is a
coding tool used while creating apps; it is never injected into web-app inference.
GitHub adaptation drafts an instruction for the existing Aether agent. It does not
synchronize Git, auto-run AI, or promise arbitrary repository compatibility. Server
apps need a deliberate static/browser adaptation before import. Project ZIPs contain
one `web-app.json`, source/resources/licences and optional verified `pwa/dist` assets;
exclude dependencies, credentials and top-level personal `data/`. Duplicate IDs/nonempty
destinations stop import without overwriting them. Partial imports remain visible for
review and are not registered as complete.

Command builds declare `build.type:"command"`, `commands:[{"command":"node",
"args":["pwa/build.mjs"]}]`, optionally `dependencies:"npm-lock"`. They must write a
verified `BUILD.json` and files into `AETHER_BUILD_OUTPUT`. Only Node, Python and npm
launchers are accepted. **Imported build scripts are trusted local code**, with Aether's
filesystem privileges; they are not sandboxed like the hosted web runtime. Inspect an
untrusted repository before opening it. Pure static apps need no command/dependency
install. Generated assets are verified and versioned; failed builds retain prior assets.
No build process remains running after completion/cancellation. Import and cache
preparation preserve the exact manifest bytes, including whitespace, so unchanged
prebuilt assets do not require a toolchain or network. Before a genuine Python
rebuild, the extension probes Python and provisions the Alpine python3 package only
when absent. A failed package download/setup retains the prior assets and reports
the error. It does not ask the user to run server or toolchain setup commands.

## Capabilities and AI

The project's portable web SDK owns record indexes, parsing, hashing, chunking,
transactions and logical quotas. Its `files.*` requests go directly to a generic
Android app-scoped file boundary, without running extension storage handlers. Each
short-lived session is restricted to the reviewed project's `data/` subtree; native
checks isolate paths/handles, revoke changed grants and bound physical storage. The
same record core is reused by extension tools, without a second implementation.
Shared files remain authoritative; there is no browser replica.

The extension owns permission review, resource fetching, tools and AI routing.
The host's generic `documents` service supplies extension-side Android-granted IO. Its generic
`model_access` service supplies selected-model metadata and one completion using
Aether's existing authentication/refresh path. The native adapter is necessary for
cold-start selection/auth access; the existing Pi extension SDK alone only exposes an
active session context. No provider secrets are returned to the browser or extension.
This is an Android host change, not a stock-Aether API. Apps 1.4.8 requires
the matching host with `directFiles:1` and matching project SDK; unsupported hosts
report incompatibility before changing project data. Public theme/app metadata is
injected at document start when supported; Lidl does not request `app.info` on startup.

Use `aether-sdk.mjs`: `selection()`, `complete(context,{maxTokens,signal})`,
`discoverTools()`, `invokeTool(name,args,signal)` and `resource(url,signal)`.
`complete` is a single model step, not an automatic agent loop. An app owns its prompt,
relevant messages and explicit tool schemas/results, and decides which steps to run.
The selected provider/model/effort/config fingerprint must match; unsupported effort
fails rather than silently falling back. No parent chat, Skills, MCP inventory, shell
instructions, book corpus or unrelated extension tools are added by this path.
Budgets reject oversized context rather than quietly truncating it: 128 messages,
16 tool schemas/64 KiB, 900 KB context, 8192 requested output tokens, one app completion
at a time and 60 requests per app per ten minutes. No automatic retries. Closing the
view cancels pending work best-effort; cancellation cannot reverse provider billing.
Aether's existing provider runtime may start on demand; this adds no per-app Alpine
instance, server, polling loop, boot daemon or extra paid backend.

Currently the only optional generic host tool is `project_read`, a single JSON record
up to 32 KiB, requiring **both** `storage:true` and `tools:["project_read"]` in the
reviewed grant. Tools are discovered explicitly. This is not a general plugin/MCP/shell
permission system. Apps may additionally define their own browser-local agent tools.
Resource requests require intersecting reviewed/current manifest HTTPS origins, return
JSON up to 1 MiB, and forward no cookies, keys, authorization headers or redirects.
The document bridge is available only to trusted extensions; the web page sees only
its own app ID's delegated operations. Source imports and extensions are trusted code.

## Packaging, updates and validation

`python3 package.py --output /path/to/output` produces the generic extension only.
App project packaging belongs in the separate web-app repository. This extension
ZIP includes the manager, SDK and starter template only. Install/update it through
Aether’s normal extension importer; no native Gradle task bundles it automatically.

Android compilation, web compilation, source/syntax/integrity checks are distinct from
installation and functional tests. The accompanying release handover records which
stages were actually completed; packaging alone does not establish runtime behavior. iOS native hosting/document/model adapters are not implemented. The
separate LearnHarness adaptation does not have full baseline parity; see its checklist.

Storage reads use short-lived sequential native readers (256 KiB chunks). A token
pins its app/store/project for one bounded operation; private grant revocation is
checked on each request, and new operations re-read the manifest. Reads keep one
document stream open, enforce offsets, close explicitly/on EOF, expire idle handles
on the next document operation and validate SHA-256 in the web client. No polling
service or background daemon is added. Writes retain revision-checked commits and
reject a project-root change before indexing a staged record.

Batched getMany/hasMany select up to 16 records using one checked index/context.
Small JSON records (up to 64 KiB each, within a 512 KiB batch budget) return inline; larger records keep bounded
read sessions. All bodies still pass byte count/SHA-256 checks. There is no persisted
browser data cache, freshness timeout, or stale-data fallback. External file edits
are checked on each new read and update the existing record descriptor safely.

Apps 1.4.7 requires the accompanying host's generic documents.readFile method. It
reads/hashes bounded small files in one native call, verifies the current revision
again, and returns at most 64 KiB inline. Larger JSON up to the caller's bound keeps
the chunked verified read path. No timestamp/TTL cache or silent fallback is used.
readView combines up to 16 selected records and four bounded metadata lists from
one checked index; inline JSON is up to 64 KiB per record and 512 KiB in total,
with an 800,000-byte combined response bound. SHA-256, permissions and CAS writes
remain enforced. Update host, owner and SDK-using projects together.

## Engineering guidance for app creation and adaptation

`WEB-APP-GUIDE.md` contains common creation and adaptation guidance for this setup: shared-folder authority, direct web-owned records, minimal first-view reads,
lazy resources, efficient AI context, accessible Material UI, build freshness and honest
validation. The coding tool `app_project` exposes `action:"guide"` even before Apps
is open. Creation results, edit/adaptation drafts and selected-project coding context
point the agent to it. The full guide is loaded on demand for coding; it is never
added to hosted app inference, copied into every project, or read on web-app startup.

## Per-app model choices and on-device builds

Advanced offers an explicit per-app model and supported thinking-level choice from
Aether's configured/enabled catalog. Default follows Aether. Private extension state
stores only the choice; native resolution uses existing authentication, rejects missing
models/unsupported explicit effort, and pins a fingerprint per request. The web app
cannot supply a preference or credentials. In-flight requests retain their selection.

The coding tool supports `app_project {action:"list"}` to discover projects and
`app_project {action:"build",id:"..."}` to sync canonical source, compile through the
existing generic build adapter and verify assets without opening the app. The library's
Add/Open remains responsible for capability review and activating the output. Errors
return bounded build diagnostics; no desktop-only build path is required by design.
This path was reviewed in code; no live on-device generation/build experiment was run.

## Reusable app scaffold

`app_project create` defaults to `template:"app"`. The packaged templates/app files
provide a working static page, Material-style responsive CSS, host colors, accessible
controls, shared storage and loading/error/retry behavior. New projects copy these
and the SDK automatically; the agent edits app-specific files rather than recreating
boilerplate. Blank and notebook templates remain available. New templates request
no AI, host tools or network access by default; storage is enabled only where used.
Imported projects retain their existing source and licences; the starter is optional
for replacing incompatible boundaries, not a reason to rewrite a working app.


Hosted Android windows have their own Recent apps entries, with one reusable task
per app. Back closes HTML dialogs, then app-local details/routes, then the window.
Use browser history or the documented cancelable `aether:back` event; see
WEB-APP-GUIDE.md. No separate APK, web server or provider login is required.

Hosted apps can request `ai.configure` with `{kind:"thinking"}` or
`{kind:"model"}` after AI access is granted. The extension opens Aether's
trusted native chooser; web arguments cannot supply model keys, effort values,
credentials, or another app ID. Cancel preserves preferences. Choices are private
and app-specific; Follow Aether removes the corresponding override. The extension
warms a bounded in-memory chooser cache after `ai.selection`, and revalidates
project AI access and the native selection before committing. No inference or
external catalogue fetch is performed by these controls.
