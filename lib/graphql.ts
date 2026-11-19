// GitHub GraphQL v4: the eighteen documents gh and github-mcp-server send,
// dispatched on the operation name parsed from the query text. Unknown fields
// answer HTTP 200 with an `errors` array; an unknown repository answers
// `data.repository = null` with no errors; no token answers exactly 401.

import type { IncomingMessage, ServerResponse } from 'node:http';
import {
  VIEWER,
  decodeCursor,
  encodeCursor,
  globalId,
  isoNow,
  nextId,
  parseGlobalId,
} from './util.ts';
import {
  Store,
  type Issue,
  type Pull,
  type Repo,
} from './store.ts';
import { authorized, type RestContext } from './rest.ts';

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

type Variables = Record<string, unknown>;

function varStr(variables: Variables, key: string): string | undefined {
  const value = variables[key];
  return typeof value === 'string' ? value : undefined;
}

function varInt(variables: Variables, key: string): number | undefined {
  const value = variables[key];
  return typeof value === 'number' && Number.isSafeInteger(value) ? value : undefined;
}

function inputOf(variables: Variables): Variables {
  const input = variables.input;
  return typeof input === 'object' && input !== null && !Array.isArray(input) ? (input as Variables) : {};
}

// ---------------------------------------------------------------- schema surface

const ISSUE_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'createdAt', 'updatedAt', 'url', 'author', 'labels', 'comments', 'closedAt', 'repository'];
const PULL_REQUEST_FIELDS = ['id', 'databaseId', 'number', 'title', 'body', 'state', 'merged', 'mergeable', 'headRefName', 'baseRefName', 'headRefOid', 'baseRefOid', 'files', 'createdAt', 'updatedAt', 'closedAt', 'mergedAt', 'author', 'repository'];
const REPOSITORY_FIELDS = ['id', 'databaseId', 'name', 'nameWithOwner', 'owner', 'defaultBranchRef', 'viewerPermission', 'hasIssuesEnabled', 'description', 'issue', 'issues', 'pullRequests', 'pullRequest', 'createdAt', 'updatedAt', 'url'];
const SEARCH_TYPE_VALUES = ['ISSUE', 'REPOSITORY', 'USER', 'DISCUSSION', 'COMMIT', 'CODE', 'TOPIC', 'PACKAGE', 'MARKETPLACE'];

// ---------------------------------------------------------------- object shapes

function repositoryJson(repo: Repo): Record<string, unknown> {
  return {
    id: globalId('Repository', repo.id),
    databaseId: repo.id,
    name: repo.name,
    nameWithOwner: `${repo.owner}/${repo.name}`,
    owner: { login: repo.owner },
    defaultBranchRef: { name: repo.defaultBranch },
    viewerPermission: 'ADMIN',
    hasIssuesEnabled: true,
    description: repo.description,
    createdAt: repo.createdAt,
    updatedAt: repo.updatedAt,
  };
}

function issueState(issue: Issue): string {
  return issue.state === 'open' ? 'OPEN' : 'CLOSED';
}

function issueJson(issue: Issue): Record<string, unknown> {
  return {
    id: globalId('Issue', issue.id),
    databaseId: issue.id,
    number: issue.number,
    title: issue.title,
    state: issueState(issue),
    body: issue.body,
    createdAt: issue.createdAt,
    updatedAt: issue.updatedAt,
  };
}

function pullState(pull: Pull): string {
  if (pull.merged) return 'MERGED';
  return pull.state === 'open' ? 'OPEN' : 'CLOSED';
}

function pullJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  return {
    id: globalId('PullRequest', pull.id),
    databaseId: pull.id,
    number: pull.number,
    title: pull.title,
    state: pullState(pull),
    merged: pull.merged,
    mergeable: pull.merged ? 'UNKNOWN' : store.mergeable(repo, pull) ? 'MERGEABLE' : 'CONFLICTING',
    headRefName: pull.head,
    baseRefName: pull.base,
    createdAt: pull.createdAt,
    updatedAt: pull.updatedAt,
  };
}

function pullFilesJson(store: Store, repo: Repo, pull: Pull): Record<string, unknown> {
  const mergeBaseOid = store.mergeBase(repo, pull.headSha, pull.baseSha);
  const files = store.diffCommits(repo, mergeBaseOid ?? pull.baseSha, pull.headSha);
  return { nodes: files.map((file) => ({ path: file.filename })) };
}

function resolveRepo(store: Store, variables: Variables): Repo | null {
  const owner = varStr(variables, 'owner');
  const name = varStr(variables, 'name');
  if (owner === undefined || name === undefined) return null;
  if (owner !== VIEWER.login) return null;
  return store.getRepo(owner, name) ?? null;
}

function resolveRepoByGlobalId(store: Store, id: string | undefined): Repo | null {
  if (id === undefined) return null;
  const parsed = parseGlobalId(id);
  if (parsed === null || parsed.kind !== 'Repository') return null;
  return store.getRepoById(parsed.id) ?? null;
}

// ---------------------------------------------------------------- operations

function execute(store: Store, query: string, variables: Variables): Record<string, unknown> {
  const match = query.match(/(?:query|mutation)\s+(\w+)/);
  const operation = match === null ? '' : (match[1] as string);

  switch (operation) {
    case 'ViewerLogin': {
      return { data: { viewer: { login: VIEWER.login } } };
    }
    case 'RepositoryFields': {
      const repo = resolveRepo(store, variables);
      return { data: { repository: repo === null ? null : repositoryJson(repo) } };
    }
    case 'Issue_fields': {
      return { data: { Issue: { fields: ISSUE_FIELDS.map((name) => ({ name })) } } };
    }
    case 'PullRequestAndRepositoryFields': {
      return {
        data: {
          PullRequest: { fields: PULL_REQUEST_FIELDS.map((name) => ({ name })) },
          Repository: { fields: REPOSITORY_FIELDS.map((name) => ({ name })) },
        },
      };
    }
    case 'SearchType_enumValues': {
      return { data: { SearchType: { enumValues: SEARCH_TYPE_VALUES.map((name) => ({ name })) } } };
    }
    case 'OpenIssues': {
      const repo = resolveRepo(store, variables);
      if (repo === null) return { data: { repository: null } };
      const first = varInt(variables, 'first') ?? 30;
      const open = repo.issues
        .filter((issue) => issue.state === 'open')
        .sort((a, b) => b.seq - a.seq)
        .slice(0, first);
      return { data: { repository: { issues: { nodes: open.map((issue) => issueJson(issue)) } } } };
    }
    case 'IssueByNumber': {
      const repo = resolveRepo(store, variables);
      if (repo === null) return { data: { repository: null } };
      const number = varInt(variables, 'number');
      const issue = number === undefined ? undefined : repo.issues.find((entry) => entry.number === number);
      return { data: { repository: { issue: issue === undefined ? null : issueJson(issue) } } };
    }
    case 'IssueCreate': {
      const input = inputOf(variables);
      const repo = resolveRepoByGlobalId(store, varStr(input, 'repositoryId'));
      if (repo === null) {
        return { data: { createIssue: null }, errors: [{ message: 'Could not resolve to a Repository with the id provided.' }] };
      }
      const title = varStr(input, 'title') ?? '';
      const body = varStr(input, 'body') ?? '';
      const issue = store.createIssue(repo, title, body, []);
      return { data: { createIssue: { issue: { number: issue.number, id: globalId('Issue', issue.id) } } } };
    }
    case 'IssueClose': {
      const input = inputOf(variables);
      const parsed = parseGlobalId(varStr(input, 'issueId') ?? '');
      const found = parsed !== null && parsed.kind === 'Issue' ? store.issueById.get(parsed.id) : undefined;
      if (found === undefined) {
        return { data: { closeIssue: null }, errors: [{ message: 'Could not resolve to an Issue with the id provided.' }] };
      }
      found.issue.state = 'closed';
      found.issue.updatedAt = isoNow();
      return {
        data: {
          closeIssue: {
            issue: { number: found.issue.number, id: globalId('Issue', found.issue.id), state: 'CLOSED' },
          },
        },
      };
    }
    case 'PullRequests': {
      const repo = resolveRepo(store, variables);
      if (repo === null) return { data: { repository: null } };
      const first = varInt(variables, 'first') ?? 30;
      const pulls = [...repo.pulls].sort((a, b) => b.seq - a.seq).slice(0, first);
      return { data: { repository: { pullRequests: { nodes: pulls.map((pull) => pullJson(store, repo, pull)) } } } };
    }
    case 'PullRequestFiles': {
      const repo = resolveRepo(store, variables);
      if (repo === null) return { data: { repository: null } };
      const number = varInt(variables, 'number');
      const pull = number === undefined ? undefined : repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { data: { repository: { pullRequest: null } } };
      return {
        data: {
          repository: {
            pullRequest: { number: pull.number, files: pullFilesJson(store, repo, pull) },
          },
        },
      };
    }
    case 'PullRequestId': {
      const repo = resolveRepo(store, variables);
      if (repo === null) return { data: { repository: null } };
      const number = varInt(variables, 'number');
      const pull = number === undefined ? undefined : repo.pulls.find((entry) => entry.number === number);
      if (pull === undefined) return { data: { repository: { pullRequest: null } } };
      return { data: { repository: { pullRequest: { id: globalId('PullRequest', pull.id), number: pull.number } } } };
    }
    case 'PullRequestCreate': {
      const input = inputOf(variables);
      const repo = resolveRepoByGlobalId(store, varStr(input, 'repositoryId'));
      if (repo === null) {
        return { data: { createPullRequest: null }, errors: [{ message: 'Could not resolve to a Repository with the id provided.' }] };
      }
      const pull = store.createPull(
        repo,
        varStr(input, 'title') ?? '',
        '',
        varStr(input, 'headRefName') ?? '',
        varStr(input, 'baseRefName') ?? '',
      );
      if (pull === null) {
        return { data: { createPullRequest: null }, errors: [{ message: 'Head or base branch does not exist.' }] };
      }
      return {
        data: {
          createPullRequest: {
            pullRequest: {
              number: pull.number,
              id: globalId('PullRequest', pull.id),
              state: 'OPEN',
              headRefName: pull.head,
              baseRefName: pull.base,
            },
          },
        },
      };
    }
    case 'MergePullRequest': {
      const input = inputOf(variables);
      const parsed = parseGlobalId(varStr(input, 'pullRequestId') ?? '');
      const found = parsed !== null && parsed.kind === 'PullRequest' ? store.pullById.get(parsed.id) : undefined;
      if (found === undefined) {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Could not resolve to a PullRequest with the id provided.' }] };
      }
      const { repo, pull } = found;
      if (pull.merged) {
        return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } } } };
      }
      const sha = store.squashMerge(repo, pull);
      if (sha === null) {
        return { data: { mergePullRequest: null }, errors: [{ message: 'Merge conflict: the pull request cannot be merged cleanly.' }] };
      }
      pull.merged = true;
      pull.state = 'closed';
      pull.mergeCommitSha = sha;
      pull.mergedAt = isoNow();
      pull.updatedAt = pull.mergedAt;
      return { data: { mergePullRequest: { pullRequest: { number: pull.number, merged: true, state: 'MERGED' } } } };
    }
    case 'AddComment': {
      const input = inputOf(variables);
      const body = varStr(input, 'body') ?? '';
      const parsed = parseGlobalId(varStr(input, 'subjectId') ?? '');
      const now = isoNow();
      const comment = { id: nextId(), body, createdAt: now, updatedAt: now };
      if (parsed !== null && parsed.kind === 'Issue') {
        const found = store.issueById.get(parsed.id);
        if (found !== undefined) found.issue.comments.push(comment);
      }
      return { data: { addComment: { commentEdge: { node: { id: globalId('IssueComment', comment.id), body } } } } };
    }
    case 'ViewerInvalidField': {
      return {
        data: null,
        errors: [{ message: 'Cannot query field "noSuchFieldOnViewer" on type "User".' }],
      };
    }
    case 'NodeRepository': {
      const id = varStr(variables, 'id') ?? '';
      const parsed = parseGlobalId(id);
      if (parsed === null || parsed.kind !== 'Repository') return { data: { node: null } };
      const repo = store.getRepoById(parsed.id);
      if (repo === undefined) return { data: { node: null } };
      return { data: { node: { id, name: repo.name, nameWithOwner: `${repo.owner}/${repo.name}` } } };
    }
    case 'IssuesPage': {
      const repo = resolveRepo(store, variables);
      if (repo === null) return { data: { repository: null } };
      const first = varInt(variables, 'first') ?? 30;
      const afterRaw = variables.after;
      const after = typeof afterRaw === 'string' ? decodeCursor(afterRaw) : null;
      const sorted = [...repo.issues].sort((a, b) => a.number - b.number);
      const page = after === null ? sorted : sorted.filter((issue) => issue.number > after);
      const nodes = page.slice(0, first);
      const hasNextPage = page.length > first;
      const endCursor = nodes.length === 0 ? null : encodeCursor(nodes[nodes.length - 1]?.number ?? 0);
      return {
        data: {
          repository: {
            issues: {
              nodes: nodes.map((issue) => ({ number: issue.number })),
              pageInfo: { hasNextPage, endCursor },
            },
          },
        },
      };
    }
    default: {
      return { data: null, errors: [{ message: `Unknown operation ${operation === '' ? 'in the document' : operation}.` }] };
    }
  }
}

/** POST /api/graphql. Handles one operation or a JSON array batch. */
export function handleGraphQL(
  ctx: RestContext,
  req: IncomingMessage,
  res: ServerResponse,
  body: unknown,
): void {
  if (!authorized(ctx, req)) {
    sendJson(res, 401, { message: 'Bad credentials' });
    return;
  }
  if (Array.isArray(body)) {
    const results = body.map((entry) => {
      if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
        return { data: null, errors: [{ message: 'Each batch entry must be a JSON object.' }] };
      }
      const record = entry as Record<string, unknown>;
      const query = typeof record.query === 'string' ? record.query : '';
      const variables = typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables)
        ? (record.variables as Variables)
        : {};
      return execute(ctx.store, query, variables);
    });
    sendJson(res, 200, results);
    return;
  }
  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    sendJson(res, 400, { errors: [{ message: 'The request body must be a JSON object.' }] });
    return;
  }
  const record = body as Record<string, unknown>;
  const query = typeof record.query === 'string' ? record.query : '';
  const variables = typeof record.variables === 'object' && record.variables !== null && !Array.isArray(record.variables)
    ? (record.variables as Variables)
    : {};
  sendJson(res, 200, execute(ctx.store, query, variables));
}
