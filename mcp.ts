// MCP: Streamable HTTP, modern era (2026-07-28) via server/discover plus the legacy
// initialize handshake as a fallback. Tools are the six required ones; every tool result is
// JSON text plus structuredContent, and the same objects are visible over REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { FIXED_TIME, type Issue, type Pull, type Repo, type Store } from './store.ts';
import { authed, parseJsonBody, sendJson, unauthorized, VIEWER } from './http-util.ts';
import { issueJson, pullJson, repoJson } from './rest.ts';

const PROTOCOL_VERSION = '2026-07-28';
const SERVER_INFO = { name: 'forge-mcp', version: '1.0.0' };

interface ToolDef {
  name: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, { type: string; description: string }>; required: string[] };
}

const TOOLS: ToolDef[] = [
  {
    name: 'create_repo',
    description: 'Create a new repository for the authenticated user.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The name of the repository.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
      },
      required: ['name'],
    },
  },
  {
    name: 'get_repo',
    description: 'Get a repository by owner and name.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_issue',
    description: 'Create an issue in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the issue.' },
        body: { type: 'string', description: 'The body of the issue.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository, optionally filtered by state.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        state: { type: 'string', description: 'Issue state filter: open, closed, or all.' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from a head branch onto a base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        title: { type: 'string', description: 'The title of the pull request.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
        body: { type: 'string', description: 'The body of the pull request.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Merge a pull request by number.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The owner of the repository.' },
        repo: { type: 'string', description: 'The name of the repository.' },
        pull_number: { type: 'number', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

function findTool(name: string): ToolDef | undefined {
  const norm = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]/g, '');
  return TOOLS.find((t) => norm(t.name) === norm(name));
}

function argOf(args: Record<string, unknown>, names: string[]): unknown {
  for (const n of names) if (args[n] !== undefined) return args[n];
  return undefined;
}

function toolResult(result: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify(result) }],
    structuredContent: result,
    isError: false,
  };
}

function toolError(message: string): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: JSON.stringify({ error: message }) }],
    structuredContent: { error: message },
    isError: true,
  };
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const tool = findTool(name);
  if (!tool) return toolError(`unknown tool: ${name}`);
  for (const req of tool.inputSchema.required) {
    if (args[req] === undefined || args[req] === null || args[req] === '') {
      return toolError(`missing required argument: ${req}`);
    }
  }
  const owner = String(argOf(args, ['owner', 'owner_login', 'user']) ?? '');
  const repoName = String(argOf(args, ['repo', 'repository', 'name']) ?? '');
  const repo: Repo | undefined = owner !== '' && repoName !== '' ? store.getRepo(owner, repoName) : undefined;

  if (tool.name === 'create_repo') {
    const rname = String(args.name ?? '');
    if (store.getRepo(VIEWER.login, rname)) return toolError(`repository '${rname}' already exists`);
    const r = store.createRepo(VIEWER.login, rname, typeof args.description === 'string' ? args.description : '', args.private === true);
    return toolResult(repoJson(store, r));
  }
  if (!repo || owner !== VIEWER.login) return toolError(`repository '${owner}/${repoName}' not found`);

  if (tool.name === 'get_repo') return toolResult(repoJson(store, repo));

  if (tool.name === 'create_issue') {
    const title = String(args.title ?? '');
    const number = ++repo.numberSeq;
    const issue: Issue = {
      id: store.nextNodeId++,
      number,
      title,
      body: typeof args.body === 'string' ? args.body : '',
      state: 'open',
      labels: [],
      userLogin: VIEWER.login,
      createdAt: FIXED_TIME,
      updatedAt: FIXED_TIME,
    };
    repo.issues.set(number, issue);
    return toolResult(issueJson(store, repo, issue));
  }

  if (tool.name === 'list_issues') {
    const state = typeof args.state === 'string' ? args.state : 'open';
    let items = [...repo.issues.values()];
    if (state !== 'all') items = items.filter((i) => i.state === state);
    items.sort((a, b) => b.number - a.number);
    return toolResult(items.map((i) => issueJson(store, repo, i)));
  }

  if (tool.name === 'create_pull_request') {
    const head = String(args.head ?? '');
    const base = String(args.base ?? repo.defaultBranch);
    const title = String(args.title ?? '');
    const headTip = repo.refs.get(`refs/heads/${head}`);
    const baseTip = repo.refs.get(`refs/heads/${base}`);
    if (!headTip || !baseTip) return toolError('head or base branch does not exist');
    for (const p of repo.pulls.values()) {
      if (p.state === 'open' && p.headRef === head && p.baseRef === base) return toolResult(pullJson(store, repo, p));
    }
    const number = ++repo.numberSeq;
    const pr: Pull = {
      id: store.nextNodeId++,
      number,
      title,
      body: typeof args.body === 'string' ? args.body : '',
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
    return toolResult(pullJson(store, repo, pr));
  }

  if (tool.name === 'merge_pull_request') {
    const n = Number(argOf(args, ['pull_number', 'number', 'pullNumber']));
    const pr = repo.pulls.get(n);
    if (!pr) return toolError(`pull request #${n} not found`);
    if (pr.merged) return toolResult(pullJson(store, repo, pr));
    const headSha = repo.refs.get(`refs/heads/${pr.headRef}`) ?? pr.headSha;
    const baseSha = repo.refs.get(`refs/heads/${pr.baseRef}`) ?? pr.baseSha;
    if (store.hasMergeConflict(repo, baseSha, headSha)) return toolError('merge conflict');
    const mb = store.mergeBase(repo, baseSha, headSha);
    const baseInfo = store.getCommit(repo, baseSha);
    const headInfo = store.getCommit(repo, headSha);
    const mbInfo = mb ? store.getCommit(repo, mb) : null;
    if (!baseInfo || !headInfo) return toolError('merge conflict');
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
    return toolResult(pullJson(store, repo, pr));
  }

  return toolError(`unknown tool: ${name}`);
}

export function handleMcp(store: Store, req: IncomingMessage, res: ServerResponse, body: Buffer): boolean {
  if (req.method !== 'POST') {
    sendJson(res, 405, { message: 'Method Not Allowed' });
    return true;
  }
  if (!authed(req)) {
    unauthorized(res);
    return true;
  }
  const parsed = parseJsonBody(body);
  if (!parsed.ok) {
    sendJson(res, 400, { jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
    return true;
  }
  const input = parsed.value as Record<string, unknown>;
  if (typeof input !== 'object' || input === null || Array.isArray(input) || typeof input.method !== 'string') {
    sendJson(res, 400, { jsonrpc: '2.0', id: (input as Record<string, unknown>)?.id ?? null, error: { code: -32600, message: 'Invalid Request' } });
    return true;
  }
  const id = input.id ?? null;
  const method = input.method;
  const params = (input.params as Record<string, unknown>) ?? {};

  // Notifications carry no id and get no JSON-RPC reply.
  if (id === null || id === undefined) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return true;
  }

  const reply = (result: unknown): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, result });
  };
  const replyError = (code: number, message: string): void => {
    sendJson(res, 200, { jsonrpc: '2.0', id, error: { code, message } });
  };

  if (method === 'server/discover') {
    reply({
      supportedVersions: [PROTOCOL_VERSION, '2025-11-25'],
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
      _meta: { 'io.modelcontextprotocol/serverInfo': SERVER_INFO },
    });
    return true;
  }
  if (method === 'initialize') {
    const requested = typeof params.protocolVersion === 'string' ? params.protocolVersion : PROTOCOL_VERSION;
    const known = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'];
    reply({
      protocolVersion: known.includes(requested) ? requested : '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: SERVER_INFO,
    });
    return true;
  }
  if (method === 'notifications/initialized' || method.startsWith('notifications/')) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return true;
  }
  if (method === 'ping') {
    reply({});
    return true;
  }
  if (method === 'tools/list') {
    reply({ tools: TOOLS });
    return true;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = (params.arguments as Record<string, unknown>) ?? {};
    if (!findTool(name)) {
      replyError(-32602, `unknown tool: ${name}`);
      return true;
    }
    reply(callTool(store, name, args));
    return true;
  }
  replyError(-32601, `Method not found: ${method}`);
  return true;
}
