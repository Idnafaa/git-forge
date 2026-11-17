// The forge's HTTP surface: /healthz, git smart HTTP, REST v3, GraphQL v4, MCP.
// One process, one in-memory store; no disk, no clock, no network of its own.

import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { Store } from './store.ts';
import { handleInfoRefs, handleReceivePack, handleUploadPack } from './git.ts';
import { handleRest } from './rest.ts';
import { handleGraphQL } from './graphql.ts';
import { handleMcp } from './mcp.ts';
import { authed, notFound, readBody, sendJson, unauthorized } from './http-util.ts';

const GIT_ROUTE = /^\/([^/]+)\/([^/]+)\.git\/(info\/refs|git-upload-pack|git-receive-pack)$/;

/** Build the server. It binds nothing until the caller listens; the entry listens on an ephemeral port. */
export function createApp(): Server {
  const store = new Store();
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    void (async () => {
      try {
        const method = req.method ?? 'GET';
        const url = new URL(req.url ?? '/', 'http://entry');
        const path = url.pathname;
        const segments = path.split('/').filter((s) => s.length > 0);

        // The env's boot check calls this twice: 200 {"ok":true}. No auth.
        if (method === 'GET' && path === '/healthz') {
          sendJson(res, 200, { ok: true });
          return;
        }

        // MCP endpoint.
        if (path === '/mcp') {
          const body = await readBody(req);
          handleMcp(store, req, res, body);
          return;
        }

        // GraphQL endpoint.
        if (path === '/api/graphql') {
          const body = await readBody(req);
          handleGraphQL(store, req, res, body);
          return;
        }

        // Git smart HTTP: /{owner}/{repo}.git/info/refs | git-upload-pack | git-receive-pack.
        const git = GIT_ROUTE.exec(path);
        if (git) {
          if (!authed(req)) {
            unauthorized(res);
            return;
          }
          const [, owner, repoName, action] = git;
          const protocol = String(req.headers['git-protocol'] ?? '');
          if (action === 'info/refs') {
            handleInfoRefs(store, res, owner, repoName, url.searchParams.get('service'), protocol);
            return;
          }
          const body = await readBody(req);
          if (action === 'git-upload-pack') handleUploadPack(store, res, owner, repoName, body, protocol);
          else handleReceivePack(store, res, owner, repoName, body);
          return;
        }

        // REST v3.
        if (segments[0] === 'api' && segments[1] === 'v3') {
          const body = await readBody(req);
          handleRest(store, req, res, method, segments, url.searchParams, body);
          return;
        }

        notFound(res);
      } catch (err) {
        // A request must never crash the process; answer 500 if the reply is still open.
        try {
          if (!res.writableEnded) sendJson(res, 500, { message: 'Internal Server Error' });
        } catch {
          // The reply is already gone; nothing more to do.
        }
        void err;
      }
    })();
  });
}
