# Worker Code

Run bounded JavaScript inside a Worker and call ordinary Pi Durable tools. This package adds `exec` and `wait` to an existing Harness. It also executes app-owned workspace modules for editable tools, tests, prompts and hooks.

This is a separate execution product, not native Code or Notebook parity. There is no shell, filesystem, ambient network, Node, Deno, timer or arbitrary npm access in the guest. Each invocation gets a fresh QuickJS context. Workspace persistence and activation belong to the app.

## Install in a Worker

Install the release package with its pinned Durable peers. It is not published to the npm registry.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.5.0/howaboua-pi-durable-worker-code-0.5.0.tgz
```

Import the package's compiled WASM through your host bundler. For Wrangler, add a `CompiledWasm` rule for `**/*.wasm` with `fallthrough: false`. No runtime fetching or compilation is needed.

```ts
import wasmModule from "@howaboua/pi-durable-worker-code/quickjs.wasm";
import { createWorkerCode } from "@howaboua/pi-durable-worker-code";

const workerCode = createWorkerCode({
  wasmModule,
  cancelTask: (id, context) => harness.abortTask(id, context),
});
registry.install(workerCode.extension);
// Open your existing Harness with this registry, then bind it.
workerCode.bind(harness);
```

Declare static `.wasm` imports as `WebAssembly.Module` in the consuming app's TypeScript configuration. Install extensions before resuming persisted tasks. Select `workerCode.extension` alongside your ordinary tool extensions through the conversation's agent configuration. Do not select native Code or Notebook at the same time. On shutdown, await `workerCode.close()` before closing the Harness.

The model calls `exec` with JavaScript source. Guest code awaits `tools[name](args)` and emits with `text(value)` or `image({data,mimeType})`. Original registration names remain intact. `ALL_TOOLS` lists callable contracts. Bare values and returned values are discarded by `exec`.

`await yield_control()` publishes progress and wakes the observer without stopping the cell. A running observation returns its `cellId`. `wait` observes that cell or terminates it with `terminate: true`. The optional leading `// @exec: {"yield_time_ms":0,"max_output_tokens":1000}` controls observation, not runtime quotas. Each observation has an independent output budget. An unchanged running snapshot is not repeated.

## Execute workspace modules

Snapshots are immutable maps of canonical absolute virtual paths to source strings. Imports resolve only inside that snapshot. Relative imports are allowed, root escapes and unknown modules are rejected.

For `exec`, factory `modules` accepts a snapshot or a synchronous snapshot provider. Use `modules: () => activeFiles` when the app reloads its workspace. Each cell copies the provider's current source map before awaiting interpreter admission. Already-running cells retain their old imports after activation.

`evaluateModule({modules,entry,exportName}, {signal})` reads a JSON data export. Supply `args` to call the export as a function instead. This route is pure. Use it for manifests, fixed tests, prompt rendering and bounded hooks. Guest code receives no ordinary tools or output capabilities.

An ordinary app-owned tool can call `executeToolModule(request, api, context, {allowedTools})`. The export is invoked with `request.args` and must return a JSON `ToolExecutionResult`. Grants default to empty. `exec`, `wait` and native-only registrations are always excluded. Granted calls use the same nested Durable task path owned by the current tool, not another cell or direct registration execution. Validation, preparation, wrapping, hooks, results, usage and invocation-ordered controls survive.

Host wrappers for impure guest modules must declare `replay: "unsafe"`. Never expose credentials, bindings, registry mutation or arbitrary host callbacks to the guest. Keep capability grants and fixed validation outside editable source. The app owns source versions, passing test receipts and atomic activation of its ordinary extension registrations.

## Bounds and recovery

`limits` is trusted host configuration and can only reduce `DEFAULT_WORKER_CODE_LIMITS`. Defaults are 8 MiB guest heap, 256 KiB stack, 64 interrupt polls, 4096 promise jobs, 128 tool calls, 32 pending bridge calls, 64 KiB source per file, 256 KiB total module snapshot, 128 modules, 32 KiB arguments, 128 KiB JSON results, 256 KiB total emitted output and 30 seconds waiting for host work. Heap cannot be configured below 256 KiB or stack below 16 KiB because context startup needs memory.

All component instances in an isolate share one compiled interpreter with 16 MiB initial and 32 MiB maximum imported WASM memory. Admission allows at most four runtimes and 24 MiB reserved guest heaps across all Harness owners. Three default-size guests can run together. Admission fails immediately when exhausted, avoiding nested-call deadlocks. Reuse the same imported module identity. `budget()` reports admission and linear-memory usage.

Fuel and job counts bound interpreted loops. A wall timer only bounds host I/O waits. Expensive interpreter builtins still rely on the hosting Worker's CPU quota as the outer limit. Tool JSON is never silently truncated. Transport and output overflow fail visibly. Images count against the same output budget.

Cells and their owned calls are cancelled and joined. Interrupted cells do not replay source. Unsafe nested effects remain reported as potentially partially executed. Guest globals do not survive a process restart. Reinstall the app's active immutable source snapshot before resuming its existing journal.

## Validation

From the repository, run `node --experimental-strip-types --test packages/worker-code/test/workflows.test.mjs`. This executes the actual compiled WASM on workerd with genuine Durable registrations. It covers concurrent impure handlers, hooks and wrapped results, isolation, module imports, fuel, jobs, heap and transport limits, incremental output, yield, wait, cancellation and isolate-wide admission across separate Harness owners.

The consuming app must separately prove its persistence, lease fencing, activation and abrupt process-loss recovery. This package does not supply another scheduler or journal.

## Headless presentations

Available in local-development builds, not release 0.5.0.

`@howaboua/pi-durable-worker-code/presentation` exports `workerCodeCapability`, `workerCodeSummary` and `workerCodeDetail`. These browser-safe descriptors are structurally compatible with the UI SDK without importing it. They perform no I/O and have no renderer.

The host supplies `{cell, result}`. Each field is explicitly nullable. A cell is `{id, status}`, with a canonical positive decimal task ID and the actual coordinator status: `running`, `completed`, `failed`, `aborted` or `interrupted`. Read these from exec/wait receipt details `cellId` and `status`. Do not substitute host request activity for cell lifecycle.

`result: null` means output has not been acquired. Otherwise pass the ordinary execution receipt. Parsing retains text, base64 images, `isError`, JSON details and structured diagnostics. Omitted fields normalize to empty content, false, null and empty diagnostics. Usage and controls remain Durable-owned, not presentation actions. Summary selects title, cell identity and status, output availability and nullable `isError`. Detail selects the full validated state. Summary can request detail without acquiring it.

The host authorizes `exec` and `wait` through ordinary registrations and publishes acquired receipts on the declared `results` stream. This is host publication, not a new runtime stream or tool bridge. Each receipt is one bounded observation, not cumulative output. Presentation disposal does not terminate cells, roll back effects or authorize replay. Acquisition, binding and cancellation policy belong to the host.
