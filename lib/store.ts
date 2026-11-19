// The in-memory store every surface shares: repositories, git objects and refs,
// issues, comments, labels and pull requests. One live process per trial, so
// plain Maps are the whole database. All ids and timestamps are deterministic.

import {
  VIEWER,
  epochNow,
  globalId,
  isoNow,
  nextId,
} from './util.ts';
import {
  buildCommit,
  buildTree,
  flattenTree,
  hashObject,
  parseCommit,
  parseTag,
  parseTree,
  writePack,
  type GitObject,
  type GitObjectType,
  type ParsedCommit,
  type TreeEntry,
} from './gitobj.ts';

export interface Label {
  name: string;
  color: string;
  description: string;
}

export interface Comment {
  id: number;
  body: string;
  createdAt: string;
  updatedAt: string;
}

export interface Issue {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  labels: string[];
  createdAt: string;
  updatedAt: string;
  seq: number;
  comments: Comment[];
}

export interface Pull {
  id: number;
  number: number;
  title: string;
  body: string;
  state: 'open' | 'closed';
  head: string;
  base: string;
  headSha: string;
  baseSha: string;
  merged: boolean;
  mergedAt: string | null;
  mergeCommitSha: string | null;
  createdAt: string;
  updatedAt: string;
  seq: number;
}

export interface Repo {
  id: number;
  name: string;
  owner: string;
  description: string;
  isPrivate: boolean;
  defaultBranch: string;
  createdAt: string;
  updatedAt: string;
  seq: number;
  refs: Map<string, string>;
  objects: Map<string, GitObject>;
  labels: Map<string, Label>;
  issues: Issue[];
  nextIssue: number;
  pulls: Pull[];
  nextPull: number;
  /** Bumped on any object or ref change; fetch-pack caches key on it. */
  version: number;
}

export const IDENTITY_NAME = VIEWER.name;
export const IDENTITY_EMAIL = VIEWER.email;

/** The identity line the conformance client puts on the commits it builds. */
export const CLIENT_IDENTITY = 'Conformance <conformance@example.invalid>';

export class Store {
  repos = new Map<string, Repo>();
  reposById = new Map<number, Repo>();
  /** Global-id lookups for GraphQL mutations: numeric id -> owning repo and object. */
  issueById = new Map<number, { repo: Repo; issue: Issue }>();
  pullById = new Map<number, { repo: Repo; pull: Pull }>();
  private seqCounter = 0;
  /** Fetch-plan cache: key -> built value (cleared when the repo's version moves). */
  private packCache = new Map<string, { version: number; value: unknown }>();

  key(owner: string, name: string): string {
    return `${owner}/${name}`;
  }

  createRepo(owner: string, name: string, description: string, isPrivate: boolean): Repo | null {
    const key = this.key(owner, name);
    if (this.repos.has(key)) return null;
    this.seqCounter += 1;
    const now = isoNow();
    const repo: Repo = {
      id: nextId(),
      name,
      owner,
      description,
      isPrivate,
      defaultBranch: 'main',
      createdAt: now,
      updatedAt: now,
      seq: this.seqCounter,
      refs: new Map(),
      objects: new Map(),
      labels: new Map(),
      issues: [],
      nextIssue: 1,
      pulls: [],
      nextPull: 1,
      version: 0,
    };
    this.repos.set(key, repo);
    this.reposById.set(repo.id, repo);
    return repo;
  }

  getRepo(owner: string, name: string): Repo | undefined {
    return this.repos.get(this.key(owner, name));
  }

  getRepoById(id: number): Repo | undefined {
    return this.reposById.get(id);
  }

  deleteRepo(owner: string, name: string): boolean {
    const repo = this.repos.get(this.key(owner, name));
    if (repo === undefined) return false;
    this.repos.delete(this.key(owner, name));
    this.reposById.delete(repo.id);
    for (const issue of repo.issues) this.issueById.delete(issue.id);
    for (const pull of repo.pulls) this.pullById.delete(pull.id);
    return true;
  }

  listRepos(owner: string): Repo[] {
    const out: Repo[] = [];
    for (const repo of this.repos.values()) if (repo.owner === owner) out.push(repo);
    out.sort((a, b) => a.seq - b.seq);
    return out;
  }

  // ---------------------------------------------------------------- git objects

  putObject(repo: Repo, type: GitObjectType, data: Buffer): string {
    const oid = hashObject(type, data);
    if (!repo.objects.has(oid)) {
      repo.objects.set(oid, { type, data });
      repo.version += 1;
    }
    return oid;
  }

  getObject(repo: Repo, oid: string): GitObject | undefined {
    return repo.objects.get(oid);
  }

  refOf(repo: Repo, ref: string): string | undefined {
    return repo.refs.get(ref);
  }

  setRef(repo: Repo, ref: string, oid: string): void {
    repo.refs.set(ref, oid);
    repo.version += 1;
  }

  deleteRef(repo: Repo, ref: string): boolean {
    const had = repo.refs.delete(ref);
    if (had) repo.version += 1;
    return had;
  }

  branchTip(repo: Repo, branch: string): string | undefined {
    return repo.refs.get(`refs/heads/${branch}`);
  }

  listBranches(repo: Repo): Array<{ name: string; sha: string }> {
    const out: Array<{ name: string; sha: string }> = [];
    for (const [ref, sha] of repo.refs) {
      if (ref.startsWith('refs/heads/')) out.push({ name: ref.slice('refs/heads/'.length), sha });
    }
    out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    return out;
  }

  parseCommitOf(repo: Repo, oid: string): ParsedCommit | null {
    const obj = repo.objects.get(oid);
    if (obj === undefined || obj.type !== 'commit') return null;
    try {
      return parseCommit(obj.data);
    } catch {
      return null;
    }
  }

  /** All commit oids reachable from `oid` (itself included), parents first walk. */
  ancestors(repo: Repo, oid: string): Set<string> {
    const seen = new Set<string>();
    const stack = [oid];
    while (stack.length > 0) {
      const current = stack.pop() as string;
      if (seen.has(current)) continue;
      const commit = this.parseCommitOf(repo, current);
      if (commit === null) continue;
      seen.add(current);
      for (const parent of commit.parents) stack.push(parent);
    }
    return seen;
  }

  /** True when `ancestor` is `descendant` itself or reachable from it. */
  isAncestor(repo: Repo, ancestor: string, descendant: string): boolean {
    if (ancestor === descendant) return true;
    return this.ancestors(repo, descendant).has(ancestor);
  }

  /** A common ancestor of two commits, preferring the nearest to `a`. */
  mergeBase(repo: Repo, a: string, b: string): string | null {
    const aAncestors = this.ancestors(repo, a);
    if (aAncestors.has(b)) return b;
    // Breadth-first from b: the first commit also reachable from a.
    const seen = new Set<string>([b]);
    const queue = [b];
    while (queue.length > 0) {
      const current = queue.shift() as string;
      const commit = this.parseCommitOf(repo, current);
      if (commit === null) continue;
      for (const parent of commit.parents) {
        if (aAncestors.has(parent)) return parent;
        if (!seen.has(parent)) {
          seen.add(parent);
          queue.push(parent);
        }
      }
    }
    return null;
  }

  /** The objects reachable from a tree (the tree itself, subtrees, blobs). */
  treeObjects(repo: Repo, treeOid: string, out: Map<string, GitObject> = new Map()): Map<string, GitObject> {
    const obj = repo.objects.get(treeOid);
    if (obj === undefined || obj.type !== 'tree') return out;
    if (out.has(treeOid)) return out;
    out.set(treeOid, obj);
    for (const entry of parseTree(obj.data)) {
      const child = repo.objects.get(entry.oid);
      if (child === undefined) continue;
      if (child.type === 'tree') this.treeObjects(repo, entry.oid, out);
      else if (!out.has(entry.oid)) out.set(entry.oid, child);
    }
    return out;
  }

  // ---------------------------------------------------------------- fetch planning

  /** Follow annotated tag objects to the commit they point at (null when it is not a commit). */
  peelToCommit(repo: Repo, oid: string): string | null {
    let current = oid;
    for (let hops = 0; hops < 16; hops += 1) {
      const obj = repo.objects.get(current);
      if (obj === undefined) return null;
      if (obj.type === 'commit') return current;
      if (obj.type !== 'tag') return null;
      try {
        current = parseTag(obj.data).object;
      } catch {
        return null;
      }
    }
    return null;
  }

  /**
   * The object set a fetch answers with, for wants/haves/depth/shallow.
   * `wants` are commit oids (a tag want also answers with its peeled commit's
   * history; a tree/blob want with just that object).
   * A `have` that is also a shallow boundary means "I hold this commit's
   * objects but not its parents": the walk passes through it, so a deepen
   * delivers the next generation. Returns the pack objects, the new shallow
   * boundaries and the old boundaries that are now complete (unshallow).
   */
  fetchPlan(
    repo: Repo,
    wants: readonly string[],
    haves: readonly string[],
    depth: number | null,
    knownShallow: readonly string[],
  ): { objects: GitObject[]; shallow: string[]; unshallow: string[] } {
    const boundary = new Set(knownShallow);
    // Commits the client holds with their full history: ancestors of a have,
    // except a have that is itself a shallow boundary only holds itself —
    // its parents are still wanted.
    const heldFully = new Set<string>();
    for (const have of haves) {
      const stack = [have];
      while (stack.length > 0) {
        const current = stack.pop() as string;
        if (heldFully.has(current)) continue;
        const commit = this.parseCommitOf(repo, current);
        if (commit === null) continue;
        heldFully.add(current);
        if (boundary.has(current)) continue;
        for (const parent of commit.parents) stack.push(parent);
      }
    }
    // Objects the client already holds: everything under a fully-held commit,
    // and a boundary commit's own objects (its parents are still wanted).
    const excluded = new Map<string, GitObject>();
    const excludeTree = (treeOid: string): void => {
      for (const [oid, obj] of this.treeObjects(repo, treeOid)) excluded.set(oid, obj);
    };
    for (const held of heldFully) {
      const commit = this.parseCommitOf(repo, held);
      if (commit === null) continue;
      const obj = repo.objects.get(held);
      if (obj !== undefined) excluded.set(held, obj);
      excludeTree(commit.tree);
    }
    for (const oid of boundary) {
      const commit = this.parseCommitOf(repo, oid);
      if (commit === null) continue;
      const obj = repo.objects.get(oid);
      if (obj !== undefined) excluded.set(oid, obj);
      excludeTree(commit.tree);
    }

    const direct: GitObject[] = [];
    const queue: Array<[string, number]> = [];
    for (const want of wants) {
      const obj = repo.objects.get(want);
      if (obj === undefined) throw new Error(`want ${want} is not an object in this repository`);
      if (obj.type === 'commit') {
        queue.push([want, 0]);
      } else if (obj.type === 'tag') {
        if (!excluded.has(want)) direct.push(obj);
        const target = this.peelToCommit(repo, want);
        if (target !== null) queue.push([target, 0]);
      } else {
        if (!excluded.has(want)) direct.push(obj);
      }
    }

    const included = new Map<string, number>(); // commit oid -> generation from a want
    // Breadth-first by generation so the nearest want wins a shared commit.
    while (queue.length > 0) {
      const [oid, generation] = queue.shift() as [string, number];
      if (included.has(oid)) continue;
      if (heldFully.has(oid) && !boundary.has(oid)) continue;
      if (depth !== null && generation >= depth) continue;
      included.set(oid, generation);
      const commit = this.parseCommitOf(repo, oid);
      if (commit === null) continue;
      for (const parent of commit.parents) queue.push([parent, generation + 1]);
    }

    const shallow: string[] = [];
    const unshallow: string[] = [];
    for (const oid of included.keys()) {
      if (boundary.has(oid)) {
        // The client held this as a boundary; the fetch now completes it.
        unshallow.push(oid);
        continue;
      }
      const commit = this.parseCommitOf(repo, oid);
      if (commit === null || commit.parents.length === 0) continue;
      const parentIncluded = commit.parents.some((parent) => included.has(parent));
      const parentHeld = commit.parents.some((parent) => heldFully.has(parent));
      if (!parentIncluded && !parentHeld) shallow.push(oid);
    }

    const objects = new Map<string, GitObject>();
    for (const obj of direct) objects.set(hashObject(obj.type, obj.data), obj);
    for (const oid of included.keys()) {
      if (boundary.has(oid) || heldFully.has(oid)) continue;
      const commitObj = repo.objects.get(oid);
      if (commitObj === undefined) continue;
      if (!excluded.has(oid)) objects.set(oid, commitObj);
      const commit = this.parseCommitOf(repo, oid);
      if (commit === null) continue;
      for (const [treeOid, treeObj] of this.treeObjects(repo, commit.tree)) {
        if (!excluded.has(treeOid)) objects.set(treeOid, treeObj);
      }
    }
    return { objects: [...objects.values()], shallow, unshallow };
  }

  /** A cached fetch result (pack plus shallow lists), keyed on the repo version. */
  cachedFetchPack<T>(repo: Repo, key: string, build: () => T): T {
    const hit = this.packCache.get(key);
    if (hit !== undefined && hit.version === repo.version) return hit.value as T;
    const value = build();
    this.packCache.set(key, { version: repo.version, value });
    if (this.packCache.size > 64) {
      const first = this.packCache.keys().next().value;
      if (first !== undefined) this.packCache.delete(first);
    }
    return value;
  }

  // ---------------------------------------------------------------- trees from flat maps

  /**
   * Build (and store) the nested trees for a flat `path -> {mode, oid}` map.
   * Returns the root tree's oid.
   */
  buildTreeFromFlat(repo: Repo, files: Map<string, { mode: string; oid: string }>): string {
    const buildLevel = (prefix: string): string => {
      const entries: TreeEntry[] = [];
      const dirs = new Map<string, Map<string, { mode: string; oid: string }>>();
      for (const [path, file] of files) {
        if (!path.startsWith(prefix)) continue;
        const rest = path.slice(prefix.length);
        const slash = rest.indexOf('/');
        if (slash < 0) {
          entries.push({ mode: file.mode, name: rest, oid: file.oid });
        } else {
          const dir = rest.slice(0, slash);
          let sub = dirs.get(dir);
          if (sub === undefined) {
            sub = new Map();
            dirs.set(dir, sub);
          }
          sub.set(path, file);
        }
      }
      for (const [dir, sub] of dirs) {
        const subPrefix = `${prefix}${dir}/`;
        const subOid = buildLevel(subPrefix);
        entries.push({ mode: '40000', name: dir, oid: subOid });
      }
      const data = buildTree(entries);
      return this.putObject(repo, 'tree', data);
    };
    return buildLevel('');
  }

  /** Create a commit on a branch and move the branch to it. Returns the commit oid. */
  createCommit(
    repo: Repo,
    branch: string,
    treeOid: string,
    message: string,
    parents: readonly string[],
  ): string {
    const commitData = buildCommit({
      tree: treeOid,
      parents,
      message,
      authorName: IDENTITY_NAME,
      authorEmail: IDENTITY_EMAIL,
      timestamp: epochNow(),
    });
    const oid = this.putObject(repo, 'commit', commitData);
    this.setRef(repo, `refs/heads/${branch}`, oid);
    return oid;
  }

  /** The flat file map of a commit's tree (empty map for a missing/empty tree). */
  filesOfCommit(repo: Repo, commitOid: string): Map<string, { mode: string; oid: string }> {
    const commit = this.parseCommitOf(repo, commitOid);
    if (commit === null) return new Map();
    return flattenTree((oid) => repo.objects.get(oid), commit.tree);
  }

  // ---------------------------------------------------------------- diff and merge

  /** Line counts added/removed between two blobs, by multiset difference. */
  static lineDiff(oldData: Buffer | null, newData: Buffer | null): { additions: number; deletions: number } {
    const countLines = (data: Buffer | null): Map<string, number> => {
      const counts = new Map<string, number>();
      if (data === null) return counts;
      const text = data.toString('utf8');
      for (const line of text.split('\n')) counts.set(line, (counts.get(line) ?? 0) + 1);
      return counts;
    };
    const oldLines = countLines(oldData);
    const newLines = countLines(newData);
    let additions = 0;
    let deletions = 0;
    for (const [line, count] of newLines) {
      const oldCount = oldLines.get(line) ?? 0;
      if (count > oldCount) additions += count - oldCount;
    }
    for (const [line, count] of oldLines) {
      const newCount = newLines.get(line) ?? 0;
      if (count > newCount) deletions += count - newCount;
    }
    return { additions, deletions };
  }

  /** The file diff between two commit trees. */
  diffCommits(
    repo: Repo,
    baseOid: string,
    headOid: string,
  ): Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> {
    const baseFiles = this.filesOfCommit(repo, baseOid);
    const headFiles = this.filesOfCommit(repo, headOid);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys()]);
    const out: Array<{ filename: string; status: 'added' | 'modified' | 'removed'; additions: number; deletions: number; changes: number }> = [];
    for (const path of [...paths].sort()) {
      const base = baseFiles.get(path);
      const head = headFiles.get(path);
      if (base === undefined && head !== undefined) {
        const data = repo.objects.get(head.oid)?.data ?? null;
        const diff = Store.lineDiff(null, data);
        out.push({ filename: path, status: 'added', additions: diff.additions, deletions: 0, changes: diff.additions });
      } else if (base !== undefined && head === undefined) {
        const data = repo.objects.get(base.oid)?.data ?? null;
        const diff = Store.lineDiff(data, null);
        out.push({ filename: path, status: 'removed', additions: 0, deletions: diff.deletions, changes: diff.deletions });
      } else if (base !== undefined && head !== undefined && base.oid !== head.oid) {
        const oldData = repo.objects.get(base.oid)?.data ?? null;
        const newData = repo.objects.get(head.oid)?.data ?? null;
        const diff = Store.lineDiff(oldData, newData);
        out.push({
          filename: path,
          status: 'modified',
          additions: diff.additions,
          deletions: diff.deletions,
          changes: diff.additions + diff.deletions,
        });
      }
    }
    return out;
  }

  /**
   * The three-way merge of a pull request's head into its base.
   * Returns null when the same file changed differently on both sides.
   * Otherwise the merged flat file map (head's changes applied onto base).
   */
  threeWayMerge(repo: Repo, pull: Pull): Map<string, { mode: string; oid: string }> | null {
    const baseTip = pull.baseSha;
    const headTip = pull.headSha;
    const mergeBaseOid = this.mergeBase(repo, headTip, baseTip);
    const baseFiles = mergeBaseOid === null ? new Map() : this.filesOfCommit(repo, mergeBaseOid);
    const headFiles = this.filesOfCommit(repo, headTip);
    const baseBranchFiles = this.filesOfCommit(repo, baseTip);
    const merged = new Map<string, { mode: string; oid: string }>(baseBranchFiles);
    const paths = new Set([...baseFiles.keys(), ...headFiles.keys(), ...baseBranchFiles.keys()]);
    for (const path of paths) {
      const ancestor = baseFiles.get(path);
      const head = headFiles.get(path);
      const base = baseBranchFiles.get(path);
      const headChanged = (head?.oid ?? null) !== (ancestor?.oid ?? null);
      const baseChanged = (base?.oid ?? null) !== (ancestor?.oid ?? null);
      if (headChanged && baseChanged && (head?.oid ?? null) !== (base?.oid ?? null)) return null;
      if (headChanged) {
        if (head === undefined) merged.delete(path);
        else merged.set(path, head);
      }
    }
    return merged;
  }

  /** True when a pull request can merge cleanly right now. */
  mergeable(repo: Repo, pull: Pull): boolean {
    if (pull.merged) return false;
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return false;
    if (headTip === baseTip) return true;
    return this.threeWayMerge(repo, { ...pull, headSha: headTip, baseSha: baseTip }) !== null;
  }

  /**
   * Squash-merge a pull request onto its base branch. Returns the merge commit
   * oid, or null when the request cannot merge.
   */
  squashMerge(repo: Repo, pull: Pull): string | null {
    const headTip = this.branchTip(repo, pull.head);
    const baseTip = this.branchTip(repo, pull.base);
    if (headTip === undefined || baseTip === undefined) return null;
    const merged = this.threeWayMerge(repo, { ...pull, headSha: headTip, baseSha: baseTip });
    if (merged === null) return null;
    const treeOid = this.buildTreeFromFlat(repo, merged);
    const message = `${pull.title} (#${pull.number})\n`;
    const oid = this.createCommit(repo, pull.base, treeOid, message, [baseTip]);
    return oid;
  }

  // ---------------------------------------------------------------- issues and pulls

  createIssue(repo: Repo, title: string, body: string, labels: string[]): Issue {
    const now = isoNow();
    const issue: Issue = {
      id: nextId(),
      number: repo.nextIssue,
      title,
      body,
      state: 'open',
      labels: [...labels],
      createdAt: now,
      updatedAt: now,
      seq: this.seqCounter += 1,
      comments: [],
    };
    repo.nextIssue += 1;
    repo.issues.push(issue);
    this.issueById.set(issue.id, { repo, issue });
    return issue;
  }

  createPull(repo: Repo, title: string, body: string, head: string, base: string): Pull | null {
    const headSha = this.branchTip(repo, head);
    const baseSha = this.branchTip(repo, base);
    if (headSha === undefined || baseSha === undefined) return null;
    const now = isoNow();
    const pull: Pull = {
      id: nextId(),
      number: repo.nextPull,
      title,
      body,
      state: 'open',
      head,
      base,
      headSha,
      baseSha,
      merged: false,
      mergedAt: null,
      mergeCommitSha: null,
      createdAt: now,
      updatedAt: now,
      seq: this.seqCounter += 1,
    };
    repo.nextPull += 1;
    repo.pulls.push(pull);
    this.pullById.set(pull.id, { repo, pull });
    return pull;
  }
}

// ---------------------------------------------------------------- serializers

export function userJson(): Record<string, unknown> {
  return {
    login: VIEWER.login,
    id: VIEWER.id,
    node_id: globalId('User', VIEWER.id),
    avatar_url: '',
    html_url: '',
    type: 'User',
    name: VIEWER.name,
    email: VIEWER.email,
  };
}

export function repoJson(repo: Repo): Record<string, unknown> {
  return {
    id: repo.id,
    node_id: globalId('Repository', repo.id),
    name: repo.name,
    full_name: `${repo.owner}/${repo.name}`,
    owner: userJson(),
    private: repo.isPrivate,
    html_url: '',
    description: repo.description,
    fork: false,
    url: `/api/v3/repos/${repo.owner}/${repo.name}`,
    created_at: repo.createdAt,
    updated_at: repo.updatedAt,
    pushed_at: repo.updatedAt,
    default_branch: repo.defaultBranch,
    has_issues: true,
    has_projects: false,
    has_wiki: false,
  };
}

export function issueJson(repo: Repo, issue: Issue): Record<string, unknown> {
  return {
    id: issue.id,
    node_id: globalId('Issue', issue.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}`,
    html_url: '',
    number: issue.number,
    title: issue.title,
    body: issue.body,
    state: issue.state,
    labels: issue.labels.map((name) => {
      const label = repo.labels.get(name);
      return { name, color: label?.color ?? '000000', description: label?.description ?? '' };
    }),
    user: userJson(),
    created_at: issue.createdAt,
    updated_at: issue.updatedAt,
    closed_at: issue.state === 'closed' ? issue.updatedAt : null,
    comments: issue.comments.length,
  };
}

export function commentJson(repo: Repo, issue: Issue, comment: Comment): Record<string, unknown> {
  return {
    id: comment.id,
    node_id: globalId('IssueComment', comment.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/issues/${issue.number}/comments/${comment.id}`,
    body: comment.body,
    user: userJson(),
    created_at: comment.createdAt,
    updated_at: comment.updatedAt,
  };
}

export function pullJson(repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: pull.id,
    node_id: globalId('PullRequest', pull.id),
    url: `/api/v3/repos/${repo.owner}/${repo.name}/pulls/${pull.number}`,
    html_url: '',
    number: pull.number,
    title: pull.title,
    body: pull.body,
    state: pull.state,
    head: { label: `${repo.owner}:${pull.head}`, ref: pull.head, sha: pull.headSha },
    base: { label: `${repo.owner}:${pull.base}`, ref: pull.base, sha: pull.baseSha },
    merged: pull.merged,
    merged_at: pull.mergedAt,
    merge_commit_sha: pull.mergeCommitSha,
    mergeable: pull.merged ? false : null,
    user: userJson(),
    created_at: pull.createdAt,
    updated_at: pull.updatedAt,
    closed_at: pull.state === 'closed' ? pull.updatedAt : null,
  };
}

/** The commit timestamp as an ISO string, parsed from the author line. */
export function commitDateOf(commit: ParsedCommit): string {
  const match = commit.author.match(/ (\d+) [+-]\d{4}$/);
  if (match === null) return isoNow();
  return new Date(Number(match[1]) * 1000).toISOString();
}

export function commitJson(repo: Repo, oid: string): Record<string, unknown> | null {
  const commit = repo.objects.get(oid);
  if (commit === undefined || commit.type !== 'commit') return null;
  let parsed: ParsedCommit;
  try {
    parsed = parseCommit(commit.data);
  } catch {
    return null;
  }
  const date = commitDateOf(parsed);
  const authorName = parsed.author.replace(/ <.*$/, '').trim();
  return {
    sha: oid,
    commit: {
      message: parsed.message,
      author: { name: authorName === '' ? IDENTITY_NAME : authorName, email: IDENTITY_EMAIL, date },
      committer: { name: IDENTITY_NAME, email: IDENTITY_EMAIL, date },
      tree: { sha: parsed.tree },
    },
    author: userJson(),
    committer: userJson(),
    parents: parsed.parents.map((sha) => ({ sha })),
  };
}
