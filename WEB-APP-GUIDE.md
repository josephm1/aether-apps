# Creating and adapting web apps for Aether

Use this guide when generating a web app or adapting an existing project into one.
It contains common design and implementation guidance, not app-specific requirements.
Inspect the current SDK and project instructions; use only APIs that actually exist.

## Start from the reusable scaffold

- Create with app_project template app for the standard shell, accessible controls,
  shared persistence, loading/errors and SDK files. Read and customize the relevant
  generated modules; do not spend context reproducing SDK/boilerplate source.
- When adapting a repository, preserve its useful existing components and replace
  only the incompatible boundaries. Reuse the scaffold/SDK where helpful rather
  than forcing an unnecessary rewrite. Enable AI/tools only when required.

## Choose a suitable browser architecture

- Identify the essential user workflows, data formats, resources and licences before
  changing an existing project. Map server-dependent features to supported browser
  or host capabilities; state gaps instead of presenting a partial port as complete.
- Prefer a static browser app. Keep domain logic, filtering, calculations, rendering
  and record handling in web code. Reuse the extension's generic SDK for storage,
  AI and permitted tools. Do not require a local web server or separate app package.
- Request only capabilities the app needs. Do not introduce native changes, broad
  shell access or a new service when existing web/SDK functionality is sufficient.
- Separate editable source/resources, generated outputs, dependencies and user data.
  Preserve licences and required corresponding source when adapting other projects.

## Make the first useful screen inexpensive

- Define the smallest data set needed for the first visible screen. Render its shell
  immediately, then hydrate those records. Optional data must not block navigation.
- Batch related reads with getMany/readView. Use summaries and bounded lists instead
  of reading every record or loading a whole collection to obtain names and counts.
- Defer large datasets, search indexes, document viewers, graphs, Settings and AI
  controls until an action needs them. Lazy-import heavy modules as well as data.
- Reuse validated data and derived indexes in memory while the view is open. Share
  one initialization promise to prevent duplicate work; reset a failed promise so
  an explicit retry can succeed. Avoid speculative background prefetching.
- Keep expensive parsing/search/computation off the UI thread when warranted. Use
  the SDK's narrow worker relay rather than creating an unrestricted host bridge.
- Use public host theme metadata when available, with a local fallback. Do not make
  a host request merely to paint the screen if that information is already available.

## Use shared storage safely and efficiently

- Use the supplied LocalStore APIs for authoritative records in the app's granted
  shared project folder. Let the web SDK handle indexes, transactions and hashes;
  do not hand-edit its internal files or hardcode filesystem paths/session tokens.
- Keep browser state for transient UI and small appearance preferences. Do not create
  a second persistent copy of authoritative records to mask slow storage access.
- Seed missing bundled resources on demand with onlyAbsent protection. Preserve
  existing edits; report malformed records instead of silently resetting them.
- Use revision-checked writes and batch related changes. Surface conflicts and allow
  explicit recovery. Failed updates must retain the last valid data.
- Use bounded sequential streams for large files and inline reads for small records
  through the SDK. Avoid repeated offset reads that reopen and skip through a file.
- Respect SDK file/record/batch limits. Keep credentials in Aether's private host
  state, never in web code, browser storage, shared data or exports.

## Keep AI integration small and explicit

- Use the SDK with the explicit per-app selection (or Aether's default), reasoning effort and existing
  authentication. Do not copy credentials, substitute models or add another login.
- Keep local features independent of AI. Query model metadata, discover tools and
  request completions only when the relevant screen or explicit action needs them.
- Send concise task instructions, relevant state/excerpts and necessary tool schemas
  or results. Do not attach unrelated chats, coding instructions, Skills, MCP tools,
  complete datasets or whole document collections by default.
- Select/search content locally before sending it. A remote model cannot read a
  local folder unless implemented, permitted tools supply the relevant contents.
- Prefer local logic for deterministic tasks. Bound context, output, concurrency
  and any app-managed tool loop. Support cancellation and explicit retry without
  silently repeating potentially billed requests. Never log private payloads.

## Design clear, usable interactions

- Follow Material 3 patterns and host colors, with semantic controls, readable text,
  accessible labels, visible focus, adequate touch targets and responsive layouts.
- Show actual loading stages and distinguish local reads, network updates and AI.
  Use determinate progress only with real totals; otherwise use an honest busy state.
- Prevent duplicate submissions, restore controls on failure and keep useful content
  visible while waiting. Offer cancellation only where it actually works.
- Give substantial primary content its own page with reliable scrolling and a clear
  return path. Reserve dialogs for short, focused tasks; check viewport and keyboard
  behavior. Preserve drafts, scroll position and focus when returning.
- Avoid redundant navigation bars and permanently prominent occasional-use controls.
  Put advanced settings and import/export where they remain discoverable.

## Build and verify the resulting app

- Rebuild generated output after source changes. Verify source and asset hashes;
  include all transitive SDK modules in builders and imports. Reuse valid prebuilt
  output when source is unchanged; keep the prior build if compilation fails.
- Test actual built modules and UI, not a second implementation. Cover minimal first
  load, first deferred action, repeated use, save/reopen and meaningful error paths.
- Check missing/damaged data, external edits, failed updates and explicit retry.
  Confirm optional datasets and AI/network requests stay unused before needed.
- Measure startup phases separately. Distinguish bridge messages, file operations,
  network traffic and UI-thread work. Optimize measured bottlenecks; desktop fixtures
  are not device timing. Check real target viewport and host behavior when authorized.
- Report what is implemented and tested, alongside remaining gaps. A successful
  package/build does not establish working workflows or full original-project parity.

## Navigation and real viewport checks

- Hosted apps open in their own Android document task and retain the same scoped
  storage/AI bridge. Use browser history for routes; Back follows that history.
- For local detail views without routes, listen for the cancelable window event
  `aether:back`. Call preventDefault only when handling Back, then use the same
  local action as your visible Back control. Native hosting closes open HTML
  dialogs first, then asks this handler, then uses browser history or exits.
  Keep handlers synchronous; start asynchronous saving only after claiming Back.
- A full-screen shell can use position:fixed and inset:0 with scrolling children.
  Verify actual rendered bounds after attachment and resize; some embedded
  WebViews can report zero for CSS viewport-height units despite a nonzero
  innerHeight. DOM text existing is not evidence that the screen is visible.
- Remove layout reservations when removing a toolbar or footer. Test keyboard
  resize and Back from details, routes and the root without clearing user data.

When AI controls are needed, show the selected model and thinking level together
in a compact, accessible composer control. Read `ai.selection` once through a
shared in-flight/cache helper instead of querying from every UI fragment. Let
`ai.configure` open the trusted chooser (`kind: "thinking"` or `"model"`); do not
invent an editable provider/key form or send arbitrary preferences with requests.
Keep the composer responsive while native selection metadata loads. Avoid large
stretched footer buttons; explicitly test wrapping at narrow widths. Settings
should offer the same controls, and cancellation should not write app settings.

### Large read-only resource libraries (Apps 1.5.6)

Keep immutable, user-owned reference libraries in `<app-id>/resources/`, beside
`source/` and `data/`. They are not static hosted assets, build inputs, or saved
records. The reviewed storage grant permits read-only access to this app's own
resource folder via `sdk/project-resources.mjs` `readResource(path, {sha256})`.
Each file is limited to 8 MiB; requests are bounded to 256 KiB and verified against
the caller's expected content hash. There is no list, write, device-wide path,
network request or AI upload. Load a small bundled title index first, then selected
resources on demand. Resource packs are separate private delivery artifacts and
must include provenance, licences and checksums. Never copy proprietary resources
into public source handoffs or scan the entire library on every app open/write.
