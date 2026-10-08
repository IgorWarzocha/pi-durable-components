# Git

Git diff, statistics, full-text context and image reads for Pi Durable and trusted application hosts. No browser or React dependency.

```ts
import { createNativeGitReader } from "@howaboua/pi-durable-git/native";

const reader = createNativeGitReader();
const result = await reader.diff({ cwd: "/work/project", includeUntracked: true });
```

Construction explicitly grants local process and filesystem access. The host must authorize repository paths and select the capability for the conversation's execution environment. Do not use the native reader as a fallback for a remote environment.

The default compares tracked worktree files against HEAD, including staged and unstaged changes. `includeUntracked` adds untracked files. Operations use a private temporary index, never the user's index. Snapshotting can write unreachable Git objects. `captureWorktreeTree` returns such a tree for host-owned baseline policy. Diff output uses canonical `a/` and `b/` prefixes. `diff` accepts ordered `onChunk` delivery and an abort signal. All reader methods accept an abort signal, and native cancellation waits for the owned process to close before releasing its index.

`readFileContents` returns UTF-8 text and SHA-256 revisions or a typed unavailable issue. Worktree reads reject traversal and symlinks outside the repository. Text is limited to 4 MiB and image previews to 12 MiB. Images return a data URL or null. Import DTOs and the RPC result validator from `/contracts`, which contains no native imports.

## Durable registration

Install matching `@earendil-works/pi-durable`, `@earendil-works/pi-ai` and `@earendil-works/chord` 1.1.0 peers for the root registration entry.

```ts
import { createGitDiffTool } from "@howaboua/pi-durable-git";

const tool = createGitDiffTool({
  readerForEnvironment: (environment) => environment === localEnvironment ? reader : undefined,
});
```

Register `tool` like any Durable tool. Code and Notebook discover `git_diff` automatically. Paths resolve through the invocation's environment. An unbound environment fails instead of falling back to the host. A UI host calls the same reader after its own authorization. No UI transport or component-specific Code bridge is required.

The standalone UI host example lives at `examples/git-ui` in the component repository.
