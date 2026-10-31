# Offer a Durable component marketplace

An app can list these components, inspect their requirements without executing package code, and activate approved packages through one public contract. Howcode uses the same contract. No Howcode package, adapter format or settings path is required.

Release 0.10.0 provides 23 activation entries and three libraries: the component SDK, UI SDK and Settings. Existing package-root APIs remain available for direct integration.

## Discover and inspect

The official catalogue is [marketplace.json](https://raw.githubusercontent.com/IgorWarzocha/pi-durable-components/main/marketplace.json). A release also contains `catalogue.json`. The SDK ships the same data at `@howaboua/pi-durable-components/catalogue.json`. Entries identify exact npm versions. Adding a catalogue does not install or enable its contents.

Install the host SDK with the matching runtime peers:

```sh
npm install @howaboua/pi-durable-components@0.10.0 @earendil-works/pi-durable@1.4.0 @earendil-works/pi-ai@1.4.0 @earendil-works/chord@1.4.0
```

Read remote catalogue data with `parseComponentCatalog`. In a Node host, inspect a chosen entry before installing it:

```ts
import { parseComponentCatalog } from "@howaboua/pi-durable-components";
import { inspectRegistryComponent } from "@howaboua/pi-durable-components/node";

const catalogue = parseComponentCatalog(catalogueData);
const entry = catalogue.components.find(
  (entry) => entry.package === "@howaboua/pi-durable-apply-patch",
);
if (!entry) throw new Error("Component is not in this catalogue");
const verified = await inspectRegistryComponent(entry, { fetch: approvedFetch });
// Show verified.manifest and retain verified.source with the installation record.
```

`approvedFetch` is the host's authorised HTTP implementation. Inspection resolves exact npm metadata, requires SRI integrity, verifies the downloaded bytes, and reads `package/package.json` from the bounded archive. It neither extracts files nor runs npm, scripts or package imports. Registry and tarball requests must stay on the approved registry origin without redirects. Optional `signal`, `registry`, `maxArchiveBytes` and `maxExpandedBytes` control transport and bounds.

The returned `source` records package, version, registry, tarball, integrity and SHA-256. `archive` contains the inspected bytes. Reuse those bytes or reverify them during installation. Installing the same package name later does not prove that the installed bytes match. The SDK does not own an installer.

Each package's `package.json` contains a versioned `durable` descriptor. `parseComponentPackage` validates it together with package identity and peer requirements. `checkComponentCompatibility` checks the actual runtime, peer versions and capability IDs. Its result is `supported` or `unsupported` with reasons. A library has no activation entry. Executable components explicitly export `./component` with a named `createComponent` function.

## Supply capabilities once

Use `ComponentCapabilities.provide(port, value)` to grant real host resources. Components validate each value again when consuming it. Ordinary activation uses common semantic ports plus serialisable JSON configuration, rather than a host switch containing every package's constructor.

| Port | Host responsibility |
|---|---|
| `modelsCapability` | Configured Models, including credential access |
| `stateCapability` | `directory(namespace)`, a pure resolver for an authorised persistent directory |
| `nodeExecutionCapability` | Explicit environment identity, complete shell environment and default shell |
| `storagePolicyCapability` | Optional live journal and checkpoint retention policy, also read by retained Notebook generations |
| `networkCapability` | Authorised `fetch`, plus explicit `nativeSockets` approval where needed |
| `compiledWasmCapability` | Compiled WASM selected by engine ABI |
| `browserCapability` | Authorised Chrome discovery and launch callbacks |
| `audioLeaseCapability` | One application-owned microphone lease shared by voice integrations |
| `nativeWebRtcAudioCapability`, `pcm24AudioCapability` | Authorised audio devices and transport |
| `schedulingCapability` | Workspace bindings and explicit scheduling admission, configuration and error policy |

Put choices in each selection's `configuration`. For example, Agents needs explicit profiles. Context accepts rollover and model-role choices. Execution packages accept validated native settings. Missing authority or invalid configuration fails visibly. Descriptors state baseline requirements. Optional features can require additional grants.

Optional advanced `howaboua.*.options.v1` ports preserve original factory options and callbacks. They are not the baseline loading protocol. Guardian's review evidence, remote browser routes and custom Sites project adapters still need genuine host integration.

Capability declarations support trust decisions, not isolation. Native workers may inherit the host process environment even when shell children receive an explicit environment. Network approval is not egress interception. A working directory is not a sandbox. Obtain trust before installation scripts or imports can run with application privileges.

## Prepare, publish, bind

The [standalone example](../examples/marketplace) uses public package entries and real Harness binding without Howcode or a live provider.

1. Inspect package data, obtain approval and install verified code through your existing installer. Keep installation separate from enablement. Leave a new installation disabled until the user explicitly chooses it.
2. Call `prepareComponents(selections, options, context)`. Each selection supplies its parsed `manifest`, approved `load: () => import(packageEntry)`, optional stable `id` and JSON `configuration`. Options supply common capabilities, actual runtime and peer versions, and the host's `whenIdle(context)` barrier.
3. Examine `skipped` and show incompatibility reasons. Unsupported entries and libraries are never imported. Construction returns registrations without starting devices, kernels or network work.
4. Publish `prepared.extensions` to the registry and `prepared.providers` to Models. The SDK rejects duplicate actual identities before publication. To replace existing registrations, pass `existing` and an exact `replace` allowlist. New duplicates always fail. Providers use a separate lane. The host owns atomic publication and rollback.
5. Open the Harness with that registry, then `await prepared.bind({ harness, storage }, context)` before resuming stored work.
6. Validate explicit conversation selections with `prepared.assertSelection(names)`. It rejects overlapping actual tool names and alternatives in the same selection group. Installing Code and Notebook is allowed. Selecting both for one conversation is not.

An empty saved selection must remain empty. Do not let registry defaults enable newly installed tools. Existing direct integrations and settings-only installations remain valid.

## Input admission

After binding, `prepared.admissionFor(selectedNames)` returns an optional generic admission interface. Context supplies it when selected. Submit the original `InputSubmissionDraft` without rewriting attachments, references, parts or request identity.

- `taskId` identifies accepted managed work.
- `waitForSubmission(context)` reports native placement as `submitted` with its `submissionId`, `aborted`, or `failed`. It does not wait for the final model answer.
- `abort(context)` explicitly cancels this owned admission and joins it, returning `aborted` or `settled`. Cancelling the placement observer alone does not cancel the task.

Where provided, `rejoin(conversationId, requestId, context)` looks up an existing admission without creating work. A cached admission facade permits this lookup after retirement while its binding remains owned. Try it before rejecting a retry because new admission is sealed. Do not reconstruct private receipt keys in the host.

Use ordinary Durable APIs when there is no selected admission handler. Observe the final answer separately through the Harness.

## Updates and shutdown

For a live update, stop new host ingress through the old generation and call `retire(context)`. It seals the admission facade, invokes optional `stopAdmission` hooks to stop background producers such as schedules, then observes the real idle barrier without cancelling admitted work. Bind and publish the replacement deliberately. Instances with Harness retention or after-close binding references stay owned. Keep retired generations in the maintenance collection and call `maintain(context)` while they can still write storage. Retired maintenance must not restart producers.

The idle barrier must include in-flight admission requests that have not returned a task ID, as well as already admitted tasks and direct tool calls. An empty task list alone does not prove that publication is safe.

Explicit application shutdown has a different order:

1. Stop all new host ingress, including direct tool and input routes.
2. `await prepared.closeBeforeHarness(context)` for every owned generation. This seals the SDK admission facade and cancels or joins owned resources while the Harness is available. It does not wait for a live-idle barrier that those resources themselves prevent from completing.
3. Close the Harness through the host's existing shutdown owner.
4. `await prepared.closeAfterHarness(context)`. This waits for the bound Harness's actual `closed` promise before releasing task definitions, provider resources and binding references.
5. Clean up the execution environment and storage through their existing owners.

The SDK never closes the Harness itself. Lifecycle operations are serialised. Cleanup errors stay visible and retain ownership for retry. Failed preparation throws `ComponentPreparationError` with its `prepared` collection if unbound cleanup needs retrying. Failed binding also leaves the caller holding partially bound ownership. Do not discard either as successfully disposed.

Removing a component does not authorise deleting its persistent data. A process restart ends live kernels and PTYs. Interrupted side effects are uncertain outcomes, never permission to replay them.

## Adopt without breaking existing users

Reuse the host's installer, revision records, credential store, selection persistence and scheduler. Do not add a second runtime or per-component Code bridge. Ordinary Durable registrations are what Code and Notebook discover.

Keep legacy direct installations, saved selections and retained kernels during migration. Howcode-specific UI and service adapters can coexist with portable activation, but are not prerequisites for another Durable host. Native Linux probes and offline lifecycle checks do not constitute live-provider, physical-audio or cross-platform acceptance.
