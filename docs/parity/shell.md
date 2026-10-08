# Shell parity

The shared implementation lives in `packages/execution/src/shell.ts` and `packages/execution/src/shell/`. Code and Notebook each include these internal sources. There is no public shell package or execution-mode bridge.

## Source

Pinned source: `howaboua-pi-stuff` revision `b2006db9def12c373ae48e70044d30f7d6b7e34f`, package `pi-codex-conversion`.

The port carries the host algorithms from `src/tools/exec/{session-manager,wait,output,results,format,shell}.ts` and shell argv policy from `src/adapter/prompt/runtime-shell.ts`. The reference checkout was read-only. Pi tool rendering, trackers and extension registration are not carried into Durable. `child_process` and `node-pty@1.1.0` replace the Rust bridge cleanly.

## Contracts and evidence

| Contract | Implementation and evidence |
| --- | --- |
| Arguments | Ordinary Durable `exec_command` and `write_stdin` registrations keep the pinned names and schemas. `command`, `cwd` and `working_directory` aliases are normalized before Durable validates arguments. Shell environment overrides remain host-side, not a new model argument. |
| Environment selection | `createShellRuntime` requires an explicit `ShellProcessBackend`. `createNodeShellBackend({environmentId})` binds local processes to a host-verified filesystem namespace. Every tool call checks `api.env.id`, including continuation calls. Missing or different namespaces fail before spawn. Workdirs resolve through `api.env.absolutePath` and its cwd, not the host's cwd. |
| Shell selection | Backend environment and configured shell replace Pi settings. Bash fallback for fish, login default true, non-login `-c`, cmd and PowerShell argv, fish-to-bash environment synchronization and `GIT_OPTIONAL_LOCKS=0` are retained. Explicit host values win. |
| Wait policy | Pinned inactivity-reset algorithms and clamps are carried. Output extends ordinary non-TTY waits up to their hard maximum. Non-TTY defaults to at least 5 seconds, empty polling defaults to at least 30 seconds, empty polls grow to 30 minutes, and nonempty writes clamp to 250 ms through 30 seconds. Host options can lower waits for validation. Optional wait-until-exit remains host-selected. Initial real-process validation verified output extension and adaptive empty polling. |
| Sessions | A process-local map owns IDs, command history, exposed sessions, snapshots and completed results. IDs use a random epoch plus a counter so persisted old handles do not normally collide after restart. Unknown handles report that sessions are expired and cannot survive restart. No effects are replayed. Both registrations use `replay: "unsafe"`. |
| Codecs | Per-stream `StringDecoder` instances decode arbitrary stdout, stderr and PTY byte chunks incrementally and flush at closure. Initial real-process validation split multibyte UTF-8 independently across stdout and stderr. PTYs retain raw terminal output, including CRLF. Pipe output sanitation remains host-side. The old Pi TUI's unused CR/backspace renderer is omitted. |
| Bounds | Retention defaults remain 1 MiB for PTYs and 256 MiB for pipes. Offset accounting exposes omitted output. Delivery defaults to 10,000 estimated tokens, four characters per token, with the pinned 256-character minimum and surrogate-safe tail slicing. Registration output limits avoid adding a smaller generic byte or line bound on top of shell-owned bounds. Completed replay keeps at most 32 results and 64 KiB per output, independently of the immediate exit-observing result. Initial validation delivered 90,000 characters at exit and then verified bounded replay. |
| Results | `chunk_id`, `wall_time_seconds`, `output`, `exit_code`, `session_id`, `original_token_count` and `truncated` keep their meanings. Wall time measures the observing call's wait. Final content retains the pinned formatter. Invocation-bound partial details are serialized and drained before the tool returns. |
| Stdin | Only an original `tty:true` command accepts nonempty input. Empty input polls either kind of session. Exited sessions reject writes but support bounded output replay. Initial real-PTY validation verified terminal status, input, UTF-8 output and Ctrl-C. |
| Failure and cleanup | Spawn failure produces output plus exit code 1, without an exposed session. POSIX termination hard-kills the owned process group, matching the source native backend. Exec cancellation and owned polling cancellation await cleanup. `close()` is idempotent and waits for pending starts and active processes. Initial validation checked actual PIDs after cancellation, Ctrl-C, explicit termination, pending-start shutdown and repeated close. |

Initial validation passed nine Node/Linux checks using real processes and native PTYs. The earlier suite was pruned. The retained `packages/execution/test/shell.test.ts` checks bounded retention and expired handles, pending-start shutdown, pipe and PTY cancellation, and cleanup after polling cancellation and close. A separate read-only comparison against the pinned source passed 118 assertions for the retained output normalization, token truncation, offsets, consumption and result formatting algorithms. These comparisons are not a fictional process-provider simulation.

## Explicit boundaries

- Custom remote or sandbox backends implement the exported spawn, stream, closed, write and terminate capability contract. No local fallback is provided. A rejecting spawn must clean any partially allocated resources. `terminate()` must release owned resources before it resolves. Native PTY loading occurs only when the local backend actually starts a PTY.
- Only Linux process and PTY behavior was validated here. Windows shell argv is preserved, but Windows process-tree and ConPTY cleanup are not asserted as tested.
- Bun can install and consume these Node-targeted packages. Executing the local PTY backend inside Bun is explicitly rejected. A real Bun 1.4.2 smoke produced missing output and incorrect SIGHUP status through node-pty's libuv integration. Node-hosted PTYs work. Bun-hosted non-TTY processes were smoke-tested successfully. A custom compatible process capability is not subject to this local-backend restriction.
- Node's process API does not expose Linux `PR_SET_PDEATHSIG`, which the old native helper used. Abrupt host death can therefore leave non-TTY processes behind. Graceful connection closure calls `close()`. Restart never recovers a terminal or authorizes replay of uncertain shell effects.
- The old helper's framed protocol and its intermediate 8 MiB event log are gone. Host-side delivery, retention and completion bounds remain. OS-specific spawn diagnostics can differ because the owning process backend has changed.
- Durable validates optional argument types before execution. The old extension's private parser sometimes ignored wrong optional types. Invalid types are not silently ignored by this port.

## Carried license

MIT License

Copyright (c) 2026 Igor Warzocha

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
