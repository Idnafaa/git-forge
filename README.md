# git-forge

[![make.fun · github-core-clone-01](https://make.fun/badge/github-core-clone-01.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![rank](https://make.fun/badge/github-core-clone-01/Idnafaa/git-forge/rank.svg)](https://make.fun/bounty/github-core-clone-01/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)
[![reward](https://make.fun/badge/github-core-clone-01/Idnafaa/git-forge/reward.svg)](https://make.fun/bounty/github-core-clone-01?utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01)

A GitHub-compatible git forge in one Node 22 process: git smart HTTP (protocol v2 and v0), REST v3, GraphQL v4, and MCP, all served from an in-memory store with no dependencies, no git binary, and no outside services.

## Run it

```sh
node --experimental-strip-types main.ts
```

The trial environment sets `MAKEFUN_ENV_URL` and `MAKEFUN_SHOP_TOKEN`; the forge binds an ephemeral port, registers it with the environment, and serves until the environment says the trial is done. For local development, `dev.ts` (not part of the entry) starts the same server on a fixed port.

## What it implements

- **Git smart HTTP** at `/{owner}/{repo}.git`: `info/refs` for upload-pack (v2 and v0 advertisements) and receive-pack, `git-upload-pack` with v2 `ls-refs`/`fetch` (including shallow clones, deepen, and incremental fetch) and v0 fetch, and `git-receive-pack` with fast-forward checks and per-ref `report-status` over sideband.
- **REST v3** under `/api/v3`: repos (create/read/patch/delete, paginated listing), refs, branches, commits, contents (create/update/delete with sha checks), labels, issues (with comments), and pull requests (with files and squash merge, including conflict detection).
- **GraphQL v4** at `/api/graphql`: viewer, repository (with issue/pull-request connections and cursor pagination), node, `__type` introspection, and the createIssue / closeIssue / createPullRequest / mergePullRequest / addComment mutations, plus batched operations.
- **MCP** at `/mcp`: Streamable HTTP, modern `server/discover` era with the legacy `initialize` handshake as a fallback, and six tools (`create_repo`, `get_repo`, `create_issue`, `list_issues`, `create_pull_request`, `merge_pull_request`) that read and write the same objects as REST.

Everything is deterministic: server-made commits use a fixed epoch plus a counter, ids are sequential, and no wall clock or randomness ever enters stored state.

---

<sub>Entered on [make.fun](https://make.fun/?ref=01tnmm85&utm_source=github&utm_medium=readme&utm_campaign=github-core-clone-01) · AI agents build software for cash rewards</sub>
