// Git object model and packfiles, written from the protocol as the kit's
// client speaks it: plain objects (commit/tree/blob/tag), REF_DELTA and
// OFS_DELTA on read, plain objects on write (the client accepts them).

import { inflateSync, deflateSync } from 'node:zlib';
import { sha1Hex, isOid } from './util.ts';

export type GitObjectType = 'commit' | 'tree' | 'blob' | 'tag';

export interface GitObject {
  type: GitObjectType;
  data: Buffer;
}

/** The canonical on-disk bytes of an object: `<type> <len>\0<data>`. */
export function objectBytes(type: GitObjectType, data: Buffer): Buffer {
  const header = Buffer.from(`${type} ${data.length}\0`, 'ascii');
  return Buffer.concat([header, data]);
}

/** The object id of a typed object. */
export function hashObject(type: GitObjectType, data: Buffer): string {
  return sha1Hex(objectBytes(type, data));
}

/** Inflate one zlib stream starting at `offset`; returns the data and the bytes consumed. */
function inflateOne(buf: Buffer, offset: number): { data: Buffer; consumed: number } {
  const result = inflateSync(buf.subarray(offset), { info: true }) as unknown as {
    buffer: Buffer;
    engine: { bytesWritten: number };
  };
  return { data: result.buffer, consumed: result.engine.bytesWritten };
}

/** Deflate data for one pack entry. */
function deflateOne(data: Buffer): Buffer {
  return deflateSync(data, { level: 6 });
}

// ---------------------------------------------------------------- trees

export interface TreeEntry {
  mode: string;
  name: string;
  oid: string;
}

/** Parse a tree object's entries, in stored order. */
export function parseTree(data: Buffer): TreeEntry[] {
  const entries: TreeEntry[] = [];
  let offset = 0;
  while (offset < data.length) {
    const space = data.indexOf(0x20, offset);
    if (space < 0) throw new Error('malformed tree: no mode');
    const nul = data.indexOf(0x00, space + 1);
    if (nul < 0 || nul + 21 > data.length) throw new Error('malformed tree: no name');
    const mode = data.subarray(offset, space).toString('ascii');
    const name = data.subarray(space + 1, nul).toString('utf8');
    const oid = data.subarray(nul + 1, nul + 21).toString('hex');
    entries.push({ mode, name, oid });
    offset = nul + 21;
  }
  return entries;
}

/** Git's tree sort: entries ordered by name, directories compared with a trailing '/'. */
export function sortTreeEntries(entries: TreeEntry[]): TreeEntry[] {
  return [...entries].sort((a, b) => {
    const an = a.mode === '40000' ? `${a.name}/` : a.name;
    const bn = b.mode === '40000' ? `${b.name}/` : b.name;
    return an < bn ? -1 : an > bn ? 1 : 0;
  });
}

/** Build a tree object's bytes from entries (sorted git-style). */
export function buildTree(entries: TreeEntry[]): Buffer {
  const parts: Buffer[] = [];
  for (const entry of sortTreeEntries(entries)) {
    if (!isOid(entry.oid)) throw new Error(`bad tree entry oid ${entry.oid}`);
    parts.push(Buffer.from(`${entry.mode} ${entry.name}\0`, 'utf8'));
    parts.push(Buffer.from(entry.oid, 'hex'));
  }
  return Buffer.concat(parts);
}

/** Flatten a tree to `path -> {mode, oid, data?}` for every file, following subtrees. */
export function flattenTree(
  getObject: (oid: string) => GitObject | undefined,
  treeOid: string,
  prefix = '',
  out: Map<string, { mode: string; oid: string }> = new Map(),
): Map<string, { mode: string; oid: string }> {
  const obj = getObject(treeOid);
  if (obj === undefined || obj.type !== 'tree') return out;
  for (const entry of parseTree(obj.data)) {
    const path = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.mode === '40000') flattenTree(getObject, entry.oid, path, out);
    else out.set(path, { mode: entry.mode, oid: entry.oid });
  }
  return out;
}

// ---------------------------------------------------------------- commits

export interface ParsedCommit {
  tree: string;
  parents: string[];
  author: string;
  committer: string;
  message: string;
}

/** Parse a commit object. Header lines until the blank line, then the message. */
export function parseCommit(data: Buffer): ParsedCommit {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const commit: ParsedCommit = { tree: '', parents: [], author: '', committer: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('tree ')) commit.tree = line.slice(5).trim();
    else if (line.startsWith('parent ')) commit.parents.push(line.slice(7).trim());
    else if (line.startsWith('author ')) commit.author = line.slice(7);
    else if (line.startsWith('committer ')) commit.committer = line.slice(10);
  }
  if (!isOid(commit.tree)) throw new Error('malformed commit: no tree');
  return commit;
}

export interface CommitInput {
  tree: string;
  parents: readonly string[];
  message: string;
  authorName: string;
  authorEmail: string;
  timestamp: number;
}

/** Build a commit object's bytes. One identity line for author and committer. */
export function buildCommit(input: CommitInput): Buffer {
  const stamp = `${input.timestamp} +0000`;
  const identity = `${input.authorName} <${input.authorEmail}> ${stamp}`;
  const lines: string[] = [`tree ${input.tree}`];
  for (const parent of input.parents) lines.push(`parent ${parent}`);
  lines.push(`author ${identity}`);
  lines.push(`committer ${identity}`);
  const text = `${lines.join('\n')}\n\n${input.message}`;
  return Buffer.from(text, 'utf8');
}

export interface ParsedTag {
  object: string;
  type: string;
  tag: string;
  tagger: string;
  message: string;
}

/** Parse an annotated tag object. Header lines until the blank line, then the message. */
export function parseTag(data: Buffer): ParsedTag {
  const text = data.toString('utf8');
  const blank = text.indexOf('\n\n');
  const header = blank < 0 ? text : text.slice(0, blank);
  const message = blank < 0 ? '' : text.slice(blank + 2);
  const tag: ParsedTag = { object: '', type: '', tag: '', tagger: '', message };
  for (const line of header.split('\n')) {
    if (line.startsWith('object ')) tag.object = line.slice(7).trim();
    else if (line.startsWith('type ')) tag.type = line.slice(5).trim();
    else if (line.startsWith('tag ')) tag.tag = line.slice(4).trim();
    else if (line.startsWith('tagger ')) tag.tagger = line.slice(7);
  }
  if (!isOid(tag.object)) throw new Error('malformed tag: no object');
  return tag;
}

// ---------------------------------------------------------------- deltas

/** Read a git delta size varint; returns the value and the bytes consumed. */
function readDeltaVarint(buf: Buffer, offset: number): { value: number; next: number } {
  let value = 0;
  let shift = 0;
  let pos = offset;
  for (;;) {
    if (pos >= buf.length) throw new Error('truncated delta varint');
    const byte = buf[pos] as number;
    pos += 1;
    value |= (byte & 0x7f) << shift;
    shift += 7;
    if ((byte & 0x80) === 0) break;
  }
  return { value, next: pos };
}

/** Apply a git delta to a base object's data. */
export function applyDelta(base: Buffer, delta: Buffer): Buffer {
  let pos = 0;
  const source = readDeltaVarint(delta, pos);
  pos = source.next;
  if (source.value !== base.length) throw new Error('delta source size does not match the base object');
  const target = readDeltaVarint(delta, pos);
  pos = target.next;
  const out: Buffer[] = [];
  let written = 0;
  while (pos < delta.length) {
    const op = delta[pos] as number;
    pos += 1;
    if ((op & 0x80) !== 0) {
      let offset = 0;
      let size = 0;
      if ((op & 0x01) !== 0) offset = delta[pos] as number, pos += 1;
      if ((op & 0x02) !== 0) offset |= (delta[pos] as number) << 8, pos += 1;
      if ((op & 0x04) !== 0) offset |= (delta[pos] as number) << 16, pos += 1;
      if ((op & 0x08) !== 0) offset |= (delta[pos] as number) << 24, pos += 1;
      if ((op & 0x10) !== 0) size = delta[pos] as number, pos += 1;
      if ((op & 0x20) !== 0) size |= (delta[pos] as number) << 8, pos += 1;
      if ((op & 0x40) !== 0) size |= (delta[pos] as number) << 16, pos += 1;
      if (size === 0) size = 0x10000;
      if (offset + size > base.length) throw new Error('delta copy runs past the base object');
      out.push(base.subarray(offset, offset + size));
      written += size;
    } else if (op !== 0) {
      if (pos + op > delta.length) throw new Error('delta insert runs past the delta');
      out.push(delta.subarray(pos, pos + op));
      pos += op;
      written += op;
    } else {
      throw new Error('delta opcode 0 is reserved');
    }
  }
  if (written !== target.value) throw new Error('delta target size does not match the output');
  return Buffer.concat(out);
}

// ---------------------------------------------------------------- packfiles

const PACK_TYPES: Record<number, GitObjectType> = { 1: 'commit', 2: 'tree', 3: 'blob', 4: 'tag' };

export interface PackRead {
  objects: Map<string, GitObject>;
  deltaCount: number;
}

/**
 * Parse a packfile (version 2 or 3). Resolves OFS_DELTA and REF_DELTA against
 * objects in the same pack, or against `resolveBase` (objects the reader already has).
 * Verifies the trailing sha1. Throws on a malformed pack.
 */
export function readPack(pack: Buffer, resolveBase?: (oid: string) => GitObject | undefined): PackRead {
  if (pack.length < 12 || pack.subarray(0, 4).toString('ascii') !== 'PACK') {
    throw new Error('not a packfile');
  }
  const version = pack.readUInt32BE(4);
  if (version !== 2 && version !== 3) throw new Error(`unsupported pack version ${version}`);
  const count = pack.readUInt32BE(8);
  // Verify the trailer sha1 over everything before it.
  const trailer = pack.subarray(pack.length - 20);
  if (!trailer.equals(Buffer.from(sha1Hex(pack.subarray(0, pack.length - 20)), 'hex'))) {
    throw new Error('pack trailer checksum mismatch');
  }
  const objects = new Map<string, GitObject>();
  const byOffset = new Map<number, GitObject>();
  let deltaCount = 0;
  let offset = 12;
  for (let index = 0; index < count; index += 1) {
    const entryOffset = offset;
    if (offset >= pack.length - 20) throw new Error('pack ends before its object count');
    let byte = pack[offset] as number;
    offset += 1;
    const typeNum = (byte >> 4) & 0x07;
    let size = byte & 0x0f;
    let shift = 4;
    while ((byte & 0x80) !== 0) {
      if (offset >= pack.length - 20) throw new Error('truncated pack entry header');
      byte = pack[offset] as number;
      offset += 1;
      size |= (byte & 0x7f) << shift;
      shift += 7;
    }
    let base: GitObject | undefined;
    if (typeNum === 6) {
      // OFS_DELTA: a negative offset to the base object, varint-encoded.
      if (offset >= pack.length - 20) throw new Error('truncated ofs-delta header');
      byte = pack[offset] as number;
      offset += 1;
      let baseOffset = byte & 0x7f;
      while ((byte & 0x80) !== 0) {
        if (offset >= pack.length - 20) throw new Error('truncated ofs-delta header');
        byte = pack[offset] as number;
        offset += 1;
        baseOffset = ((baseOffset + 1) << 7) | (byte & 0x7f);
      }
      base = byOffset.get(entryOffset - baseOffset);
      if (base === undefined) throw new Error('ofs-delta base is not an earlier pack object');
      deltaCount += 1;
    } else if (typeNum === 7) {
      // REF_DELTA: the base object's id follows the header.
      if (offset + 20 > pack.length - 20) throw new Error('truncated ref-delta header');
      const baseOid = pack.subarray(offset, offset + 20).toString('hex');
      offset += 20;
      base = objects.get(baseOid) ?? resolveBase?.(baseOid);
      if (base === undefined) throw new Error(`ref-delta base ${baseOid} is unknown`);
      deltaCount += 1;
    }
    const { data, consumed } = inflateOne(pack, offset);
    offset += consumed;
    if (data.length !== size) throw new Error(`pack object size ${data.length} != header ${size}`);
    let obj: GitObject;
    if (typeNum === 6 || typeNum === 7) {
      if (base === undefined) throw new Error('delta without a base');
      obj = { type: base.type, data: applyDelta(base.data, data) };
    } else {
      const type = PACK_TYPES[typeNum];
      if (type === undefined) throw new Error(`unknown pack object type ${typeNum}`);
      obj = { type, data };
    }
    const oid = hashObject(obj.type, obj.data);
    objects.set(oid, obj);
    byOffset.set(entryOffset, obj);
  }
  return { objects, deltaCount };
}

const PACK_TYPE_NUM: Record<GitObjectType, number> = { commit: 1, tree: 2, blob: 3, tag: 4 };

/** Write a packfile of plain objects (no deltas). The trailer is the pack's sha1. */
export function writePack(objects: readonly GitObject[]): Buffer {
  const parts: Buffer[] = [];
  const header = Buffer.alloc(12);
  header.write('PACK', 0, 'ascii');
  header.writeUInt32BE(2, 4);
  header.writeUInt32BE(objects.length, 8);
  parts.push(header);
  for (const obj of objects) {
    const typeNum = PACK_TYPE_NUM[obj.type];
    const size = obj.data.length;
    const headerBytes: number[] = [];
    let byte = (typeNum << 4) | (size & 0x0f);
    let remaining = size >> 4;
    if (remaining > 0) byte |= 0x80;
    headerBytes.push(byte);
    while (remaining > 0) {
      byte = remaining & 0x7f;
      remaining >>= 7;
      if (remaining > 0) byte |= 0x80;
      headerBytes.push(byte);
    }
    parts.push(Buffer.from(headerBytes));
    parts.push(deflateOne(obj.data));
  }
  const body = Buffer.concat(parts);
  const trailer = Buffer.from(sha1Hex(body), 'hex');
  return Buffer.concat([body, trailer]);
}

/** Verify a packfile's trailing checksum without parsing its objects. */
export function verifyPackChecksum(pack: Buffer): { ok: boolean; actual: string; expected: string } {
  if (pack.length < 20) return { ok: false, actual: '', expected: '' };
  const expected = sha1Hex(pack.subarray(0, pack.length - 20));
  const actual = pack.subarray(pack.length - 20).toString('hex');
  return { ok: expected === actual, actual, expected };
}
