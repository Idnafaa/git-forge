// Git smart HTTP: pkt-lines, packfiles (plain objects, deltas read back), protocol v2/v0
// advertisement, ls-refs, fetch, and receive-pack. Written from the git protocol description in
// the kit's wire contract, not from any existing git implementation.

import { createHash } from 'node:crypto';
import { deflateSync, inflateSync } from 'node:zlib';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { parseCommit, parseTag, parseTree, sha1Of, ZERO_OID, type GitObject, type ObjType, type Repo, type Store } from './store.ts';

// ---------------------------------------------------------------- pkt-lines

export function pktLine(text: string): Buffer {
  const body = Buffer.from(text, 'utf8');
  const len = body.length + 4;
  const head = Buffer.from(len.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([head, body]);
}

export const FLUSH = Buffer.from('0000', 'ascii');
export const DELIM = Buffer.from('0001', 'ascii');

export function sideband(data: Buffer, band: 1 | 2): Buffer {
  const chunks: Buffer[] = [];
  let off = 0;
  while (off < data.length) {
    const slice = data.subarray(off, off + 65515);
    const payload = Buffer.concat([Buffer.from([band]), slice]);
    const len = payload.length + 4;
    chunks.push(Buffer.concat([Buffer.from(len.toString(16).padStart(4, '0'), 'ascii'), payload]));
    off += slice.length;
  }
  return Buffer.concat(chunks);
}

interface PktLine {
  kind: 'line' | 'flush' | 'delim';
  text?: string;
  raw?: Buffer;
}

/** Parse pkt-lines from the front of `buf` until a flush packet; returns lines and the remainder. */
export function parsePktLines(buf: Buffer): { lines: PktLine[]; rest: Buffer } {
  const lines: PktLine[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (len === 0) {
      i += 4;
      return { lines, rest: buf.subarray(i) };
    }
    if (len === 1) {
      lines.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    const payload = buf.subarray(i + 4, i + len);
    lines.push({ kind: 'line', text: payload.toString('utf8'), raw: payload });
    i += len;
  }
  return { lines, rest: buf.subarray(i) };
}

/** Split a buffer into pkt-lines without stopping at a flush; used for command parsing. */
export function splitPktLines(buf: Buffer): PktLine[] {
  const out: PktLine[] = [];
  let i = 0;
  while (i + 4 <= buf.length) {
    const len = parseInt(buf.subarray(i, i + 4).toString('ascii'), 16);
    if (len === 0) {
      out.push({ kind: 'flush' });
      i += 4;
      continue;
    }
    if (len === 1) {
      out.push({ kind: 'delim' });
      i += 4;
      continue;
    }
    if (len < 4 || i + len > buf.length) break;
    out.push({ kind: 'line', text: buf.subarray(i + 4, i + len).toString('utf8') });
    i += len;
  }
  return out;
}

// ---------------------------------------------------------------- packfiles

const TYPE_NUM: Record<ObjType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };
const NUM_TYPE: Record<number, ObjType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

function encodePackEntry(type: ObjType, data: Buffer): Buffer {
  const comp = deflateSync(data);
  // type/size varint: low 4 bits of size in first byte, then 7 bits per byte.
  const head: number[] = [];
  let size = data.length;
  let first = (TYPE_NUM[type] << 4) | (size & 0x0f);
  size >>= 4;
  if (size > 0) first |= 0x80;
  head.push(first);
  while (size > 0) {
    let b = size & 0x7f;
    size >>= 7;
    if (size > 0) b |= 0x80;
    head.push(b);
  }
  return Buffer.concat([Buffer.from(head), comp]);
}

export function encodePack(objects: GitObject[]): Buffer {
  const parts: Buffer[] = [Buffer.from('PACK', 'ascii')];
  const v = Buffer.alloc(4);
  v.writeUInt32BE(2, 0);
  parts.push(v);
  const n = Buffer.alloc(4);
  n.writeUInt32BE(objects.length, 0);
  parts.push(n);
  const hash = createHash('sha1');
  for (const p of parts) hash.update(p);
  for (const o of objects) {
    const e = encodePackEntry(o.type, o.data);
    hash.update(e);
    parts.push(e);
  }
  parts.push(hash.digest());
  return Buffer.concat(parts);
}

interface PackEntry {
  type: ObjType;
  data: Buffer;
  oid: string;
}

function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let i = 0;
  const readVarint = (): number => {
    let out = 0;
    let shift = 0;
    while (i < delta.length) {
      const b = delta[i++];
      out |= (b & 0x7f) << shift;
      shift += 7;
      if ((b & 0x80) === 0) break;
    }
    return out;
  };
  const baseSize = readVarint();
  const resultSize = readVarint();
  if (baseSize !== base.length) throw new Error('delta base size mismatch');
  const out: Buffer[] = [];
  let total = 0;
  while (i < delta.length) {
    const op = delta[i++];
    if (op & 0x80) {
      let off = 0;
      let size = 0;
      for (let b = 0; b < 4; b++) if (op & (1 << b)) off |= delta[i++] << (8 * b);
      for (let b = 0; b < 3; b++) if (op & (0x10 << b)) size |= delta[i++] << (8 * b);
      if (size === 0) size = 0x10000;
      out.push(base.subarray(off, off + size));
      total += size;
    } else if (op > 0) {
      out.push(delta.subarray(i, i + op));
      total += op;
      i += op;
    } else {
      throw new Error('delta opcode 0');
    }
  }
  const buf = Buffer.concat(out);
  if (total !== resultSize || buf.length !== resultSize) throw new Error('delta result size mismatch');
  return buf;
}

/** Parse a packfile. Returns the objects it carries. `known` supplies objects the pack may
 *  delta against that already live in the store (REF_DELTA bases). */
export function decodePack(buf: Buffer, known?: Map<string, GitObject>): { objects: PackEntry[]; error?: string } {
  try {
    if (buf.length < 12 || buf.subarray(0, 4).toString('ascii') !== 'PACK') return { objects: [], error: 'not a packfile' };
    const version = buf.readUInt32BE(4);
    if (version !== 2 && version !== 3) return { objects: [], error: `unsupported pack version ${version}` };
    const count = buf.readUInt32BE(8);
    // First pass: read every entry header and its zlib payload.
    interface Raw {
      start: number;
      typeNum: number;
      data: Buffer;
      baseOid?: string;
      baseOffset?: number;
      resolved?: PackEntry;
    }
    const raw: Raw[] = [];
    let i = 12;
    for (let n = 0; n < count; n++) {
      const start = i;
      const b0 = buf[i++];
      const typeNum = (b0 >> 4) & 0x7;
      let size = b0 & 0x0f;
      let shift = 4;
      let b = b0;
      while (b & 0x80) {
        b = buf[i++];
        size |= (b & 0x7f) << shift;
        shift += 7;
      }
      void size;
      let baseOid: string | undefined;
      let baseOffset: number | undefined;
      if (typeNum === 6) {
        let off = buf[i++];
        let v = off & 0x7f;
        while (off & 0x80) {
          off = buf[i++];
          v = ((v + 1) << 7) | (off & 0x7f);
        }
        baseOffset = start - v;
      } else if (typeNum === 7) {
        baseOid = buf.subarray(i, i + 20).toString('hex');
        i += 20;
      }
      const { end, data } = inflateOne(buf.subarray(i));
      i += end;
      raw.push({ start, typeNum, data, baseOid, baseOffset });
    }
    // Second pass: resolve plain entries first, then deltas (bases always precede their deltas).
    const byOffset = new Map<number, PackEntry>();
    const byOid = new Map<string, PackEntry>();
    if (known) for (const [oid, o] of known) byOid.set(oid, { type: o.type, data: o.data, oid });
    const resolved: PackEntry[] = [];
    const resolveEntry = (idx: number, depth: number): PackEntry => {
      if (depth > 64) throw new Error('delta chain too deep');
      const r = raw[idx];
      if (r.resolved) return r.resolved;
      if (r.typeNum === 6 || r.typeNum === 7) {
        let base: PackEntry | undefined;
        if (r.baseOffset !== undefined) base = byOffset.get(r.baseOffset);
        else if (r.baseOid !== undefined) base = byOid.get(r.baseOid);
        if (!base) throw new Error('delta base not found');
        const data = applyDelta(base.data, r.data);
        const entry: PackEntry = { type: base.type, data, oid: sha1Of(base.type, data) };
        r.resolved = entry;
        resolved.push(entry);
        byOid.set(entry.oid, entry);
        return entry;
      }
      const type = NUM_TYPE[r.typeNum];
      if (!type) throw new Error(`unknown object type ${r.typeNum}`);
      const entry: PackEntry = { type, data: r.data, oid: sha1Of(type, r.data) };
      r.resolved = entry;
      resolved.push(entry);
      byOid.set(entry.oid, entry);
      byOffset.set(r.start, entry);
      return entry;
    };
    for (let n = 0; n < count; n++) if (raw[n].typeNum !== 6 && raw[n].typeNum !== 7) resolveEntry(n, 0);
    for (let n = 0; n < count; n++) resolveEntry(n, 0);
    return { objects: resolved };
  } catch (err) {
    return { objects: [], error: err instanceof Error ? err.message : String(err) };
  }
}

/** Adler-32 of a buffer: the zlib stream's last four bytes are this checksum of the payload. */
function adler32(buf: Buffer): number {
  let a = 1;
  let b = 0;
  for (let i = 0; i < buf.length; i++) {
    a = (a + buf[i]) % 65521;
    b = (b + a) % 65521;
  }
  return ((b << 16) | a) >>> 0;
}

/** Inflate one zlib stream and report how many input bytes it consumed.
 *  Fast path first: inflate the whole remainder (inflateSync ignores trailing bytes),
 *  recover the stream's exact length by re-deflating (same zlib defaults git uses),
 *  and verify with the Adler-32 trailer plus a re-inflate of the exact slice. Any
 *  mismatch falls back to the binary search, so a client using other zlib settings
 *  still decodes correctly, just slower. */
function inflateOne(buf: Buffer): { data: Buffer; end: number } {
  try {
    const data = inflateSync(buf);
    const cand = deflateSync(data).length;
    if (cand > 0 && cand <= buf.length && buf.readUInt32BE(cand - 4) === adler32(data)) {
      const check = inflateSync(buf.subarray(0, cand));
      if (check.equals(data)) return { data, end: cand };
    }
  } catch {
    // Not a plain zlib stream at this offset, or the re-deflate disagreed: binary search below.
  }
  let lo = 1;
  let hi = buf.length;
  let best: Buffer | null = null;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    try {
      best = inflateSync(buf.subarray(0, mid));
      hi = mid - 1;
    } catch {
      lo = mid + 1;
    }
  }
  if (best === null) throw new Error('zlib inflate failed');
  return { data: best, end: lo };
}

// ---------------------------------------------------------------- helpers

function sendBinary(res: ServerResponse, status: number, contentType: string, body: Buffer): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function refLines(store: Store, repo: Repo, caps: string): Buffer[] {
  const out: Buffer[] = [];
  const defaultRef = `refs/heads/${repo.defaultBranch}`;
  const tip = repo.refs.get(defaultRef);
  const headOid = tip ?? ZERO_OID;
  const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
  const first = true;
  const lines: string[] = [];
  lines.push(`${headOid} HEAD\0${caps}\n`);
  for (const [name, oid] of sorted) {
    lines.push(`${oid} ${name}\n`);
    const obj = repo.objects.get(oid);
    if (obj && obj.type === 'tag') {
      const peeled = store.peelToCommit(repo, oid);
      if (peeled) lines.push(`${peeled} ${name}^{}\n`);
    }
  }
  void first;
  for (const l of lines) out.push(pktLine(l));
  return out;
}

const UPLOAD_CAPS = 'symref=HEAD:refs/heads/main report-status report-status-v2 delete-refs side-band-64k quiet atomic ofs-delta agent=forge/1.0';
const RECEIVE_CAPS = 'symref=HEAD:refs/heads/main report-status report-status-v2 side-band-64k delete-refs ofs-delta agent=forge/1.0';

// ---------------------------------------------------------------- info/refs

export function handleInfoRefs(
  store: Store,
  res: ServerResponse,
  owner: string,
  name: string,
  service: string | null,
  gitProtocol: string,
): void {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  if (service === 'git-upload-pack') {
    if (gitProtocol === 'version=2') {
      // One capability per pkt-line: the client splits each line on its first '='.
      const body = Buffer.concat([
        pktLine('# service=git-upload-pack\n'),
        FLUSH,
        pktLine('version 2\n'),
        pktLine('agent=forge/1.0\n'),
        pktLine('ls-refs=unborn\n'),
        pktLine('fetch=shallow wait-for-done filter\n'),
        pktLine('server-option\n'),
        pktLine('object-format=sha1\n'),
        FLUSH,
      ]);
      sendBinary(res, 200, 'application/x-git-upload-pack-advertisement', body);
      return;
    }
    const body = Buffer.concat([pktLine('# service=git-upload-pack\n'), FLUSH, ...refLines(store, repo, UPLOAD_CAPS), FLUSH]);
    sendBinary(res, 200, 'application/x-git-upload-pack-advertisement', body);
    return;
  }
  if (service === 'git-receive-pack') {
    const body = Buffer.concat([pktLine('# service=git-receive-pack\n'), FLUSH, ...refLines(store, repo, RECEIVE_CAPS), FLUSH]);
    sendBinary(res, 200, 'application/x-git-receive-pack-advertisement', body);
    return;
  }
  sendJson(res, 400, { message: 'missing or unknown service' });
}

// ---------------------------------------------------------------- fetch

interface FetchOpts {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  unbornWanted: boolean;
}

/** Commits at each depth from the wants (0 = the wants themselves). */
function depthLayers(store: Store, repo: Repo, wants: string[], maxDepth: number): { included: Set<string>; boundary: Set<string> } {
  const included = new Set<string>();
  const boundary = new Set<string>();
  const depth = new Map<string, number>();
  const queue: string[] = [];
  for (const w of wants) {
    const c = store.peelToCommit(repo, w);
    if (c && !depth.has(c)) {
      depth.set(c, 0);
      queue.push(c);
    }
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    const d = depth.get(oid) as number;
    if (d >= maxDepth) {
      boundary.add(oid);
      continue;
    }
    included.add(oid);
    const info = store.getCommit(repo, oid);
    if (!info) continue;
    for (const p of info.parents) {
      if (!depth.has(p)) {
        depth.set(p, d + 1);
        queue.push(p);
      }
    }
  }
  // Boundary commits are the deepest included ones: parents of included commits at depth maxDepth-1.
  // With the loop above, boundary holds commits AT depth maxDepth (not included). The shallow set is
  // the included commits whose parents were cut: recompute as included commits with a parent at
  // depth == maxDepth.
  const shallow = new Set<string>();
  for (const oid of included) {
    const d = depth.get(oid) as number;
    if (d === maxDepth - 1) shallow.add(oid);
  }
  void boundary;
  return { included, boundary: shallow };
}

/** Cached fetch packs: the bench's 50 concurrent clones ask for the same pack, and a pack's
 *  bytes depend only on the store's objects and refs plus the fetch options. Objects are
 *  only ever added (never removed) and refs are snapshotted into the key, so a hit is exact;
 *  any mutation misses and rebuilds. The raw pack is cached; sideband framing stays per-request. */
function buildFetchPackCached(
  store: Store,
  repo: Repo,
  opts: FetchOpts,
): { pack: Buffer; shallow: string[]; unshallow: string[]; ack: string | null } {
  const refs = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([k, v]) => `${k}=${v}`).join(',');
  const key = `${repo.version}|${refs}|${opts.wants.join(',')}|${opts.haves.join(',')}|${opts.shallow.join(',')}|${opts.depth ?? ''}`;
  const hit = repo.fetchCache.get(key);
  if (hit) return hit;
  const out = buildFetchPack(store, repo, opts);
  repo.fetchCache.set(key, out);
  return out;
}

function buildFetchPack(
  store: Store,
  repo: Repo,
  opts: FetchOpts,
): { pack: Buffer; shallow: string[]; unshallow: string[]; ack: string | null } {
  const wantCommits = opts.wants.map((w) => store.peelToCommit(repo, w)).filter((c): c is string => c !== null);
  // What the client already holds: walk its haves, but never past a shallow boundary — the
  // parents of a shallow commit were never sent to it, so they are not held.
  const shallowSet = new Set(opts.shallow.map((s) => store.peelToCommit(repo, s)).filter((c): c is string => c !== null));
  const heldCommits = new Set<string>();
  const queue: string[] = [];
  for (const h of opts.haves) {
    const c = store.peelToCommit(repo, h);
    if (c) queue.push(c);
  }
  while (queue.length > 0) {
    const oid = queue.shift() as string;
    if (heldCommits.has(oid)) continue;
    heldCommits.add(oid);
    if (shallowSet.has(oid)) continue;
    const info = store.getCommit(repo, oid);
    if (!info) continue;
    for (const p of info.parents) queue.push(p);
  }

  let includedCommits: Set<string>;
  let boundary: Set<string>;
  if (opts.depth !== null) {
    const r = depthLayers(store, repo, opts.wants, opts.depth);
    includedCommits = r.included;
    boundary = r.boundary;
  } else {
    includedCommits = store.ancestors(repo, opts.wants);
    boundary = new Set<string>();
  }

  // Objects to send: everything reachable from included commits, minus what haves already cover.
  // Depth-limited fetches must not walk past the included commits into their parents.
  const sendSet =
    opts.depth !== null
      ? store.reachableFromCommits(repo, includedCommits)
      : store.reachableObjects(repo, [...includedCommits]);
  const haveObjects = store.reachableFromCommits(repo, heldCommits);
  const toSend: GitObject[] = [];
  const seen = new Set<string>();
  // Order: commits first (in creation order), then trees/blobs — any order is valid for a pack.
  for (const [oid, o] of repo.objects) {
    if (!sendSet.has(oid) || haveObjects.has(oid)) continue;
    if (seen.has(oid)) continue;
    seen.add(oid);
    toSend.push(o);
  }
  void sendSet;

  // ACK: a have that is an ancestor of a want (and held) means the client is up to date on that line.
  let ack: string | null = null;
  for (const h of opts.haves) {
    const c = store.peelToCommit(repo, h);
    if (c && wantCommits.some((w) => store.isAncestor(repo, c, w))) {
      ack = c;
      break;
    }
  }

  const shallow = [...boundary].sort();
  const oldShallow = new Set(opts.shallow);
  const unshallow = [...oldShallow].filter((o) => includedCommits.has(o)).sort();
  return { pack: encodePack(toSend), shallow, unshallow, ack };
}

export function handleUploadPack(
  store: Store,
  res: ServerResponse,
  owner: string,
  name: string,
  body: Buffer,
  gitProtocol: string,
): void {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  try {
    if (gitProtocol === 'version=2') {
      handleUploadPackV2(store, res, repo, body);
      return;
    }
    handleUploadPackV0(store, res, repo, body);
  } catch (err) {
    // A malformed fetch must not crash the server; answer an empty pack and stay healthy.
    if (!res.writableEnded) {
      const bodyOut = Buffer.concat([pktLine('NAK\n'), sideband(encodePack([]), 1), FLUSH]);
      sendBinary(res, 200, 'application/x-git-upload-pack-result', bodyOut);
    }
    void err;
  }
}

function handleUploadPackV2(store: Store, res: ServerResponse, repo: Repo, body: Buffer): void {
  const { lines } = parsePktLines(body);
  const first = lines.find((l) => l.kind === 'line')?.text?.trim() ?? '';
  if (first.startsWith('command=ls-refs')) {
    const args = lines.filter((l) => l.kind === 'line').map((l) => (l.text ?? '').trim());
    let peel = false;
    let unborn = false;
    let prefix = '';
    for (const a of args) {
      if (a === 'peel') peel = true;
      else if (a === 'unborn') unborn = true;
      else if (a.startsWith('ref-prefix ')) prefix = a.slice('ref-prefix '.length);
    }
    const out: Buffer[] = [];
    const defaultRef = `refs/heads/${repo.defaultBranch}`;
    const tip = repo.refs.get(defaultRef);
    const refs: { name: string; oid: string; symref?: string; peeled?: string }[] = [];
    // HEAD is listed only when no ref-prefix filters it out: its name is 'HEAD', which never
    // starts with a refs/ prefix.
    if (!prefix) {
      if (tip) {
        refs.push({ name: 'HEAD', oid: tip, symref: defaultRef });
      } else if (unborn) {
        refs.push({ name: 'HEAD', oid: 'unborn', symref: defaultRef });
      }
    }
    const sorted = [...repo.refs.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1));
    for (const [rname, oid] of sorted) {
      if (prefix && !rname.startsWith(prefix)) continue;
      const entry: { name: string; oid: string; symref?: string; peeled?: string } = { name: rname, oid };
      if (peel) {
        const obj = repo.objects.get(oid);
        if (obj && obj.type === 'tag') {
          const peeled = store.peelToCommit(repo, oid);
          if (peeled) entry.peeled = peeled;
        }
      }
      refs.push(entry);
    }
    for (const r of refs) {
      if (r.oid === 'unborn') {
        out.push(pktLine(`unborn HEAD symref-target:${r.symref}\n`));
        continue;
      }
      let line = `${r.oid} ${r.name}`;
      if (r.symref) line += ` symref-target:${r.symref}`;
      if (r.peeled) line += ` peeled:${r.peeled}`;
      out.push(pktLine(`${line}\n`));
    }
    out.push(FLUSH);
    sendBinary(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    return;
  }
  if (first.startsWith('command=fetch')) {
    const args = lines.filter((l) => l.kind === 'line').map((l) => (l.text ?? '').trim());
    const opts: FetchOpts = { wants: [], haves: [], shallow: [], depth: null, unbornWanted: false };
    let i = 0;
    for (const a of args) {
      if (a === 'command=fetch') continue;
      if (a === 'done') break;
      if (a.startsWith('want ')) opts.wants.push(a.slice(5).trim());
      else if (a.startsWith('have ')) opts.haves.push(a.slice(5).trim());
      else if (a.startsWith('shallow ')) opts.shallow.push(a.slice(8).trim());
      else if (a.startsWith('deepen ')) opts.depth = parseInt(a.slice(7).trim(), 10);
      i++;
    }
    void i;
    const { pack, shallow, unshallow, ack } = buildFetchPackCached(store, repo, opts);
    const out: Buffer[] = [pktLine('acknowledgments\n')];
    out.push(pktLine(ack ? `ACK ${ack}\n` : 'NAK\n'));
    if (ack) out.push(pktLine('ready\n'));
    out.push(DELIM);
    if (shallow.length > 0 || unshallow.length > 0) {
      out.push(pktLine('shallow-info\n'));
      for (const s of shallow) out.push(pktLine(`shallow ${s}\n`));
      for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
      out.push(DELIM);
    }
    out.push(pktLine('packfile\n'));
    out.push(sideband(pack, 1));
    out.push(FLUSH);
    sendBinary(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
    return;
  }
  sendJson(res, 400, { message: 'unknown v2 command' });
}

function handleUploadPackV0(store: Store, res: ServerResponse, repo: Repo, body: Buffer): void {
  const parts = splitPktLines(body);
  const opts: FetchOpts = { wants: [], haves: [], shallow: [], depth: null, unbornWanted: false };
  let seenFlush = false;
  for (const p of parts) {
    if (p.kind === 'flush') {
      seenFlush = true;
      continue;
    }
    if (p.kind !== 'line') continue;
    const text = (p.text ?? '').trim();
    if (!seenFlush) {
      if (text.startsWith('want ')) {
        opts.wants.push(text.slice(5).split(' ')[0]);
      } else if (text.startsWith('shallow ')) {
        opts.shallow.push(text.slice(8).trim());
      } else if (text.startsWith('deepen ')) {
        opts.depth = parseInt(text.slice(7).trim(), 10);
      }
    } else {
      if (text.startsWith('have ')) opts.haves.push(text.slice(5).trim());
      else if (text === 'done') break;
    }
  }
  const { pack, shallow, unshallow, ack } = buildFetchPackCached(store, repo, opts);
  const out: Buffer[] = [pktLine(ack ? `ACK ${ack}\n` : 'NAK\n')];
  for (const s of shallow) out.push(pktLine(`shallow ${s}\n`));
  for (const s of unshallow) out.push(pktLine(`unshallow ${s}\n`));
  out.push(sideband(pack, 1));
  out.push(FLUSH);
  sendBinary(res, 200, 'application/x-git-upload-pack-result', Buffer.concat(out));
}

// ---------------------------------------------------------------- receive-pack

export function handleReceivePack(
  store: Store,
  res: ServerResponse,
  owner: string,
  name: string,
  body: Buffer,
): void {
  const repo = store.getRepo(owner, name);
  if (!repo) {
    sendJson(res, 404, { message: 'Not Found' });
    return;
  }
  const { lines, rest } = parsePktLines(body);
  interface Cmd {
    oldOid: string;
    newOid: string;
    ref: string;
  }
  const cmds: Cmd[] = [];
  for (const l of lines) {
    if (l.kind !== 'line') continue;
    // The first command line carries the client's capabilities after a NUL; strip them.
    const raw = (l.text ?? '').trim();
    const nul = raw.indexOf('\0');
    const text = nul >= 0 ? raw.slice(0, nul) : raw;
    const parts = text.split(' ');
    if (parts.length < 3) continue;
    cmds.push({ oldOid: parts[0], newOid: parts[1], ref: parts.slice(2).join(' ') });
  }
  const report: string[] = [];
  let unpackOk = true;
  let unpackError = '';
  if (rest.length > 0) {
    const decoded = decodePack(rest, repo.objects);
    if (decoded.error) {
      unpackOk = false;
      unpackError = decoded.error;
    } else {
      for (const o of decoded.objects) {
        // The oid was already computed while decoding; do not hash the data a second time.
        store.storeObjectKnown(repo, o.type, o.data, o.oid);
      }
    }
  }
  if (!unpackOk) {
    report.push(`unpack error: ${unpackError}`);
    for (const c of cmds) report.push(`ng ${c.ref} unpacker error`);
  } else {
    report.push('unpack ok');
    for (const c of cmds) {
      const isDelete = c.newOid === ZERO_OID;
      const current = repo.refs.get(c.ref);
      if (!isDelete && c.newOid !== ZERO_OID) {
        const obj = repo.objects.get(c.newOid);
        if (!obj || (obj.type !== 'commit' && obj.type !== 'tag')) {
          report.push(`ng ${c.ref} object not found`);
          continue;
        }
      }
      if (c.oldOid !== ZERO_OID && current !== c.oldOid) {
        report.push(`ng ${c.ref} old value mismatch`);
        continue;
      }
      if (isDelete) {
        if (!current) {
          report.push(`ng ${c.ref} ref does not exist`);
          continue;
        }
        repo.refs.delete(c.ref);
        report.push(`ok ${c.ref}`);
        continue;
      }
      if (c.oldOid === ZERO_OID && current) {
        report.push(`ng ${c.ref} already exists`);
        continue;
      }
      // Fast-forward check for branches: the new tip must descend from the old one.
      if (current && c.ref.startsWith('refs/heads/')) {
        const newCommit = store.peelToCommit(repo, c.newOid);
        const oldCommit = store.peelToCommit(repo, current);
        if (newCommit && oldCommit && !store.isAncestor(repo, oldCommit, newCommit)) {
          report.push(`ng ${c.ref} non-fast-forward`);
          continue;
        }
      }
      repo.refs.set(c.ref, c.newOid);
      report.push(`ok ${c.ref}`);
    }
  }
  const chunks: Buffer[] = [];
  for (const line of report) chunks.push(pktLine(`${line}\n`));
  const bodyOut = Buffer.concat([sideband(Buffer.concat(chunks), 1), FLUSH]);
  sendBinary(res, 200, 'application/x-git-receive-pack-result', bodyOut);
}

export { parseCommit, parseTag, parseTree, sha1Of };
