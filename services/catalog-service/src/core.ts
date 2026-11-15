import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { DatabaseSync } from 'node:sqlite';

export const SERVICE = process.env.SERVICE_NAME ?? 'service';

export type Params = Record<string, string>;
export type Handler = (req: IncomingMessage, res: ServerResponse, p: Params) => Promise<void> | void;

const routes: { method: string; path: string; handler: Handler }[] = [];
const delay = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function on(method: string, path: string, handler: Handler): void {
  routes.push({ method, path, handler });
}

export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), `[${SERVICE}]`, ...args);
}

export function httpError(status: number, message: string): Error {
  return Object.assign(new Error(message), { status });
}

export function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

export function openDb(): DatabaseSync {
  const db = new DatabaseSync(process.env.DB_PATH ?? `${SERVICE}.db`);
  db.exec('PRAGMA journal_mode = WAL');
  db.exec('PRAGMA busy_timeout = 3000');
  return db;
}

export async function readJson(req: IncomingMessage): Promise<any> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > 1_000_000) throw httpError(413, 'payload too large');
    chunks.push(chunk as Buffer);
  }
  if (chunks.length === 0) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw httpError(400, 'invalid JSON');
  }
}

function matchPath(routePath: string, urlPath: string): Params | null {
  const r = routePath.split('/').filter(Boolean);
  const u = urlPath.split('/').filter(Boolean);
  if (r.length !== u.length) return null;
  const params: Params = {};
  for (let i = 0; i < r.length; i++) {
    if (r[i].startsWith(':')) params[r[i].slice(1)] = decodeURIComponent(u[i]);
    else if (r[i] !== u[i]) return null;
  }
  return params;
}

// Единственная точка сетевого взаимодействия: таймаут плюс ретраи с экспоненциальной задержкой.
// Бросает исключение только на транспортных ошибках; HTTP-ответ любого кода возвращается как есть.
export async function callJson(
  method: string,
  url: string,
  body?: unknown,
  opts: { retries?: number; timeoutMs?: number } = {},
): Promise<{ status: number; body: any }> {
  const retries = opts.retries ?? 0;
  let lastError: unknown;

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetch(url, {
        method,
        headers: { 'content-type': 'application/json' },
        body: body === undefined ? undefined : JSON.stringify(body),
        signal: AbortSignal.timeout(opts.timeoutMs ?? 2000),
      });
      const text = await res.text();
      let parsed: any = null;
      try { parsed = text ? JSON.parse(text) : null; } catch { /* не-JSON ответ */ }

      if (res.status >= 500 && attempt < retries) {
        log(`retry ${attempt + 1} after ${res.status}: ${method} ${url}`);
        await delay(200 * 2 ** attempt);
        continue;
      }
      return { status: res.status, body: parsed };
    } catch (err) {
      lastError = err;
      log(`attempt ${attempt + 1} failed: ${method} ${url}`);
      if (attempt < retries) await delay(200 * 2 ** attempt);
    }
  }
  throw lastError;
}

export function start(db?: DatabaseSync): void {
  const port = Number(process.env.PORT ?? 5000);
  on('GET', '/health', (_req, res) => send(res, 200, { service: SERVICE, status: 'ok' }));

  const server = createServer(async (req, res) => {
    const started = Date.now();
    const url = new URL(req.url ?? '/', 'http://localhost');
    try {
      for (const route of routes) {
        if (route.method !== req.method) continue;
        const params = matchPath(route.path, url.pathname);
        if (!params) continue;
        await route.handler(req, res, params);
        log(`${req.method} ${url.pathname} ${res.statusCode} ${Date.now() - started}ms`);
        return;
      }
      send(res, 404, { error: 'not found' });
    } catch (err: any) {
      const status = err?.status ?? 500;
      if (status >= 500) log('internal error:', err);
      send(res, status, { error: err?.message ?? 'internal error' });
    }
  });

  server.listen(port, () => log(`listening on ${port}`));
  const shutdown = () => server.close(() => { db?.close(); process.exit(0); });
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
}