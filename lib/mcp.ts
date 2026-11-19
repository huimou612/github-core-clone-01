// Model Context Protocol over streamable HTTP: the modern `server/discover`
// handshake (revision 2026-07-28), the legacy `initialize` fallback, and the
// six tools the suite drives. Tool results carry both `content` text (JSON)
// and `structuredContent`, and act on the same store as REST.

import type { IncomingMessage, ServerResponse } from 'node:http';
import { VIEWER, isoNow } from './util.ts';
import {
  Store,
  issueJson,
  pullJson,
  repoJson,
} from './store.ts';
import { authorized, type RestContext } from './rest.ts';

const SERVER_NAME = 'github-core-clone';
const SERVER_VERSION = '1.0.0';
const SUPPORTED_VERSIONS = ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26'];

interface McpTool {
  name: string;
  description: string;
  inputSchema: {
    type: 'object';
    properties: Record<string, Record<string, unknown>>;
    required?: string[];
  };
}

const TOOLS: McpTool[] = [
  {
    name: 'create_repo',
    description: 'Create a repository owned by the viewer.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The repository name.' },
        description: { type: 'string', description: 'A short description of the repository.' },
        private: { type: 'boolean', description: 'Whether the repository is private.' },
        owner: { type: 'string', description: 'The owner login (defaults to the viewer).' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
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
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The issue title.' },
        body: { type: 'string', description: 'The issue body.' },
      },
      required: ['owner', 'repo', 'title'],
    },
  },
  {
    name: 'list_issues',
    description: 'List issues in a repository.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        state: { type: 'string', description: 'open, closed or all (default open).' },
      },
      required: ['owner', 'repo'],
    },
  },
  {
    name: 'create_pull_request',
    description: 'Create a pull request from one branch into another.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        title: { type: 'string', description: 'The pull request title.' },
        body: { type: 'string', description: 'The pull request body.' },
        head: { type: 'string', description: 'The head branch name.' },
        base: { type: 'string', description: 'The base branch name.' },
      },
      required: ['owner', 'repo', 'title', 'head', 'base'],
    },
  },
  {
    name: 'merge_pull_request',
    description: 'Squash-merge a pull request into its base branch.',
    inputSchema: {
      type: 'object',
      properties: {
        owner: { type: 'string', description: 'The repository owner login.' },
        repo: { type: 'string', description: 'The repository name.' },
        full_name: { type: 'string', description: 'The owner/repo full name.' },
        pull_number: { type: 'integer', description: 'The pull request number.' },
      },
      required: ['owner', 'repo', 'pull_number'],
    },
  },
];

/** The tools list, frozen once so two tools/list calls answer byte for byte. */
const TOOLS_JSON = JSON.stringify({ tools: TOOLS });

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

function rpcResult(id: unknown, result: unknown): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, result };
}

function rpcError(id: unknown, code: number, message: string): Record<string, unknown> {
  return { jsonrpc: '2.0', id: id ?? null, error: { code, message } };
}

/** A tool result: JSON text plus the same value as structured content. */
function toolResult(value: unknown): Record<string, unknown> {
  return {
    content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value) }],
    structuredContent: value,
  };
}

function toolError(message: string): Record<string, unknown> {
  return { content: [{ type: 'text', text: message }], isError: true };
}

/** The first present, non-null argument among the given names (synonyms included). */
function pick(args: Record<string, unknown>, ...names: string[]): unknown {
  for (const name of names) {
    const value = args[name];
    if (value !== undefined && value !== null) return value;
  }
  return undefined;
}

function pickStr(args: Record<string, unknown>, ...names: string[]): string | undefined {
  const value = pick(args, ...names);
  return typeof value === 'string' && value !== '' ? value : undefined;
}

/** Resolve owner/repo from the arguments (full_name, or owner + repo synonyms). */
function repoOf(args: Record<string, unknown>): { owner: string; repo: string } | null {
  const fullName = pickStr(args, 'full_name', 'fullName');
  if (fullName !== undefined) {
    const slash = fullName.indexOf('/');
    if (slash > 0) return { owner: fullName.slice(0, slash), repo: fullName.slice(slash + 1) };
  }
  const owner = pickStr(args, 'owner', 'owner_login', 'login');
  const repo = pickStr(args, 'repo', 'repository', 'repo_name');
  if (owner === undefined || repo === undefined) return null;
  return { owner, repo };
}

/** The canonical tool name: a server prefix is stripped, matching is case-insensitive. */
function canonicalToolName(name: string): string {
  const lower = name.toLowerCase();
  const idx = lower.lastIndexOf('__');
  return idx >= 0 ? lower.slice(idx + 2) : lower;
}

function callTool(store: Store, name: string, args: Record<string, unknown>): Record<string, unknown> {
  switch (canonicalToolName(name)) {
    case 'create_repo': {
      const repoName = pickStr(args, 'name', 'repo', 'repository');
      if (repoName === undefined) return toolError('Missing required argument: name');
      const owner = pickStr(args, 'owner', 'owner_login', 'login') ?? VIEWER.login;
      const created = store.createRepo(owner, repoName, pickStr(args, 'description') ?? '', pick(args, 'private') === true);
      if (created === null) return toolError(`Repository ${owner}/${repoName} already exists`);
      return toolResult(repoJson(created));
    }
    case 'get_repo': {
      const target = repoOf(args);
      if (target === null) return toolError('Missing required arguments: owner and repo');
      if (target.owner !== VIEWER.login) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      return toolResult(repoJson(repo));
    }
    case 'create_issue': {
      const target = repoOf(args);
      if (target === null) return toolError('Missing required arguments: owner and repo');
      const title = pickStr(args, 'title');
      if (title === undefined) return toolError('Missing required argument: title');
      if (target.owner !== VIEWER.login) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const issue = store.createIssue(repo, title, pickStr(args, 'body') ?? '', []);
      return toolResult(issueJson(repo, issue));
    }
    case 'list_issues': {
      const target = repoOf(args);
      if (target === null) return toolError('Missing required arguments: owner and repo');
      if (target.owner !== VIEWER.login) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const state = pickStr(args, 'state') ?? 'open';
      const issues = repo.issues
        .filter((issue) => state === 'all' || issue.state === state)
        .sort((a, b) => b.seq - a.seq)
        .map((issue) => issueJson(repo, issue));
      return toolResult(issues);
    }
    case 'create_pull_request': {
      const target = repoOf(args);
      if (target === null) return toolError('Missing required arguments: owner and repo');
      const title = pickStr(args, 'title');
      const head = pickStr(args, 'head', 'head_branch', 'head_ref');
      const base = pickStr(args, 'base', 'base_branch', 'base_ref');
      if (title === undefined) return toolError('Missing required argument: title');
      if (head === undefined) return toolError('Missing required argument: head');
      if (base === undefined) return toolError('Missing required argument: base');
      if (target.owner !== VIEWER.login) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const pull = store.createPull(repo, title, pickStr(args, 'body') ?? '', head, base);
      if (pull === null) return toolError('Head or base branch does not exist');
      return toolResult(pullJson(repo, pull));
    }
    case 'merge_pull_request': {
      const target = repoOf(args);
      if (target === null) return toolError('Missing required arguments: owner and repo');
      const pullNumber = pick(args, 'pull_number', 'number', 'pullNumber');
      if (typeof pullNumber !== 'number' || !Number.isSafeInteger(pullNumber)) {
        return toolError('Missing required argument: pull_number');
      }
      if (target.owner !== VIEWER.login) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const repo = store.getRepo(target.owner, target.repo);
      if (repo === undefined) return toolError(`Repository ${target.owner}/${target.repo} not found`);
      const pull = repo.pulls.find((entry) => entry.number === pullNumber);
      if (pull === undefined) return toolError(`Pull request #${pullNumber} not found`);
      if (pull.merged) {
        return toolResult({ sha: pull.mergeCommitSha, merged: true, number: pull.number, state: 'closed' });
      }
      const sha = store.squashMerge(repo, pull);
      if (sha === null) return toolError('Merge conflict: the pull request cannot be merged cleanly');
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = sha;
      pull.mergedAt = isoNow();
      pull.updatedAt = pull.mergedAt;
      return toolResult({ sha, merged: true, number: pull.number, state: 'closed' });
    }
    default: {
      return toolError(`Unknown tool: ${name}`);
    }
  }
}

/** POST /mcp: one JSON-RPC 2.0 request per call. */
export function handleMcp(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  rawBody: Buffer,
  body: unknown | null,
): void {
  // Authentication is decided before any tool exists: no token answers 401.
  if (!authorized(ctx, req)) {
    sendJson(res, 401, { jsonrpc: '2.0', id: null, error: { code: -32000, message: 'Unauthorized' } });
    return;
  }
  // A non-JSON body is a parse error: HTTP 400 on the modern revision,
  // HTTP 200 for a pre-2026-07-28 protocol version.
  if (body === null && rawBody.length > 0) {
    const version = req.headers['mcp-protocol-version'] ?? '';
    const status = typeof version === 'string' && version !== '' && version < '2026-07-28' ? 200 : 400;
    sendJson(res, status, rpcError(null, -32700, 'Parse error: the request body is not valid JSON'));
    return;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, rpcError(null, -32600, 'Invalid Request: the body must be a JSON-RPC object'));
    return;
  }
  const record = body as Record<string, unknown>;
  const method = typeof record.method === 'string' ? record.method : '';
  const id = record.id === undefined ? undefined : record.id;
  const hasId = id !== undefined && id !== null;
  const params = typeof record.params === 'object' && record.params !== null && !Array.isArray(record.params)
    ? (record.params as Record<string, unknown>)
    : {};

  // Notifications carry no id and get no body back.
  if (!hasId) {
    res.writeHead(202, { 'content-length': 0 });
    res.end();
    return;
  }

  if (method === 'server/discover') {
    const serverInfo = { name: SERVER_NAME, version: SERVER_VERSION };
    sendJson(res, 200, rpcResult(id, {
      serverInfo,
      capabilities: { tools: {} },
      supportedVersions: [...SUPPORTED_VERSIONS],
      _meta: { 'io.modelcontextprotocol/serverInfo': serverInfo },
    }));
    return;
  }
  if (method === 'initialize') {
    sendJson(res, 200, rpcResult(id, {
      protocolVersion: '2025-11-25',
      capabilities: { tools: {} },
      serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
    }));
    return;
  }
  if (method === 'ping') {
    sendJson(res, 200, rpcResult(id, {}));
    return;
  }
  if (method === 'tools/list') {
    // The list itself is a frozen constant: byte-identical across calls.
    const text = `{"jsonrpc":"2.0","id":${JSON.stringify(id)},"result":${TOOLS_JSON}}\n`;
    res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
    res.end(text);
    return;
  }
  if (method === 'tools/call') {
    const name = typeof params.name === 'string' ? params.name : '';
    const args = typeof params.arguments === 'object' && params.arguments !== null && !Array.isArray(params.arguments)
      ? (params.arguments as Record<string, unknown>)
      : {};
    const known = TOOLS.some((tool) => canonicalToolName(tool.name) === canonicalToolName(name));
    if (!known) {
      sendJson(res, 200, rpcError(id, -32601, `Method not found: ${name}`));
      return;
    }
    const result = callTool(ctx.store, name, args);
    sendJson(res, 200, rpcResult(id, result));
    return;
  }
  sendJson(res, 200, rpcError(id, -32601, `Method not found: ${method}`));
}
