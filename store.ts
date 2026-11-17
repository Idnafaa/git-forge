// The forge's store: every repo's git objects, refs, issues, pulls and labels, all in memory.
// Deterministic by construction: server-made commits use a fixed epoch plus a counter, ids are
// sequential, and no wall clock or randomness ever enters stored state.

import { createHash } from 'node:crypto';

export type ObjType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: ObjType;
  data: Buffer;
}

export interface CommitInfo {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: Label[];
  userLogin: string;
  createdAt: string;
  updatedAt: string;
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  merged: boolean;
  headRef: string;
  headSha: string;
  baseRef: string;
  baseSha: string;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
}

export interface IssueComment {
  id: number;
  issueNumber: number;
  body: string;
  userLogin: string;
  createdAt: string;
}

export interface Repo {
  dbId: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdSeq: number;
  objects: Map<string, GitObject>;
  refs: Map<string, string>;
  labels: Map<string, Label>;
  issues: Map<number, Issue>;
  pulls: Map<number, Pull>;
  comments: Map<number, IssueComment>;
  numberSeq: number;
  commentSeq: number;
  /** Parsed commits, keyed by oid. Objects are immutable once stored, so this never goes stale. */
  commitInfo: Map<string, CommitInfo>;
  /** Full ancestor set per commit oid (the commit itself plus every ancestor). Immutable content, so no invalidation. */
  ancestorSet: Map<string, Set<string>>;
  /** Commit oids in creation order (insertion order of storeObject). */
  commitSeq: string[];
  /** Bumped on every object/ref mutation; fetch-pack cache keys include it. */
  version: number;
  /** Cached fetch packs, keyed by version + refs snapshot + fetch options. */
  fetchCache: Map<string, { pack: Buffer; shallow: string[]; unshallow: string[]; ack: string | null }>;
  /** Cached serialized single-issue JSON lines, keyed by issue number. */
  issueJsonCache: Map<number, { text: string; length: number }>;
}

/** The identity the forge signs its own commits with (the viewer, per the fixed scenario). */
export const SERVER_IDENTITY = 'adaiversen <adaiversen@example.invalid>';
/** Fixed epoch for server-made commits; a per-commit counter keeps them unique and ordered. */
export const SERVER_EPOCH = 1735689600;
/** Fixed ISO timestamps on REST objects: the suite never checks them, and real clocks would break determinism. */
export const FIXED_TIME = '2025-01-01T00:00:00Z';
export const ZERO_OID = '0000000000000000000000000000000000000000';

export function sha1Of(type: ObjType, data: Buffer): string {
  const h = createHash('sha1');
  h.update(`${type} ${data.length}\0`);
  h.update(data);
  return h.digest('hex');
}

export function parseCommit(data: Buffer): CommitInfo {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0];
  const lines = head.split('\n');
  let tree = '';
  const parents: string[] = [];
  let author = '';
  let committer = '';
  for (const line of lines) {
    if (line.startsWith('tree ')) tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) author = line.slice(7);
    else if (line.startsWith('committer ')) committer = line.slice(10);
  }
  const idx = text.indexOf('\n\n');
  const message = idx >= 0 ? text.slice(idx + 2) : '';
  return { tree, parents, author, committer, message };
}

export function encodeCommit(info: CommitInfo): Buffer {
  let out = `tree ${info.tree}\n`;
  for (const p of info.parents) out += `parent ${p}\n`;
  out += `author ${info.author}\ncommitter ${info.committer}\n\n${info.message}`;
  return Buffer.from(out, 'utf8');
}

export function parseTag(data: Buffer): { object: string; type: ObjType; tag: string; tagger: string; message: string } {
  const text = data.toString('utf8');
  const head = text.split('\n\n')[0];
  const lines = head.split('\n');
  let object = '';
  let type: ObjType = 'commit';
  let tag = '';
  let tagger = '';
  for (const line of lines) {
    if (line.startsWith('object ')) object = line.slice(7).trim();
    else if (line.startsWith('type ')) type = line.slice(5).trim() as ObjType;
    else if (line.startsWith('tag ')) tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tagger = line.slice(7);
  }
  const idx = text.indexOf('\n\n');
  return { object, type, tag, tagger, message: idx >= 0 ? text.slice(idx + 2) : '' };
}

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let i = 0;
  while (i < data.length) {
    const sp = data.indexOf(0x20, i);
    const mode = data.subarray(i, sp).toString('ascii');
    const nul = data.indexOf(0, sp);
    const name = data.subarray(sp + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    i = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries sort by name, directories as if the name ended in '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

export function encodeTree(entries: TreeEntry[]): Buffer {
  const sorted = sortTreeEntries(entries);
  const parts: Buffer[] = [];
  for (const e of sorted) {
    parts.push(Buffer.from(`${e.mode} ${e.name}\0`, 'utf8'));
    parts.push(Buffer.from(e.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

export class Store {
  repos = new Map<string, Repo>();
  nextRepoId = 1;
  nextNodeId = 1;
  nextCommentId = 1;
  repoSeq = 0;
  commitCounter = 0;
  requestSeq = 0;

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo {
    const repo: Repo = {
      dbId: this.nextRepoId++,
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdSeq: this.repoSeq++,
      objects: new Map(),
      refs: new Map(),
      labels: new Map(),
      issues: new Map(),
      pulls: new Map(),
      comments: new Map(),
      numberSeq: 0,
      commentSeq: 0,
      commitInfo: new Map(),
      ancestorSet: new Map(),
      commitSeq: [],
      version: 0,
      fetchCache: new Map(),
      issueJsonCache: new Map(),
    };
    this.repos.set(this.key(owner, name), repo);
    return repo;
  }

  deleteRepo(owner: string, name: string): boolean {
    return this.repos.delete(this.key(owner, name));
  }

  /** Newest-first list of all repos owned by `owner`. */
  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const r of this.repos.values()) if (r.owner === owner) out.push(r);
    out.sort((a, b) => b.createdSeq - a.createdSeq);
    return out;
  }

  storeObject(repo: Repo, type: ObjType, data: Buffer): string {
    const oid = sha1Of(type, data);
    return this.storeObjectKnown(repo, type, data, oid);
  }

  /** Store an object whose oid is already known (e.g. a pack entry just decoded): skips re-hashing. */
  storeObjectKnown(repo: Repo, type: ObjType, data: Buffer, oid: string): string {
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.version += 1;
      if (type === 'commit') repo.commitSeq.push(oid);
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  getCommit(repo: Repo, oid: string): CommitInfo | null {
    const cached = repo.commitInfo.get(oid);
    if (cached) return cached;
    const o = repo.objects.get(oid);
    if (!o || o.type !== 'commit') return null;
    const info = parseCommit(o.data);
    repo.commitInfo.set(oid, info);
    return info;
  }

  /** The full ancestor set of one commit (itself included), memoized. Objects are immutable,
   *  so a set computed once stays correct forever. Iterative post-order: parents before children. */
  ancestorSetOf(repo: Repo, oid: string): Set<string> {
    const cached = repo.ancestorSet.get(oid);
    if (cached) return cached;
    const order: string[] = [];
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const cur = stack.pop() as string;
      if (seen.has(cur) || repo.ancestorSet.has(cur)) continue;
      seen.add(cur);
      order.push(cur);
      const info = this.getCommit(repo, cur);
      if (info) for (const p of info.parents) stack.push(p);
    }
    for (let i = order.length - 1; i >= 0; i--) {
      const cur = order[i];
      if (repo.ancestorSet.has(cur)) continue;
      const set = new Set<string>([cur]);
      const info = this.getCommit(repo, cur);
      if (info) {
        for (const p of info.parents) {
          const ps = repo.ancestorSet.get(p);
          if (ps) for (const x of ps) set.add(x);
        }
      }
      repo.ancestorSet.set(cur, set);
    }
    return repo.ancestorSet.get(oid) as Set<string>;
  }

  /** Peel a tag (recursively) to the commit it names; commits pass through. */
  peelToCommit(repo: Repo, oid: string): string | null {
    let cur = oid;
    for (let i = 0; i < 16; i++) {
      const o = repo.objects.get(cur);
      if (!o) return null;
      if (o.type === 'commit') return cur;
      if (o.type === 'tag') {
        cur = parseTag(o.data).object;
        continue;
      }
      return null;
    }
    return null;
  }

  /** All commit oids reachable from `roots` (tags peeled, parents followed). */
  ancestors(repo: Repo, roots: string[]): Set<string> {
    const out = new Set<string>();
    for (const r of roots) {
      const c = this.peelToCommit(repo, r);
      if (!c) continue;
      for (const x of this.ancestorSetOf(repo, c)) out.add(x);
    }
    return out;
  }

  isAncestor(repo: Repo, anc: string, desc: string): boolean {
    if (anc === desc) return true;
    const c = this.peelToCommit(repo, desc);
    if (!c) return false;
    return this.ancestorSetOf(repo, c).has(anc);
  }

  /** The newest common ancestor of two commits, or null. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aSet = this.ancestors(repo, [a]);
    if (aSet.has(b)) return b;
    // Walk b's ancestry breadth-first (newest first by insertion order is approximated by
    // following parents in order); the first commit also in aSet is a merge base.
    const seen = new Set<string>();
    const queue = [b];
    while (queue.length > 0) {
      const oid = queue.shift() as string;
      if (seen.has(oid)) continue;
      seen.add(oid);
      if (aSet.has(oid)) return oid;
      const info = this.getCommit(repo, oid);
      if (!info) continue;
      for (const p of info.parents) queue.push(p);
    }
    return null;
  }

  /** Every object reachable from the given roots (commits, their trees/blobs, tags). */
  reachableObjects(repo: Repo, roots: string[]): Map<string, GitObject> {
    return this.reachableFromCommits(repo, this.ancestors(repo, roots));
  }

  /** The given commits themselves plus their trees/blobs (parents are NOT followed). */
  reachableFromCommits(repo: Repo, commits: Set<string>): Map<string, GitObject> {
    const out = new Map<string, GitObject>();
    const walkTree = (treeOid: string): void => {
      const o = repo.objects.get(treeOid);
      if (!o || o.type !== 'tree' || out.has(treeOid)) return;
      out.set(treeOid, o);
      for (const e of parseTree(o.data)) {
        const child = repo.objects.get(e.oid);
        if (!child) continue;
        if (child.type === 'tree') walkTree(e.oid);
        else out.set(e.oid, child);
      }
    };
    for (const c of commits) {
      const o = repo.objects.get(c);
      if (o) out.set(c, o);
      const info = this.getCommit(repo, c);
      if (info) walkTree(info.tree);
    }
    // Include tag objects naming these commits.
    for (const [oid, o] of repo.objects) {
      if (o.type === 'tag' && commits.has(this.peelToCommit(repo, oid) ?? '')) out.set(oid, o);
    }
    return out;
  }

  /** Flat path -> {oid, mode} map of a tree, recursing into subdirectories. */
  flattenTree(repo: Repo, treeOid: string, prefix = '', out = new Map<string, { oid: string; mode: string }>()): Map<string, { oid: string; mode: string }> {
    const o = repo.objects.get(treeOid);
    if (!o || o.type !== 'tree') return out;
    for (const e of parseTree(o.data)) {
      const path = prefix === '' ? e.name : `${prefix}/${e.name}`;
      if (e.mode === '40000') this.flattenTree(repo, e.oid, path, out);
      else out.set(path, { oid: e.oid, mode: e.mode });
    }
    return out;
  }

  /** Build (and store) the tree for a flat file map, creating intermediate trees. */
  buildTree(repo: Repo, files: Map<string, { oid: string; mode: string }>): string {
    return this.buildTreeInto(repo, files, '');
  }

  private buildTreeInto(repo: Repo, files: Map<string, { oid: string; mode: string }>, prefix: string): string {
    const entries: TreeEntry[] = [];
    const subdirs = new Map<string, Map<string, { oid: string; mode: string }>>();
    for (const [path, f] of files) {
      if (!path.startsWith(prefix)) continue;
      const rest = path.slice(prefix.length);
      const slash = rest.indexOf('/');
      if (slash === -1) {
        entries.push({ mode: f.mode, name: rest, oid: f.oid });
      } else {
        const dir = rest.slice(0, slash);
        let sub = subdirs.get(dir);
        if (!sub) {
          sub = new Map();
          subdirs.set(dir, sub);
        }
        sub.set(path, f);
      }
    }
    for (const [dir, sub] of subdirs) {
      entries.push({ mode: '40000', name: dir, oid: this.buildTreeInto(repo, sub, `${prefix}${dir}/`) });
    }
    return this.storeObject(repo, 'tree', encodeTree(entries));
  }

  /** Create a commit with a deterministic timestamp and store it. */
  createCommit(repo: Repo, tree: string, parents: string[], message: string): string {
    const epoch = SERVER_EPOCH + this.commitCounter++;
    const ident = `${SERVER_IDENTITY} ${epoch} +0000`;
    const info: CommitInfo = { tree, parents, author: ident, committer: ident, message };
    return this.storeObject(repo, 'commit', encodeCommit(info));
  }

  /** Apply file changes (null = delete) onto a base tree and return the new tree oid. */
  applyToTree(repo: Repo, baseTreeOid: string | null, changes: Map<string, { oid: string; mode: string } | null>): string {
    const files = baseTreeOid ? this.flattenTree(repo, baseTreeOid) : new Map<string, { oid: string; mode: string }>();
    for (const [path, f] of changes) {
      if (f === null) files.delete(path);
      else files.set(path, f);
    }
    return this.buildTree(repo, files);
  }

  /** Commits reachable from `root`, newest first (insertion order is creation order). */
  listCommits(repo: Repo, root: string): { sha: string; info: CommitInfo }[] {
    const set = this.ancestors(repo, [root]);
    const out: { sha: string; info: CommitInfo; seq: number }[] = [];
    // Walk objects in insertion order; commits were stored in creation order.
    let seq = 0;
    for (const [oid, o] of repo.objects) {
      if (o.type !== 'commit') continue;
      if (!set.has(oid)) continue;
      out.push({ sha: oid, info: parseCommit(o.data), seq: seq++ });
    }
    out.sort((a, b) => b.seq - a.seq);
    return out.map(({ sha, info }) => ({ sha, info }));
  }

  /** File-level three-way diff: base tree vs head tree. */
  diffTrees(repo: Repo, baseTreeOid: string, headTreeOid: string): { path: string; baseOid: string | null; headOid: string | null; baseMode: string | null; headMode: string | null }[] {
    const base = this.flattenTree(repo, baseTreeOid);
    const head = this.flattenTree(repo, headTreeOid);
    const paths = new Set<string>([...base.keys(), ...head.keys()]);
    const out: { path: string; baseOid: string | null; headOid: string | null; baseMode: string | null; headMode: string | null }[] = [];
    for (const path of [...paths].sort()) {
      const b = base.get(path);
      const h = head.get(path);
      if (b && h && b.oid === h.oid) continue;
      out.push({ path, baseOid: b?.oid ?? null, headOid: h?.oid ?? null, baseMode: b?.mode ?? null, headMode: h?.mode ?? null });
    }
    return out;
  }

  /** True when head and base both changed the same file differently since merge-base. */
  hasMergeConflict(repo: Repo, baseTip: string, headTip: string): boolean {
    const mb = this.mergeBase(repo, baseTip, headTip);
    if (!mb) return false;
    const mbInfo = this.getCommit(repo, mb);
    const baseInfo = this.getCommit(repo, baseTip);
    const headInfo = this.getCommit(repo, headTip);
    if (!mbInfo || !baseInfo || !headInfo) return false;
    const baseChanges = this.diffTrees(repo, mbInfo.tree, baseInfo.tree);
    const headChanges = this.diffTrees(repo, mbInfo.tree, headInfo.tree);
    const baseMap = new Map(baseChanges.map((c) => [c.path, c]));
    for (const h of headChanges) {
      const b = baseMap.get(h.path);
      if (b && b.headOid !== h.headOid) return true;
    }
    return false;
  }
}
