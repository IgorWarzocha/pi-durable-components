# Durable Guardian

Guardian blocks explicitly selected tools or reviews one pending action before execution. Rules are empty by default. Unmatched calls pass through. A matching block rule wins over review and makes no inference.

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.9.0/howaboua-pi-durable-guardian-0.9.0.tgz
```

```ts
const guardian = createGuardian({
  rules: { rules: [{ tool: "deploy", action: "review" }] },
  cwdForConversation: id => executionDirectories.get(id),
});
const provider = createOpenAIResponsesProvider({
  onPreparedRequest: guardian.prepareRequest,
  onCompletion: guardian.observeCompletion,
});
// Register provider with Models. Install guardian.extension in guarded agents.
```

The two packages are composed by the host, with no dependency between them. Review requires the owned canonical ChatGPT Codex provider, stored subscription OAuth, an observed successful parent completion, and the exact current pending tool call. Custom routes, custom authentication, continuation-only context, attachments and opaque history do not qualify. The complete parent context and action must fit the 96 KiB review bound. Nothing is silently truncated.

Each review uses `codex-auto-review`, a fresh tool-less SSE session, one inference and zero retries. The 30-second deadline includes authentication. Denial, malformed responses, cancellation, unavailable provenance and uncertain results block execution. Reviews and parent bindings are ephemeral and are never restored or replayed after restart.

## Rules and lifecycle

Each rule has an exact `tool`, an `action` of `block` or `review`, and optional `args` mapping top-level argument names to regular-expression strings. Predicates are AND within a rule. Missing or non-string arguments do not match. Rule objects reject unknown keys. There are at most 256 rules in a 64 KiB policy snapshot.

Argument regexes require explicit `nativeRegex: true`. They run in a disposable Node process with a 32 MiB heap, a one-second deadline and at most 1 MiB of matching input. There is no shell invocation or ambient rule-file loading. Regex matching failures block the call.

Use `reload({ rules })`, `setEnabled(boolean)` and `status()` for host controls. Loading invalid rules fails closed. Reload and enable changes cancel owned work and discard parent bindings. The host owns rule-file loading, additive global and trusted-project composition, persistence of the enabled setting, and UI. Call `invalidate()` before trust, model, branch, authorization or execution-environment changes. Call `close()` on shutdown. `cwdForConversation` must return the conversation's execution directory, never the host's default directory.

Ordinary Durable `beforeTool` hooks cover registered tools, including generic nested dispatch. No Code or Notebook bridge is required. Generic invocation metadata carries the actual admitted originating call. Nested review validates its originating tool slot before and after inference. A yielded cell whose original slot has finished cannot be reviewed. Missing, mismatched or stale origins fail closed. Never infer the origin from the latest response or wrapper name. Select Guardian after argument-transforming hooks so its decision covers the final action.

Completion observations are trusted host-only data, not tool arguments or persisted session metadata. Guardian retains up to eight unattached wire bodies, eight bounded preparation snapshots and eight bounded conversation parents. The provider emits evidence for both SSE and WebSockets only after an actual successful `response.completed`, with the exact sent JSON and no authentication headers. Observer failure cannot retry a completed request. Fixture validation does not establish live backend compatibility or billing eligibility.
