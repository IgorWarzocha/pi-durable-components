# Contributing

Use Node.js 22.19 or newer and Bun 1.4.2.

```sh
bun install --frozen-lockfile --ignore-scripts
bun run setup:native
```

The native setup builds node-pty when a prebuilt addon is unavailable. That path requires Python and a C++ compiler.

```sh
bun run check
```

This runs Biome, strict TypeScript 7, Knip, real-tool workflows, builds and package checks. The workflows use V8, Deno, files, shell sessions and Durable worker conversations. Model responses choose tool calls rather than fabricate results.

To produce installable archives after validation:

```sh
bun run pack
```

Archives are written to `dist/`. Test them from a separate host project before attaching them to a release. Never make users build the repository just to install a component.

## Live services

Live checks are opt-in and require an unexpired Codex credential in pi-ai's `auth.json` format. Adding `--images` makes two image-service requests and can incur charges.

```sh
node scripts/smoke-live.mjs --credentials /path/to/auth.json
node scripts/smoke-live.mjs --credentials /path/to/auth.json --images
```

The script searches, opens a returned reference and, with `--images`, generates, views and edits an image. It leaves credentials unchanged and removes temporary files.

The provider smoke makes real model requests through Durable, using a native tool over SSE and actual Code Mode execution over cached WebSockets:

```sh
node scripts/smoke-provider.mjs --credentials /path/to/auth.json
```

It checks tool execution, follow-up responses and chronological transport diagnostics. It does not refresh or modify credentials. Report cache hits only when the backend reports cached tokens.
