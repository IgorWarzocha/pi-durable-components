# A marketplace for Durable components

The goal is for any Durable app to offer a component catalogue, let users choose what they want, and activate compatible packages without Howcode-specific runtime adapters. The packages already work through public Durable APIs. A shared marketplace and activation contract are proposed here, not implemented in release 0.9.1.

## What established marketplaces separate

Claude Code and Cursor both distinguish a marketplace catalogue from each plugin's own manifest and contents. Adding a catalogue makes entries discoverable. Installation resolves code. Enablement chooses where it is used.

| | Claude Code | Cursor |
|---|---|---|
| Catalogue | `.claude-plugin/marketplace.json` | `.cursor-plugin/marketplace.json` |
| Package manifest | `.claude-plugin/plugin.json` | `.cursor-plugin/plugin.json` |
| Catalogue entries | Named plugins with a source | Named plugins with a source directory |
| Resolution | Includes Git, npm and archive sources | Documented plugin-directory resolution |
| Selection | User, project and local scopes | User and project scopes, plus team distribution controls |

These are similar structures, not interchangeable formats. Their supported components, manifest merging and activation behaviour differ. Copying a Claude or Cursor manifest would not make a Durable package loadable in those apps.

The useful precedent is a small catalogue pointing at independently versioned packages. A Durable catalogue should use Durable-native package contracts, rather than emulate either product's hooks, MCP configuration or plugin runtime.

Official references: [Claude Code marketplace reference](https://code.claude.com/docs/en/plugins/marketplace-reference), [Claude Code installation and scopes](https://code.claude.com/docs/en/discover-plugins), [Cursor plugin reference](https://cursor.com/docs/reference/plugins), and [Cursor marketplaces](https://cursor.com/docs/plugins).

## The portable boundary

The catalogue, package descriptor and activation contract must be usable without Howcode. Howcode is one consuming host and must adapt its loader to that public contract. Another app must not need Howcode packages, settings paths, UI metadata or backend services to activate the same component.

There are three distinct pieces:

1. **Catalogue.** Plain data identifying components and exact npm package versions, with descriptions and documentation links. An app can add a catalogue without importing or running every listed package. It records the resolved source and integrity when a user installs an entry.
2. **Package descriptor.** Side-effect-free, versioned data owned by the package. It identifies the runtime entry, integration kind, compatible Durable peers, supported environments, required host capabilities and owned extension names or provider IDs. Package metadata is authoritative. Catalogue claims cannot grant permissions or override compatibility checks.
3. **Activation contract.** An explicit public entry point that receives authorised host capabilities and owns component startup, binding, work and cleanup. Plain tools return ordinary Durable extensions. Providers compose with Models. Optional settings and presentations remain separate from tool availability.

The first catalogue should resolve exact npm versions rather than introduce another installer or every possible Git and archive source. Adding a catalogue must not install its entire contents. Listing a component is not permission to load it.

## The gap to close

Release 0.9.1 does not export a common package descriptor or activation entry. Plain extensions already install with `registry.install(...)`. Service factories such as Code, Notebook, Context and Voice have their own documented host options and lifecycles. Providers, settings and UI contracts have different integration points again.

A catalogue alone cannot bridge those differences. A host that guesses a factory name, or relies on a Howcode adapter for every service, has not implemented universal component loading. The reusable descriptor and activation contract belong with these portable components, with host-neutral capability types.

That contract needs to distinguish compatibility checks from activation. Checking an entry must not start a provider connection, kernel, microphone or background task. Startup must clean up partial failures. Binding must finish before stored work resumes. Retirement must stop new admission and respect already admitted work. Shutdown must join owned resources at the correct phase around Harness closure, report cleanup failures and never replay an uncertain side effect.

Construction and binding must be separate phases: construct the extensions and providers, register them, open the Harness, bind the component to its Harness and storage, then resume work. Requiring a running Harness merely to construct its registry would create a circular dependency. Live updates need the same ownership boundaries.

The host must check registration ownership before publishing an activation. Conflicting extension names or provider IDs require rejection or an explicit replacement decision, never last-writer-wins. Returned registrations must match the descriptor. Overlapping tool names can represent alternatives such as Code and Notebook, but their conversation selections must remain mutually exclusive.

Persistent data and live resources need separate ownership. Notebook updates, for example, can leave earlier kernel generations alive. Storage maintenance must reach every retained writer. A generic immediate `dispose()` cannot replace that lifecycle without changing behaviour.

## What an app implements

An app implementing the shared contract would:

1. Read catalogue data and show entries without executing their packages.
2. Resolve and verify the selected package bytes without running installation scripts or importing package code.
3. Read the data-only descriptor from those bytes, then validate its version, runtime peers, environment and registration ownership. Show unsupported entries as unavailable with a reason.
4. Explain trust and required capabilities, obtain the user's decision, then allow any approved executable installation steps and supply the actual authorised grants. Credentials stay in the host's Models or secret storage.
5. Activate the component and expose its ordinary registrations through the existing Harness. Preserve the user's explicit conversation selections.
6. Retire, update and remove components through their owned lifecycle. Preserve feature data unless the user explicitly requests deletion.

Installation and enablement must remain distinct. For a new marketplace flow, the recommended default is installed but disabled until the user chooses to enable the component. An app can combine those steps in one explicit, reviewed action. It must not change existing users' selections just because a catalogue is added.

Permission declarations describe requirements and support consent. They do not sandbox trusted Node code. Package installation and imports can execute code with the application's privileges. A host must not advertise isolation that its execution model does not provide.

## Adoption by existing apps

Hosts should reuse their installer, revision tracking and conversation selection rather than introduce parallel implementations for marketplace entries. Their loader maps real Models, Harness, storage and execution grants into the portable activation contract. Howcode follows that same boundary. Its UI and application-specific integrations can remain optional.

Migrating an existing host must preserve direct package installations, settings-only installations, saved selections and retained work. Existing app behaviour is evidence to preserve, not a reason to impose that app's adapter format on other Durable hosts.

## Delivery sequence

First document the existing library integration and its requirements. Then define and exercise the portable descriptor and lifecycle contract in a small standalone Durable host, independent of Howcode. Use plain tools and a resource-owning component to prove both simple and lifecycle-heavy activation.

Once that boundary works, publish catalogue data for the components that implement it and add host support in Howcode through the same public contract. Unsupported entries should remain visibly unavailable. Do not claim all 25 packages are marketplace-ready before their required capabilities and lifecycle are represented and exercised.
