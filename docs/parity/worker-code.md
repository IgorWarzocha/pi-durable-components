# Worker Code

Worker Code is a new bounded execution mode for Cloudflare Workers. It does not replace or claim parity with the native Code and Notebook implementations pinned in [the parity index](../parity.md). Native shells, arbitrary npm imports, persistent guest globals and host filesystem access are deliberately absent.

The public component registers ordinary `exec` and `wait` tools. It shares the existing Durable cell coordinator and nested-task dispatcher. Editable module handlers use that same dispatcher under their current ordinary tool task, without starting another conversation-level cell or calling registrations directly.

QuickJS comes from exact `quickjs-emscripten` and `@jitl/quickjs-wasmfile-release-sync` version 0.32.0 dependencies. The package build copies the upstream WASM bytes and full license notice into its distribution. Dry-pack verification compares the shipped binary with the pinned dependency. The host supplies the compiled module explicitly. No runtime binary download or host compilation is required.

## Runtime evidence

`packages/worker-code/test/workflows.test.mjs` runs the maintained component through Wrangler's real workerd runtime with compiled WASM and a real Durable Harness. Its workflow exercises:

- Relative snapshot module imports and guest isolation.
- Interpreter fuel, promise-job, heap and result limits, followed by successful execution.
- Concurrent ordinary tools reached through an editable guest handler, including argument preparation, hooks, wrapped registrations, results, usage and controls.
- Incremental output, explicit yielding and observations of running cells.
- Cancellation of a double-nested owned effect with no remaining live tasks or guest runtimes.

Guest invocations use fresh runtimes. Shared isolate admission and WASM memory ceilings also apply across component instances. Interrupted source and uncertain effects are not permission to replay execution.

Persistent workspace storage, test receipts, capability policy and activation belong to the consuming application. Component tests do not establish those application contracts or remote Sites deployment compatibility.

## Live Site evidence

On 2026-10-05, Durable Chat app commit `e82eea3` deployed Worker Code 0.1.0 from component commit `2626b6c` through the normal private Sites source build. The compiled WASM loaded and executed on the deployed Site. All 26 existing messages retained their exact serialized hash, with Luna and high reasoning unchanged.

Clawa used ordinary tools to edit its summary helper and tests, pass the fixed baseline, and activate workspace generation 2 without redeployment. Independent D1 reads confirmed the active version `22b50278645a5d542e8cf20561dae79890424ec8176282c34ed07b01ed49a7b8` and its passing receipt. The updated tool returned `Workspace contains 3 files. Active generation 2 (22b50278).` A relative module import from `exec` also executed successfully.

A read-only follow-up during browser-owner handover was interrupted and visibly paused, not automatically replayed. After explicit Resume, the new owner called the retained tools successfully, reported the same generation and version, and recalled the pre-deployment validation word. This establishes live owner reopening, not survival of a guest heap or socket. The application's real workerd process-loss test separately proved that an admitted unsafe effect runs once and leaves an uncertainty diagnostic after restart.
