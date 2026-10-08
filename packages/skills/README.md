# Durable Skills

The source tree targets upstream 1.1.0. The release archive linked below retains its original 1.0.2 peer requirements.

Discover skill packages and load instructions or selected references on demand. This component registers the ordinary Durable `skills` tool. It does not load Pi extensions or rewrite existing prompts.

Requires Node 22.19 or newer and `@earendil-works/pi-durable`, `@earendil-works/chord`, and `@earendil-works/pi-ai` 1.1.0.

## Register

```sh
npm install https://github.com/IgorWarzocha/pi-durable-components/releases/download/v0.3.0/howaboua-pi-durable-skills-0.3.0.tgz
```

```ts
import { createRegistry } from "@earendil-works/pi-durable";
import { skills } from "@howaboua/pi-durable-skills";

const registry = createRegistry();
registry.install(skills({
  globalRoot: "/shared/skills",
  sessionRoot: ".agent/skills",
  guidance: true,
}));
```

Pass this registry to your Durable harness and provide its `env` factory. All reads, directory traversal, symlink resolution, and relative paths use the calling conversation's environment. There is no host filesystem fallback and no implicit global directory. Without roots or a catalog, listing returns `No skills available.`

`guidance` defaults to false. Enable it for a short progressive-discovery prompt section. `createSkillsTool(options)` also returns the tool registration on its own. Code and Notebook can discover that registration without an adapter.

## Commands

The tool takes `{ command: string }`.

```text
list
list code visual
read tooling
read tooling api runtime
read tooling writing style
read tooling api; read writing style; list code
```

Roots contain `<package>/SKILL.md` or `<category>/<package>/SKILL.md`. Documents need YAML frontmatter with a valid lowercase hyphenated name, a description, and a Markdown body. Root skills appear before categorized skills. Names must be unique within each root. Session skills override global names and appear in `session`. A session skill with `disable-model-invocation: true` hides the corresponding global name.

Hidden-skill discovery honors `.gitignore`, `.ignore`, and `.fdignore`, including nested rules and negation. Boolean metadata supports YAML quoted keys, explicit types, and aliases. As in the source tool, these ignore rules affect hidden declarations only, not the visible package inventory. An ignore-listed disabled package remains visible. Hidden declarations in root Markdown files and deeper packages can mask global names even when those files are not visible packages themselves.

Read one skill to see its instructions and package paths. Read references by their names, relative reference paths, qualified paths such as `tooling/references/api.md`, or the absolute paths returned by the tool. Reference-only reads omit the main instructions. Additional skill names change the scope of following reference names. Ambiguous references return qualified retry paths.

Package listings exclude dotfiles, dependency directories, broken links, and links escaping the canonical package directory. Top-level `assets` directories are listed one level deep. References must be Markdown files beneath `references`. Skill-package symlinks are supported, including packages outside a configured discovery root.

Output is limited to 48 KiB. An incomplete result includes an exact `--offset <byte>` continuation command. Offsets must land on UTF-8 boundaries. Continuations rediscover and reread files, so do not edit the library while paging.

## Host catalogs

Supply `loadedSkills` for package-managed skills or other host discovery policies. A nonempty catalog is authoritative and replaces root discovery. Each entry has `name`, `description`, `filePath`, and `baseDir`. Optional `disableModelInvocation` hides entries. `sourceInfo.scope: "project"` categorizes an entry as `session`. Files still belong to the conversation's environment.

For changing catalogs, use `getLoadedSkills(api, context)`. It runs once per invocation and takes precedence over `loadedSkills`. Honor the supplied cancellation context. An empty catalog falls back to configured roots, matching the source tool.

Discovery does not read Pi settings or resolve Pi packages. Hosts needing those external policies should supply their resolved catalog. See [parity evidence](../../docs/parity/skills.md) for the exact migration boundary.

Filesystem failures are reported rather than replaced by local reads. Missing roots are empty catalogs. Unsupported canonical-path operations fail visibly. Read-only calls may rerun after Durable recovery and see current file contents.
