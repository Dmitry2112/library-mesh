import { randomUUID } from 'node:crypto';
import { callJson, httpError, log, on, openDb, readJson, send, start } from './core.ts';

const CATALOG_URL = process.env.CATALOG_URL ?? 'http://localhost:5000';
const READER_URL = process.env.READER_URL ?? 'http://localhost:5003';
const NOTIFICATION_URL = process.env.NOTIFICATION_URL ?? 'http://localhost:5002';
const LOAN_LIMIT = Number(process.env.LOAN_LIMIT ?? 3);
const LOAN_DAYS = Number(process.env.LOAN_DAYS ?? 14);

const db = openDb();
db.exec(`
  CREATE TABLE IF NOT EXISTS loans (
    id          TEXT PRIMARY KEY,
    reader_id   TEXT NOT NULL,
    reader_name TEXT NOT NULL,
    book_id     TEXT NOT NULL,
    book_title  TEXT NOT NULL,
    created_at  TEXT NOT NULL,
    due_at      TEXT NOT NULL,
    returned_at TEXT,
    status      TEXT NOT NULL CHECK (status IN ('active','returned'))
  )
`);
db.exec('CREATE INDEX IF NOT EXISTS idx_loans_reader ON loans (reader_id, status)');

function view(loan: any) {
  return { ...loan, overdue: loan.status === 'active' && Date.parse(loan.due_at) < Date.now() };
}

async function notify(to: string, message: string): Promise<'sent' | 'failed'> {
  try {
    const r = await callJson('POST', `${NOTIFICATION_URL}/notify`, { to, message }, { retries: 2 });
    if (r.status >= 400) { log(`notification rejected: ${r.status}`); return 'failed'; }
    return 'sent';
  } catch (err: any) {
    log(`notification unavailable: ${err?.message}`);
    return 'failed';
  }
}

on('POST', '/loans', async (req, res) => {
  const b = await readJson(req);
  const readerId = String(b.reader_id ?? '').trim();
  const bookId = String(b.book_id ?? '').trim();
  if (!readerId || !bookId) throw httpError(400, 'reader_id and book_id are required');

  const cnt = db.prepare("SELECT COUNT(*) AS n FROM loans WHERE reader_id = ? AND status = 'active'").get(readerId) as any;
  if (cnt.n >= LOAN_LIMIT) throw httpError(409, `loan limit reached (${LOAN_LIMIT})`);
  const dup = db.prepare("SELECT id FROM loans WHERE reader_id = ? AND book_id = ? AND status = 'active'").get(readerId, bookId);
  if (dup) throw httpError(409, 'reader already has this book');

  let reader;
  try {
    reader = await callJson('GET', `${READER_URL}/readers/${encodeURIComponent(readerId)}`);
  } catch (err) {
    log('reader-service unreachable', err);
    throw httpError(503, 'reader-service unavailable');
  }
  if (reader.status === 404) throw httpError(404, 'reader not found');
  if (reader.status !== 200) throw httpError(502, 'unexpected response from reader-service');
  if (reader.body.status !== 'active') throw httpError(403, 'reader is blocked');

  let reserved;
  try {
    reserved = await callJson('POST', `${CATALOG_URL}/books/${encodeURIComponent(bookId)}/reserve`);
  } catch (err) {
    log('catalog-service unreachable', err);
    throw httpError(503, 'catalog-service unavailable');
  }
  if (reserved.status === 404) throw httpError(404, 'book not found');
  if (reserved.status === 409) throw httpError(409, 'no copies available');
  if (reserved.status !== 200) throw httpError(502, 'unexpected response from catalog-service');

  const now = new Date();
  const loan = {
    id: randomUUID(),
    reader_id: readerId,
    reader_name: reader.body.name,
    book_id: bookId,
    book_title: reserved.body.title,
    created_at: now.toISOString(),
    due_at: new Date(now.getTime() + LOAN_DAYS * 86_400_000).toISOString(),
    returned_at: null as string | null,
    status: 'active',
  };
  try {
    db.prepare(`INSERT INTO loans
      (id, reader_id, reader_name, book_id, book_title, created_at, due_at, returned_at, status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(loan.id, loan.reader_id, loan.reader_name, loan.book_id, loan.book_title,
           loan.created_at, loan.due_at, null, loan.status);
  } catch (err) {
    log('CRITICAL local insert failed, compensating reserve', err);
    try {
      await callJson('POST', `${CATALOG_URL}/books/${encodeURIComponent(bookId)}/release`);
    } catch (e) {
      log(`CRITICAL compensation failed for book ${bookId}, manual repair needed`, e);
    }
    throw httpError(500, 'failed to persist loan');
  }

  const notification = await notify(loan.reader_name, `Книга "${loan.book_title}" выдана до ${loan.due_at.slice(0, 10)}`);
  log(`loan ${loan.id} created, notification=${notification}`);
  send(res, 201, { ...view(loan), notification });
});

on('POST', '/loans/:id/return', async (_req, res, p) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(p.id) as any;
  if (!loan) throw httpError(404, 'loan not found');
  if (loan.status !== 'active') throw httpError(409, 'loan already returned');

  let released;
  try {
    released = await callJson('POST', `${CATALOG_URL}/books/${encodeURIComponent(loan.book_id)}/release`);
  } catch (err) {
    log('catalog-service unreachable', err);
    throw httpError(503, 'catalog-service unavailable');
  }
  if (released.status !== 200) throw httpError(502, `catalog refused release (${released.status})`);

  const returnedAt = new Date().toISOString();
  db.prepare("UPDATE loans SET status = 'returned', returned_at = ? WHERE id = ?").run(returnedAt, loan.id);
  const updated = { ...loan, status: 'returned', returned_at: returnedAt };
  const notification = await notify(loan.reader_name, `Книга "${loan.book_title}" возвращена`);
  log(`loan ${loan.id} returned`);
  send(res, 200, { ...view(updated), notification });
});

on('GET', '/loans', (req, res) => {
  const url = new URL(req.url ?? '/', 'http://localhost');
  const readerId = url.searchParams.get('reader_id');
  const status = url.searchParams.get('status');
  if (status && !['active', 'returned'].includes(status)) throw httpError(400, 'invalid status filter');

  const clauses: string[] = [];
  const args: string[] = [];
  if (readerId) { clauses.push('reader_id = ?'); args.push(readerId); }
  if (status) { clauses.push('status = ?'); args.push(status); }
  const where = clauses.length ? `WHERE ${clauses.join(' AND ')}` : '';
  const rows = db.prepare(`SELECT * FROM loans ${where} ORDER BY created_at DESC`).all(...args) as any[];
  send(res, 200, rows.map(view));
});

on('GET', '/loans/:id', (_req, res, p) => {
  const loan = db.prepare('SELECT * FROM loans WHERE id = ?').get(p.id) as any;
  if (!loan) throw httpError(404, 'loan not found');
  send(res, 200, view(loan));
});

start(db);