// git smart HTTP: pkt-lines, advertisements, upload-pack (v0 and v2) and
// receive-pack. Written against the wire format the kit's client speaks.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { ZERO_OID } from './util.ts';
import {
  readPack,
  verifyPackChecksum,
  writePack,
  type GitObject,
} from './gitobj.ts';
import { Store, type Repo } from './store.ts';

const AGENT = 'github-core-clone/1.0';
const MAX_PKT = 65520;
/** Sideband data per packet: the pkt-line header plus the one band byte. */
const SIDEBAND_CHUNK = MAX_PKT - 5;

// ---------------------------------------------------------------- pkt-lines

export function pktLine(data: string | Buffer): Buffer {
  const payload = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const length = payload.length + 4;
  if (length > MAX_PKT) throw new Error('pkt-line too long');
  const header = Buffer.from(length.toString(16).padStart(4, '0'), 'ascii');
  return Buffer.concat([header, payload]);
}

export function pktFlush(): Buffer {
  return Buffer.from('0000', 'ascii');
}

export function pktDelim(): Buffer {
  return Buffer.from('0001', 'ascii');
}

export type Pkt = { kind: 'data' | 'flush' | 'delim'; payload: Buffer };

/** Decode a whole pkt-line stream. Throws on a malformed frame. */
export function decodePktLines(buf: Buffer): Pkt[] {
  const packets: Pkt[] = [];
  let offset = 0;
  while (offset < buf.length) {
    if (offset + 4 > buf.length) throw new Error('truncated pkt-line header');
    const text = buf.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(text, 16);
    if (Number.isNaN(length) || length < 0 || length > MAX_PKT) throw new Error(`bad pkt-line length ${JSON.stringify(text)}`);
    if (length === 0) {
      packets.push({ kind: 'flush', payload: Buffer.alloc(0) });
      offset += 4;
    } else if (length === 1) {
      packets.push({ kind: 'delim', payload: Buffer.alloc(0) });
      offset += 4;
    } else {
      if (offset + length > buf.length) throw new Error('truncated pkt-line payload');
      packets.push({ kind: 'data', payload: buf.subarray(offset + 4, offset + length) });
      offset += length;
    }
  }
  return packets;
}

/** The data lines of a pkt-line stream, as strings without the trailing newline. */
export function pktLinesOf(buf: Buffer): string[] {
  const lines: string[] = [];
  for (const packet of decodePktLines(buf)) {
    if (packet.kind === 'data') lines.push(packet.payload.toString('utf8').replace(/\n$/, ''));
  }
  return lines;
}

/** Split payload bytes into sideband band-1 packets, then a flush. */
export function sideband(data: Buffer): Buffer {
  const parts: Buffer[] = [];
  for (let offset = 0; offset < data.length; offset += SIDEBAND_CHUNK) {
    const chunk = data.subarray(offset, Math.min(data.length, offset + SIDEBAND_CHUNK));
    parts.push(pktLine(Buffer.concat([Buffer.from([1]), chunk])));
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- advertisements

function branchRefs(repo: Repo): Array<{ name: string; oid: string }> {
  const refs: Array<{ name: string; oid: string }> = [];
  for (const [ref, oid] of repo.refs) refs.push({ name: ref, oid });
  refs.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  return refs;
}

function headOid(repo: Repo): string {
  return repo.refs.get(`refs/heads/${repo.defaultBranch}`) ?? ZERO_OID;
}

/** v2 upload-pack advertisement: `version 2` plus capability lines. */
export function v2Advertisement(repo: Repo): Buffer {
  void repo;
  const lines = [
    '# service=git-upload-pack\n',
    'version 2\n',
    'ls-refs=unborn\n',
    'fetch=shallow filter\n',
    'object-format=sha1\n',
    `agent=${AGENT}\n`,
  ];
  const parts: Buffer[] = [pktLine(lines[0]) as Buffer, pktFlush()];
  for (const line of lines.slice(1)) parts.push(pktLine(line));
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

/** v0 advertisement for either service. The first ref line carries the capabilities. */
export function v0Advertisement(store: Store, repo: Repo, service: 'git-upload-pack' | 'git-receive-pack'): Buffer {
  const caps =
    service === 'git-upload-pack'
      ? `symref=HEAD:refs/heads/${repo.defaultBranch} multi_ack thin-pack side-band side-band-64k ofs-delta shallow no-progress agent=${AGENT}`
      : `report-status side-band-64k delete-refs ofs-delta agent=${AGENT}`;
  const head = headOid(repo);
  const parts: Buffer[] = [
    pktLine(`# service=${service}\n`),
    pktFlush(),
    pktLine(`${head} HEAD\0${caps}\n`),
  ];
  for (const ref of branchRefs(repo)) {
    parts.push(pktLine(`${ref.oid} ${ref.name}\n`));
    // A tag ref advertises its peeled commit on a `^{}` line, as real git does.
    const obj = repo.objects.get(ref.oid);
    if (obj !== undefined && obj.type === 'tag') {
      const peeled = store.peelToCommit(repo, ref.oid);
      if (peeled !== null) parts.push(pktLine(`${peeled} ${ref.name}^{}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- upload-pack

interface FetchRequest {
  wants: string[];
  haves: string[];
  shallow: string[];
  depth: number | null;
  filter: string | null;
}

/** Parse a v2 fetch/ls-refs body into its command and argument lines. */
function parseV2Body(body: Buffer): { command: string; args: string[] } {
  const lines = pktLinesOf(body);
  if (lines.length === 0) throw new Error('empty v2 request');
  const first = lines[0] as string;
  const match = first.match(/^command=(\S+)$/);
  if (match === null) throw new Error(`v2 request has no command line: ${JSON.stringify(first.slice(0, 40))}`);
  return { command: match[1] as string, args: lines.slice(1) };
}

/** Parse a v0 fetch body: wants section, then haves section, each ended by flush. */
function parseV0Fetch(body: Buffer): FetchRequest {
  const packets = decodePktLines(body);
  const sections: string[][] = [[]];
  for (const packet of packets) {
    if (packet.kind === 'flush') {
      sections.push([]);
      continue;
    }
    if (packet.kind === 'data') {
      const last = sections[sections.length - 1] as string[];
      last.push(packet.payload.toString('utf8').replace(/\n$/, ''));
    }
  }
  const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
  const wantsSection = sections[0] ?? [];
  const havesSection = sections[1] ?? [];
  for (const line of wantsSection) {
    if (line.startsWith('want ')) {
      const oid = line.slice(5).split(' ')[0] as string;
      request.wants.push(oid);
    } else if (line.startsWith('shallow ')) request.shallow.push(line.slice(8));
    else if (line.startsWith('deepen ')) request.depth = Number(line.slice(7));
    else if (line.startsWith('filter ')) request.filter = line.slice(7);
  }
  for (const line of havesSection) {
    if (line.startsWith('have ')) request.haves.push(line.slice(5));
    else if (line === 'done') break;
  }
  return request;
}

/** The pack for a fetch, honoring `filter blob:none` and the shallow-pack cache. */
function packForFetch(store: Store, repo: Repo, request: FetchRequest): { pack: Buffer; shallow: string[]; unshallow: string[] } {
  const key = `${repo.id}:${request.wants.join(',')}:${request.haves.join(',')}:${request.shallow.join(',')}:${request.depth}:${request.filter ?? ''}`;
  const built = store.cachedFetchPack(repo, key, () => {
    const plan = store.fetchPlan(repo, request.wants, request.haves, request.depth, request.shallow);
    let objects: GitObject[] = plan.objects;
    if (request.filter === 'blob:none') objects = objects.filter((obj) => obj.type !== 'blob');
    return { pack: writePack(objects), shallow: plan.shallow, unshallow: plan.unshallow };
  });
  return built;
}

function v2FetchResponse(store: Store, repo: Repo, request: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = packForFetch(store, repo, request);
  const parts: Buffer[] = [pktLine('acknowledgments\n'), pktLine('NAK\n'), pktDelim()];
  if (shallow.length > 0 || unshallow.length > 0) {
    parts.push(pktLine('shallow-info\n'));
    for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
    for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
    parts.push(pktDelim());
  }
  parts.push(pktLine('packfile\n'), sideband(pack));
  return Buffer.concat(parts);
}

function v0FetchResponse(store: Store, repo: Repo, request: FetchRequest): Buffer {
  const { pack, shallow, unshallow } = packForFetch(store, repo, request);
  const parts: Buffer[] = [];
  let acked = false;
  for (const have of request.haves) {
    if (request.wants.some((want) => want === have || store.isAncestor(repo, have, want))) {
      parts.push(pktLine(`ACK ${have}\n`));
      acked = true;
      break;
    }
  }
  if (!acked) parts.push(pktLine('NAK\n'));
  for (const oid of shallow) parts.push(pktLine(`shallow ${oid}\n`));
  for (const oid of unshallow) parts.push(pktLine(`unshallow ${oid}\n`));
  parts.push(sideband(pack));
  return Buffer.concat(parts);
}

function v2LsRefsResponse(store: Store, repo: Repo, args: string[]): Buffer {
  const prefixes: string[] = [];
  let peel = false;
  let symrefs = false;
  let unborn = false;
  for (const arg of args) {
    if (arg === 'peel') peel = true;
    else if (arg === 'symrefs') symrefs = true;
    else if (arg === 'unborn') unborn = true;
    else if (arg.startsWith('ref-prefix ')) prefixes.push(arg.slice('ref-prefix '.length));
  }
  const keep = (name: string): boolean => prefixes.length === 0 || prefixes.some((prefix) => name.startsWith(prefix));
  const parts: Buffer[] = [];
  const head = headOid(repo);
  if (head === ZERO_OID) {
    if (unborn && keep('HEAD')) {
      parts.push(pktLine(`unborn HEAD${symrefs ? ` symref-target:refs/heads/${repo.defaultBranch}` : ''}\n`));
    }
  } else {
    if (symrefs && keep('HEAD')) {
      parts.push(pktLine(`${head} HEAD symref-target:refs/heads/${repo.defaultBranch}\n`));
    }
    for (const ref of branchRefs(repo)) {
      if (!keep(ref.name)) continue;
      let line = `${ref.oid} ${ref.name}`;
      // A tag ref peels to the commit its tag object points at.
      if (peel) {
        const obj = repo.objects.get(ref.oid);
        if (obj !== undefined && obj.type === 'tag') {
          const peeled = store.peelToCommit(repo, ref.oid);
          if (peeled !== null) line += ` peeled:${peeled}`;
        }
      }
      parts.push(pktLine(`${line}\n`));
    }
  }
  parts.push(pktFlush());
  return Buffer.concat(parts);
}

// ---------------------------------------------------------------- receive-pack

interface PushCommand {
  oldOid: string;
  newOid: string;
  ref: string;
}

/** Parse a receive-pack body: the pkt-lined command list, then the raw pack. */
function parsePush(body: Buffer): { commands: PushCommand[]; capabilities: string[]; pack: Buffer } {
  let offset = 0;
  const commands: PushCommand[] = [];
  let capabilities: string[] = [];
  let first = true;
  for (;;) {
    if (offset + 4 > body.length) throw new Error('truncated push command list');
    const text = body.subarray(offset, offset + 4).toString('ascii');
    const length = parseInt(text, 16);
    if (Number.isNaN(length)) throw new Error('bad push pkt-line length');
    if (length === 0) {
      offset += 4;
      break;
    }
    if (offset + length > body.length) throw new Error('truncated push command line');
    let line = body.subarray(offset + 4, offset + length).toString('utf8').replace(/\n$/, '');
    offset += length;
    if (first) {
      first = false;
      const nul = line.indexOf('\0');
      if (nul >= 0) {
        capabilities = line.slice(nul + 1).split(' ').filter(Boolean);
        line = line.slice(0, nul);
      }
    }
    const parts = line.split(' ');
    if (parts.length !== 3) throw new Error(`bad push command ${JSON.stringify(line.slice(0, 60))}`);
    commands.push({ oldOid: parts[0] as string, newOid: parts[1] as string, ref: parts[2] as string });
  }
  return { commands, capabilities, pack: body.subarray(offset) };
}

/** Run a receive-pack exchange. Returns the report body (already sideband-wrapped when asked). */
export function runReceivePack(store: Store, repo: Repo, body: Buffer): Buffer {
  const { commands, capabilities, pack } = parsePush(body);
  const useSideband = capabilities.includes('side-band-64k');
  const reportLines: string[] = [];
  let unpackOk = true;
  let unpackDetail = 'ok';
  if (commands.some((command) => command.newOid !== ZERO_OID) && pack.length > 0) {
    const checksum = verifyPackChecksum(pack);
    if (!checksum.ok) {
      unpackOk = false;
      unpackDetail = 'pack checksum mismatch';
    } else {
      try {
        const read = readPack(pack, (oid) => repo.objects.get(oid));
        for (const [oid, obj] of read.objects) {
          if (!repo.objects.has(oid)) repo.objects.set(oid, obj);
        }
        repo.version += 1;
      } catch (err) {
        unpackOk = false;
        unpackDetail = err instanceof Error ? err.message : 'unpack error';
      }
    }
  }
  for (const command of commands) {
    if (!unpackOk) {
      reportLines.push(`ng ${command.ref} unpack failed`);
      continue;
    }
    const current = repo.refs.get(command.ref);
    if (command.newOid === ZERO_OID) {
      // Delete.
      if (current === undefined) {
        reportLines.push(`ng ${command.ref} remote ref does not exist`);
      } else if (command.oldOid !== ZERO_OID && command.oldOid !== current) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        store.deleteRef(repo, command.ref);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    const target = repo.objects.get(command.newOid);
    if (target === undefined) {
      reportLines.push(`ng ${command.ref} object not found`);
      continue;
    }
    // A branch moves only to a commit; a tag ref may point at a tag object
    // (annotated tag) or a commit (lightweight tag).
    const isBranch = command.ref.startsWith('refs/heads/');
    if (isBranch && target.type !== 'commit') {
      reportLines.push(`ng ${command.ref} object not found`);
      continue;
    }
    if (current === undefined) {
      if (command.oldOid !== ZERO_OID) {
        reportLines.push(`ng ${command.ref} non-fast-forward`);
      } else {
        store.setRef(repo, command.ref, command.newOid);
        reportLines.push(`ok ${command.ref}`);
      }
      continue;
    }
    if (command.oldOid !== current) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    if (command.newOid === current) {
      reportLines.push(`ok ${command.ref}`);
      continue;
    }
    // Fast-forward enforcement applies to branches; a tag ref moves when the
    // old value matches, without an ancestry check.
    if (isBranch && !store.isAncestor(repo, current, command.newOid)) {
      reportLines.push(`ng ${command.ref} non-fast-forward`);
      continue;
    }
    store.setRef(repo, command.ref, command.newOid);
    reportLines.push(`ok ${command.ref}`);
  }
  const innerParts: Buffer[] = [pktLine(`unpack ${unpackOk ? 'ok' : unpackDetail}\n`)];
  for (const line of reportLines) innerParts.push(pktLine(`${line}\n`));
  innerParts.push(pktFlush());
  const inner = Buffer.concat(innerParts);
  if (useSideband) return sideband(inner);
  return Buffer.concat([inner, pktFlush()]);
}

// ---------------------------------------------------------------- HTTP entry points

export function gitContentType(service: 'git-upload-pack' | 'git-receive-pack', kind: 'advertisement' | 'result'): string {
  return `application/x-${service}-${kind}`;
}

function sendBuffer(res: ServerResponse, status: number, body: Buffer, contentType: string): void {
  res.writeHead(status, { 'content-type': contentType, 'content-length': body.length });
  res.end(body);
}

/** GET /{owner}/{repo}.git/info/refs?service=... */
export function handleInfoRefs(store: Store, repo: Repo | undefined, req: IncomingMessage, res: ServerResponse): void {
  const url = new URL(req.url ?? '/', 'http://entry');
  const service = url.searchParams.get('service');
  if (repo === undefined || (service !== 'git-upload-pack' && service !== 'git-receive-pack')) {
    const body = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
    sendBuffer(res, 404, body, 'application/json; charset=utf-8');
    return;
  }
  const wantsV2 = service === 'git-upload-pack' && (req.headers['git-protocol'] ?? '') === 'version=2';
  const body = wantsV2 ? v2Advertisement(repo) : v0Advertisement(store, repo, service);
  sendBuffer(res, 200, body, gitContentType(service, 'advertisement'));
}

/** POST /{owner}/{repo}.git/git-upload-pack */
export function handleUploadPack(store: Store, repo: Repo | undefined, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (repo === undefined) {
    const text = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
    sendBuffer(res, 404, text, 'application/json; charset=utf-8');
    return;
  }
  try {
    const wantsV2 = (req.headers['git-protocol'] ?? '') === 'version=2';
    let out: Buffer;
    if (wantsV2) {
      const { command, args } = parseV2Body(body);
      if (command === 'ls-refs') {
        out = v2LsRefsResponse(store, repo, args);
      } else if (command === 'fetch') {
        const request: FetchRequest = { wants: [], haves: [], shallow: [], depth: null, filter: null };
        for (const arg of args) {
          if (arg.startsWith('want ')) request.wants.push(arg.slice(5));
          else if (arg.startsWith('have ')) request.haves.push(arg.slice(5));
          else if (arg.startsWith('shallow ')) request.shallow.push(arg.slice(8));
          else if (arg.startsWith('deepen ')) request.depth = Number(arg.slice(7));
          else if (arg.startsWith('filter ')) request.filter = arg.slice(7);
        }
        out = v2FetchResponse(store, repo, request);
      } else {
        throw new Error(`unknown v2 command ${command}`);
      }
    } else {
      const request = parseV0Fetch(body);
      out = v0FetchResponse(store, repo, request);
    }
    sendBuffer(res, 200, out, gitContentType('git-upload-pack', 'result'));
  } catch (err) {
    const text = Buffer.from(`error: ${err instanceof Error ? err.message : String(err)}\n`, 'utf8');
    sendBuffer(res, 400, text, 'text/plain; charset=utf-8');
  }
}

/** POST /{owner}/{repo}.git/git-receive-pack */
export function handleReceivePack(store: Store, repo: Repo | undefined, req: IncomingMessage, res: ServerResponse, body: Buffer): void {
  if (repo === undefined) {
    const text = Buffer.from(JSON.stringify({ message: 'Not Found' }), 'utf8');
    sendBuffer(res, 404, text, 'application/json; charset=utf-8');
    return;
  }
  try {
    const out = runReceivePack(store, repo, body);
    sendBuffer(res, 200, out, gitContentType('git-receive-pack', 'result'));
  } catch (err) {
    const text = Buffer.from(`error: ${err instanceof Error ? err.message : String(err)}\n`, 'utf8');
    sendBuffer(res, 400, text, 'text/plain; charset=utf-8');
  }
}
