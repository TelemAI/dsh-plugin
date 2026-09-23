# @telemai/dsh-plugin

Telem web search for [DeepSeek Harness](https://github.com/deepseek-harness) (DSH):
two native DSH tools, `telem_search` (batched, provider-attributed web search)
and `telem_fetch` (read up to 5 pages by URL), with the unified Telem config and
trajectory-v5 lineage the other Telem plugins share.

**Status: experimental.** Built against DSH `0.1.5-rc.2`; DSH's plugin APIs are
prerelease and may change between release candidates.

## Install

DSH installs plugins per profile (`web`, `headless`, …) through pnpm, so `pnpm`
must be on your `PATH`.

```sh
dsh plugin --profile web add @telemai/dsh-plugin
dsh plugin --profile headless add @telemai/dsh-plugin   # if you use the headless profile too
```

Or from a packed tarball: `dsh plugin --profile web add ./telemai-dsh-plugin-0.1.0-rc.1.tgz`.

Verify: `dsh --profile web --dump-config` lists a `telem` row, and the model
sees `telem_search` / `telem_fetch` in every preset (the tools register
globally; DSH resolves tools agent → preset → global).

## Tools

- `telem_search({ queries: string[], goal?: string })` — one or more queries run
  concurrently as one interaction; the result is one section per query, one
  `[provider]` line per result, provider failures shown inline. `goal` labels
  the step in monitoring.
- `telem_fetch({ urls: string[] })` — up to 5 absolute http(s) URLs per call,
  fetched as one batch; failed URLs keep their status and error rather than
  failing the call. Under DSH's default spill policy (50 KB inline) a full
  five-page batch is spilled to disk with a preview; the model reads the spill.

Both tools are concurrency-safe and honour DSH's cancellation and timeout
policy.

## Built-in `web_search`

This plugin does not disable DSH's built-in `web_search`; it adds a
system-prompt section preferring Telem. To make Telem the only search tool:

- **headless / TUI profiles** — `tool-web` is a host row in dsh-base: add
  `- id: tool-web` with `disabled: true` to your profile's `cordis.patch.yml`.
- **Web profile** — the host row is already disabled there and the shipped,
  read-only presets mount `tool-web` per session: copy the preset you use into
  `$DSH_HOME/.agent-presets/` without that row.

DSH's built-in `web_fetch` is off by default (`fetch: false`).

## Credentials

Resolved on **every** call, in this order — so a rotated key reaches the next
call with no restart:

1. DSH's credential service, asked for `TELEM_API_KEY` (or the `apiKeyEnv` you
   configure): its local provider layers your process environment,
   `$DSH_HOME/.credentials.yaml`, then `.env` files.
2. `TELEM_API_KEY` in the environment.
3. `~/.telem/credentials.json` — the file `npm create @telemai` writes. It may
   also carry a `baseUrl`.

The key is never written to `cordis.patch.yml`, argv, logs, or tool output.
Requests use `redirect: 'error'`, so a bearer credential can never follow a
redirect off the configured host.

## Configuration

Search options resolve on every call, per key:

1. this plugin's row `config` in your profile patch (see below);
2. `<project>/.telem/telem.json`, where the project is the calling agent's
   session directory;
3. `~/.telem/telem.json`;
4. `TELEM_*` environment variables (`TELEM_TIER`, `TELEM_FIELDS`,
   `TELEM_PROVIDERS_INCLUDE`, `TELEM_PROVIDERS_EXCLUDE`, `TELEM_FULL_CONTENT`).

Keys: `tier`, `fields`, `providersInclude`, `providersExclude`, `fullContent`,
`providerOverrides` — the same vocabulary as every Telem surface (see the
config-core schema). Nothing configured means the server's defaults.

To set plugin-level config, override the row in
`~/.dsh/profiles/<profile>/cordis.patch.yml` (or `$DSH_HOME/cordis.patch.yml`
for all profiles). A patch replaces the row's **whole** config, so restate every
key you keep:

```yaml
- id: telem
  config:
    tier: max
    searchTimeoutMs: 60000     # DSH enforces it host-side (default 60000)
    fetchTimeoutMs: 60000
    apiKeyEnv: TELEM_API_KEY   # a credential NAME, never a value
    # baseUrl: https://router.telem.ai   # or TELEM_BASE_URL
```

Config-file warnings (a malformed file, an ignored key, a project file choosing
providers) go to stderr once per edit.

## Subagents and lineage

Every search and fetch carries trajectory-v5 metadata: the DSH session's
context-window key (rotated on each summarizing compaction), the message history
of the calling agent, and — for in-process subagents (spawn/fork) — a frozen
snapshot of the parent at the child's creation. The compaction is tracked as a
projection over delivered session events (DSH's session-projection registry
when the composition mounts it, which also covers a session resumed from
storage; otherwise the `session/event` feed), never by reading a session's event
history. A parent's snapshot is read through DSH's session-query service
(`ctx.sessionQuery.observeSession`, live-preferred: the live log's immutable
snapshot while the parent is live, storage otherwise; a forked parent reads the
same way), which the dsh-base bundle mounts. The snapshot is folded over the
parent's log as it stood at the child's creation, so a compaction the parent
runs later never changes it. When the parent's events cannot be read but its
header is known, the ancestor is still emitted keys-only (empty context) so the
two sessions stay linked on the backend.
Out-of-process backends (`subagent-acp`, `subagent-claude-code`, `subagent-codex`,
`subagent-dsh-sdk`) run in a separate process without this plugin: no Telem tools
there, no lineage. Lineage is best-effort; a lineage failure never fails a search,
and a degraded lineage is reported once per session on stderr
(`telem: lineage for session … degraded: …`).

## Troubleshooting

- **401 Missing API key** — nothing in the chain above resolved a key. Run
  `npm create @telemai`, or `export TELEM_API_KEY=…`, or add it to
  `$DSH_HOME/.credentials.yaml`.
- **"answered without the V2 normalized contract"** — the backend at `baseUrl`
  is pre-V2; point `TELEM_BASE_URL` at a V2 deployment.
- **Tools missing in a subagent** — the child composition's `toolFilter` hides
  global tools, or the child runs out of process (see above).
- **`dsh plugin add` fails with exit 127** — `pnpm` is not on `PATH`.

## License

Copyright (c) 2026 Telem AI. Licensed under the [Apache License, Version 2.0](LICENSE).
