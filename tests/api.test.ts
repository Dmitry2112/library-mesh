import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const CATALOG = process.env.CATALOG_URL ?? 'http://localhost:5000';
const READER = process.env.READER_URL ?? 'http://localhost:5003';
const LOAN = process.env.LOAN_URL ?? 'http://localhost:5001';
const NOTIFY = process.env.NOTIFICATION_URL ?? 'http://localhost:5002';

async function api(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(8000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

const rid = () => randomUUID().slice(0, 8);

async function newBook(copies = 1) {
  const r = await api(CATALOG, 'POST', '/books', { title: `Book-${rid()}`, author: 'Author', copies_total: copies });
  assert.equal(r.status, 201);
  return r.body;
}
async function newReader() {
  const r = await api(READER, 'POST', '/readers', { name: `Reader-${rid()}`, email: `${rid()}@example.com` });
  assert.equal(r.status, 201);
  return r.body;
}
const newLoan = (readerId: string, bookId: string) => api(LOAN, 'POST', '/loans', { reader_id: readerId, book_id: bookId });

test('все сервисы живы', async () => {
  for (const base of [CATALOG, READER, LOAN, NOTIFY]) {
    const r = await api(base, 'GET', '/health');
    assert.equal(r.status, 200);
    assert.equal(r.body.status, 'ok');
  }
});

test('catalog: полный CRUD', async () => {
  const book = await newBook(2);
  assert.equal((await api(CATALOG, 'GET', `/books/${book.id}`)).status, 200);
  const patched = await api(CATALOG, 'PATCH', `/books/${book.id}`, { title: 'New title' });
  assert.equal(patched.body.title, 'New title');
  assert.equal((await api(CATALOG, 'DELETE', `/books/${book.id}`)).status, 200);
  assert.equal((await api(CATALOG, 'GET', `/books/${book.id}`)).status, 404);
});

test('reader: CRUD и уникальный email', async () => {
  const reader = await newReader();
  const dup = await api(READER, 'POST', '/readers', { name: 'X', email: reader.email });
  assert.equal(dup.status, 409);
  const blocked = await api(READER, 'PATCH', `/readers/${reader.id}`, { status: 'blocked' });
  assert.equal(blocked.body.status, 'blocked');
  assert.equal((await api(READER, 'DELETE', `/readers/${reader.id}`)).status, 200);
});

test('сквозной сценарий: выдача, срок 14 дней, уведомление доставлено', async () => {
  const reader = await newReader();
  const book = await newBook(1);
  const r = await newLoan(reader.id, book.id);
  assert.equal(r.status, 201);
  assert.equal(r.body.notification, 'sent');
  assert.equal(r.body.overdue, false);
  const days = (Date.parse(r.body.due_at) - Date.parse(r.body.created_at)) / 86_400_000;
  assert.equal(Math.round(days), 14);

  const after = await api(CATALOG, 'GET', `/books/${book.id}`);
  assert.equal(after.body.copies_available, 0);

  const notes = await api(NOTIFY, 'GET', `/notifications?recipient=${encodeURIComponent(reader.name)}`);
  assert.ok(notes.body.some((n: any) => n.message.includes(book.title)));
});

test('экземпляры закончились: 409', async () => {
  const book = await newBook(1);
  assert.equal((await newLoan((await newReader()).id, book.id)).status, 201);
  assert.equal((await newLoan((await newReader()).id, book.id)).status, 409);
});

test('несуществующие читатель и книга: 404', async () => {
  const reader = await newReader();
  const book = await newBook(1);
  assert.equal((await newLoan(reader.id, 'no-such-book')).status, 404);
  assert.equal((await newLoan('no-such-reader', book.id)).status, 404);
});

test('заблокированный читатель: 403', async () => {
  const reader = await newReader();
  const book = await newBook(1);
  await api(READER, 'PATCH', `/readers/${reader.id}`, { status: 'blocked' });
  assert.equal((await newLoan(reader.id, book.id)).status, 403);
});

test('лимит трёх активных выдач', async () => {
  const reader = await newReader();
  const book = await newBook(5);
  for (let i = 0; i < 3; i++) {
    const b = await newBook(1);
    assert.equal((await newLoan(reader.id, b.id)).status, 201);
  }
  assert.equal((await newLoan(reader.id, book.id)).status, 409);
});

test('нельзя взять вторую копию той же книги', async () => {
  const reader = await newReader();
  const book = await newBook(3);
  assert.equal((await newLoan(reader.id, book.id)).status, 201);
  assert.equal((await newLoan(reader.id, book.id)).status, 409);
});

test('возврат восстанавливает экземпляр и защищает от повтора', async () => {
  const reader = await newReader();
  const book = await newBook(1);
  const loan = (await newLoan(reader.id, book.id)).body;

  const ret = await api(LOAN, 'POST', `/loans/${loan.id}/return`);
  assert.equal(ret.status, 200);
  assert.equal(ret.body.status, 'returned');
  assert.equal((await api(LOAN, 'POST', `/loans/${loan.id}/return`)).status, 409);
  assert.equal((await api(CATALOG, 'GET', `/books/${book.id}`)).body.copies_available, 1);
  assert.equal((await newLoan((await newReader()).id, book.id)).status, 201);
});

test('книгу с активной выдачей удалить нельзя', async () => {
  const book = await newBook(1);
  await newLoan((await newReader()).id, book.id);
  assert.equal((await api(CATALOG, 'DELETE', `/books/${book.id}`)).status, 409);
});

test('фильтры выдач работают', async () => {
  const reader = await newReader();
  const book = await newBook(1);
  const loan = (await newLoan(reader.id, book.id)).body;
  await api(LOAN, 'POST', `/loans/${loan.id}/return`);
  const active = await api(LOAN, 'GET', `/loans?reader_id=${reader.id}&status=active`);
  const returned = await api(LOAN, 'GET', `/loans?reader_id=${reader.id}&status=returned`);
  assert.equal(active.body.length, 0);
  assert.equal(returned.body.length, 1);
});