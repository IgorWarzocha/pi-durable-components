# Sites parity

## PR #558 to #570 reconciliation

Read-only comparison of Pi Stuff `84bd5bce..e4aa5bb43c560b722829a5123b3f2e05d3d9a19d` found only Sites changelog and package metadata changes. No service, argument, result or lifecycle implementation changed. The existing ordinary native registrations and structured result boundary remain unchanged.

Source: `packages/pi-chatgpt-sites` at `69f50cf70e8a7b05c2349be6227f521b6504f80e` in `howaboua-pi-stuff`. The source checkout remains read-only. License and modification notices ship with `packages/sites`.

The ordinary `sites` and `sites_documentation` registrations preserve the operation table, fourteen guides, on-demand schemas, bounded results and actionable failures. Empty help needs no credentials or filesystem. Code and Notebook discover these registrations without a Sites bridge.

Saving requires clean committed exact HEAD, including the tracked project binding. Caller-supplied commits cannot override it. Deployment visibility remains explicitly private or shared. Creation retains exclusive binding locks and atomic persistence. Failed binding persistence returns the created project ID. Failed publication after saving retains the saved version ID. Side effects have no automatic retries and are unsafe to replay after interruption.

Authentication uses host-configured Models OAuth and the canonical ChatGPT backend. No ambient Pi credential files or arbitrary Responses endpoints are accepted. Filesystem and direct-argument Git operations require an explicit capability matching the conversation environment. The bundled capability accepts Durable's native Node environment. Other namespaces need their own authorized implementation.

## Evidence

Disposable offline checks used a real SQLite Harness, Models OAuth fixtures, a temporary working repository and a local bare Git remote. They exercised exact received HEAD, dirty and forged-input rejection before credentials, binding mismatch, explicit visibility, bearer and basic Git authentication setup, credential redaction, exclusive locks, partial-save recovery and project-ID recovery. Owned cancellation followed by a genuinely reopened Harness did not replay the side effect. Temporary credentials and owned locks were cleaned up.

Package declaration compilation, formatting, bundled import and dry packing passed. No permanent tests were added.

Live Sites entitlement, HTTPS Git service compatibility and deployment success remain unverified. Abrupt process death can leave a binding lock. Resolve the uncertain operation before removing that lock. Source schema checks validate unknown and required fields, not complete JSON Schema semantics. The source's remote-build fallback remains unchanged. No archive uploader or unattended schedule writer is supplied.

## 2026-10-19 source alignment

Inspected read-only Pi Stuff snapshot `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32` against `036dc876da5afc4ec27b64878ebb1cfb30c8211d`.

Sites and Sites documentation now declare help-backed deferred discovery on their ordinary registrations. Sites uses the concise source description. Empty-call help and live resource/action documentation remain tool-owned, with no Code/Notebook bridge. The source experimental GPT description switch is excluded as Pi prompt policy; it does not alter the native Sites API, namespace-owned project capability or lifecycle.

A disposable real Harness exercised empty Browser, Sites and Sites documentation calls without CDP discovery, OAuth, project access or network traffic. Safety and resource guidance survived the native output boundary. The generic execution contract reader rendered all three as help-backed capability entries. No permanent tests were added.

## 2026-10-26 PR #552 result alignment

Compared read-only source `a06eae4d..1338b66a1067c254fec46746ef96b6bd9456148b`. The Sites facade now returns its selected, redacted provider result directly rather than wrapping it in `ok`, `operation` and `result`. Owned preparation and cleanup remain unchanged. Failures now expose the redacted message, an applicable documentation hint, terms URL and bounded details instead of a second structured error envelope. Oversize-output rejection remains intact.

A disposable Node 26 probe invoked the production facade with a controlled schema and provider response. It confirmed the selected payload is unwrapped while a nested credential is still redacted. No live Site was created or changed. Source guide deltas in this range are formatting-only and do not change the portable guides' behaviour.
