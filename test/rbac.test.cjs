'use strict';

const assert = require('node:assert/strict');
const { createHash, scryptSync } = require('node:crypto');
const { request: https } = require('node:https');
const { readFile, writeFile, access } = require('node:fs/promises');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { test } = require('node:test');
const { setTimeout: wait } = require('node:timers/promises');
const { run, testService, temporary, permanent, root } = require('./support.cjs');

const ID = '故障事件id';
const KEY = '故障根因';
const create = (revision, id) => ({ revision, source: 'pd', fields: { [ID]: id } });

function postInTwoParts(origin, path, cookie, body) {
  const json = JSON.stringify(body);
  let request;
  const status = new Promise((resolve, reject) => {
    request = https(origin + '/api/' + path, {
      method: 'POST', rejectUnauthorized: false,
      headers: { Origin: origin, Cookie: cookie, 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(json) }
    }, (response) => {
      response.resume();
      resolve(response.statusCode);
    });
    request.on('error', reject);
    request.write(json.slice(0, 1));
  });
  return { status, finish: () => request.end(json.slice(1)) };
}

test('isolated functional grants, live revocation, session binding and role history', { timeout: 50_000 }, async (t) => {
  const s = await testService(t);
  const alice = await s.bootstrap();
  const names = (await s.api('roles', undefined, alice.cookie)).json;
  assert.deepEqual(names.roles.map(({ id }) => id), ['admin', 'operator', 'reader']);
  assert.ok(names.roles[0].permissions.includes('accounts.manage'));
  assert.deepEqual(names.roles[2].permissions, ['view']);
  await s.api('roles/admin', { name: '伪装管理员', permissions: ['view'] }, alice.cookie, 403);
  await s.api('roles', { name: 'ＡＤＭＩＮ', permissions: ['view'] }, alice.cookie, 409);
  await s.api('roles', { name: '无查看', permissions: ['ticket.create'] }, alice.cookie, 400);
  await s.api('roles', { name: '越权', permissions: ['view', 'accounts.manage'] }, alice.cookie, 400);
  await s.api('roles', { name: '重复', permissions: ['view', 'view'] }, alice.cookie, 400);
  let role = (await s.api('roles', { name: '工单登记', permissions: ['view', 'ticket.create'] }, alice.cookie, 201)).json.role;
  assert.equal(role.builtIn, false);
  const rolePath = 'roles/' + role.id;
  async function saveRole(name, permissions) {
    role = (await s.api(rolePath, { name, revision: role.revision, permissions: ['view', ...permissions] }, alice.cookie)).json.role;
  }
  await s.api(`accounts/${alice.account.id}`, { displayName: '王明', role: role.id, active: true }, alice.cookie, 400);
  await s.api(`accounts/${alice.account.id}`, { displayName: '王明', role: 'admin', active: false }, alice.cookie, 400);

  const user = await s.addAccount(alice, 'member', role.id, '张雪');
  await s.addAccount(alice, 'member2', role.id, '赵蒙');
  let member = await s.changePassword(await s.login('member', temporary));
  const member2 = await s.changePassword(await s.login('member2', temporary));
  assert.deepEqual(member.account.permissions, ['view', 'ticket.create']);
  const relog = async () => member = await s.login('member', permanent);
  assert.equal((await s.request('/accounts', { cookie: member.cookie })).status, 403);
  await s.api('accounts', undefined, member.cookie, 403);
  await s.api('roles', undefined, member.cookie, 403);
  await s.api('roles', { name: '新角色', permissions: ['view'] }, member.cookie, 403);
  await s.api(rolePath, { name: '覆盖', permissions: ['view'], revision: role.revision }, member.cookie, 403);
  await s.api('accounts', {}, member.cookie, 403);
  await s.api('dashboard', undefined, member.cookie);
  await s.api('batches', undefined, member.cookie);
  const mismatch = await s.api('tickets', create(0, 'RBAC-WRONG-SESSION'), member.cookie, 409,
    { headers: { 'X-Incident-Session': alice.account.sessionKey } });
  assert.equal(mismatch.json.code, 'session_changed');
  const { uid } = (await s.api('tickets', { ...create(0, 'RBAC-FIRST'), role: 'admin', actor: alice.account }, member.cookie, 201,
    { headers: { 'X-Incident-Session': member.account.sessionKey } })).json;
  const { uid: second } = (await s.api('tickets', create(1, 'RBAC-SECOND'), alice.cookie, 201)).json;
  const fields = `tickets/${uid}/fields`;
  const action = `tickets/${uid}/action`;
  const links = `tickets/${uid}/links`;
  const edit = (revision) => ({ revision, source: 'pd', fields: { [KEY]: '手工记录' } });
  const link = (revision) => ({ revision, target: second, remove: false });
  const claim = (revision) => ({ revision, operation: 'claim', input: {} });
  const csv = { source: '', name: '权限校验.csv', text: '故障事件id,PD应用实例,故障根因\r\nRBAC-SECOND,服务二,由 CSV 补齐\r\nRBAC-IMPORT,服务三,导入新增' };
  const initial = await s.workspace(member);
  assert.equal(initial.records.find((item) => item.uid === uid).work.history[0].actor.id, user.id);
  assert.deepEqual(initial.people, []);
  for (const [path, body] of [[fields, edit(2)], [action, claim(2)], [links, link(2)], ['import/preview', csv], ['import/commit', { revision: 2 }]]) {
    await s.api(path, body, member.cookie, 403);
  }

  const firstRevision = role.revision;
  await saveRole('字段与关联', ['ticket.fields', 'ticket.links']);
  await s.api(rolePath, { name: '旧编辑', revision: firstRevision, permissions: ['view'] }, alice.cookie, 409);
  await s.api('workspace', undefined, member.cookie, 401);
  await s.api('session', undefined, member2.cookie, 401);
  await relog();
  assert.equal(member.account.roleName, '字段与关联');
  await s.api('tickets', create(2, 'RBAC-NO-CREATE'), member.cookie, 403);
  const edited = (await s.api(fields, edit(2), member.cookie)).json.snapshot;
  assert.equal(edited.records.find((item) => item.uid === uid).fields[KEY], '手工记录');
  const linked = (await s.api(links, link(3), member.cookie)).json.snapshot;
  assert.equal(linked.links.length, 1);
  assert.equal((await s.api(links, undefined, member.cookie)).json.links.length, 1);
  await s.api(action, claim(4), member.cookie, 403);
  await s.api(action, { revision: 4, operation: 'assign', input: { owner: user.id } }, alice.cookie, 400);

  await saveRole('处置', ['ticket.action']);
  await relog();
  const claimed = (await s.api(action, claim(4), member.cookie)).json.snapshot;
  assert.equal(claimed.records.find((item) => item.uid === uid).work.owner, user.id);
  const assigning = { revision: 5, operation: 'assign', input: { owner: user.id } };
  await s.api(`tickets/${second}/action`, assigning, alice.cookie);

  await saveRole('数据导入', ['csv.import']);
  await relog();
  const owner = (await s.workspace(alice)).people.find((person) => person.id === user.id);
  assert.equal(owner.assignable, false);
  await s.api(fields, edit(6), member.cookie, 403);
  await s.api('tickets', create(6, 'RBAC-NO-MANUAL'), member.cookie, 403);
  const preview = (await s.api('import/preview', csv, member.cookie)).json.plan;
  const commit = { ...csv, revision: preview.revision, token: preview.token, choices: [] };
  const imported = (await s.api('import/commit', commit, member.cookie)).json;
  assert.equal(imported.batch.inserted, 1);
  assert.equal(imported.batch.updated, 1);
  assert.equal(imported.batch.actor.id, user.id);
  assert.equal((await s.api(`batches/${imported.batch.id}`, undefined, member.cookie)).json.batch.id, imported.batch.id);
  assert.equal((await s.api(fields.replace('/fields', ''), undefined, member.cookie)).json.record.work.history[0].actor.id, user.id);

  const replacement = { ...csv, text: '故障事件id,PD应用实例\r\nRBAC-LATE,等待中的请求' };
  const latePreview = (await s.api('import/preview', replacement, member.cookie)).json.plan;
  const request = postInTwoParts(s.origin, 'import/commit', member.cookie,
    { ...replacement, token: latePreview.token, revision: latePreview.revision, choices: [] });
  try {
    await wait(100);
    await saveRole('只看队列', []);
  } finally {
    request.finish();
  }
  assert.equal(await request.status, 401);
  await relog();
  await s.api('import/preview', replacement, member.cookie, 403);
  await s.api('import/commit', { ...replacement, token: latePreview.token, revision: latePreview.revision, choices: [] }, member.cookie, 403);
  const after = await s.workspace(member);
  assert.equal(after.revision, imported.snapshot.revision);
  assert.deepEqual(after.records, imported.snapshot.records);
  assert.deepEqual(after.batches, imported.snapshot.batches);
  const audits = (await s.api('accounts', undefined, alice.cookie)).json.history;
  const roleAudits = audits.filter((event) => event.subject.id === role.id);
  assert.equal(roleAudits.length, 5);
  assert.deepEqual(roleAudits[0].details.permissions, [['view', 'csv.import'], ['view']]);
  assert.equal(roleAudits[0].actor.id, alice.account.id);
  assert.equal(roleAudits.at(-1).action, 'role_created');
  assert.equal(audits.find((event) => event.subject.id === user.id && event.action === 'account_created').details.roleName, '工单登记');

  await s.api(`accounts/${user.id}`, { displayName: '张雪', role: 'operator', active: true }, alice.cookie);
  await s.api('workspace', undefined, member.cookie, 401);
  await relog();
  await s.api('tickets', create(after.revision, 'RBAC-OPERATOR'), member.cookie, 201);
});

test('schema-1 upgrade and backup restore preserve records, identities, password hashes and audit', { timeout: 45_000 }, async (t) => {
  const s = await testService(t);
  await s.stop();
  const oldFile = join(s.directory, 'v1.sqlite3');
  const account = { id: 'legacy-admin', username: 'legacy', displayName: '原管理员' };
  const operator = { id: 'legacy-operator', username: 'older', displayName: '原处置员' };
  const salt = Buffer.from('v1-test-fixture!');
  assert.equal(salt.length, 16);
  const hash = Buffer.concat([salt, scryptSync(permanent, salt, 32, { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 })]).toString('base64url');
  const at = 1700000000000;
  const token = Buffer.alloc(32, 52).toString('base64url');
  const sessionDigest = createHash('sha256').update(token).digest('hex');
  const cookie = '__Host-incident_session=' + token;
  const event = { type: 'created', at, actor: operator, via: 'manual', revision: 1, changes: [] };
  const batch = { id: 'legacy-batch', actor: operator, at, source: 'pd', decisions: [] };
  const legacySchema = await readFile(join(root, 'schema.sql'), 'utf8');
  const old = new DatabaseSync(oldFile);
  old.exec(legacySchema);
  const insert = old.prepare('INSERT INTO accounts VALUES (?, ?, ?, ?, ?, 1, 0)');
  insert.run(account.id, account.username, account.displayName, 'admin', hash);
  insert.run(operator.id, operator.username, operator.displayName, 'operator', hash);
  old.prepare('INSERT INTO sessions VALUES (?, ?, ?)').run(sessionDigest, account.id, Date.now() + 5 * 60_000);
  old.prepare('UPDATE workspace SET revision = 3, clock_at = ?').run(at);
  const ticket = old.prepare('INSERT INTO tickets VALUES (?, ?, \'pd\', ?, ?, \'active\', ?, \'P2\', \'\', ?, ?)');
  ticket.run('legacy-a', 1, 'PD-OLD-A', JSON.stringify({ [ID]: 'PD-OLD-A' }), operator.id, at, at);
  ticket.run('legacy-b', 2, 'PD-OLD-B', JSON.stringify({ [ID]: 'PD-OLD-B' }), account.id, at, at);
  old.prepare('INSERT INTO links (left_uid, right_uid, linked_at) VALUES (?, ?, ?)').run('legacy-a', 'legacy-b', at);
  old.prepare('INSERT INTO timeline VALUES (?, 0, ?)').run('legacy-a', JSON.stringify(event));
  old.prepare('INSERT INTO batches (id, batch_json) VALUES (?, ?)').run(batch.id, JSON.stringify(batch));
  old.prepare('INSERT INTO account_history (at, actor_json, subject_json, action, details_json) VALUES (?, ?, ?, ?, ?)')
    .run(at, JSON.stringify(account), JSON.stringify(operator), 'account_created', '{"role":"operator"}');
  assert.equal(old.prepare('PRAGMA user_version').get().user_version, 1);
  old.close();

  const v1Backup = await readFile(oldFile);
  const restored = join(s.directory, 'restored-v1.sqlite3');
  const legacyExport = run('backup.cjs', oldFile, ['export']);
  assert.equal(legacyExport.status, 0, legacyExport.stderr.toString());
  assert.deepEqual(await readFile(oldFile), v1Backup);
  const restoredResult = run('backup.cjs', restored, ['restore'], v1Backup);
  assert.equal(restoredResult.status, 0, restoredResult.stderr.toString());

  async function checkPreserved(current) {
    const source = new DatabaseSync(current, { readOnly: true });
    assert.equal(source.prepare('PRAGMA user_version').get().user_version, 2);
    assert.equal(source.prepare('PRAGMA foreign_key_check').get(), undefined);
    const preserved = source.prepare('SELECT * FROM accounts ORDER BY id').all();
    assert.deepEqual(preserved.map((row) => [row.id, row.role, row.custom_role_id, row.password_hash]),
      [[account.id, 'admin', null, hash], [operator.id, 'operator', null, hash]]);
    source.close();
    const identity = await s.login('legacy', permanent);
    assert.deepEqual([identity.account.id, identity.account.role], [account.id, 'admin']);
    const formerOperator = await s.login('older', permanent);
    assert.deepEqual([formerOperator.account.id, formerOperator.account.role], [operator.id, 'operator']);
    const data = await s.workspace(identity);
    assert.equal(data.revision, 3);
    assert.equal(data.records[0].work.owner, operator.id);
    assert.deepEqual(data.records[0].work.history, [event]);
    assert.deepEqual(data.batches, [batch]);
    assert.deepEqual(JSON.parse(JSON.stringify(data.links)), [{ left: 'legacy-a', right: 'legacy-b', at }]);
    const adminView = (await s.api('accounts', undefined, identity.cookie)).json;
    assert.deepEqual(adminView.history, [{ at, actor: account, subject: operator, action: 'account_created', details: { role: 'operator' } }]);
    return identity;
  }

  await s.start(oldFile);
  assert.equal((await s.workspace({ cookie })).account.id, account.id);
  await checkPreserved(oldFile);
  await s.stop();
  await s.start(restored);
  await s.api('workspace', undefined, cookie, 401);
  const login = await checkPreserved(restored);
  const { role } = (await s.api('roles', { name: '恢复后编辑', permissions: ['view', 'ticket.fields'] }, login.cookie, 201)).json;
  await s.api(`accounts/${operator.id}`, { displayName: operator.displayName, role: role.id, active: true }, login.cookie);
  const newSnapshot = run('backup.cjs', restored, ['export']);
  assert.equal(newSnapshot.status, 0, newSnapshot.stderr.toString());
  const restoredV2 = join(s.directory, 'restored-v2.sqlite3');
  const secondRestore = run('backup.cjs', restoredV2, ['restore'], newSnapshot.stdout);
  assert.equal(secondRestore.status, 0, secondRestore.stderr.toString());
  await s.stop();
  await s.start(restoredV2);
  await s.api('workspace', undefined, login.cookie, 401);
  const roleLogin = await s.login('older', permanent);
  assert.deepEqual(roleLogin.account.permissions, ['view', 'ticket.fields']);
  assert.equal((await s.workspace(roleLogin)).records[0].work.owner, operator.id);
  await s.stop();

  const damaged = join(s.directory, 'v1-invalid.sqlite3');
  await writeFile(damaged, v1Backup);
  const corrupt = new DatabaseSync(damaged, { enableForeignKeyConstraints: false });
  corrupt.exec("UPDATE tickets SET owner = 'missing-account'");
  corrupt.close();
  const invalid = run('admin.cjs', damaged, ['bootstrap', 'nobody', '新用户'], permanent);
  assert.equal(invalid.status, 1);
  assert.match(invalid.stderr.toString(), /外键完整性/u);
  const unchanged = new DatabaseSync(damaged, { readOnly: true });
  assert.equal(unchanged.prepare('PRAGMA user_version').get().user_version, 1);
  assert.equal(unchanged.prepare("SELECT name FROM sqlite_schema WHERE name = 'custom_roles'").get(), undefined);
  assert.equal(unchanged.prepare('SELECT count(*) AS n FROM accounts').get().n, 2);
  unchanged.close();
  const absent = join(s.directory, 'unpublished-invalid.sqlite3');
  assert.equal(run('backup.cjs', absent, ['restore'], await readFile(damaged)).status, 1);
  await assert.rejects(access(absent), { code: 'ENOENT' });
});
