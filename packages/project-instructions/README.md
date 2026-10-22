# Project instructions

Load project guidance from the conversation's filesystem environment. Cwd ancestors are available immediately. Nested guidance appears on the next model request after a structured file operation reaches that scope, without scanning the repository or delaying a write for instructions.

Install the package alongside Chord and Pi Durable 1.4.0. Install and select its extension in the same way as ordinary Durable extensions:

```ts
import { createProjectInstructions } from "@howaboua/pi-durable-project-instructions";

const instructions = createProjectInstructions();
registry.install(instructions);
```

The default filename is `AGENTS.md`. Pass `fileNames` to choose an ordered list of plain filenames. The first existing file in each directory wins. Each source is labelled with its directory scope. More specific guidance applies within that scope.

The extension observes successful `read`, `write` and `edit` calls through their structured `path` arguments. It observes `apply_patch` through its structured `details.result.changedFiles` receipt, including committed partial results and move endpoints. It neither parses JavaScript, shell commands or patch text nor discovers paths used only through other tools. Tool-specific path aliases are not interpreted.

Discovered directory scopes are conversation documents, isolated by execution-environment identity and retained across reopen, compaction and forks at their native history position. File contents are reread for every model request. Newly created guidance in an encountered scope appears automatically. Deleted guidance disappears. Deselecting the extension removes its section on the next request.

Operations run before discovery. Their results, errors and replay policies remain unchanged. Discovery failures produce warnings rather than retrying a completed side effect. Global user instructions and execution-environment grants remain the host's responsibility. No host filesystem access, timers or binding service is used.
