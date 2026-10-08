# Standalone Git UI host

From the repository root, run `bun run build`, then:

```sh
node examples/git-ui/server.mjs /absolute/path/to/a/git/worktree
```

Open `http://127.0.0.1:4318`. `PORT` selects another port. The view includes tracked and untracked changes and follows the system theme. Mount, unmount and layout controls exercise the SDK without Howcode, a model provider or a Durable session.

The server binds loopback, authorizes a per-run token and exact browser origin, and grants Git access only to the repository supplied on startup. It does not accept client paths or arbitrary methods. The browser imports only public built package entries. The server uses the same `GitReader.diff` capability as `createGitDiffTool`.

Closing an in-flight HTTP response aborts the owned Git read. That is this host's transport behavior, not a guarantee made by the generic UI SDK. Stop the example with Ctrl+C. Build assets are disposable files under `dist/git-ui`.
