# ChatGPT Sites for Pi Durable

Manage Sites, save committed source and deploy explicitly as private or shared. The `sites` facade includes access, environment, domains, analytics, diagnostics, database and schedules. `sites_documentation` provides bounded guides and current operation schemas.

Register ordinary Durable tools. Code and Notebook discover them automatically.

```ts
import { NodeExecutionEnv } from "@earendil-works/pi-durable/env/node";
import {
  createNativeSitesProjectCapability,
  createSitesExtension,
} from "@howaboua/pi-durable-sites";

const env = new NodeExecutionEnv({ cwd: projectDirectory });
const project = createNativeSitesProjectCapability(env);
const sites = createSitesExtension({
  models,
  projectForEnvironment: (environment) =>
    environment.id === project.id ? project : undefined,
});
registry.install(sites);
// Select sites in the conversation's extensions and supply env through Harness.
```

Requires Node 22.19 or newer, Git and a host-configured ChatGPT Codex OAuth provider in `Models`. `providerId` defaults to `openai-codex`. Custom provider IDs are accepted only with OAuth and the canonical ChatGPT backend route. No ambient Pi credentials, configurable Responses URLs or automatic login. Optional `fetch` supplies host-owned egress to the fixed Sites endpoint.

The native project capability accepts only Durable's local `NodeExecutionEnv`. Other execution namespaces require an explicitly authorized `SitesProjectCapability` with matching `id`. No filesystem or Git fallback to the host. The capability owns exclusive binding locks, atomic manifest updates and direct-argument Git execution with owned cancellation.

## Use

```json
{}
```

Returns help without authentication or filesystem access. Call `sites_documentation({"topic":"version.save"})` for the current schema. Calls use `{resource, action, params}`. Omitted `project_id` comes from `.openai/hosting.json`. `params.project_dir` selects a project root.

1. Reuse the bound project or call `site.create` once. Commit the returned binding and intended source.
2. Call `version.save` or `version.publish_private` with a clean worktree, including untracked files. These push exact committed HEAD, never caller-supplied commits or archives. Git hooks and automatic publication on push are disabled.
3. Call `deployment.deploy` with `visibility: "private"` or `"shared"` and the saved version ID. The facade never silently chooses shared deployment or widens access.

Side effects are unsafe to replay. A failed or interrupted request can have an uncertain outcome. Inspect remote state before issuing another side effect. When deployment fails after saving, reuse the returned `saved_version_id`. When site creation succeeds but binding persistence fails, recover the returned `project_id` in `.openai/hosting.json` rather than creating another site. An interrupted create can leave `hosting.lock`. Resolve the uncertain operation before removing a stale lock.

Outputs redact credentials and secret environment values. Results are capped at 32 KB and documentation at 16 KB. Schema checks preserve the source facade's unknown-field and required-field validation, not full JSON Schema validation. Source saves rely on remote build fallback. No archive uploader or unattended schedule writer is supplied.

Offline validation uses real Durable Harness, Models OAuth fixtures and temporary Git repositories. It does not establish live account access, provider compatibility or deployment success.
