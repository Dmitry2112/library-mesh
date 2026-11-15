import { randomUUID } from 'node:crypto';
import { httpError, log, on, openDb, readJson, send, start } from './core.ts';

const db = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS notifications (
    id         TEXT PRIMARY KEY,
    recipient  TEXT NOT NULL,
    message    TEXT NOT NULL,
    created_at TEXT NOT NULL
  )
`);

on('POST', '/notify', async (req, res) => {
  const b = await readJson(req);
  const to = String(b.to ?? '').trim();
  const message = String(b.message ?? '').trim();
  if (!to || !message) throw httpError(400, 'to and message are required');

  const item = { id: randomUUID(), to, message, created_at: new Date().toISOString() };
  db.prepare('INSERT INTO notifications (id, recipient, message, created_at) VALUES (?, ?, ?, ?)')
    .run(item.id, item.to, item.message, item.created_at);
  log(`EMAIL to=${to}: ${message}`);
  send(res, 201, item);
});

on('GET', '/notifications', (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const recipient = url.searchParams.get('recipient');
  const rows = recipient
    ? db.prepare('SELECT * FROM notifications WHERE recipient = ? ORDER BY created_at DESC').all(recipient)
    : db.prepare('SELECT * FROM notifications ORDER BY created_at DESC').all();
  send(res, 200, rows);
});

start(db);