# Headless component presentations

The local-development packages expose browser-safe capability contracts and summary/detail projections for native host interfaces. These exports are not included in release 0.5.0.

Import from `@howaboua/pi-durable-<component>/presentation`. Git retains its existing `/contracts` export. The objects work with the UI SDK's `bindCapability` and `mountPresentation`, but do not import the SDK, React, DOM controls or the Durable runtime.

| Component | Snapshot owned by the host |
|---|---|
| Code, Worker Code | Observed cell identity and status, with an optional execution receipt |
| Agents | Agent roster and an optional selected reply |
| Context | Notes inventory and an optional note body |
| Skills | Skill catalog and an optional selected skill body |
| Browser | Operation count and continuation metadata, with optional full output |
| Web | Search result count and optional provider output |
| Image Generation | Generated artifact metadata and optional generation output |
| View Image | Image metadata and optional viewing output |
| Apply Patch | Patch receipt and optional detailed changes |
| Git | Diff statistics and optional full diff |

Each package README lists its exact exports and state shape. `parseState` validates a snapshot. Summary selectors expose compact domain data. Detail selectors expose separately acquired data, which can be null. Neither selector fetches, invokes a tool or chooses a widget. A presentation request is a host navigation signal, not permission to acquire data.

The host owns authorization, tool invocation, snapshot publication, freshness, loading and errors. Bind once, then render the same capability instance in a composer, sidebar or main view using the host's native controls. A null detail means not acquired, not an empty successful result. Readonly artifact receipts deliberately declare no actions. Interactive capabilities declare ordinary registration names without providing another invocation bridge.

Execution receipts describe bounded observations, not a replayable transcript. A running cell can outlive the request that observed it. Cancelling a view does not authorize replay, and uncertain side effects remain uncertain. The host must use the existing execution and task-ownership APIs.

The [Git review example](../examples/component-ui) demonstrates host-owned controls, shared summary/detail state, presentation requests and revision-anchored comments. Notebook has no presentation contract. The OpenAI Responses provider has no separate presentation because it is a transport integration, not an interactive tool surface. Shared execution remains internal.
