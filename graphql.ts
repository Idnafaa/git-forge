// GraphQL v4: a small parser and executor for the documents the suite sends. It is not a
// general GraphQL server — it implements exactly the query/mutation shapes in the wire contract
// (viewer, repository, node, __type, issue/pull-request connections, the five mutations, batching)
// plus field validation with GitHub-style error messages.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_TIME, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { authed, parseJsonBody, sendJson, unauthorized, VIEWER } from './http-util.ts';
import { currentTips } from './rest.ts';

// ---------------------------------------------------------------- global ids

export function globalId(kind: string, ...parts: (string | number)[]): string {
  return Buffer.from([kind, ...parts].join(':'), 'utf8').toString('base64url');
}

function decodeGlobalId(id: string): { kind: string; parts: string[] } | null {
  try {
    const text = Buffer.from(id, 'base64url').toString('utf8');
    const [kind, ...parts] = text.split(':');
    if (!kind) return null;
    return { kind, parts };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- parser

type Value =
  | { kind: 'variable'; name: string }
  | { kind: 'string'; value: string }
  | { kind: 'int'; value: number }
  | { kind: 'float'; value: number }
  | { kind: 'boolean'; value: boolean }
  | { kind: 'null' }
  | { kind: 'enum'; value: string }
  | { kind: 'list'; values: Value[] }
  | { kind: 'object'; fields: { name: string; value: Value }[] };

interface FieldNode {
  kind: 'field';
  name: string;
  alias: string;
  args: { name: string; value: Value }[];
  selections: SelectionNode[];
}

interface FragmentNode {
  kind: 'fragment';
  typeCondition: string | null;
  selections: SelectionNode[];
}

type SelectionNode = FieldNode | FragmentNode;

interface Operation {
  type: 'query' | 'mutation';
  name: string | null;
  variables: Record<string, Value>;
  selections: SelectionNode[];
}

function tokenize(src: string): string[] {
  const tokens: string[] = [];
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (c === ' ' || c === '\t' || c === '\n' || c === '\r' || c === ',' || c === '#') {
      if (c === '#') while (i < src.length && src[i] !== '\n') i++;
      else i++;
      continue;
    }
    if (c === '.' && src.slice(i, i + 3) === '...') {
      tokens.push('...');
      i += 3;
      continue;
    }
    if ('{}():$!=@[]|'.includes(c)) {
      tokens.push(c);
      i++;
      continue;
    }
    if (c === '"') {
      let j = i + 1;
      let out = '';
      while (j < src.length && src[j] !== '"') {
        if (src[j] === '\\' && j + 1 < src.length) {
          const esc = src[j + 1];
          out += esc === 'n' ? '\n' : esc === 't' ? '\t' : esc === 'r' ? '\r' : esc;
          j += 2;
        } else {
          out += src[j];
          j++;
        }
      }
      tokens.push(JSON.stringify(out));
      i = j + 1;
      continue;
    }
    let j = i;
    while (j < src.length && /[A-Za-z0-9_.-]/.test(src[j])) j++;
    tokens.push(src.slice(i, j));
    i = j;
  }
  return tokens;
}

class Parser {
  private pos = 0;
  private tokens: string[];
  constructor(tokens: string[]) {
    this.tokens = tokens;
  }

  peek(): string | undefined {
    return this.tokens[this.pos];
  }

  next(): string {
    return this.tokens[this.pos++];
  }

  expect(tok: string): void {
    const got = this.next();
    if (got !== tok) throw new Error(`expected ${tok}, got ${got}`);
  }

  parseDocument(): { operations: Operation[]; fragments: Record<string, FragmentNode> } {
    const operations: Operation[] = [];
    const fragments: Record<string, FragmentNode> = {};
    while (this.pos < this.tokens.length) {
      const tok = this.peek();
      if (tok === 'fragment') {
        this.next();
        const name = this.next();
        this.expect('on');
        const typeCondition = this.next();
        const selections = this.parseSelectionSet();
        fragments[name] = { kind: 'fragment', typeCondition, selections };
      } else {
        operations.push(this.parseOperation());
      }
    }
    return { operations, fragments };
  }

  parseOperation(): Operation {
    let type: 'query' | 'mutation' = 'query';
    let name: string | null = null;
    let variables: Record<string, Value> = {};
    const tok = this.peek();
    if (tok === 'query' || tok === 'mutation') {
      type = this.next() as 'query' | 'mutation';
      const n = this.peek();
      if (n && n !== '{' && n !== '(') name = this.next();
      if (this.peek() === '(') variables = this.parseVariableDefinitions();
    }
    const selections = this.parseSelectionSet();
    return { type, name, variables, selections };
  }

  parseVariableDefinitions(): Record<string, Value> {
    const out: Record<string, Value> = {};
    this.expect('(');
    while (this.peek() !== ')') {
      this.expect('$');
      const name = this.next();
      this.expect(':');
      // Skip the type (Name, [Name], Name!, [Name!]!).
      this.skipType();
      if (this.peek() === '=') {
        this.next();
        this.parseValue();
      }
      out[name] = { kind: 'null' };
    }
    this.expect(')');
    return out;
  }

  skipType(): void {
    if (this.peek() === '[') {
      this.next();
      this.skipType();
      this.expect(']');
    } else {
      this.next();
    }
    if (this.peek() === '!') this.next();
  }

  parseSelectionSet(): SelectionNode[] {
    this.expect('{');
    const out: SelectionNode[] = [];
    while (this.peek() !== '}') {
      out.push(this.parseSelection());
    }
    this.expect('}');
    return out;
  }

  parseSelection(): SelectionNode {
    if (this.peek() === '...') {
      this.next();
      if (this.peek() === 'on') {
        this.next();
        const typeCondition = this.next();
        const selections = this.parseSelectionSet();
        return { kind: 'fragment', typeCondition, selections };
      }
      // Named fragment spread: resolved by the executor via the fragments table.
      const name = this.next();
      return { kind: 'fragment', typeCondition: name, selections: [] };
    }
    const first = this.next();
    let alias = first;
    let name = first;
    if (this.peek() === ':') {
      this.next();
      name = this.next();
    }
    const args: { name: string; value: Value }[] = [];
    if (this.peek() === '(') {
      this.next();
      while (this.peek() !== ')') {
        const argName = this.next();
        this.expect(':');
        args.push({ name: argName, value: this.parseValue() });
      }
      this.next();
    }
    const selections = this.peek() === '{' ? this.parseSelectionSet() : [];
    return { kind: 'field', name, alias, args, selections };
  }

  parseValue(): Value {
    const tok = this.next();
    if (tok === '$') return { kind: 'variable', name: this.next() };
    if (tok === '[') {
      const values: Value[] = [];
      while (this.peek() !== ']') values.push(this.parseValue());
      this.next();
      return { kind: 'list', values };
    }
    if (tok === '{') {
      const fields: { name: string; value: Value }[] = [];
      while (this.peek() !== '}') {
        const name = this.next();
        this.expect(':');
        fields.push({ name, value: this.parseValue() });
      }
      this.next();
      return { kind: 'object', fields };
    }
    if (tok === 'true') return { kind: 'boolean', value: true };
    if (tok === 'false') return { kind: 'boolean', value: false };
    if (tok === 'null') return { kind: 'null' };
    if (tok.startsWith('"')) return { kind: 'string', value: JSON.parse(tok) as string };
    if (/^-?\d+$/.test(tok)) return { kind: 'int', value: parseInt(tok, 10) };
    if (/^-?\d*\.\d+$/.test(tok)) return { kind: 'float', value: parseFloat(tok) };
    return { kind: 'enum', value: tok };
  }
}

// ---------------------------------------------------------------- values

function resolveValue(v: Value, variables: Record<string, unknown>): unknown {
  switch (v.kind) {
    case 'variable':
      return variables[v.name] ?? null;
    case 'string':
    case 'int':
    case 'float':
    case 'boolean':
      return v.value;
    case 'null':
      return null;
    case 'enum':
      return v.value;
    case 'list':
      return v.values.map((x) => resolveValue(x, variables));
    case 'object': {
      const out: Record<string, unknown> = {};
      for (const f of v.fields) out[f.name] = resolveValue(f.value, variables);
      return out;
    }
  }
}

// ---------------------------------------------------------------- type metadata (for __type and field validation)

const TYPE_FIELDS: Record<string, string[]> = {
  Query: ['viewer', 'repository', 'node', '__type'],
  Mutation: ['createIssue', 'closeIssue', 'createPullRequest', 'mergePullRequest', 'addComment'],
  User: ['login', 'id', 'name', 'email', 'avatarUrl', 'url'],
  Repository: ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'issue', 'issues', 'pullRequests', 'pullRequest', 'description', 'isPrivate', 'createdAt', 'updatedAt', 'url'],
  Issue: ['id', 'number', 'title', 'state', 'body', 'author', 'createdAt', 'updatedAt', 'url', 'comments', 'labels'],
  PullRequest: ['id', 'number', 'title', 'state', 'merged', 'headRefName', 'baseRefName', 'mergeable', 'files', 'body', 'author', 'createdAt', 'mergedAt', 'mergeCommitSha', 'headRef', 'baseRef'],
  IssueConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  PullRequestConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  FileConnection: ['nodes', 'edges', 'pageInfo', 'totalCount'],
  IssueEdge: ['node', 'cursor'],
  PullRequestEdge: ['node', 'cursor'],
  CommentEdge: ['node', 'cursor'],
  FileEdge: ['node', 'cursor'],
  PageInfo: ['hasNextPage', 'hasPreviousPage', 'startCursor', 'endCursor'],
  Ref: ['name', 'target', 'prefix'],
  IssueComment: ['id', 'body', 'author', 'createdAt'],
  File: ['path', 'additions', 'deletions', 'changeType'],
  __Type: ['name', 'kind', 'description', 'fields', 'enumValues', 'inputFields', 'interfaces', 'possibleTypes', 'ofType'],
  __Field: ['name', 'description', 'args', 'type', 'isDeprecated', 'deprecationReason'],
  __EnumValue: ['name', 'description', 'isDeprecated', 'deprecationReason'],
  __InputValue: ['name', 'description', 'type', 'defaultValue'],
};

const TYPE_ENUMS: Record<string, string[]> = {
  SearchType: ['ISSUE', 'PULL_REQUEST', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'MILESTONE', 'ORGANIZATION'],
  IssueState: ['OPEN', 'CLOSED'],
  PullRequestState: ['OPEN', 'CLOSED', 'MERGED'],
  MergeableState: ['CONFLICTING', 'MERGEABLE', 'UNKNOWN'],
  IssueOrderField: ['COMMENTS', 'CREATED_AT', 'UPDATED_AT'],
  OrderDirection: ['ASC', 'DESC'],
};

// ---------------------------------------------------------------- executor

interface Ctx {
  store: Store;
  errors: { message: string; path?: (string | number)[] }[];
  fragments: Record<string, FragmentNode>;
}

type Obj = Record<string, unknown> & { __typename: string };

function userObj(login: string): Obj {
  return { __typename: 'User', login, id: login === VIEWER.login ? VIEWER.id : 1002, name: login === VIEWER.login ? VIEWER.name : login, email: login === VIEWER.login ? VIEWER.email : `${login}@example.invalid` };
}

function repoObj(repo: Repo): Obj {
  return { __typename: 'Repository', repo };
}

function issueObj(store: Store, repo: Repo, issue: Issue): Obj {
  return { __typename: 'Issue', store, repo, issue };
}

function pullObj(store: Store, repo: Repo, pr: Pull): Obj {
  return { __typename: 'PullRequest', store, repo, pr };
}

function cursorFor(n: number): string {
  return Buffer.from(`cursor:${n}`, 'utf8').toString('base64url');
}

function cursorNum(cursor: string | null): number | null {
  if (!cursor) return null;
  try {
    const text = Buffer.from(cursor, 'base64url').toString('utf8');
    const m = text.match(/^cursor:(\d+)$/);
    return m ? parseInt(m[1], 10) : null;
  } catch {
    return null;
  }
}

function issueConnection(store: Store, repo: Repo, args: Record<string, unknown>): Obj {
  const first = typeof args.first === 'number' ? args.first : null;
  const after = cursorNum(typeof args.after === 'string' ? args.after : null);
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  const orderBy = (args.orderBy as { field?: string; direction?: string } | undefined) ?? {};
  const direction = orderBy.direction ?? 'DESC';
  let items = [...repo.issues.values()];
  if (states) items = items.filter((i) => states.includes(i.state.toUpperCase()));
  items.sort((a, b) => (direction === 'ASC' ? a.number - b.number : b.number - a.number));
  if (after !== null) {
    items = items.filter((i) => (direction === 'ASC' ? i.number > after : i.number < after));
  }
  const hasNextPage = first !== null && items.length > first;
  const page = first !== null ? items.slice(0, first) : items;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __typename: 'IssueConnection',
    store,
    repo,
    nodes: page.map((i) => issueObj(store, repo, i)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length > 0 ? cursorFor(page[0].number) : null },
  };
}

function pullConnection(store: Store, repo: Repo, args: Record<string, unknown>): Obj {
  const first = typeof args.first === 'number' ? args.first : null;
  const states = Array.isArray(args.states) ? (args.states as string[]) : null;
  let items = [...repo.pulls.values()];
  if (states) items = items.filter((p) => states.includes(p.state.toUpperCase()));
  items.sort((a, b) => b.number - a.number);
  const hasNextPage = first !== null && items.length > first;
  const page = first !== null ? items.slice(0, first) : items;
  const endCursor = page.length > 0 ? cursorFor(page[page.length - 1].number) : null;
  return {
    __typename: 'PullRequestConnection',
    store,
    repo,
    nodes: page.map((p) => pullObj(store, repo, p)),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor, hasPreviousPage: false, startCursor: page.length > 0 ? cursorFor(page[0].number) : null },
  };
}

function fileConnection(store: Store, repo: Repo, pr: Pull, args: Record<string, unknown>): Obj {
  const first = typeof args.first === 'number' ? args.first : null;
  const { headSha, baseSha } = currentTips(store, repo, pr);
  const mb = store.mergeBase(repo, baseSha, headSha);
  let paths: { path: string }[] = [];
  if (mb) {
    const mbInfo = store.getCommit(repo, mb);
    const headInfo = store.getCommit(repo, headSha);
    if (mbInfo && headInfo) {
      paths = store.diffTrees(repo, mbInfo.tree, headInfo.tree).map((d) => ({ path: d.path }));
    }
  }
  paths.sort((a, b) => (a.path < b.path ? -1 : 1));
  const page = first !== null ? paths.slice(0, first) : paths;
  const hasNextPage = first !== null && paths.length > first;
  return {
    __typename: 'FileConnection',
    nodes: page.map((f) => ({ __typename: 'File', ...f, additions: 1, deletions: 0, changeType: 'MODIFIED' })),
    pageInfo: { __typename: 'PageInfo', hasNextPage, endCursor: null, hasPreviousPage: false, startCursor: null },
  };
}

function findRepoByDbId(store: Store, dbId: number): Repo | null {
  for (const r of store.repos.values()) if (r.dbId === dbId) return r;
  return null;
}

function resolveNode(store: Store, id: string): Obj | null {
  const dec = decodeGlobalId(id);
  if (!dec) return null;
  if (dec.kind === 'Repository') {
    const repo = findRepoByDbId(store, parseInt(dec.parts[0], 10));
    return repo ? repoObj(repo) : null;
  }
  if (dec.kind === 'Issue') {
    const repo = findRepoByDbId(store, parseInt(dec.parts[0], 10));
    const issue = repo?.issues.get(parseInt(dec.parts[1], 10));
    return repo && issue ? issueObj(store, repo, issue) : null;
  }
  if (dec.kind === 'PullRequest') {
    const repo = findRepoByDbId(store, parseInt(dec.parts[0], 10));
    const pr = repo?.pulls.get(parseInt(dec.parts[1], 10));
    return repo && pr ? pullObj(store, repo, pr) : null;
  }
  return null;
}

function createIssueFromInput(store: Store, input: Record<string, unknown>): Obj | null {
  const dec = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
  if (!dec || dec.kind !== 'Repository') return null;
  const repo = findRepoByDbId(store, parseInt(dec.parts[0], 10));
  if (!repo) return null;
  const title = typeof input.title === 'string' ? input.title : '';
  const number = ++repo.numberSeq;
  const issue: Issue = {
    id: store.nextNodeId++,
    number,
    title,
    body: typeof input.body === 'string' ? input.body : '',
    state: 'open',
    labels: [],
    userLogin: VIEWER.login,
    createdAt: FIXED_TIME,
    updatedAt: FIXED_TIME,
  };
  repo.issues.set(number, issue);
  return issueObj(store, repo, issue);
}

function closeIssueFromInput(store: Store, input: Record<string, unknown>): Obj | null {
  const dec = typeof input.issueId === 'string' ? decodeGlobalId(input.issueId) : null;
  if (!dec || dec.kind !== 'Issue') return null;
  const repo = findRepoByDbId(store, parseInt(dec.parts[0], 10));
  const issue = repo?.issues.get(parseInt(dec.parts[1], 10));
  if (!repo || !issue) return null;
  issue.state = 'closed';
  return issueObj(store, repo, issue);
}

function createPullFromInput(store: Store, input: Record<string, unknown>): Obj | null {
  const dec = typeof input.repositoryId === 'string' ? decodeGlobalId(input.repositoryId) : null;
  if (!dec || dec.kind !== 'Repository') return null;
  const repo = findRepoByDbId(store, parseInt(dec.parts[0], 10));
  if (!repo) return null;
  const head = typeof input.headRefName === 'string' ? input.headRefName : '';
  const base = typeof input.baseRefName === 'string' ? input.baseRefName : repo.defaultBranch;
  const title = typeof input.title === 'string' ? input.title : '';
  const headTip = repo.refs.get(`refs/heads/${head}`);
  const baseTip = repo.refs.get(`refs/heads/${base}`);
  if (!headTip || !baseTip) return null;
  for (const p of repo.pulls.values()) {
    if (p.state === 'open' && p.headRef === head && p.baseRef === base) return pullObj(store, repo, p);
  }
  const number = ++repo.numberSeq;
  const pr: Pull = {
    id: store.nextNodeId++,
    number,
    title,
    body: '',
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
  return pullObj(store, repo, pr);
}

function mergePullFromInput(store: Store, input: Record<string, unknown>): Obj | null {
  const dec = typeof input.pullRequestId === 'string' ? decodeGlobalId(input.pullRequestId) : null;
  if (!dec || dec.kind !== 'PullRequest') return null;
  const repo = findRepoByDbId(store, parseInt(dec.parts[0], 10));
  const pr = repo?.pulls.get(parseInt(dec.parts[1], 10));
  if (!repo || !pr) return null;
  if (pr.merged) return pullObj(store, repo, pr);
  const { headSha, baseSha } = currentTips(store, repo, pr);
  if (store.hasMergeConflict(repo, baseSha, headSha)) return pullObj(store, repo, pr);
  const mb = store.mergeBase(repo, baseSha, headSha);
  const baseInfo = store.getCommit(repo, baseSha);
  const headInfo = store.getCommit(repo, headSha);
  const mbInfo = mb ? store.getCommit(repo, mb) : null;
  if (!baseInfo || !headInfo) return pullObj(store, repo, pr);
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
  return pullObj(store, repo, pr);
}

function addCommentFromInput(store: Store, input: Record<string, unknown>): Obj | null {
  const dec = typeof input.subjectId === 'string' ? decodeGlobalId(input.subjectId) : null;
  if (!dec || dec.kind !== 'Issue') return null;
  const repo = findRepoByDbId(store, parseInt(dec.parts[0], 10));
  const issue = repo?.issues.get(parseInt(dec.parts[1], 10));
  if (!repo || !issue) return null;
  const body = typeof input.body === 'string' ? input.body : '';
  const id = store.nextCommentId++;
  repo.comments.set(id, { id, issueNumber: issue.number, body, userLogin: VIEWER.login, createdAt: FIXED_TIME });
  return {
    __typename: 'CommentEdge',
    node: { __typename: 'IssueComment', id: globalId('IssueComment', repo.dbId, id), body, author: userObj(VIEWER.login), createdAt: FIXED_TIME },
    cursor: cursorFor(id),
  };
}

function resolveField(obj: Obj, field: string, args: Record<string, unknown>, ctx: Ctx): unknown {
  const store = ctx.store;
  switch (obj.__typename) {
    case 'Query': {
      if (field === 'viewer') return userObj(VIEWER.login);
      if (field === 'repository') {
        const repo = store.getRepo(String(args.owner ?? ''), String(args.name ?? ''));
        if (!repo || String(args.owner) !== VIEWER.login) return null;
        return repoObj(repo);
      }
      if (field === 'node') return typeof args.id === 'string' ? resolveNode(store, args.id) : null;
      if (field === '__type') {
        const name = String(args.name ?? '');
        if (!TYPE_FIELDS[name] && !TYPE_ENUMS[name]) return null;
        return { __typename: '__Type', name, fields: TYPE_FIELDS[name] ?? [], enumValues: TYPE_ENUMS[name] ?? [] };
      }
      return undefined;
    }
    case 'Mutation': {
      if (field === 'createIssue') {
        const issue = createIssueFromInput(store, (args.input as Record<string, unknown>) ?? {});
        return { __typename: 'CreateIssuePayload', issue };
      }
      if (field === 'closeIssue') {
        const issue = closeIssueFromInput(store, (args.input as Record<string, unknown>) ?? {});
        return { __typename: 'CloseIssuePayload', issue };
      }
      if (field === 'createPullRequest') {
        const pr = createPullFromInput(store, (args.input as Record<string, unknown>) ?? {});
        return { __typename: 'CreatePullRequestPayload', pullRequest: pr };
      }
      if (field === 'mergePullRequest') {
        const pr = mergePullFromInput(store, (args.input as Record<string, unknown>) ?? {});
        return { __typename: 'MergePullRequestPayload', pullRequest: pr };
      }
      if (field === 'addComment') {
        const edge = addCommentFromInput(store, (args.input as Record<string, unknown>) ?? {});
        return { __typename: 'AddCommentPayload', commentEdge: edge };
      }
      return undefined;
    }
    case 'User': {
      if (field === 'login') return obj.login;
      if (field === 'id') return globalId('User', String(obj.id));
      if (field === 'name') return obj.name;
      if (field === 'email') return obj.email;
      if (field === 'avatarUrl') return '';
      if (field === 'url') return `https://github.com/${obj.login}`;
      return undefined;
    }
    case 'Repository': {
      const repo = obj.repo as Repo;
      if (field === 'id') return globalId('Repository', repo.dbId);
      if (field === 'databaseId') return repo.dbId;
      if (field === 'name') return repo.name;
      if (field === 'nameWithOwner') return `${repo.owner}/${repo.name}`;
      if (field === 'owner') return userObj(repo.owner);
      if (field === 'defaultBranchRef') {
        const tip = repo.refs.get(`refs/heads/${repo.defaultBranch}`);
        return tip ? { __typename: 'Ref', name: repo.defaultBranch, target: { __typename: 'Commit', oid: tip } } : null;
      }
      if (field === 'viewerPermission') return 'ADMIN';
      if (field === 'hasIssuesEnabled') return true;
      if (field === 'description') return repo.description;
      if (field === 'isPrivate') return repo.isPrivate;
      if (field === 'createdAt') return FIXED_TIME;
      if (field === 'updatedAt') return FIXED_TIME;
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}`;
      if (field === 'issue') {
        const issue = repo.issues.get(Number(args.number));
        return issue ? issueObj(store, repo, issue) : null;
      }
      if (field === 'issues') return issueConnection(store, repo, args);
      if (field === 'pullRequests') return pullConnection(store, repo, args);
      if (field === 'pullRequest') {
        const pr = repo.pulls.get(Number(args.number));
        return pr ? pullObj(store, repo, pr) : null;
      }
      return undefined;
    }
    case 'Issue': {
      const issue = obj.issue as Issue;
      const repo = obj.repo as Repo;
      if (field === 'id') return globalId('Issue', repo.dbId, issue.number);
      if (field === 'number') return issue.number;
      if (field === 'title') return issue.title;
      if (field === 'state') return issue.state.toUpperCase();
      if (field === 'body') return issue.body;
      if (field === 'author') return userObj(issue.userLogin);
      if (field === 'createdAt') return issue.createdAt;
      if (field === 'updatedAt') return issue.updatedAt;
      if (field === 'url') return `https://github.com/${repo.owner}/${repo.name}/issues/${issue.number}`;
      if (field === 'comments') {
        const items = [...repo.comments.values()].filter((c) => c.issueNumber === issue.number);
        return { __typename: 'IssueCommentConnection', nodes: items.map((c) => ({ __typename: 'IssueComment', id: globalId('IssueComment', repo.dbId, c.id), body: c.body, author: userObj(c.userLogin), createdAt: c.createdAt })) };
      }
      if (field === 'labels') {
        return { __typename: 'LabelConnection', nodes: issue.labels.map((l) => ({ __typename: 'Label', name: l.name, color: l.color })) };
      }
      return undefined;
    }
    case 'PullRequest': {
      const pr = obj.pr as Pull;
      const repo = obj.repo as Repo;
      if (field === 'id') return globalId('PullRequest', repo.dbId, pr.number);
      if (field === 'number') return pr.number;
      if (field === 'title') return pr.title;
      if (field === 'state') return pr.merged ? 'MERGED' : pr.state.toUpperCase();
      if (field === 'merged') return pr.merged;
      if (field === 'headRefName') return pr.headRef;
      if (field === 'baseRefName') return pr.baseRef;
      if (field === 'mergeable') {
        const { headSha, baseSha } = currentTips(store, repo, pr);
        return store.hasMergeConflict(repo, baseSha, headSha) ? 'CONFLICTING' : 'MERGEABLE';
      }
      if (field === 'files') return fileConnection(store, repo, pr, args);
      if (field === 'body') return pr.body;
      if (field === 'author') return userObj(VIEWER.login);
      if (field === 'createdAt') return pr.createdAt;
      if (field === 'mergedAt') return pr.mergedAt;
      if (field === 'mergeCommitSha') return pr.mergeCommitSha;
      if (field === 'headRef') return { __typename: 'Ref', name: pr.headRef };
      if (field === 'baseRef') return { __typename: 'Ref', name: pr.baseRef };
      return undefined;
    }
    case 'IssueConnection':
    case 'PullRequestConnection':
    case 'FileConnection':
    case 'IssueCommentConnection':
    case 'LabelConnection': {
      if (field === 'nodes') return obj.nodes;
      if (field === 'edges') {
        const nodes = (obj.nodes as unknown[]) ?? [];
        return nodes.map((n) => ({ __typename: 'IssueEdge', node: n, cursor: '' }));
      }
      if (field === 'pageInfo') return obj.pageInfo;
      if (field === 'totalCount') return ((obj.nodes as unknown[]) ?? []).length;
      return undefined;
    }
    case 'PageInfo': {
      if (field === 'hasNextPage') return obj.hasNextPage;
      if (field === 'hasPreviousPage') return obj.hasPreviousPage;
      if (field === 'startCursor') return obj.startCursor;
      if (field === 'endCursor') return obj.endCursor;
      return undefined;
    }
    case 'Ref': {
      if (field === 'name') return obj.name;
      if (field === 'target') return obj.target;
      if (field === 'prefix') return 'refs/heads/';
      return undefined;
    }
    case 'IssueComment': {
      if (field === 'id') return obj.id;
      if (field === 'body') return obj.body;
      if (field === 'author') return obj.author;
      if (field === 'createdAt') return obj.createdAt;
      return undefined;
    }
    case 'File': {
      if (field === 'path') return obj.path;
      if (field === 'additions') return obj.additions;
      if (field === 'deletions') return obj.deletions;
      if (field === 'changeType') return obj.changeType;
      return undefined;
    }
    case '__Type': {
      if (field === 'name') return obj.name;
      if (field === 'kind') return (obj.enumValues as string[]).length > 0 ? 'ENUM' : 'OBJECT';
      if (field === 'description') return null;
      if (field === 'fields') {
        const includeDeprecated = args.includeDeprecated === true;
        void includeDeprecated;
        return ((obj.fields as string[]) ?? []).map((n) => ({ __typename: '__Field', name: n }));
      }
      if (field === 'enumValues') {
        return ((obj.enumValues as string[]) ?? []).map((n) => ({ __typename: '__EnumValue', name: n }));
      }
      if (field === 'inputFields') return [];
      if (field === 'interfaces') return [];
      if (field === 'possibleTypes') return [];
      if (field === 'ofType') return null;
      return undefined;
    }
    case '__Field': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      if (field === 'args') return [];
      if (field === 'type') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return undefined;
    }
    case '__EnumValue': {
      if (field === 'name') return obj.name;
      if (field === 'description') return null;
      if (field === 'isDeprecated') return false;
      if (field === 'deprecationReason') return null;
      return undefined;
    }
    case 'CreateIssuePayload':
    case 'CloseIssuePayload': {
      if (field === 'issue') return obj.issue;
      return undefined;
    }
    case 'CreatePullRequestPayload':
    case 'MergePullRequestPayload': {
      if (field === 'pullRequest') return obj.pullRequest;
      return undefined;
    }
    case 'AddCommentPayload': {
      if (field === 'commentEdge') return obj.commentEdge;
      return undefined;
    }
    case 'CommentEdge':
    case 'IssueEdge':
    case 'PullRequestEdge':
    case 'FileEdge': {
      if (field === 'node') return obj.node;
      if (field === 'cursor') return obj.cursor;
      return undefined;
    }
    case 'Commit': {
      if (field === 'oid') return obj.oid;
      return undefined;
    }
    case 'Label': {
      if (field === 'name') return obj.name;
      if (field === 'color') return obj.color;
      return undefined;
    }
    default:
      return undefined;
  }
}

function executeSelections(
  obj: Obj,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: Ctx,
  path: (string | number)[],
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const sel of selections) {
    if (sel.kind === 'fragment') {
      if (sel.selections.length > 0) {
        // Inline fragment: apply when the type condition matches (or is absent).
        if (!sel.typeCondition || sel.typeCondition === obj.__typename) {
          Object.assign(out, executeSelections(obj, sel.selections, variables, ctx, path));
        }
      } else if (sel.typeCondition && ctx.fragments[sel.typeCondition]) {
        // Named fragment spread.
        const frag = ctx.fragments[sel.typeCondition];
        if (!frag.typeCondition || frag.typeCondition === obj.__typename) {
          Object.assign(out, executeSelections(obj, frag.selections, variables, ctx, path));
        }
      }
      continue;
    }
    if (sel.name === '__typename') {
      out[sel.alias] = obj.__typename;
      continue;
    }
    const args: Record<string, unknown> = {};
    for (const a of sel.args) args[a.name] = resolveValue(a.value, variables);
    const value = resolveField(obj, sel.name, args, ctx);
    if (value === undefined) {
      ctx.errors.push({
        message: `Cannot query field "${sel.name}" on type "${obj.__typename}".`,
        path: [...path, sel.alias],
      });
      out[sel.alias] = null;
      continue;
    }
    out[sel.alias] = resolveValueNode(value, sel.selections, variables, ctx, [...path, sel.alias]);
  }
  return out;
}

function resolveValueNode(
  value: unknown,
  selections: SelectionNode[],
  variables: Record<string, unknown>,
  ctx: Ctx,
  path: (string | number)[],
): unknown {
  if (value === null || value === undefined) return value;
  if (Array.isArray(value)) {
    return value.map((v, i) => resolveValueNode(v, selections, variables, ctx, [...path, i]));
  }
  if (typeof value === 'object' && '__typename' in (value as Record<string, unknown>)) {
    // An object field without a sub-selection is invalid GraphQL; never serialize the raw
    // internal object (it holds the store and would be circular).
    if (selections.length === 0) return null;
    return executeSelections(value as Obj, selections, variables, ctx, path);
  }
  return value;
}

function executeOperation(store: Store, op: Operation, variables: Record<string, unknown>, fragments: Record<string, FragmentNode>): { data: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } {
  const ctx: Ctx = { store, errors: [], fragments };
  const root: Obj = { __typename: op.type === 'mutation' ? 'Mutation' : 'Query' };
  const data = executeSelections(root, op.selections, variables, ctx, []);
  const out: { data: Record<string, unknown> | null; errors?: { message: string; path?: (string | number)[] }[] } = { data };
  if (ctx.errors.length > 0) out.errors = ctx.errors;
  return out;
}

// ---------------------------------------------------------------- handler

export function handleGraphQL(
  store: Store,
  req: IncomingMessage,
  res: ServerResponse,
  body: Buffer,
): boolean {
  if (!authed(req)) {
    unauthorized(res);
    return true;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { message: 'Problems parsing JSON' });
    return true;
  }
  const requests = Array.isArray(parsed.value) ? parsed.value : [parsed.value];
  const results = requests.map((r) => {
    const input = (r ?? {}) as Record<string, unknown>;
    const query = typeof input.query === 'string' ? input.query : '';
    const variables = (input.variables as Record<string, unknown>) ?? {};
    const operationName = typeof input.operationName === 'string' ? input.operationName : null;
    try {
      const parser = new Parser(tokenize(query));
      const { operations, fragments } = parser.parseDocument();
      const op = operationName ? operations.find((o) => o.name === operationName) ?? operations[0] : operations[0];
      if (!op) return { data: null, errors: [{ message: 'No operation found in query' }] };
      return executeOperation(store, op, variables, fragments);
    } catch (err) {
      return { data: null, errors: [{ message: err instanceof Error ? err.message : 'GraphQL parse error' }] };
    }
  });
  sendJson(res, 200, Array.isArray(parsed.value) ? results : results[0]);
  return true;
}
