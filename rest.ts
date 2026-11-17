// REST v3: /api/v3 — repos, refs, branches, commits, contents, labels, issues, pulls.
// Shapes follow the GitHub API closely enough that the suite's client can read them; every
// reply is JSON and carries X-GitHub-Request-Id.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  FIXED_TIME,
  parseCommit,
  parseTree,
  sha1Of,
  ZERO_OID,
  type Issue,
  type Label,
  type Pull,
  type Repo,
  type Store,
} from './store.ts';
import { authed, notFound, parseJsonBody, sendEmpty, sendJson, unauthorized, VIEWER } from './http-util.ts';

// ---------------------------------------------------------------- serializers

export function repoJson(store: Store, repo: Repo): Record<string, unknown> {
  const openIssues = [...repo.issues.values()].filter((i) => i.state === 'open').length;
  const openPulls = [...repo.pulls.values()].filter((p) => p.state === 'open').length;
  return {
    id: repo.dbId,
    node_id: Buffer.from(`Repository:${repo.dbId}`).toString('base64'),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner, id: repo.owner === VIEWER.login ? VIEWER.id : 1002, type: 'User' },
    private: repo.isPrivate,
    description: repo.description,
    default_branch: repo.defaultBranch,
    html_url: `https://github.com/${repo.owner}/${repo.name}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: FIXED_TIME,
    updated_at: FIXED_TIME,
    pushed_at: FIXED_TIME,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
    has_pages: false,
    forks_count: 0,
    open_issues_count: openIssues + openPulls,
    watchers_count: 0,
    stargazers_count: 0,
    subscribers_count: 0,
    license: null,
    visibility: repo.isPrivate ? 'private' : 'public',
    archived: false,
    disabled: false,
    fork: false,
    language: null,
    topics: [],
  };
}

export function labelJson(repo: Repo, label: Label): Record<string, unknown> {
  const idx = [...repo.labels.keys()].indexOf(label.name);
  return {
    id: repo.dbId * 1000 + idx + 1,
    node_id: Buffer.from(`Label:${repo.dbId}:${label.name}`).toString('base64'),
    name: label.name,
    color: label.color,
    description: label.description,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/labels/${encodeURIComponent(label.name)}`,
    default: false,
  };
}

export function issueJson(store: Store, repo: Repo, issue: Issue): Record<string, unknown> {
  const commentCount = [...repo.comments.values()].filter((c) => c.issueNumber === issue.number).length;
  return {
    id: issue.id,
    node_id: Buffer.from(`Issue:${repo.dbId}:${issue.number}`).toString('base64'),
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((l) => labelJson(repo, l)),
    user: { login: issue.userLogin, id: issue.userLogin === VIEWER.login ? VIEWER.id : 1002, type: 'User' },
    assignee: null,
    assignees: [],
    locked: false,
    comments: commentCount,
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    repository_url: `/api/v3/repos/${repo.owner}/${repo.name}`,
  };
}

export function currentTips(store: Store, repo: Repo, pr: Pull): { headSha: string; baseSha: string } {
  const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
  const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
  return { headSha, baseSha };
}

export function pullJson(store: Store, repo: Repo, pr: Pull): Record<string, unknown> {
  const { headSha, baseSha } = currentTips(store, repo, pr);
  const mergeable = !store.hasMergeConflict(repo, baseSha, headSha);
  return {
    id: pr.id,
    node_id: Buffer.from(`PullRequest:${repo.dbId}:${pr.number}`).toString('base64'),
    number: pr.number,
    title: pr.title,
    body: pr.body,
    state: pr.state,
    locked: false,
    user: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
    head: { ref: pr.headRef, sha: headSha, label: `${repo.owner}:${pr.headRef}`, user: { login: repo.owner, id: VIEWER.id, type: 'User' } },
    base: { ref: pr.baseRef, sha: baseSha, label: `${repo.owner}:${pr.baseRef}`, user: { login: repo.owner, id: VIEWER.id, type: 'User' } },
    merged: pr.merged,
    mergeable,
    merged_at: pr.mergedAt,
    merge_commit_sha: pr.mergeCommitSha,
    created_at: pr.createdAt,
    updated_at: pr.createdAt,
    closed_at: pr.state === 'closed' ? pr.createdAt : null,
    html_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pr.number}`,
    diff_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.diff`,
    patch_url: `https://github.com/${repo.owner}/${repo.name}/pull/${pr.number}.patch`,
    comments: 0,
    review_comments: 0,
    commits: 0,
    additions: 0,
    deletions: 0,
    changed_files: 0,
  };
}

function commentJson(repo: Repo, c: { id: number; body: string; userLogin: string; createdAt: string }): Record<string, unknown> {
  return {
    id: c.id,
    node_id: Buffer.from(`IssueComment:${repo.dbId}:${c.id}`).toString('base64'),
    body: c.body,
    user: { login: c.userLogin, id: c.userLogin === VIEWER.login ? VIEWER.id : 1002, type: 'User' },
    created_at: c.createdAt,
    updated_at: c.createdAt,
    html_url: `https://github.com/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/comments/${c.id}`,
  };
}

// ---------------------------------------------------------------- helpers

function pageParams(query: URLSearchParams): { page: number; perPage: number } {
  const page = Math.max(1, parseInt(query.get('page') ?? '1', 10) || 1);
  const perPage = Math.min(100, Math.max(1, parseInt(query.get('per_page') ?? '30', 10) || 30));
  return { page, perPage };
}

function paginate<T>(req: IncomingMessage, path: string, query: URLSearchParams, items: T[]): { page: T[]; link: string | null } {
  const { page, perPage } = pageParams(query);
  const total = items.length;
  const pages = Math.max(1, Math.ceil(total / perPage));
  const start = (page - 1) * perPage;
  const host = req.headers.host ?? 'localhost';
  const base = `http://${host}${path}`;
  const linkFor = (p: number, rel: string): string => `<${base}?per_page=${perPage}&page=${p}>; rel="${rel}"`;
  const links: string[] = [];
  if (page < pages) links.push(linkFor(page + 1, 'next'));
  if (page > 1) links.push(linkFor(page - 1, 'prev'));
  links.push(linkFor(1, 'first'));
  links.push(linkFor(pages, 'last'));
  return { page: items.slice(start, start + perPage), link: links.length > 0 ? links.join(', ') : null };
}

function lookupRepo(store: Store, owner: string, name: string): Repo | null {
  const repo = store.getRepo(owner, name);
  if (!repo) return null;
  // A repo belongs to the login the token names; the same name under another owner is a 404.
  if (owner !== VIEWER.login) return null;
  return repo;
}

/** Resolve a ref-ish (branch name, oid, or HEAD) to a commit oid, or null. */
function resolveRef(store: Store, repo: Repo, ref: string): string | null {
  if (ref === 'HEAD') {
    return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
  }
  const byName = repo.refs.get(`refs/heads/${ref}`) ?? repo.refs.get(`refs/tags/${ref}`);
  if (byName) return store.peelToCommit(repo, byName);
  if (/^[0-9a-f]{40}$/.test(ref)) return store.peelToCommit(repo, ref);
  return null;
}

/** Walk a tree to a path: file, directory, or missing. */
function resolvePath(
  store: Store,
  repo: Repo,
  treeOid: string,
  path: string,
): { kind: 'file'; oid: string; mode: string } | { kind: 'dir'; oid: string } | null {
  const parts = path.split('/').filter((p) => p.length > 0);
  let cur = treeOid;
  for (let i = 0; i < parts.length; i++) {
    const obj = repo.objects.get(cur);
    if (!obj || obj.type !== 'tree') return null;
    const entry = parseTree(obj.data).find((e) => e.name === parts[i]);
    if (!entry) return null;
    const isLast = i === parts.length - 1;
    if (entry.mode === '40000') {
      if (isLast) return { kind: 'dir', oid: entry.oid };
      cur = entry.oid;
    } else {
      if (!isLast) return null;
      return { kind: 'file', oid: entry.oid, mode: entry.mode };
    }
  }
  return { kind: 'dir', oid: treeOid };
}

function listDir(store: Store, repo: Repo, treeOid: string, dirPath: string): Record<string, unknown>[] {
  const obj = repo.objects.get(treeOid);
  if (!obj || obj.type !== 'tree') return [];
  const out: Record<string, unknown>[] = [];
  for (const e of parseTree(obj.data)) {
    const path = dirPath === '' ? e.name : `${dirPath}/${e.name}`;
    if (e.mode === '40000') {
      out.push({ type: 'dir', name: e.name, path, sha: e.oid, size: 0, url: '', html_url: '', git_url: '', download_url: null });
    } else {
      const blob = repo.objects.get(e.oid);
      out.push({ type: 'file', name: e.name, path, sha: e.oid, size: blob?.data.length ?? 0, url: '', html_url: '', git_url: '', download_url: null });
    }
  }
  void store;
  return out;
}

function parseIdent(ident: string): { name: string; email: string; date: string } {
  const m = ident.match(/^(.*?) <(.*?)> (\d+) ([+-]\d{4})$/);
  if (!m) return { name: ident, email: '', date: FIXED_TIME };
  const date = new Date(parseInt(m[3], 10) * 1000).toISOString();
  return { name: m[1], email: m[2], date };
}

/** Line counts for a changed file: multiset difference of lines. */
function lineCounts(oldText: string | null, newText: string | null): { additions: number; deletions: number } {
  const oldLines = oldText === null ? [] : oldText.split('\n');
  const newLines = newText === null ? [] : newText.split('\n');
  const counts = new Map<string, number>();
  for (const l of oldLines) counts.set(l, (counts.get(l) ?? 0) + 1);
  let additions = 0;
  for (const l of newLines) {
    const c = counts.get(l) ?? 0;
    if (c > 0) counts.set(l, c - 1);
    else additions++;
  }
  let deletions = 0;
  for (const c of counts.values()) deletions += c;
  return { additions, deletions };
}

// ---------------------------------------------------------------- router

export function handleRest(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  method: string,
  segments: string[],
  query: URLSearchParams,
  body: Buffer,
): boolean {
  if (segments[0] !== 'api' || segments[1] !== 'v3') return false;

  if (!authed(req)) {
    unauthorized(res);
    return true;
  }

  const rest = segments.slice(2);

  // GET /api/v3
  if (rest.length === 0) {
    if (method !== 'GET') return notFound(res), true;
    sendJson(res, 200, { current_user_url: '/api/v3/user', rate_limit_url: '/api/v3/rate_limit' }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (rest.length === 1 && rest[0] === 'meta') {
    if (method !== 'GET') return notFound(res), true;
    sendJson(res, 200, { installed_version: '1.0.0' });
    return true;
  }

  // GET /api/v3/user
  if (rest.length === 1 && rest[0] === 'user') {
    if (method !== 'GET') return notFound(res), true;
    sendJson(res, 200, {
      login: VIEWER.login,
      id: VIEWER.id,
      name: VIEWER.name,
      email: VIEWER.email,
      type: 'User',
      avatar_url: '',
      html_url: `https://github.com/${VIEWER.login}`,
      url: '/api/v3/user',
    });
    return true;
  }

  // /api/v3/user/repos
  if (rest.length === 2 && rest[0] === 'user' && rest[1] === 'repos') {
    if (method === 'GET') {
      const repos = store.listRepos(VIEWER.login);
      const { page, link } = paginate(req, '/api/v3/user/repos', query, repos);
      sendJson(res, 200, page.map((r) => repoJson(store, r)), link ? { link } : {});
      return true;
    }
    if (method === 'POST') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const input = parsed.value as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      if (!name) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Repository', field: 'name', code: 'missing_field' }] });
        return true;
      }
      if (store.getRepo(VIEWER.login, name)) {
        sendJson(res, 422, { message: 'Repository creation failed.', errors: [{ resource: 'Repository', field: 'name', code: 'custom', message: 'name already exists on this account' }] });
        return true;
      }
      const repo = store.createRepo(
        VIEWER.login,
        name,
        typeof input.description === 'string' ? input.description : '',
        input.private === true,
      );
      sendJson(res, 201, repoJson(store, repo));
      return true;
    }
    return notFound(res), true;
  }

  // Everything below is /api/v3/repos/{owner}/{repo}/...
  if (rest.length < 3 || rest[0] !== 'repos') return notFound(res), true;
  const owner = decodeURIComponent(rest[1]);
  const repoName = decodeURIComponent(rest[2]);
  const repo = lookupRepo(store, owner, repoName);
  if (!repo) return notFound(res), true;
  const tail = rest.slice(3);

  // /repos/{o}/{r}
  if (tail.length === 0) {
    if (method === 'GET') {
      sendJson(res, 200, repoJson(store, repo));
      return true;
    }
    if (method === 'PATCH') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const input = parsed.value as Record<string, unknown>;
      if (typeof input.description === 'string') repo.description = input.description;
      if (typeof input.private === 'boolean') repo.isPrivate = input.private;
      sendJson(res, 200, repoJson(store, repo));
      return true;
    }
    if (method === 'DELETE') {
      store.deleteRepo(owner, repoName);
      sendEmpty(res, 204);
      return true;
    }
    return notFound(res), true;
  }

  // /repos/{o}/{r}/branches
  if (tail[0] === 'branches') {
    if (tail.length === 1) {
      if (method !== 'GET') return notFound(res), true;
      const out = [...repo.refs.entries()]
        .filter(([name]) => name.startsWith('refs/heads/'))
        .sort((a, b) => (a[0] < b[0] ? -1 : 1))
        .map(([name, oid]) => ({
          name: name.slice('refs/heads/'.length),
          commit: { sha: oid, url: '' },
          protected: false,
        }));
      sendJson(res, 200, out);
      return true;
    }
    const branch = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
    const oid = repo.refs.get(`refs/heads/${branch}`);
    if (!oid) return notFound(res), true;
    if (method !== 'GET') return notFound(res), true;
    sendJson(res, 200, { name: branch, commit: { sha: oid, url: '' }, protected: false });
    return true;
  }

  // /repos/{o}/{r}/commits
  if (tail[0] === 'commits') {
    if (method !== 'GET' || tail.length !== 1) return notFound(res), true;
    const ref = query.get('sha') ?? repo.defaultBranch;
    const tip = resolveRef(store, repo, ref);
    if (!tip) return notFound(res), true;
    const commits = store.listCommits(repo, tip);
    sendJson(
      res,
      200,
      commits.map(({ sha, info }) => {
        const author = parseIdent(info.author);
        const committer = parseIdent(info.committer);
        return {
          sha,
          commit: {
            message: info.message,
            author: { name: author.name, email: author.email, date: author.date },
            committer: { name: committer.name, email: committer.email, date: committer.date },
            tree: { sha: info.tree },
          },
          author: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          committer: { login: VIEWER.login, id: VIEWER.id, type: 'User' },
          parents: info.parents.map((p) => ({ sha: p })),
        };
      }),
    );
    return true;
  }

  // /repos/{o}/{r}/git/refs
  if (tail[0] === 'git' && tail[1] === 'refs') {
    if (tail.length === 2) {
      if (method !== 'POST') return notFound(res), true;
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const input = parsed.value as Record<string, unknown>;
      const ref = typeof input.ref === 'string' ? input.ref : '';
      const sha = typeof input.sha === 'string' ? input.sha : '';
      if (!ref.startsWith('refs/') || !repo.objects.has(sha)) {
        sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Reference', code: 'invalid', field: 'sha' }] });
        return true;
      }
      if (repo.refs.has(ref)) {
        sendJson(res, 422, { message: 'Reference already exists' });
        return true;
      }
      repo.refs.set(ref, sha);
      const obj = repo.objects.get(sha);
      sendJson(res, 201, { ref, object: { sha, type: obj?.type ?? 'commit' }, url: '' });
      return true;
    }
    if (tail.length >= 4 && tail[2] === 'heads') {
      const branch = tail.slice(3).map((s) => decodeURIComponent(s)).join('/');
      const oid = repo.refs.get(`refs/heads/${branch}`);
      if (!oid) return notFound(res), true;
      if (method !== 'GET') return notFound(res), true;
      const obj = repo.objects.get(oid);
      sendJson(res, 200, { ref: `refs/heads/${branch}`, object: { sha: oid, type: obj?.type ?? 'commit' }, url: '' });
      return true;
    }
    return notFound(res), true;
  }

  // /repos/{o}/{r}/contents/{path}
  if (tail[0] === 'contents') {
    const path = tail.slice(1).map((s) => decodeURIComponent(s)).join('/');
    if (method === 'GET') {
      const ref = query.get('ref') ?? repo.defaultBranch;
      const tip = resolveRef(store, repo, ref);
      if (!tip) return notFound(res), true;
      const info = store.getCommit(repo, tip);
      if (!info) return notFound(res), true;
      if (path === '') {
        sendJson(res, 200, listDir(store, repo, info.tree, ''));
        return true;
      }
      const found = resolvePath(store, repo, info.tree, path);
      if (!found) return notFound(res), true;
      if (found.kind === 'dir') {
        sendJson(res, 200, listDir(store, repo, found.oid, path));
        return true;
      }
      const blob = repo.objects.get(found.oid);
      const data = blob?.data ?? Buffer.alloc(0);
      sendJson(res, 200, {
        type: 'file',
        encoding: 'base64',
        size: data.length,
        name: path.split('/').pop() ?? path,
        path,
        content: data.toString('base64'),
        sha: found.oid,
        url: '',
        git_url: '',
        html_url: '',
        download_url: null,
      });
      return true;
    }
    if (method === 'PUT') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const input = parsed.value as Record<string, unknown>;
      const message = typeof input.message === 'string' ? input.message : 'Update file';
      const contentB64 = typeof input.content === 'string' ? input.content : '';
      const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
      const givenSha = typeof input.sha === 'string' ? input.sha : null;
      let content: Buffer;
      try {
        content = Buffer.from(contentB64.replace(/\s/g, ''), 'base64');
      } catch {
        sendJson(res, 422, { message: 'Validation Failed' });
        return true;
      }
      const blobOid = store.storeObject(repo, 'blob', content);
      const refName = `refs/heads/${branch}`;
      let tip = repo.refs.get(refName);
      let tipInfo = tip ? store.getCommit(repo, tip) : null;
      if (!tip && branch !== repo.defaultBranch) {
        // A new branch starts from the default branch tip.
        tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? null;
        tipInfo = tip ? store.getCommit(repo, tip) : null;
      }
      let isUpdate = false;
      if (tipInfo) {
        const files = store.flattenTree(repo, tipInfo.tree);
        const existing = files.get(path);
        if (existing) {
          isUpdate = true;
          if (givenSha && givenSha !== existing.oid) {
            sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
            return true;
          }
        } else if (givenSha) {
          sendJson(res, 409, { message: 'Conflict: file does not exist' });
          return true;
        }
      }
      const newTree = store.applyToTree(repo, tipInfo ? tipInfo.tree : null, new Map([[path, { oid: blobOid, mode: '100644' }]]));
      const commitSha = store.createCommit(repo, newTree, tip ? [tip] : [], message);
      repo.refs.set(refName, commitSha);
      sendJson(res, isUpdate ? 200 : 201, {
        content: {
          name: path.split('/').pop() ?? path,
          path,
          sha: blobOid,
          size: content.length,
          encoding: 'base64',
          type: 'file',
          url: '',
          git_url: '',
          html_url: '',
          download_url: null,
        },
        commit: { sha: commitSha, message },
      });
      return true;
    }
    if (method === 'DELETE') {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const input = parsed.value as Record<string, unknown>;
      const message = typeof input.message === 'string' ? input.message : 'Delete file';
      const branch = typeof input.branch === 'string' ? input.branch : repo.defaultBranch;
      const givenSha = typeof input.sha === 'string' ? input.sha : null;
      const refName = `refs/heads/${branch}`;
      const tip = repo.refs.get(refName);
      if (!tip) return notFound(res), true;
      const tipInfo = store.getCommit(repo, tip);
      if (!tipInfo) return notFound(res), true;
      const files = store.flattenTree(repo, tipInfo.tree);
      const existing = files.get(path);
      if (!existing) return notFound(res), true;
      if (givenSha && givenSha !== existing.oid) {
        sendJson(res, 409, { message: 'Conflict: sha does not match the current file' });
        return true;
      }
      const newTree = store.applyToTree(repo, tipInfo.tree, new Map([[path, null]]));
      const commitSha = store.createCommit(repo, newTree, [tip], message);
      repo.refs.set(refName, commitSha);
      sendJson(res, 200, { commit: { sha: commitSha, message } });
      return true;
    }
    return notFound(res), true;
  }

  // /repos/{o}/{r}/labels
  if (tail[0] === 'labels') {
    if (method === 'GET' && tail.length === 1) {
      sendJson(res, 200, [...repo.labels.values()].map((l) => labelJson(repo, l)));
      return true;
    }
    if (method === 'POST' && tail.length === 1) {
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      const input = parsed.value as Record<string, unknown>;
      const name = typeof input.name === 'string' ? input.name : '';
      const color = typeof input.color === 'string' ? input.color.replace(/^#/, '') : 'ededed';
      if (!name) {
        sendJson(res, 422, { message: 'Validation Failed' });
        return true;
      }
      let label = repo.labels.get(name);
      if (!label) {
        label = { name, color, description: typeof input.description === 'string' ? input.description : '' };
        repo.labels.set(name, label);
      }
      sendJson(res, 201, labelJson(repo, label));
      return true;
    }
    return notFound(res), true;
  }

  // /repos/{o}/{r}/issues[/{n}[/comments]]
  if (tail[0] === 'issues') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        const sort = query.get('sort') ?? 'created';
        const direction = query.get('direction') ?? 'desc';
        let items = [...repo.issues.values()];
        if (state !== 'all') items = items.filter((i) => i.state === state);
        items.sort((a, b) => (sort === 'created' ? a.number - b.number : a.number - b.number));
        if (direction === 'desc') items.reverse();
        const { page, link } = paginate(req, `/api/v3/repos/${owner}/${repoName}/issues`, query, items);
        sendJson(res, 200, page.map((i) => issueJson(store, repo, i)), link ? { link } : {});
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const input = parsed.value as Record<string, unknown>;
        const title = typeof input.title === 'string' ? input.title : '';
        const labelNames = Array.isArray(input.labels) ? (input.labels as unknown[]).filter((l): l is string => typeof l === 'string') : [];
        const labels: Label[] = [];
        for (const ln of labelNames) {
          const l = repo.labels.get(ln);
          if (!l) {
            sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'Issue', field: 'labels', code: 'invalid', message: `Label '${ln}' does not exist` }] });
            return true;
          }
          labels.push(l);
        }
        if (!title) {
          sendJson(res, 422, { message: 'Validation Failed' });
          return true;
        }
        const number = ++repo.numberSeq;
        const issue: Issue = {
          id: store.nextNodeId++,
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          labels,
          userLogin: VIEWER.login,
          createdAt: FIXED_TIME,
          updatedAt: FIXED_TIME,
        };
        repo.issues.set(number, issue);
        sendJson(res, 201, issueJson(store, repo, issue));
        return true;
      }
      return notFound(res), true;
    }
    const n = parseInt(tail[1], 10);
    if (Number.isNaN(n)) return notFound(res), true;
    const issue = repo.issues.get(n);
    if (tail.length === 2) {
      if (!issue) return notFound(res), true;
      if (method === 'GET') {
        sendJson(res, 200, issueJson(store, repo, issue));
        return true;
      }
      if (method === 'PATCH') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const input = parsed.value as Record<string, unknown>;
        if (typeof input.title === 'string') issue.title = input.title;
        if (typeof input.body === 'string') issue.body = input.body;
        if (input.state === 'open' || input.state === 'closed') issue.state = input.state;
        if (Array.isArray(input.labels)) {
          const labels: Label[] = [];
          let bad: string | null = null;
          for (const ln of input.labels as unknown[]) {
            if (typeof ln !== 'string') continue;
            const l = repo.labels.get(ln);
            if (!l) {
              bad = ln;
              break;
            }
            labels.push(l);
          }
          if (bad) {
            sendJson(res, 422, { message: `Label '${bad}' does not exist` });
            return true;
          }
          issue.labels = labels;
        }
        sendJson(res, 200, issueJson(store, repo, issue));
        return true;
      }
      return notFound(res), true;
    }
    if (tail.length === 3 && tail[2] === 'comments') {
      if (!issue) return notFound(res), true;
      if (method === 'GET') {
        const items = [...repo.comments.values()].filter((c) => c.issueNumber === n).sort((a, b) => a.id - b.id);
        sendJson(res, 200, items.map((c) => commentJson(repo, c)));
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const input = parsed.value as Record<string, unknown>;
        const commentBody = typeof input.body === 'string' ? input.body : '';
        if (!commentBody) {
          sendJson(res, 422, { message: 'Validation Failed' });
          return true;
        }
        const id = store.nextCommentId++;
        const comment = { id, issueNumber: n, body: commentBody, userLogin: VIEWER.login, createdAt: FIXED_TIME };
        repo.comments.set(id, comment);
        sendJson(res, 201, commentJson(repo, comment));
        return true;
      }
      return notFound(res), true;
    }
    return notFound(res), true;
  }

  // /repos/{o}/{r}/pulls[/{n}[/files|/merge]]
  if (tail[0] === 'pulls') {
    if (tail.length === 1) {
      if (method === 'GET') {
        const state = query.get('state') ?? 'open';
        let items = [...repo.pulls.values()];
        if (state !== 'all') items = items.filter((p) => p.state === state);
        items.sort((a, b) => b.number - a.number);
        const { page, link } = paginate(req, `/api/v3/repos/${owner}/${repoName}/pulls`, query, items);
        sendJson(res, 200, page.map((p) => pullJson(store, repo, p)), link ? { link } : {});
        return true;
      }
      if (method === 'POST') {
        const parsed = parseJsonBody(body);
        if (!parsed.ok) {
          sendJson(res, 400, { message: 'Problems parsing JSON' });
          return true;
        }
        const input = parsed.value as Record<string, unknown>;
        const title = typeof input.title === 'string' ? input.title : '';
        const head = typeof input.head === 'string' ? input.head : '';
        const base = typeof input.base === 'string' ? input.base : repo.defaultBranch;
        if (!title || !head) {
          sendJson(res, 422, { message: 'Validation Failed' });
          return true;
        }
        const headTip = repo.refs.get(`refs/heads/${head}`);
        const baseTip = repo.refs.get(`refs/heads/${base}`);
        if (!headTip || !baseTip) {
          sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'invalid', field: 'head', message: 'head or base branch does not exist' }] });
          return true;
        }
        for (const p of repo.pulls.values()) {
          if (p.state === 'open' && p.headRef === head && p.baseRef === base) {
            sendJson(res, 422, { message: 'Validation Failed', errors: [{ resource: 'PullRequest', code: 'custom', field: 'head', message: 'A pull request already exists for this head and base' }] });
            return true;
          }
        }
        const number = ++repo.numberSeq;
        const pr: Pull = {
          id: store.nextNodeId++,
          number,
          title,
          body: typeof input.body === 'string' ? input.body : '',
          state: 'open',
          merged: false,
          headRef: head,
          headSha: headTip,
          baseRef: base,
          baseSha: baseTip,
          mergedAt: null,
          mergeCommitSha: null,
          createdAt: FIXED_TIME,
        };
        repo.pulls.set(number, pr);
        sendJson(res, 201, pullJson(store, repo, pr));
        return true;
      }
      return notFound(res), true;
    }
    const n = parseInt(tail[1], 10);
    if (Number.isNaN(n)) return notFound(res), true;
    const pr = repo.pulls.get(n);
    if (tail.length === 2) {
      if (!pr) return notFound(res), true;
      if (method !== 'GET') return notFound(res), true;
      sendJson(res, 200, pullJson(store, repo, pr));
      return true;
    }
    if (tail.length === 3 && tail[2] === 'files') {
      if (!pr) return notFound(res), true;
      if (method !== 'GET') return notFound(res), true;
      const { headSha, baseSha } = currentTips(store, repo, pr);
      const mb = store.mergeBase(repo, baseSha, headSha);
      if (!mb) {
        sendJson(res, 200, []);
        return true;
      }
      const mbInfo = store.getCommit(repo, mb);
      const headInfo = store.getCommit(repo, headSha);
      if (!mbInfo || !headInfo) {
        sendJson(res, 200, []);
        return true;
      }
      const diff = store.diffTrees(repo, mbInfo.tree, headInfo.tree);
      const files = diff.map((d) => {
        const oldText = d.baseOid ? (repo.objects.get(d.baseOid)?.data.toString('utf8') ?? null) : null;
        const newText = d.headOid ? (repo.objects.get(d.headOid)?.data.toString('utf8') ?? null) : null;
        const { additions, deletions } = lineCounts(oldText, newText);
        const status = d.baseOid === null ? 'added' : d.headOid === null ? 'removed' : 'modified';
        return {
          sha: d.headOid ?? d.baseOid,
          filename: d.path,
          status,
          additions,
          deletions,
          changes: additions + deletions,
          blob_url: '',
          raw_url: '',
          contents_url: '',
        };
      });
      sendJson(res, 200, files);
      return true;
    }
    if (tail.length === 3 && tail[2] === 'merge') {
      if (!pr) return notFound(res), true;
      if (method !== 'PUT') return notFound(res), true;
      const parsed = parseJsonBody(body);
      if (!parsed.ok) {
        sendJson(res, 400, { message: 'Problems parsing JSON' });
        return true;
      }
      if (pr.merged) {
        sendJson(res, 405, { message: 'Pull request has already been merged' });
        return true;
      }
      const { headSha, baseSha } = currentTips(store, repo, pr);
      if (store.hasMergeConflict(repo, baseSha, headSha)) {
        sendJson(res, 405, { message: 'Merge conflict' });
        return true;
      }
      const mb = store.mergeBase(repo, baseSha, headSha);
      const baseInfo = store.getCommit(repo, baseSha);
      const headInfo = store.getCommit(repo, headSha);
      const mbInfo = mb ? store.getCommit(repo, mb) : null;
      if (!baseInfo || !headInfo) {
        sendJson(res, 405, { message: 'Merge conflict' });
        return true;
      }
      const changes = new Map<string, { oid: string; mode: string } | null>();
      if (mbInfo) {
        for (const d of store.diffTrees(repo, mbInfo.tree, headInfo.tree)) {
          changes.set(d.path, d.headOid ? { oid: d.headOid, mode: d.headMode ?? '100644' } : null);
        }
      } else {
        for (const [path, f] of store.flattenTree(repo, headInfo.tree)) changes.set(path, f);
      }
      const newTree = store.applyToTree(repo, baseInfo.tree, changes);
      const mergeSha = store.createCommit(repo, newTree, [baseSha], pr.title);
      repo.refs.set(`refs/heads/${pr.baseRef}`, mergeSha);
      pr.merged = true;
      pr.state = 'closed';
      pr.mergedAt = FIXED_TIME;
      pr.mergeCommitSha = mergeSha;
      sendJson(res, 200, { sha: mergeSha, merged: true, message: 'Pull Request successfully merged' });
      return true;
    }
    return notFound(res), true;
  }

  return notFound(res), true;
}

export { ZERO_OID };
