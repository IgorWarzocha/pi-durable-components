# Standalone portable host

This offline example activates Apply Patch and Context through their public `./component` entries. It opens real SQLite storage and a Durable Harness, observes native input placement separately from completion, retires the generation, rejoins the original input and closes bindings after the Harness. It uses pi-ai's deterministic faux provider, so no credentials or live service are needed.

Use Node.js 22.19 or newer. Copy `main.mjs` into a new directory, then run:

```sh
npm init -y
npm install --ignore-scripts @howaboua/pi-durable-components@0.10.0 @howaboua/pi-durable-apply-patch@0.10.0 @howaboua/pi-durable-context@0.10.0 @earendil-works/pi-durable@1.4.0 @earendil-works/pi-ai@1.4.0 @earendil-works/chord@1.4.0 @modelcontextprotocol/sdk@1.32.0
node main.mjs
```

The output shows a native submission receipt, a completed managed task and `true` for rejoining the original task after retirement. The temporary database is removed after orderly shutdown. No patch is applied and no files outside that temporary directory are changed.

The packages are explicitly approved and already installed before this example starts. A marketplace must first inspect package bytes, obtain trust and install them through its own verified installer. See the [host guide](../../docs/marketplace.md) for inspection, grants, publication, exact selections and failure recovery. The example's idle barrier tracks its one admission route. A full host must track every route into active work.
