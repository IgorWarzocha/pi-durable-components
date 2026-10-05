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
