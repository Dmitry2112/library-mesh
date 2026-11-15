import { execSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

const CATALOG = process.env.CATALOG_URL ?? 'http://localhost:5000';
const READER = process.env.READER_URL ?? 'http://localhost:5003';
const LOAN = process.env.LOAN_URL ?? 'http://localhost:5001';
const NOTIFY = process.env.NOTIFICATION_URL ?? 'http://localhost:5002';

const compose = (cmd: string) => execSync(`docker compose ${cmd}`, { stdio: 'inherit' });
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const rid = () => randomUUID().slice(0, 8);

async function api(base: string, method: string, path: string, body?: unknown) {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(15_000),
  });
  const text = await res.text();
  return { status: res.status, body: text ? JSON.parse(text) : null };
}

async function waitHealthy(base: string) {
  for (let i = 0; i < 30; i++) {
    try {
      if ((await api(base, 'GET', '/health')).status === 200) return;
    } catch { /* ещё не поднялся */ }
    await sleep(1000);
  }
  throw new Error(`сервис ${base} не поднялся`);
}

async function fixtures() {
  const r = await api(READER, 'POST', '/readers', { name: `Reader-${rid()}`, email: `${rid()}@example.com` });
  assert.equal(r.status, 201, `не удалось создать читателя: ${JSON.stringify(r.body)}`);
  const b = await api(CATALOG, 'POST', '/books', { title: `Book-${rid()}`, author: 'Author', copies_total: 2 });
  assert.equal(b.status, 201, `не удалось создать книгу: ${JSON.stringify(b.body)}`);
  return { readerId: r.body.id as string, bookId: b.body.id as string };
}

const issue = (f: { readerId: string; bookId: string }) =>
  api(LOAN, 'POST', '/loans', { reader_id: f.readerId, book_id: f.bookId });

const expect = (r: { status: number; body: any }, status: number) =>
  assert.equal(r.status, status, `ожидали ${status}, получили ${r.status}: ${JSON.stringify(r.body)}`);

await Promise.all([CATALOG, READER, LOAN, NOTIFY].map(waitHealthy));

console.log('\n--- 1. notification-service остановлен (некритичная зависимость) ---');
let f = await fixtures();
compose('stop notification-service');
try {
  const r = await issue(f);
  expect(r, 201);
  assert.equal(r.body.notification, 'failed', `ожидали failed: ${JSON.stringify(r.body)}`);
  console.log('РЕЗУЛЬТАТ: 201, выдача создана, уведомление помечено failed (деградация)');
  expect(await api(LOAN, 'GET', `/loans?reader_id=${f.readerId}`), 200);
  console.log('РЕЗУЛЬТАТ: чтение собственных данных loan-service работает');
} finally {
  compose('start notification-service');
  await waitHealthy(NOTIFY);
}

console.log('\n--- 2. catalog-service остановлен (критичная зависимость) ---');
f = await fixtures();
compose('stop catalog-service');
try {
  const r = await issue(f);
  expect(r, 503);
  console.log(`РЕЗУЛЬТАТ: 503 "${r.body.error}"`);
} finally {
  compose('start catalog-service');
  await waitHealthy(CATALOG);
}
const book2 = await api(CATALOG, 'GET', `/books/${f.bookId}`);
assert.equal(book2.body.copies_available, 2, 'экземпляр не должен был списаться');
const loans2 = await api(LOAN, 'GET', `/loans?reader_id=${f.readerId}`);
assert.equal(loans2.body.length, 0, 'выдача не должна была создаться');
console.log('РЕЗУЛЬТАТ: фонд не изменён, выдача не создана, состояние согласовано');

console.log('\n--- 3. reader-service остановлен (критичная зависимость) ---');
f = await fixtures();
compose('stop reader-service');
try {
  const r = await issue(f);
  expect(r, 503);
  console.log(`РЕЗУЛЬТАТ: 503 "${r.body.error}", fail closed: статус читателя проверить нельзя`);
} finally {
  compose('start reader-service');
  await waitHealthy(READER);
}
const book3 = await api(CATALOG, 'GET', `/books/${f.bookId}`);
assert.equal(book3.body.copies_available, 2, 'списание не должно было произойти');
console.log('РЕЗУЛЬТАТ: списания не было, отказ произошёл до изменения чужого состояния');

console.log('\nВсе три сценария отказа прошли успешно.');