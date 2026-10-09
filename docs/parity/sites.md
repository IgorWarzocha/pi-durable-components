# Sites parity

Source: `packages/pi-chatgpt-sites` at `69f50cf70e8a7b05c2349be6227f521b6504f80e` in `howaboua-pi-stuff`. The source checkout remains read-only. License and modification notices ship with `packages/sites`.

The ordinary `sites` and `sites_documentation` registrations preserve the structured facade, operation table, fourteen guides, on-demand schemas, bounded results and structured failures. Empty help needs no credentials or filesystem. Code and Notebook discover these registrations without a Sites bridge.

Saving requires clean committed exact HEAD, including the tracked project binding. Caller-supplied commits cannot override it. Deployment visibility remains explicitly private or shared. Creation retains exclusive binding locks and atomic persistence. Failed binding persistence returns the created project ID. Failed publication after saving retains the saved version ID. Side effects have no automatic retries and are unsafe to replay after interruption.

Authentication uses host-configured Models OAuth and the canonical ChatGPT backend. No ambient Pi credential files or arbitrary Responses endpoints are accepted. Filesystem and direct-argument Git operations require an explicit capability matching the conversation environment. The bundled capability accepts Durable's native Node environment. Other namespaces need their own authorized implementation.

## Evidence

Disposable offline checks used a real SQLite Harness, Models OAuth fixtures, a temporary working repository and a local bare Git remote. They exercised exact received HEAD, dirty and forged-input rejection before credentials, binding mismatch, explicit visibility, bearer and basic Git authentication setup, credential redaction, exclusive locks, partial-save recovery and project-ID recovery. Owned cancellation followed by a genuinely reopened Harness did not replay the side effect. Temporary credentials and owned locks were cleaned up.

Package declaration compilation, formatting, bundled import and dry packing passed. No permanent tests were added.

Live Sites entitlement, HTTPS Git service compatibility and deployment success remain unverified. Abrupt process death can leave a binding lock. Resolve the uncertain operation before removing that lock. Source schema checks validate unknown and required fields, not complete JSON Schema semantics. The source's remote-build fallback remains unchanged. No archive uploader or unattended schedule writer is supplied.
