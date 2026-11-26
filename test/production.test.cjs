'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const { access, mkdir, readFile, unlink, writeFile } = require('node:fs/promises');
const { join } = require('node:path');
const { run, testService, temporary, permanent } = require('./support.cjs');

const ID = '故障事件id';
const KEY = '故障根因';
const multiline = '两行开始\r\n<b>值</b>';
const ticket = (state, uid) => state.records.find((item) => item.uid === uid);
const latest = (state, uid) => ticket(state, uid).work.history.at(-1);

test('same-origin HTTPS identities, UTC field audit, CSV transaction and online SQLite backup/restore', { timeout: 70_000 }, async (t) => {
  const s = await testService(t);
  assert.equal((await s.request('/')).headers.location, '/v2/');
  assert.equal((await s.request('/v2/')).headers.location, '/login');
  assert.equal((await s.request('/v2/index.html')).headers.location, '/login');
  await s.api('workspace', undefined, undefined, 401);
  await s.api('tickets', {}, undefined, 401);
  await s.api('session/login', { username: 'alice', password: temporary }, undefined, 401);
  await s.api('session/login', { username: 'alice', password: temporary }, undefined, 403, { originHeader: null });
  const alice = await s.bootstrap();
  const first = await s.workspace(alice);
  assert.deepEqual([first.revision, first.records, first.batches, first.links], [0, [], [], []]);
  assert.ok(Math.abs(first.clock.at - Date.now()) < 5000);
  await s.addAccount(alice, 'bob', 'operator', '李平');
  await s.addAccount(alice, 'charlie', 'reader', '只读用户');
  const temporaryBob = await s.login('bob', temporary);
  await s.api('workspace', undefined, temporaryBob.cookie, 403);
  const bob = await s.changePassword(temporaryBob);
  await s.api('workspace', undefined, temporaryBob.cookie, 401);
  const reader = await s.changePassword(await s.login('charlie', temporary));
  await s.api('accounts', undefined, reader.cookie, 403);
  assert.equal((await s.request('/accounts', { cookie: reader.cookie })).status, 403);
  assert.equal((await s.request('/accounts', { cookie: alice.cookie })).status, 200);
  await s.api('import/preview', {}, reader.cookie, 403);
  await s.api('tickets', { revision: 0 }, reader.cookie, 403);
  await s.api('tickets', { revision: 0 }, alice.cookie, 403, { originHeader: null });
  await s.api('tickets', { revision: 0 }, alice.cookie, 403, { originHeader: 'https://elsewhere.invalid' });

  const create = (await s.api('tickets', { revision: 0, source: 'pd', fields: { [ID]: 'PD-001' } }, alice.cookie, 201)).json;
  const uid = create.uid;
  assert.equal(latest(create.snapshot, uid).type, 'created');
  assert.deepEqual(latest(create.snapshot, uid).actor, { id: alice.account.id, username: 'alice', displayName: '王明' });
  const fieldInput = (revision, value) => ({ revision, source: 'pd', fields: { [KEY]: value } });
  const changed = (await s.api(`tickets/${uid}/fields`,
    { ...fieldInput(1, multiline), actor: bob.account, username: 'bob', at: 1 },
    alice.cookie, 200, { headers: { 'X-Remote-User': 'bob' } })).json;
  const firstDiff = latest(changed.snapshot, uid);
  assert.equal(firstDiff.actor.username, 'alice');
  assert.equal(firstDiff.via, 'manual');
  assert.ok(Math.abs(firstDiff.at - Date.now()) < 5000);
  assert.deepEqual(firstDiff.changes, [{ area: 'source', key: KEY, before: null, after: multiline }]);
  const clear = (await s.api(`tickets/${uid}/fields`, fieldInput(2, ''), bob.cookie)).json;
  const secondDiff = latest(clear.snapshot, uid);
  assert.equal(secondDiff.actor.displayName, '李平');
  assert.deepEqual(secondDiff.changes, [{ area: 'source', key: KEY, before: multiline, after: '' }]);
  await s.api(`tickets/${uid}/fields`, fieldInput(2, '旧修订'), alice.cookie, 409);
  const noop = (await s.api(`tickets/${uid}/fields`, fieldInput(3, ''), alice.cookie)).json;
  assert.equal(noop.changed, false);
  assert.equal(noop.snapshot.revision, 3);
  assert.equal(ticket(noop.snapshot, uid).work.history.length, 3);

  const claim = (await s.api(`tickets/${uid}/action`, {
    revision: 3, operation: 'claim', input: { actor: alice.account.id, owner: alice.account.id }
  }, bob.cookie)).json;
  assert.equal(ticket(claim.snapshot, uid).work.owner, bob.account.id);
  assert.equal(latest(claim.snapshot, uid).actor.username, 'bob');
  assert.deepEqual(latest(claim.snapshot, uid).changes.map((field) => field.key), ['status', 'owner']);
  await s.api(`tickets/${uid}/action`, { revision: 4, operation: 'assign', input: { owner: reader.account.id } }, bob.cookie, 400);
  const actions = [
    ['impact', { priority: 'P1', impact: '排队\n核实' }], ['note', { note: '处理' }], ['pause', { note: '等待' }], ['resume', {}],
    ['verify', { note: '待检查' }], ['reject', { note: '验证失败' }], ['verify', { note: '复验' }], ['close', { note: '通过' }], ['reopen', { note: '复发' }]
  ];
  let revision = 4;
  for (const [operation, input] of actions) {
    const result = (await s.api(`tickets/${uid}/action`, { revision, operation, input }, bob.cookie)).json;
    assert.equal(latest(result.snapshot, uid).type, operation);
    assert.equal(latest(result.snapshot, uid).actor.username, 'bob');
    revision = result.snapshot.revision;
  }
  const dashboards = await Promise.all([alice, bob].map((session) => s.api('dashboard', undefined, session.cookie)));
  assert.deepEqual(dashboards.map((response) => response.json.queues.mine), [0, 1]);

  async function preview(session, name, text, source = '') {
    const doc = { name, text, source };
    const { plan } = (await s.api('import/preview', doc, session.cookie)).json;
    return { ...doc, revision: plan.revision, token: plan.token, plan };
  }
  async function commit(session, data, choices = [], expected = 200) {
    const { plan, ...doc } = data;
    return (await s.api('import/commit', { ...doc, choices }, session.cookie, expected)).json;
  }

  const pd = await preview(alice, 'PD.csv', '故障事件id,PD应用实例,故障根因,故障发生时间,额外列\r\nPD-001,worker,导入补齐,2026-11-25T18:00:00Z,');
  await commit(bob, pd, [], 400);
  assert.equal((await s.workspace(alice)).revision, revision);
  const imported = await commit(alice, pd);
  assert.equal(imported.batch.actor.username, 'alice');
  assert.equal(imported.batch.updated, 1);
  const importAudit = latest(imported.snapshot, uid);
  assert.equal(importAudit.via, 'csv');
  assert.equal(importAudit.id, imported.batch.id);
  assert.deepEqual(importAudit.changes.find((diff) => diff.key === KEY), { area: 'source', key: KEY, before: '', after: '导入补齐' });
  assert.equal(ticket(imported.snapshot, uid).fields['故障发生时间'], '2026-11-25T18:00:00Z');

  const repeats = await commit(alice, await preview(alice, pd.name, pd.text));
  assert.equal(repeats.batch.updated, 0);
  assert.equal(ticket(repeats.snapshot, uid).work.history.length, ticket(imported.snapshot, uid).work.history.length);

  const conflict = await preview(bob, '冲突.csv',
    '故障事件id,PD应用实例,故障根因\r\nPD-001,worker,"另一行\r\n继续"\r\nPD-001,worker,第三行');
  assert.deepEqual(conflict.plan.conflicts[0].candidates.map((choice) => choice.lines), [[], [2], [4]]);
  await commit(bob, conflict, [], 400);
  assert.equal((await s.workspace(alice)).revision, repeats.snapshot.revision);

  // Force a real failure after updating the ticket, at the audit insert.
  const fault = new DatabaseSync(s.filename);
  fault.exec("CREATE TRIGGER test_audit_failure BEFORE INSERT ON timeline BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  await commit(bob, conflict, [[0, 1]], 500);
  const rolledBack = await s.workspace(alice);
  assert.deepEqual(rolledBack.records, repeats.snapshot.records);
  assert.deepEqual(rolledBack.batches, repeats.snapshot.batches);
  assert.equal(rolledBack.revision, repeats.snapshot.revision);
  fault.exec('DROP TRIGGER test_audit_failure;');
  fault.close();

  const resolved = await commit(bob, conflict, [[0, 1]]);
  assert.equal(resolved.batch.decisions[0].selected.value, '另一行\r\n继续');
  assert.equal(latest(resolved.snapshot, uid).actor.username, 'bob');
  assert.equal(latest(resolved.snapshot, uid).changes[0].before, '导入补齐');
  assert.equal(latest(resolved.snapshot, uid).changes[0].after, '另一行\r\n继续');

  for (const text of [
    '故障事件id,告警名称（ARMS）,故障发生时间\nPD-001,跨云,2026-11-25T18:00:00Z',
    '故障事件id,主机名称\nPD-001,GPU 主机'
  ]) {
    const result = await commit(alice, await preview(alice, '来源.csv', text));
    assert.equal(result.batch.inserted, 1);
  }
  const beforeLink = await s.workspace(alice);
  assert.deepEqual([...beforeLink.records.map((record) => record.source)].sort(), ['gpu', 'hybrid', 'pd']);
  const target = beforeLink.records.find((record) => record.source === 'gpu').uid;
  const linked = (await s.api(`tickets/${uid}/links`, { revision: beforeLink.revision, target, remove: false }, alice.cookie)).json;
  assert.equal(latest(linked.snapshot, uid).changes[0].after, target);
  assert.equal(latest(linked.snapshot, target).changes[0].after, uid);
  const unlinked = (await s.api(`tickets/${uid}/links`, { revision: linked.snapshot.revision, target, remove: true }, bob.cookie)).json;
  assert.equal(latest(unlinked.snapshot, target).changes[0].before, uid);
  assert.equal(latest(unlinked.snapshot, target).actor.username, 'bob');

  await s.api(`accounts/${bob.account.id}`, { displayName: '李平（新）', role: 'operator', active: true }, alice.cookie);
  const renamed = await s.workspace(bob);
  assert.equal(renamed.account.displayName, '李平（新）');
  assert.equal(latest(renamed, target).actor.displayName, '李平');
  await s.api(`accounts/${bob.account.id}`, { displayName: '李平（新）', role: 'reader', active: true }, alice.cookie);
  await s.api('workspace', undefined, bob.cookie, 401);
  const downgraded = await s.login('bob', permanent);
  await s.api('tickets', { revision: renamed.revision }, downgraded.cookie, 403);
  await s.api(`accounts/${bob.account.id}`, { displayName: '李平（新）', role: 'reader', active: false }, alice.cookie);
  await s.api('workspace', undefined, downgraded.cookie, 401);
  await s.api('session/login', { username: 'bob', password: permanent }, undefined, 401);

  await access(s.filename + '-wal');
  await access(s.filename + '-shm');
  const beforeRestart = await s.workspace(alice);
  const backup = run('backup.cjs', s.filename, ['export']);
  assert.equal(backup.status, 0, backup.stderr.toString());
  assert.match(backup.stdout.toString('ascii', 0, 15), /SQLite format 3/u);
  const backupFile = join(s.directory, 'backup.sqlite3');
  await writeFile(backupFile, backup.stdout);
  const backupDb = new DatabaseSync(backupFile, { readOnly: true });
  assert.equal(backupDb.prepare('SELECT count(*) AS n FROM sessions').get().n, 0);
  backupDb.close();
  assert.equal(run('backup.cjs', s.filename, ['restore'], backup.stdout).status, 1);
  await s.stop('SIGKILL');
  await s.start();
  const afterRestart = await s.workspace(alice);
  for (const key of ['revision', 'records', 'batches', 'links']) assert.deepEqual(afterRestart[key], beforeRestart[key]);
  assert.ok(afterRestart.clock.at >= beforeRestart.clock.at);

  const restoreDir = join(s.directory, 'fresh-volume');
  await mkdir(restoreDir);
  const restored = join(restoreDir, 'workspace.sqlite3');
  await writeFile(restored + '-wal', 'stale');
  assert.equal(run('backup.cjs', restored, ['restore'], backup.stdout).status, 1);
  await unlink(restored + '-wal');
  assert.equal(run('backup.cjs', restored, ['restore'], Buffer.from('wrong-data')).status, 1);
  const restoredResult = run('backup.cjs', restored, ['restore'], await readFile(backupFile));
  assert.equal(restoredResult.status, 0, restoredResult.stderr.toString());
  await s.stop();
  await s.start(restored);
  await s.api('workspace', undefined, alice.cookie, 401);
  const reauthenticated = await s.login('alice', permanent);
  const afterRestore = await s.workspace(reauthenticated);
  for (const key of ['revision', 'records', 'batches', 'links']) assert.deepEqual(afterRestore[key], beforeRestart[key]);
  assert.equal((await s.api('accounts', undefined, reauthenticated.cookie)).json.accounts.find((row) => row.username === 'bob').active, false);
});
