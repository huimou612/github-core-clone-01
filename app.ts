// The server: routing for the health probe, git smart HTTP, REST v3,
// GraphQL v4 and MCP. main.ts owns the lifecycle; this file owns the surface.
//
// A request's body is read once here (binary for the git endpoints, JSON for
// the API surfaces) and handed to the module that answers it. Nothing here
// throws out of a request: a bad body is a 400, an unknown route a JSON 404.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './lib/store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './lib/gitproto.ts';
import { handleRest, type RestContext } from './lib/rest.ts';
import { handleGraphQL } from './lib/graphql.ts';
import { handleMcp } from './lib/mcp.ts';

const JSON_TYPE = 'application/json; charset=utf-8';
/** The largest request body accepted (packs in the suite are far smaller). */
const MAX_BODY_BYTES = 64 * 1024 * 1024;

/** Answer one request with a JSON body. */
function sendJson(res: ServerResponse, status: number, body: unknown): void {
  const text = `${JSON.stringify(body)}\n`;
  res.writeHead(status, { 'content-type': JSON_TYPE, 'content-length': Buffer.byteLength(text) });
  res.end(text);
}

/** The path of a request URL, or '/' when it does not parse (never a throw from a request). */
function pathOf(req: IncomingMessage): string {
  try {
    return new URL(req.url ?? '/', 'http://entry').pathname;
  } catch {
    return '/';
  }
}

function urlOf(req: IncomingMessage): URL {
  try {
    return new URL(req.url ?? '/', 'http://entry');
  } catch {
    return new URL('/', 'http://entry');
  }
}

/** Read the request body, bounded. Rejects when it exceeds MAX_BODY_BYTES. */
function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on('data', (chunk: Buffer) => {
      total += chunk.length;
      if (total > MAX_BODY_BYTES) {
        reject(new Error('request body too large'));
        req.destroy();
        return;
      }
      chunks.push(chunk);
    });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

/** Parse a JSON body, or null when it is empty or malformed. */
function parseJson(raw: Buffer): unknown | null {
  if (raw.length === 0) return null;
  try {
    return JSON.parse(raw.toString('utf8')) as unknown;
  } catch {
    return null;
  }
}

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  const ctx: RestContext = {
    store,
    token: process.env.MAKEFUN_SHOP_TOKEN ?? '',
  };
  const server = createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const path = pathOf(req);
        const method = req.method ?? 'GET';

        // The env's boot check calls this twice: 200 {"ok":true}.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/...
        const gitMatch = path.match(/^\/([^/]+)\/([^/]+)\.git\/(.+)$/);
        if (gitMatch !== null) {
          const owner = decodeURIComponent(gitMatch[1] as string);
          const repoName = decodeURIComponent(gitMatch[2] as string);
          const tail = gitMatch[3] as string;
          const repo = store.getRepo(owner, repoName);
          if (tail === 'info/refs' && method === 'GET') {
            handleInfoRefs(store, repo, req, res);
            return;
          }
          if (tail === 'git-upload-pack' && method === 'POST') {
            const raw = await readBody(req);
            handleUploadPack(store, repo, req, res, raw);
            return;
          }
          if (tail === 'git-receive-pack' && method === 'POST') {
            const raw = await readBody(req);
            handleReceivePack(store, repo, req, res, raw);
            return;
          }
          sendJson(res, 404, { message: 'Not Found' });
          return;
        }

        // GraphQL v4.
        if (method === 'POST' && (path === '/api/graphql' || path === '/api/graphql/')) {
          const raw = await readBody(req);
          handleGraphQL(ctx, req, res, parseJson(raw));
          return;
        }

        // MCP over streamable HTTP.
        if (method === 'POST' && (path === '/mcp' || path === '/mcp/')) {
          const raw = await readBody(req);
          handleMcp(ctx, req, res, raw, parseJson(raw));
          return;
        }

        // REST v3.
        if (path === '/api/v3' || path.startsWith('/api/v3/')) {
          const url = urlOf(req);
          const raw = method === 'GET' || method === 'HEAD' ? Buffer.alloc(0) : await readBody(req);
          const json = raw.length === 0 ? {} : parseJson(raw);
          const body = json !== null && typeof json === 'object' && !Array.isArray(json)
            ? (json as Record<string, unknown>)
            : null;
          handleRest(ctx, req, res, url, body, raw);
          return;
        }

        // Everything else, every method: GitHub's 404 body.
        sendJson(res, 404, { message: 'Not Found' });
      } catch (err) {
        if (!res.headersSent) {
          sendJson(res, 500, { message: err instanceof Error ? err.message : 'Internal Server Error' });
        } else {
          res.destroy();
        }
      }
    })();
  });
  server.keepAliveTimeout = 30_000;
  server.headersTimeout = 60_000;
  return server;
}
