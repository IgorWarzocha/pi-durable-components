# Guardian parity

Source: `packages/pi-codex-guardian` at `69f50cf70e8a7b05c2349be6227f521b6504f80e` in `howaboua-pi-stuff`. Source license and modification notices ship with `packages/guardian`.

Guardian is an ordinary Durable tool hook. Explicit rules are empty by default. Matching block rules win over review. Argument predicates run with bounded native process isolation when explicitly enabled. Invalid configuration and failed matching block execution. The host owns rule loading, trusted-project composition and controls rather than Pi commands or ambient files.

Review requires a genuine pending tool call from an observed canonical Codex subscription completion. Host composition connects Guardian to the owned provider's optional prepared-request and completion callbacks. Both SSE and WebSockets report exact sent JSON only after an actual successful `response.completed`. The observation contains no authentication headers. Observer failure must not replay the completed request.

Guardian correlates response, model, session, generation, selected agent and live tool slot. Reload cancels owned work and rejects late observations. Complete parent context and action must fit the bound without truncation. Unsupported routing, credentials, attachments and opaque continuation context fail closed. Review uses one tool-less `codex-auto-review` inference with zero retries and an authentication-inclusive deadline. Uncertain outcomes cannot authorize execution.

Generic execution metadata preserves the actual originating tool admission through child tasks. Nested hooks validate that slot before and after review. Metadata is not independent authorization. A yielded cell cannot reuse its retired exec slot. An authorized live wait can supply its own origin for newly admitted nested tasks; each child freezes that origin and cannot borrow a later wait. There is no Guardian-specific Code or Notebook bridge.

With Durable 1.2.0, Guardian resolves native `executeTool()` ancestry through `ToolHookCall.parent` and `LiveDoc.nestedTools`, using read-only hook APIs. Intermediate pass rules need no extra receipts. A disposable real Harness check verified two nested levels resolve to the original model task and a blocked child performs no side effect.

## Evidence

The 2026-10-19 provider alignment at Pi Stuff `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32` moves standing instructions into an initial developer input item. Guardian captures that exact full input, including Lite's preceding `additional_tools`, without reconstructing prompts or requiring an obsolete `instructions` envelope. Explicit malformed envelopes remain unsupported. A disposable capture-boundary probe used actual emitted standard and Lite provider JSON and verified developer-input preservation, empty-system acceptance, and rejection of opaque continuation, multimodal input, malformed instructions and responses without tool calls. This is not a live Guardian authorization or billing test. Native runtime probes separately checked live-wait origin renewal and frozen retired origins; canonical observation, response/session/run and pending-slot authorization guards remain unchanged.

Disposable real Harness checks exercised default-empty rules, block precedence, isolated regex matching, allow, deny, malformed review, missing provenance, reload during generation and review, opaque continuation and session mismatch. Actual generic cell dispatch admitted a nested action while its original slot remained pending. Missing origin, wrong call ID and a yielded cell after original-slot completion blocked without issuing a review request.

Offline SSE and WebSocket fixtures verified exact sent-body observations. Throwing observers caused exactly one send on each transport despite a nonzero retry budget. Package compilation and bundled import passed. No permanent tests were added.

Live Codex compatibility and billing eligibility remain unverified. Parent bindings and reviews are ephemeral and are not restored after restart. Hosts must invalidate authorization on trust, model, branch and environment changes and place Guardian after argument-transforming hooks.
