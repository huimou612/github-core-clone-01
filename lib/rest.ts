// GitHub REST v3: repositories, branches, commits, refs, contents, labels,
// issues, comments and pull requests. Every reply is JSON with a non-empty
// X-GitHub-Request-Id; errors are JSON with a string `message`.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, decodeBase64, isOid, isoNow, nextId } from './util.ts';
import {
  Store,
  commentJson,
  commitJson,
  issueJson,
  pullJson,
  repoJson,
  userJson,
  type Comment,
  type Repo,
} from './store.ts';

let requestCounter = 0;

function requestId(): string {
  requestCounter += 1;
  return `req-${requestCounter}`;
}

export interface RestContext {
  store: Store;
  token: string;
}

function sendJson(
  res: ServerResponse,
  status: number,
  body: unknown,
  extraHeaders: Readonly<Record<string, string>> = {},
): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(text),
    'x-github-request-id': requestId(),
    ...extraHeaders,
  });
  res.end(text);
}

function sendError(res: ServerResponse, status: number, message: string): void {
  sendJson(res, status, { message });
}

/** The bearer token the request carries, or null. */
function bearerOf(req: IncomingMessage): string | null {
  const header = req.headers.authorization ?? '';
  const match = header.match(/^Bearer (.+)$/);
  return match === null ? null : (match[1] as string);
}

/** True when the request's bearer token is the trial's token. */
export function authorized(ctx: RestContext, req: IncomingMessage): boolean {
  const bearer = bearerOf(req);
  if (bearer === null || bearer === '') return false;
  if (ctx.token === '') return true; // no token configured (local runs): any bearer passes
  return bearer === ctx.token;
}

/** Split a path into its segments, decoding each. */
function segments(path: string): string[] {
  return path.split('/').filter((part) => part !== '').map((part) => decodeURIComponent(part));
}

interface Page {
  page: number;
  perPage: number;
}

/** `page`/`per_page` query params (GitHub defaults: page 1, 30 a page). */
function pageOf(url: URL): Page {
  const page = Number(url.searchParams.get('page') ?? '1');
  const perPage = Number(url.searchParams.get('per_page') ?? '30');
  return {
    page: Number.isFinite(page) && page >= 1 ? Math.trunc(page) : 1,
    perPage: Number.isFinite(perPage) && perPage >= 1 ? Math.min(100, Math.trunc(perPage)) : 30,
  };
}

/** Paginate a list: the slice for this page. */
function pageSlice<T>(items: readonly T[], page: Page): T[] {
  return items.slice((page.page - 1) * page.perPage, page.page * page.perPage);
}

/** The absolute base for Link headers: the request's own host, so the next page URL is same-origin. */
function absoluteLink(req: IncomingMessage, path: string, page: number, perPage: number): string {
  const host = req.headers.host ?? 'localhost';
  return `http://${host}${path}?page=${page}&per_page=${perPage}`;
}

function linkHeader(req: IncomingMessage, path: string, page: Page, total: number): string | null {
  const lastPage = Math.max(1, Math.ceil(total / page.perPage));
  if (page.page >= lastPage) return null;
  const next = absoluteLink(req, path, page.page + 1, page.perPage);
  const last = absoluteLink(req, path, lastPage, page.perPage);
  return `<${next}>; rel="next", <${last}>; rel="last"`;
}

/** Resolve a repo from the path, enforcing the viewer-owner rule (404, never 403). */
function repoOf(ctx: RestContext, owner: string, name: string): Repo | null {
  if (owner !== VIEWER.login) return null;
  return ctx.store.getRepo(owner, name) ?? null;
}

/** Resolve a ref name (branch, `refs/heads/x`, or an oid) to a commit oid. */
function resolveRef(store: Store, repo: Repo, ref: string | null): string | undefined {
  if (ref === null || ref === '') return store.branchTip(repo, repo.defaultBranch);
  if (isOid(ref)) return store.getObject(repo, ref) !== undefined ? ref : undefined;
  if (ref.startsWith('refs/heads/')) return store.refOf(repo, ref);
  return store.branchTip(repo, ref);
}

/** The JSON body of a request, already parsed by app.ts ({} when empty). */
export type JsonBody = Record<string, unknown>;

function str(body: JsonBody, key: string): string | undefined {
  const value = body[key];
  return typeof value === 'string' ? value : undefined;
}

function strArray(body: JsonBody, key: string): string[] | undefined {
  const value = body[key];
  if (!Array.isArray(value)) return undefined;
  return value.filter((entry): entry is string => typeof entry === 'string');
}

/** List an issue set with GitHub's state/sort/direction parameters. */
function listIssues(repo: Repo, url: URL): ReturnType<typeof issueJson>[] {
  const state = url.searchParams.get('state') ?? 'open';
  const sort = url.searchParams.get('sort') ?? 'created';
  const direction = url.searchParams.get('direction') ?? 'desc';
  let issues = [...repo.issues];
  if (state !== 'all') issues = issues.filter((issue) => issue.state === state);
  if (sort === 'created') {
    issues.sort((a, b) => (direction === 'asc' ? a.seq - b.seq : b.seq - a.seq));
  }
  return issues.map((issue) => issueJson(repo, issue));
}

function listPulls(repo: Repo, url: URL): ReturnType<typeof pullJson>[] {
  const state = url.searchParams.get('state') ?? 'open';
  let pulls = [...repo.pulls];
  if (state !== 'all') pulls = pulls.filter((pull) => pull.state === state);
  pulls.sort((a, b) => b.seq - a.seq);
  return pulls.map((pull) => pullJson(repo, pull));
}

/** The main REST dispatcher. Returns true when the route was handled. */
export function handleRest(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  url: URL,
  body: JsonBody | null,
  rawBody: Buffer,
): boolean {
  const method = req.method ?? 'GET';
  const path = url.pathname;
  if (!path.startsWith('/api/v3')) return false;
  const parts = segments(path.slice('/api/v3'.length));

  // Auth: every /api/v3 route needs the trial token.
  if (!authorized(ctx, req)) {
    sendError(res, 401, 'Bad credentials');
    return true;
  }
  // A malformed JSON body is a 400 on any route that takes one.
  if (body === null && rawBody.length > 0 && (method === 'POST' || method === 'PUT' || method === 'PATCH')) {
    sendError(res, 400, 'Problems parsing JSON');
    return true;
  }
  const json: JsonBody = body ?? {};

  // GET /api/v3 — the API root.
  if (parts.length === 0) {
    if (method !== 'GET') {
      sendError(res, 404, 'Not Found');
      return true;
    }
    sendJson(res, 200, {
      current_user_url: '/api/v3/user',
      rate_limit_url: '/api/v3/rate_limit',
      repository_url: '/api/v3/repos/{owner}/{repo}',
    }, { 'x-oauth-scopes': 'repo, read:org' });
    return true;
  }

  // GET /api/v3/meta
  if (parts.length === 1 && parts[0] === 'meta' && method === 'GET') {
    sendJson(res, 200, {
      verifiable_password_authentication: false,
      installed_version: '1.0.0',
      github_services_sha: '0000000000000000000000000000000000000000',
      hooks: [],
      git: [],
      pages: [],
      importer: [],
      ssh_key_fingerprints: {},
      ssh_keys: [],
      domains: {},
    });
    return true;
  }

  // GET /api/v3/user
  if (parts.length === 1 && parts[0] === 'user' && method === 'GET') {
    sendJson(res, 200, userJson());
    return true;
  }

  // /api/v3/user/repos
  if (parts.length === 2 && parts[0] === 'user' && parts[1] === 'repos') {
    if (method === 'GET') {
      const page = pageOf(url);
      const repos = ctx.store.listRepos(VIEWER.login).map((repo) => repoJson(repo));
      const link = linkHeader(req, path, page, repos.length);
      const headers: Record<string, string> = {};
      if (link !== null) headers.link = link;
      sendJson(res, 200, pageSlice(repos, page), headers);
      return true;
    }
    if (method === 'POST') {
      const name = str(json, 'name');
      if (name === undefined || name === '') {
        sendError(res, 422, 'Validation Failed: name is required');
        return true;
      }
      const created = ctx.store.createRepo(VIEWER.login, name, str(json, 'description') ?? '', json.private === true);
      if (created === null) {
        sendError(res, 422, 'Validation Failed: name already exists on this account');
        return true;
      }
      sendJson(res, 201, repoJson(created));
      return true;
    }
    sendError(res, 404, 'Not Found');
    return true;
  }

  // /api/v3/repos/{owner}/{repo}[/...]
  if (parts.length >= 3 && parts[0] === 'repos') {
    const owner = parts[1] as string;
    const name = parts[2] as string;
    const repo = repoOf(ctx, owner, name);
    if (repo === null) {
      sendError(res, 404, 'Not Found');
      return true;
    }
    const rest = parts.slice(3);

    // GET/PATCH/DELETE /repos/{owner}/{repo}
    if (rest.length === 0) {
      if (method === 'GET') {
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'PATCH') {
        const description = str(json, 'description');
        if (description !== undefined) repo.description = description;
        repo.updatedAt = isoNow();
        sendJson(res, 200, repoJson(repo));
        return true;
      }
      if (method === 'DELETE') {
        ctx.store.deleteRepo(owner, name);
        res.writeHead(204, { 'x-github-request-id': requestId() });
        res.end();
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // Branches.
    if (rest[0] === 'branches') {
      if (rest.length === 1 && method === 'GET') {
        sendJson(res, 200, ctx.store.listBranches(repo).map((branch) => ({
          name: branch.name,
          commit: { sha: branch.sha, url: `/api/v3/repos/${owner}/${name}/commits/${branch.sha}` },
          protected: false,
        })));
        return true;
      }
      if (rest.length === 2 && method === 'GET') {
        const tip = ctx.store.branchTip(repo, rest[1] as string);
        if (tip === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, {
          name: rest[1],
          commit: { sha: tip, url: `/api/v3/repos/${owner}/${name}/commits/${tip}` },
          protected: false,
        });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // Commits.
    if (rest[0] === 'commits' && rest.length === 1 && method === 'GET') {
      const tip = resolveRef(ctx.store, repo, url.searchParams.get('sha'));
      if (tip === undefined) {
        sendJson(res, 200, []);
        return true;
      }
      const out: Record<string, unknown>[] = [];
      const seen = new Set<string>();
      const queue = [tip];
      while (queue.length > 0) {
        const oid = queue.shift() as string;
        if (seen.has(oid)) continue;
        seen.add(oid);
        const entry = commitJson(repo, oid);
        if (entry === null) continue;
        out.push(entry);
        const commit = ctx.store.parseCommitOf(repo, oid);
        if (commit !== null) for (const parent of commit.parents) queue.push(parent);
      }
      sendJson(res, 200, out);
      return true;
    }

    // Git refs.
    if (rest[0] === 'git' && rest[1] === 'refs') {
      if (method === 'POST' && rest.length === 2) {
        const ref = str(json, 'ref');
        const sha = str(json, 'sha');
        if (ref === undefined || sha === undefined || !ref.startsWith('refs/')) {
          sendError(res, 422, 'Validation Failed: ref and sha are required');
          return true;
        }
        const obj = ctx.store.getObject(repo, sha);
        if (obj === undefined) {
          sendError(res, 422, 'Validation Failed: sha does not exist');
          return true;
        }
        if (ctx.store.refOf(repo, ref) !== undefined) {
          sendError(res, 422, 'Validation Failed: ref already exists');
          return true;
        }
        ctx.store.setRef(repo, ref, sha);
        sendJson(res, 201, { ref, object: { sha, type: obj.type } });
        return true;
      }
      if (method === 'GET') {
        const wanted = rest.slice(2).join('/');
        if (wanted === '') {
          const refs: Record<string, unknown>[] = [];
          for (const [ref, sha] of repo.refs) refs.push({ ref, object: { sha, type: 'commit' } });
          sendJson(res, 200, refs);
          return true;
        }
        const sha = ctx.store.refOf(repo, wanted);
        if (sha === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        sendJson(res, 200, { ref: wanted, object: { sha, type: 'commit' } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // Contents.
    if (rest[0] === 'contents') {
      const contentPath = rest.slice(1).join('/');
      const branch = str(json, 'branch') ?? url.searchParams.get('ref') ?? repo.defaultBranch;
      const tip = ctx.store.branchTip(repo, branch);
      if (method === 'GET') {
        const files = tip === undefined ? new Map() : ctx.store.filesOfCommit(repo, tip);
        if (contentPath === '') {
          // Root listing.
          const entries: Record<string, unknown>[] = [];
          const seen = new Set<string>();
          for (const path of [...files.keys()].sort()) {
            const top = path.split('/')[0] as string;
            if (seen.has(top)) continue;
            seen.add(top);
            const isDir = [...files.keys()].some((other) => other.startsWith(`${top}/`));
            if (isDir) {
              entries.push({ type: 'dir', name: top, path: top, sha: '' });
            } else {
              const file = files.get(top) as { mode: string; oid: string };
              const data = ctx.store.getObject(repo, file.oid)?.data;
              entries.push({ type: 'file', name: top, path: top, sha: file.oid, size: data?.length ?? 0 });
            }
          }
          sendJson(res, 200, entries);
          return true;
        }
        const file = files.get(contentPath);
        if (file !== undefined) {
          const data = ctx.store.getObject(repo, file.oid)?.data ?? Buffer.alloc(0);
          sendJson(res, 200, {
            type: 'file',
            encoding: 'base64',
            size: data.length,
            name: contentPath.split('/').pop(),
            path: contentPath,
            content: data.toString('base64'),
            sha: file.oid,
          });
          return true;
        }
        // A directory: entries directly under it.
        const dirEntries: Record<string, unknown>[] = [];
        const prefix = `${contentPath}/`;
        const seen = new Set<string>();
        for (const path of [...files.keys()].sort()) {
          if (!path.startsWith(prefix)) continue;
          const restPath = path.slice(prefix.length);
          const top = restPath.split('/')[0] as string;
          if (seen.has(top)) continue;
          seen.add(top);
          const isDir = restPath.includes('/');
          if (isDir) {
            dirEntries.push({ type: 'dir', name: top, path: `${contentPath}/${top}`, sha: '' });
          } else {
            const entry = files.get(path) as { mode: string; oid: string };
            const data = ctx.store.getObject(repo, entry.oid)?.data;
            dirEntries.push({ type: 'file', name: top, path, sha: entry.oid, size: data?.length ?? 0 });
          }
        }
        if (dirEntries.length > 0) {
          sendJson(res, 200, dirEntries);
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (method === 'PUT' || method === 'DELETE') {
        const message = str(json, 'message') ?? (method === 'PUT' ? `Update ${contentPath}` : `Delete ${contentPath}`);
        const files = tip === undefined ? new Map() : ctx.store.filesOfCommit(repo, tip);
        if (method === 'PUT') {
          const content = str(json, 'content');
          if (content === undefined) {
            sendError(res, 422, 'Validation Failed: content is required');
            return true;
          }
          const data = decodeBase64(content);
          if (data === null) {
            sendError(res, 422, 'Validation Failed: content is not valid base64');
            return true;
          }
          const existing = files.get(contentPath);
          const sha = str(json, 'sha');
          if (existing !== undefined) {
            if (sha === undefined || sha !== existing.oid) {
              sendError(res, 409, 'Conflict: sha does not match the current file');
              return true;
            }
          }
          const blobOid = ctx.store.putObject(repo, 'blob', data);
          files.set(contentPath, { mode: '100644', oid: blobOid });
          const treeOid = ctx.store.buildTreeFromFlat(repo, files);
          const parents = tip === undefined ? [] : [tip];
          const commitOid = ctx.store.createCommit(repo, branch, treeOid, message, parents);
          sendJson(res, existing === undefined ? 201 : 200, {
            content: {
              type: 'file',
              encoding: 'base64',
              size: data.length,
              name: contentPath.split('/').pop(),
              path: contentPath,
              content: data.toString('base64'),
              sha: blobOid,
            },
            commit: { sha: commitOid, message },
          });
          return true;
        }
        // DELETE
        const existing = files.get(contentPath);
        if (existing === undefined) {
          sendError(res, 404, 'Not Found');
          return true;
        }
        const sha = str(json, 'sha');
        if (sha !== undefined && sha !== existing.oid) {
          sendError(res, 409, 'Conflict: sha does not match the current file');
          return true;
        }
        files.delete(contentPath);
        const treeOid = ctx.store.buildTreeFromFlat(repo, files);
        const parents = tip === undefined ? [] : [tip];
        const commitOid = ctx.store.createCommit(repo, branch, treeOid, message, parents);
        sendJson(res, 200, { commit: { sha: commitOid, message } });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // Labels.
    if (rest[0] === 'labels') {
      if (method === 'GET' && rest.length === 1) {
        sendJson(res, 200, [...repo.labels.values()].map((label) => ({ name: label.name, color: label.color, description: label.description })));
        return true;
      }
      if (method === 'POST' && rest.length === 1) {
        const name = str(json, 'name');
        if (name === undefined || name === '') {
          sendError(res, 422, 'Validation Failed: name is required');
          return true;
        }
        if (repo.labels.has(name)) {
          sendError(res, 422, 'Validation Failed: label already exists');
          return true;
        }
        const label = { name, color: str(json, 'color') ?? '000000', description: str(json, 'description') ?? '' };
        repo.labels.set(name, label);
        sendJson(res, 201, label);
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // Issues.
    if (rest[0] === 'issues') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const page = pageOf(url);
          const issues = listIssues(repo, url);
          const link = linkHeader(req, path, page, issues.length);
          const headers: Record<string, string> = {};
          if (link !== null) headers.link = link;
          sendJson(res, 200, pageSlice(issues, page), headers);
          return true;
        }
        if (method === 'POST') {
          const title = str(json, 'title');
          if (title === undefined || title === '') {
            sendError(res, 422, 'Validation Failed: title is required');
            return true;
          }
          const labels = strArray(json, 'labels') ?? [];
          for (const label of labels) {
            if (!repo.labels.has(label)) {
              sendError(res, 422, `Validation Failed: label "${label}" does not exist`);
              return true;
            }
          }
          const issue = ctx.store.createIssue(repo, title, str(json, 'body') ?? '', labels);
          sendJson(res, 201, issueJson(repo, issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      const number = Number(rest[1]);
      if (!Number.isSafeInteger(number) || number <= 0) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const issue = repo.issues.find((entry) => entry.number === number);
      if (issue === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        if (method === 'PATCH') {
          const state = str(json, 'state');
          if (state === 'open' || state === 'closed') issue.state = state;
          else if (state !== undefined) {
            sendError(res, 422, 'Validation Failed: state must be open or closed');
            return true;
          }
          const title = str(json, 'title');
          if (title !== undefined) issue.title = title;
          const bodyText = str(json, 'body');
          if (bodyText !== undefined) issue.body = bodyText;
          issue.updatedAt = isoNow();
          sendJson(res, 200, issueJson(repo, issue));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'comments') {
        if (method === 'GET') {
          sendJson(res, 200, issue.comments.map((comment) => commentJson(repo, issue, comment)));
          return true;
        }
        if (method === 'POST') {
          const bodyText = str(json, 'body');
          if (bodyText === undefined) {
            sendError(res, 422, 'Validation Failed: body is required');
            return true;
          }
          const now = isoNow();
          const created: Comment = { id: nextId(), body: bodyText, createdAt: now, updatedAt: now };
          issue.comments.push(created);
          sendJson(res, 201, commentJson(repo, issue, created));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    // Pull requests.
    if (rest[0] === 'pulls') {
      if (rest.length === 1) {
        if (method === 'GET') {
          const page = pageOf(url);
          const pulls = listPulls(repo, url);
          const link = linkHeader(req, path, page, pulls.length);
          const headers: Record<string, string> = {};
          if (link !== null) headers.link = link;
          sendJson(res, 200, pageSlice(pulls, page), headers);
          return true;
        }
        if (method === 'POST') {
          const title = str(json, 'title');
          const head = str(json, 'head');
          const base = str(json, 'base');
          if (title === undefined || head === undefined || base === undefined) {
            sendError(res, 422, 'Validation Failed: title, head and base are required');
            return true;
          }
          const headBranch = head.includes(':') ? (head.split(':').pop() as string) : head;
          const baseBranch = base.includes(':') ? (base.split(':').pop() as string) : base;
          const pull = ctx.store.createPull(repo, title, str(json, 'body') ?? '', headBranch, baseBranch);
          if (pull === null) {
            sendError(res, 422, 'Validation Failed: head or base branch does not exist');
            return true;
          }
          sendJson(res, 201, pullJson(repo, pull));
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      const number = Number(rest[1]);
      if (!Number.isSafeInteger(number) || number <= 0) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      const pull = repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) {
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 2) {
        if (method === 'GET') {
          const out = pullJson(repo, pull);
          out.mergeable = pull.merged ? false : ctx.store.mergeable(repo, pull);
          sendJson(res, 200, out);
          return true;
        }
        sendError(res, 404, 'Not Found');
        return true;
      }
      if (rest.length === 3 && rest[2] === 'files' && method === 'GET') {
        const mergeBaseOid = ctx.store.mergeBase(repo, pull.headSha, pull.baseSha);
        const files = ctx.store.diffCommits(repo, mergeBaseOid ?? pull.baseSha, pull.headSha);
        sendJson(res, 200, files);
        return true;
      }
      if (rest.length === 3 && rest[2] === 'merge' && method === 'PUT') {
        const mergeMethod = str(json, 'merge_method');
        if (mergeMethod !== undefined && mergeMethod !== 'squash') {
          sendError(res, 405, `Merge method ${mergeMethod} is not supported`);
          return true;
        }
        if (pull.merged) {
          sendError(res, 405, 'Pull request has already been merged');
          return true;
        }
        if (pull.state === 'closed') {
          sendError(res, 405, 'Pull request is closed');
          return true;
        }
        const sha = ctx.store.squashMerge(repo, pull);
        if (sha === null) {
          sendError(res, 405, 'Merge conflict');
          return true;
        }
        pull.merged = true;
        pull.state = 'closed';
        pull.mergeCommitSha = sha;
        pull.mergedAt = isoNow();
        pull.updatedAt = pull.mergedAt;
        sendJson(res, 200, { sha, merged: true, message: 'Pull request successfully merged' });
        return true;
      }
      sendError(res, 404, 'Not Found');
      return true;
    }

    sendError(res, 404, 'Not Found');
    return true;
  }

  sendError(res, 404, 'Not Found');
  return true;
}
