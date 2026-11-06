# App starter

This working static template already has a responsive Material-style shell, host
colors, accessible controls, loading/error/retry states and shared-folder records.
It performs no AI call, tool discovery, network update or background polling.

Customize index.html, styles.css and app.mjs for the requested workflows. Keep the
SDK modules intact unless the SDK itself needs a deliberate generic improvement.
Use LocalStore for records; generated output stays disposable. The example list
loads only 50 summaries; implement pagination/filtering appropriate to the real app.

The default manifest enables storage only. If AI is needed, explicitly enable the
AI capability in web-app.json and review it in Apps before use. Import selection
and complete from aether-sdk.mjs only on the relevant user action. Model/thinking
choices live in Apps → Advanced and authentication remains private. Send no tool
schemas by default; add only necessary, implemented app tools with clear behavior.

Use app_project read/write with revisions to edit source and action build to compile
and verify static output, then Add/Open through Apps. No npm installation, Python,
Node server or manual runtime setup is needed for this template. Preserve licences
when adapting other projects. SDK-LICENSE.txt contains the copied SDK's licence;
it does not assign a new licence to unrelated imported code.

Use browser history for routes or handle the cancelable `aether:back` window event for local detail views. Claim the event only when handling it; unhandled Back exits the hosted window at its root.
