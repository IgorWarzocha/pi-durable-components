# Shared execution

The shared implementation is internal to Code, Notebook and Worker Code. Ordinary Durable tool registrations are its dispatch boundary. No execution mode requires per-tool adapters or a Pi extension API shim. Worker Code imports only the runtime-neutral cell and nested-dispatch sources, not native shell modules.

## Sources

- Durable 1.0.2, source revision `f5d20047b3ad43d068a8eb61bd4e1f193bedbce6`, `packages/durable/src/harness/tool.ts`, `output.ts`, `agent.ts`, `generation.ts` and `usage.ts`.
- The output buffer was refreshed from the published Durable 1.0.4 source map. Nested invocation now supports its `outputWindow` and skipped-output contract, with progress intervals taken from the Harness settings.
- Code and Notebook source revision `b2006db9def12c373ae48e70044d30f7d6b7e34f`, `packages/pi-codex-conversion/src/tools/code-mode/exec-contract.ts`, `host-protocol.ts`, `public-tools.ts`, `tool-source.ts`, `custom-tools.ts` and `custom-tool-runner.ts`.
- `packages/execution/NOTICE` retains the MIT notices. The bounded output buffer and progress committer derive from Durable's implementation. The leading exec pragma parser and provider grammar derive from the pinned Code source.

## Dispatch

`createCellCoordinator` resolves the conversation's selected, filtered, wrapped registrations through the public `TaskRuntime.agent()` API. Tool names remain unchanged, including names requiring JavaScript bracket access. Drivers receive these registrations and callable functions automatically.

Every nested call creates an owned Durable task. Raw JSON values pass through the registration's `prepareArguments` before schema validation. The selected extensions' `ToolTask` hooks run in extension order. Before hooks can replace arguments or block a call. Replacement arguments are validated again before intent commits. The task commits the final arguments and replay policy before executing the registration.

Tool execution and hooks receive the Harness's shared Models collection through Durable 1.1.0's public `models` field, preserving the host's catalog, credentials and request transforms.

Output, details and diagnostics commit while tools run. Final results preserve images, errors, usage and controls. The output retention limits, UTF-8 handling, sanitization and truncation diagnostics follow Durable. Usage updates the conversation's ordinary `UsageDoc` in the same transaction as the terminal result. Nested audit entries have no model contribution. No synthetic assistant calls or tool-result messages are appended.

Nested recovery reruns only when both the committed and current registration policies are `safe`. Unsafe or unavailable interrupted calls report uncertainty and retained output. Execution throws fail the task and cancel its owned work. A returned `isError` result completes normally, as Durable does. Before-hook failures block the call. After-hook failures are reported without discarding the preceding result.

`tools[name](value, signal)` supports per-call cancellation. Cancellation marks the nested task and awaits its settlement. Its owned tasks and conversations follow Durable's cancellation scope.

Mandatory child cancellation uses a cleanup context without the cancelled caller signal and is joined even when the observer wait rejects. An aborted nested task whose execution intent already committed reports that it may have partially run.

## Cells

A cell is a foreground, conversation-owned task, not a child of the outer `exec` or `wait` tool invocation. An outer observer can settle while its cell continues running. Ordinary idle waits and conversation aborts still include that cell and its descendants. Starting another cell in the same mode and conversation checks and creates atomically, rejecting overlap.

`CellEngine.run` owns the driver's language runtime and globals. The shared task supplies tools, environment and lifecycle APIs. `publish` commits text, images and error snapshots. `checkpoint` commits driver-specific JSON. `requestYield` commits a yield counter and wakes observers without ending the engine invocation. Completed snapshots and checkpoints remain in `CellStateDoc` because Durable retires task-scoped documents at settlement.

The cell commits execution intent before running arbitrary source. Recovery after that intent reports an interrupted cell and never replays its source. Abort signals the engine and cancels owned work through Durable. Closing the coordinator signals active engines, joins their invocations and closes the engine once.

Nested controls combine in invocation order into the final cell result. Tool additions are unioned, termination is preserved and the first handoff wins. The final outer result lets Durable apply its ordinary post-tool-round policy. Yield snapshots do not terminate or hand off the conversation while a cell still runs.

## Provider surface

The `GenerationTask.beforeRequest` hook projects only request-local system `toolsAdded` and `toolsRemoved` deltas. The selected execution surface retains its exact tool schema and grammar. Stored entries, existing calls and results, and the actual agent tool selection remain unchanged. Tools removed by real agent filters are neither listed nor callable.

Code and Notebook can be installed together. Select exactly one with `conversation.configure({ extensions: [...] })`. Selecting both refuses cell startup with a configuration error. Each mode owns distinct cell and nested-task definition names.

Both drivers share the exec source parser and grammar. Empty source, malformed pragmas, unsupported budget fields, non-integer budgets and limits outside the accepted ranges fail before source execution.

Top-level waits share the source's adaptive budget policy. Incomplete observations double the wait window, starting at a five-second minimum and growing to thirty minutes. An explicitly requested longer wait remains the floor. Drivers reset the incomplete-observation count after completion, termination or an observation error.

Ordinary registrations can carry optional `executionHints` with usage, output description, loading preference, direct-call yield budget and runtime input schema. `readToolContract` validates these fields and supplies defaults for registrations without hints. This metadata controls runtime help and observation, not the implementation schema, argument repair or selected tool set. The shared source scanner applies the largest configured yield budget among direct executable tool references. Comments, quoted strings, regular expressions and non-executable template text do not trigger an override. Names remain unchanged and bracket calls support names that are not JavaScript identifiers.

`executionHints.nativeOnly` adds a generic execution boundary. Native-only tools remain on the provider surface and cannot run inside cells. Durable strips registration metadata from provider declarations, so the host binds Code or Notebook to the same Harness. Projection then resolves the selected wrapped registrations through the public conversation API. Discovery and dispatch enforce the same policy, including retained Notebook functions and nested recovery. Unbound components preserve their existing execution-only projection.

The TOML command factory and direct process backend are shared internal modules, exposed by both public products. Notebook does not depend on Code to load commands. Trusted roots and a namespace-bound backend are explicit host inputs. Loaded commands are ordinary unsafe-replay registrations with scalar argument repair and runtime hints. Live inventory changes publish through the ordinary registry. Invocation rereads the current definition, validates the conversation's environment namespace and executes directly without shell expansion.

The shared JavaScript projection uses meaningful details as structured fields and preserves accompanying result content. Empty details fall back to parsed JSON text or plain text. String details matching the complete text result remain strings, including JSON-looking command output. Images retain data URLs usable by the drivers' image helpers. Errors expose diagnostics and retain the full result on `NestedToolError.result`.

## Evidence

`packages/code/test/integration.test.ts` drives the actual V8 host through the real Durable Harness and faux provider. It checks that an ordinary side effect executes once across conversation-owned yielding and reaches the model through V8.

`packages/code/test/output.test.ts` checks fresh wait budgets and nonduplicated delivery through V8. `packages/notebook/test/runtime.test.ts` drives real Deno and the Harness. It checks persistence without source replay, cross-conversation checkpoint isolation, incremental observation and cancellation of unawaited nested calls.

`test/toolkit.test.ts` installs both modes with context management. It checks native-only projection, nested-call rejection and live state retention after rollover and mode switching. The earlier all-tool feature tour is not retained.

Worker Code's [real workerd workflow](worker-code.md) additionally exercises concurrent nested effects and incremental delivery through an impure guest handler, plus conversation abort and explicit cell termination. Application-level D1 process-loss checks belong to the consuming Site.

Run the actual shared routes with `node --test packages/code/test/integration.test.ts packages/code/test/output.test.ts packages/notebook/test/runtime.test.ts`.
