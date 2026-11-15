import { randomUUID } from 'node:crypto';
import { httpError, log, on, openDb, readJson, send, start } from './core.ts';

const db = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS books (
    id               TEXT PRIMARY KEY,
    title            TEXT NOT NULL,
    author           TEXT NOT NULL,
    copies_total     INTEGER NOT NULL CHECK (copies_total >= 0),
    copies_available INTEGER NOT NULL CHECK (copies_available >= 0 AND copies_available <= copies_total)
  )
`);

on('POST', '/books', async (req, res) => {
  const b = await readJson(req);
  const title = String(b.title ?? '').trim();
  const author = String(b.author ?? '').trim();
  const total = Number(b.copies_total ?? -1);
  if (!title || !author || !Number.isInteger(total) || total < 0) {
    throw httpError(400, 'title, author and non-negative integer copies_total are required');
  }
  const book = { id: randomUUID(), title, author, copies_total: total, copies_available: total };
  db.prepare('INSERT INTO books (id, title, author, copies_total, copies_available) VALUES (?, ?, ?, ?, ?)')
    .run(book.id, book.title, book.author, book.copies_total, book.copies_available);
  log(`book created ${book.id}`);
  send(res, 201, book);
});

on('GET', '/books', (_req, res) => send(res, 200, db.prepare('SELECT * FROM books').all()));

on('GET', '/books/:id', (_req, res, p) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(p.id) as any;
  if (!book) throw httpError(404, 'book not found');
  send(res, 200, book);
});

on('PATCH', '/books/:id', async (req, res, p) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(p.id) as any;
  if (!book) throw httpError(404, 'book not found');
  const b = await readJson(req);
  const title = b.title === undefined ? book.title : String(b.title).trim();
  const author = b.author === undefined ? book.author : String(b.author).trim();
  if (!title || !author) throw httpError(400, 'title and author must not be empty');
  db.prepare('UPDATE books SET title = ?, author = ? WHERE id = ?').run(title, author, p.id);
  send(res, 200, db.prepare('SELECT * FROM books WHERE id = ?').get(p.id));
});

on('DELETE', '/books/:id', (_req, res, p) => {
  const book = db.prepare('SELECT * FROM books WHERE id = ?').get(p.id) as any;
  if (!book) throw httpError(404, 'book not found');
  if (book.copies_available < book.copies_total) throw httpError(409, 'book has active loans');
  db.prepare('DELETE FROM books WHERE id = ?').run(p.id);
  send(res, 200, { deleted: p.id });
});

on('POST', '/books/:id/reserve', (_req, res, p) => {
  const r = db.prepare('UPDATE books SET copies_available = copies_available - 1 WHERE id = ? AND copies_available > 0').run(p.id);
  if (r.changes === 0) {
    const exists = db.prepare('SELECT id FROM books WHERE id = ?').get(p.id);
    throw httpError(exists ? 409 : 404, exists ? 'no copies available' : 'book not found');
  }
  log(`reserved ${p.id}`);
  send(res, 200, db.prepare('SELECT * FROM books WHERE id = ?').get(p.id));
});

on('POST', '/books/:id/release', (_req, res, p) => {
  const r = db.prepare('UPDATE books SET copies_available = copies_available + 1 WHERE id = ? AND copies_available < copies_total').run(p.id);
  if (r.changes === 0) {
    const exists = db.prepare('SELECT id FROM books WHERE id = ?').get(p.id);
    throw httpError(exists ? 409 : 404, exists ? 'all copies already returned' : 'book not found');
  }
  log(`released ${p.id}`);
  send(res, 200, db.prepare('SELECT * FROM books WHERE id = ?').get(p.id));
});

start(db);