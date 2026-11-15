import { randomUUID } from 'node:crypto';
import { httpError, log, on, openDb, readJson, send, start } from './core.ts';

const db = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS readers (
    id         TEXT PRIMARY KEY,
    name       TEXT NOT NULL,
    email      TEXT NOT NULL UNIQUE,
    status     TEXT NOT NULL CHECK (status IN ('active','blocked')),
    created_at TEXT NOT NULL
  )
`);

const EMAIL = /^[^@\s]+@[^@\s]+\.[^@\s]+$/;

on('POST', '/readers', async (req, res) => {
  const b = await readJson(req);
  const name = String(b.name ?? '').trim();
  const email = String(b.email ?? '').trim().toLowerCase();
  if (!name || !EMAIL.test(email)) throw httpError(400, 'name and valid email are required');

  const reader = { id: randomUUID(), name, email, status: 'active', created_at: new Date().toISOString() };
  try {
    db.prepare('INSERT INTO readers (id, name, email, status, created_at) VALUES (?, ?, ?, ?, ?)')
      .run(reader.id, reader.name, reader.email, reader.status, reader.created_at);
  } catch (err: any) {
    if (String(err?.message).includes('UNIQUE')) throw httpError(409, 'email already registered');
    throw err;
  }
  log(`reader created ${reader.id}`);
  send(res, 201, reader);
});

on('GET', '/readers', (_req, res) => send(res, 200, db.prepare('SELECT * FROM readers').all()));

on('GET', '/readers/:id', (_req, res, p) => {
  const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(p.id) as any;
  if (!reader) throw httpError(404, 'reader not found');
  send(res, 200, reader);
});

on('PATCH', '/readers/:id', async (req, res, p) => {
  const reader = db.prepare('SELECT * FROM readers WHERE id = ?').get(p.id) as any;
  if (!reader) throw httpError(404, 'reader not found');
  const b = await readJson(req);
  const name = b.name === undefined ? reader.name : String(b.name).trim();
  const status = b.status === undefined ? reader.status : String(b.status);
  if (!name) throw httpError(400, 'name must not be empty');
  if (!['active', 'blocked'].includes(status)) throw httpError(400, 'status must be active or blocked');
  db.prepare('UPDATE readers SET name = ?, status = ? WHERE id = ?').run(name, status, p.id);
  log(`reader ${p.id} status=${status}`);
  send(res, 200, db.prepare('SELECT * FROM readers WHERE id = ?').get(p.id));
});

on('DELETE', '/readers/:id', (_req, res, p) => {
  const r = db.prepare('DELETE FROM readers WHERE id = ?').run(p.id);
  if (r.changes === 0) throw httpError(404, 'reader not found');
  send(res, 200, { deleted: p.id });
});

start(db);