# github-core-clone-01

[![github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/huimou612/github-core-clone-01/rank.svg)](https://make.fun/bounty/github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/huimou612/github-core-clone-01/reward.svg)](https://make.fun/bounty/github-core-clone-01)

A standalone GitHub-compatible git forge in Node 22 (erasable TypeScript, standard
library only), built for [the make.fun bounty](https://make.fun/bounty/github-core-clone-01).
One process serves git smart HTTP, REST v3, GraphQL v4 and MCP over streamable HTTP,
all on the same in-memory store — no git binary, no network, no dependencies.

## What it serves

| Route | What it is |
| --- | --- |
| `GET /healthz` | 200 `{"ok":true}`: the env's boot probe, called twice |
| `GET /api/v3/` | 200, `X-Oauth-Scopes: repo, read:org`, a JSON API root |
| `/api/v3/...` | GitHub REST v3: repositories, branches, commits, refs, contents, issues, comments, labels, pull requests, files, squash merges |
| `POST /api/graphql` | GitHub GraphQL v4: the eighteen documents `gh` and `github-mcp-server` send |
| `POST /mcp` | Model Context Protocol over streamable HTTP: `server/discover`, `initialize`, `tools/list`, `tools/call` |
| `/<owner>/<repo>.git/...` | git smart HTTP: `info/refs`, `git-upload-pack` (protocol v2 with v0 fallback), `git-receive-pack` (v0) |
| anything else | 404 `{"message":"Not Found"}` |

Details worth knowing:

- **Git**: pkt-line framing, packfile parse (plain objects plus `OFS_DELTA` /
  `REF_DELTA`) and generate (plain objects), shallow clones (`deepen`, including
  deepen past a held boundary), annotated tags (push, peel in `ls-refs` and the
  v0 advertisement, round-trip in clones), fast-forward enforcement with
  per-ref `report-status` (`non-fast-forward` refuses one ref while the others
  still apply), and delete-refs.
- **Pull requests**: three-way file merge for conflict detection; squash merge
  lands a commit on the base branch and closes the request as merged.
- **Determinism**: no wall clock, no `Math.random`, no unseeded ids anywhere a
  response carries one. Timestamps come from `MAKEFUN_TRIAL_NOW` when the env
  sets it, else a fixed base time plus a monotonic counter, so a replayed trial
  exports byte-identical state.
- **Performance**: in-memory Maps, a fetch-pack cache keyed on the repo version
  (so 50 concurrent shallow clones of one tip share one pack build), and
  keep-alive friendly HTTP.

## Run it

```sh
node --experimental-strip-types main.ts
```

The platform runs `node /bot/main.ts` on Node 22.18 or later, which strips
TypeScript types on its own; the flag is harmless there and makes an older local
Node work too. There is nothing to install: the program imports `node:http`,
`node:zlib`, `node:crypto` and its own `lib/` modules only, and the trial has no
package manager and no internet.

`MAKEFUN_ENV_URL` names the env to register with; `MAKEFUN_SHOP_TOKEN` is the
bearer token every API call presents. Without `MAKEFUN_ENV_URL` the program
exits 1 at once.

## Layout

- `main.ts`: the entry ↔ env lifecycle (bind an ephemeral port, register it,
  poll until the env says done, exit 0). Keep it as it is.
- `app.ts`: the server and its routing.
- `lib/util.ts`: deterministic time and ids, sha1, base64 cursors.
- `lib/gitobj.ts`: git objects, trees, commits, tags, deltas, packfiles.
- `lib/store.ts`: the shared store — repos, objects and refs, issues, pulls,
  three-way merge, fetch planning.
- `lib/gitproto.ts`: pkt-lines, advertisements, upload-pack v0/v2, receive-pack.
- `lib/rest.ts`: REST v3. `lib/graphql.ts`: GraphQL v4. `lib/mcp.ts`: MCP.
- `package.json`, `tsconfig.json`, `LICENSE` (MIT), `.makefun/owner.json`.

## Score

Practice trials, local grader (`grade-local --driver process`): feature
600/600, agent 200/200, perf 184/200 — 984/1000 on the final run, 973–979
across three instances, replay-verified byte for byte.

---

Built for [make.fun](https://make.fun/bounty/github-core-clone-01?ref=vy4ejv7y)
