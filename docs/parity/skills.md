# Skills parity

Source: [`pi-better-skills-tool` at `b2006db9def12c373ae48e70044d30f7d6b7e34f`](https://github.com/IgorWarzocha/howaboua-pi-stuff/tree/b2006db9def12c373ae48e70044d30f7d6b7e34f/packages/pi-better-skills-tool). The source checkout was read-only. Adapted algorithms retain the MIT notice in `packages/skills/NOTICE`.

The component registers `skills` as an ordinary Durable `ToolRegistration` with `{ command?: string }` arguments and text content. Details carry exposed instruction-body evidence, described below. Empty calls and explicit help return command guidance with the catalog. Explicit list returns reference-selection guidance with the catalog. There is no Code or Notebook adapter. An optional Durable section supplies the source progressive-discovery guidance without editing other prompt sections.

Empty-call discovery follows source revision `69f50cf70e8a7b05c2349be6227f521b6504f80e`. Disposable real-Harness validation exercised omitted arguments, catalog-backed help, explicit list and unknown-field rejection. The retained output-boundary workflow and package typecheck passed. Earlier source differential results below describe the original extraction, before this help addition.

The 2026-10-15 refresh follows `47f1e2afb689903f829b5ad43e6f07d27d1b7106`, inspected at `036dc876da5afc4ec27b64878ebb1cfb30c8211d`. Help and invalid-input guidance show `tools.skills("read <skill>")`. The existing string preparation and native `{command}` envelope remain supported; discovery and read behavior are unchanged.

## Preserved contracts

| Source owner | Durable implementation | Evidence |
|---|---|---|
| `catalog.ts` | `src/catalog.ts` | Same command groups, semicolon parsing, categories, 4 KiB command budget, exact errors, 48 KiB UTF-8 byte continuation and footer |
| `discovery.ts` | `src/discovery.ts` | Root and one-level category discovery, declared and fallback names, validation, collisions, sorted categories, session overrides, hidden names, authoritative nonempty host catalogs |
| Loader hidden-metadata prepass consumed by `discovery.ts` | `src/hidden-skills.ts` | Same `.gitignore`, `.ignore`, `.fdignore` pattern prefixing and ordered negation, nested rules, root Markdown and deep package hidden declarations, YAML typed booleans, quoted keys and aliases |
| `skill-document.ts` | `src/skill-document.ts` | Carried parser and validation algorithms, including BOM, newline normalization, quoted and folded scalars, name and description limits |
| `skill-package.ts` | `src/skill-selection.ts`, `src/skill-package.ts` | Carried selection algorithm, local-first reference resolution, mixed skills, scoped selectors, deduplication, qualified ambiguity recovery, absolute paths, reference-only output and source attribution |
| Package traversal | `src/files.ts`, `src/package-files.ts` | Environment-owned canonical containment, package symlinks, reference aliases, cycles, broken links, escaping links, dotfiles, dependency pruning and shallow assets |
| Tool execution | `src/index.ts` | Real Durable Harness test preserves bounded output and its continuation footer despite thousands of lines |

`packages/skills/test/registration.test.ts` runs the ordinary tool through a Durable Harness and a scripted pi-ai provider. It rejects loss of continuation information at the output boundary. Discovery, parser, validation and hook tours are not retained.

A read-only live differential probe compared 24 calls against the pinned source `runSkills`. Outputs and error messages matched for listing, category filtering, session precedence, hidden skills, full package reads, suffix aliases, scoped and mixed references, duplicate selectors, batched commands, malformed commands, unknown skills, byte offsets and escaping references. This probe used identical temporary fixtures for both implementations and left the source untouched.

A second live differential probe compared 26 outputs and errors for YAML quoted keys, explicit boolean tags, aliases, multiline values, boolean-looking strings, duplicate keys, nested ignore files, negation across ignore files, hidden package aliases, and session name masking. These are recorded source comparisons, not retained unit fixtures.

## Explicit environment and lifecycle changes

- Roots are host options, not assumed `~/.pi` or current-process paths. Relative paths are resolved by `api.env`.
- Pi's resolved skill list becomes `loadedSkills` or an invocation-scoped `getLoadedSkills(api, context)`. Nonempty lists remain authoritative. An empty list falls back to the explicit roots.
- Every filesystem operation uses Durable's `FileSystem` capability. Canonical path support is required for package reads. No local filesystem imports or process execution exist in production code.
- Chord cancellation is checked before and after operations. Unsupported operations and permission failures remain visible rather than being silently swallowed as missing files. Broken links still disappear from package inventories.
- The tool is replay-safe because it only reads. Recovery rereads current files. It does not promise snapshot-consistent continuation pages.
- Source prompt catalog removal, native `/skill:` expansion, Pi changelog UI and Code-specific registration are intentionally not emulated.

## Loader ownership

The source tool directly calls Pi's loader to collect hidden paths and names. That policy belongs to explicit-root discovery and is implemented locally with the same `ignore` 7.0.8 and `yaml` 2.9.0 libraries used by the pinned source's resolved `@earendil-works/pi-coding-agent` 1.0.1 dependency. No Pi loader or context API is imported. The prepass has its own YAML parsing because the source document parser intentionally has a smaller scalar grammar. Invalid loader YAML contributes no hidden metadata, matching the source warning path.

Ignore files affect this prepass only. The source's direct visible package traversal does not honor them. Thus an ignore-listed disabled package remains visible, and an ignore-listed hidden root Markdown file does not mask a global name. Both behaviors are retained rather than replaced by conventional whole-catalog ignore filtering.

Pi package and settings resolution happens outside the source tool through its injected loaded-skill list. That remains host-owned through `loadedSkills` or `getLoadedSkills`. Native prompt rewriting and slash-command expansion are intentionally excluded. No known deterministic tool capability remains unimplemented within explicit-root discovery or authoritative-catalog reading.

## Validation

- `node --experimental-strip-types --test packages/skills/test/registration.test.ts` exercises the retained Harness workflow.
- Live source comparisons: 24 core commands and 26 hidden-policy outputs and errors matched.
- `node node_modules/typescript/bin/tsc -p packages/skills/tsconfig.json`: package build and declarations passed with TypeScript 7 strict settings.
- The coordinating agent owns the final repository gate.

## 2026-10-19 source alignment

Inspected read-only Pi Stuff snapshot `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32` against `036dc876da5afc4ec27b64878ebb1cfb30c8211d`.

Includes local `ca3836dd` reference guidance: both help and list explain that reference-only selectors omit the initial body and show separate semicolon-delimited commands for reading a body plus another reference. The command parameter names help, list and read. Ordinary registration metadata declares help-backed discovery; the string preparation and native command envelope remain supported.

The source experimental GPT help is a shorter prose variant. It is excluded as Pi prompt policy, without changing selection behaviour or adding a global mode. A disposable real Harness exercised help, list and a reference-only read, verified reference output without the primary body, and captured the source guidance. The retained output-boundary Harness workflow passed. No permanent tests were added.

## Pi 1.4 source alignment

Compared read-only Pi Stuff `3d0faf5a6f0bc67c0bd9248d07da6ddfa901b281` against `7f3295e67a8e6146b2a6922b56a06fa4db5c3a32`. The changed `catalog.ts`, `skill-package.ts` and `tool.ts` add `details.skillReads: { version: 1, reads, continuation }`. Each read records `name`, `skillPath`, `path` and `kind`, either `skill` or `reference`. Evidence covers only nonempty body spans intersecting the current UTF-8 byte page. Labels, inventories, source paths and continuation footers do not count. An inventory-only continuation returns no reads. Batched commands offset their spans into the combined output before paging.

The ordinary Durable result carries that metadata without a Code or Notebook bridge. The public `runSkills` helper retains its text return value. Existing arguments, output text, selection rules, byte budgets and environment boundaries remain unchanged. The source's compressed GPT wording remains excluded as an alternate prompt mode.

The release-coverage audit caught a nested-result regression in the first 1.4 build: adding host read metadata made the generic execution projection return an object instead of the source's plain skill text. Skills now declares its ordinary structured program result as a string, retaining read receipts only in host details. Real Harness calls through both V8 Code and Deno Notebook verified string operations on the returned text and intact host read evidence. No component-specific execution path was added.

A disposable real SQLite/Harness probe captured empty-call evidence, a body read, a reference-only read, a truncated body page and an inventory-only continuation. It verified instruction attribution without claiming whole-file exposure. Strict TypeScript passed with installed Durable, Pi AI and Chord 1.4.0. No permanent tests or live-provider acceptance were added. The coordinator owns the final repository gate.
