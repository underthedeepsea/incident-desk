'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { DatabaseSync } = require('node:sqlite');
const XLSX = require('xlsx');
const { testService, temporary } = require('./support.cjs');
const { ID, ANONYMOUS } = require('../v2/data.js');

function workbook(sheets, name = '告警.xlsx', date1904 = false) {
  const book = XLSX.utils.book_new();
  book.Workbook = { WBProps: { date1904 } };
  for (const [title, worksheet] of Object.entries(sheets)) XLSX.utils.book_append_sheet(book, worksheet, title);
  const bytes = XLSX.write(book, { type: 'buffer', bookType: 'xlsx', compression: true, bookSST: true });
  return { name, format: 'xlsx', source: '', base64: bytes.toString('base64') };
}
const sheet = (rows, options) => XLSX.utils.aoa_to_sheet(rows, options);
const pd = ['故障事件 ID', 'PD应用实例', '故障发生时间', '', '备注'];
const asOf = '2026-11-26 09:45:27';

function replaceWorkbookPart(doc, name, replace) {
  const zip = XLSX.CFB.read(Buffer.from(doc.base64, 'base64'), { type: 'buffer' });
  const before = XLSX.CFB.find(zip, '/' + name).content.toString('utf8');
  const after = replace(before);
  assert.notEqual(after, before);
  assert.equal(XLSX.CFB.utils.cfb_del(zip, '/' + name), true);
  XLSX.CFB.utils.cfb_add(zip, name, Buffer.from(after));
  const bytes = XLSX.CFB.write(zip, { type: 'buffer', fileType: 'zip' });
  return { ...doc, base64: bytes.toString('base64') };
}

async function importWithoutConflicts(service, account, doc) {
  const { plan } = (await service.api('import/preview', doc, account.cookie)).json;
  assert.deepEqual(plan.conflicts, []);
  return (await service.api('import/commit', {
    ...doc, sheet: plan.sheet, revision: plan.revision, token: plan.token, choices: []
  }, account.cookie)).json;
}

test('XLSX chooses one sheet and shares CSV identity, conflicts, permissions and atomic audits', { timeout: 45_000 }, async (t) => {
  const s = await testService(t);
  const alice = await s.bootstrap();
  await s.addAccount(alice, 'bob', 'operator', '测试操作员');
  await s.addAccount(alice, 'reader', 'reader', '测试只读');
  const bob = await s.changePassword(await s.login('bob', temporary));
  const reader = await s.changePassword(await s.login('reader', temporary));
  const request = (route, doc, actor = alice, status) => s.api('import/' + route, doc, actor.cookie, status);

  const csv = { name: '历史.csv', source: '', text: `故障事件 ID,PD应用实例,故障发生时间,,备注\r\n000042,worker,${asOf},,"首行\r\n第二行 😀"` };
  const csvPlan = (await request('preview', csv)).json.plan;
  const previous = (await request('commit', { ...csv, revision: csvPlan.revision, token: csvPlan.token, choices: [] })).json;
  const first = previous.snapshot.records[0];
  assert.equal(first.work.history[0].via, 'csv');
  assert.equal(previous.batch.format, undefined);

  const alert = sheet([pd, [42, 'worker', 46352.4065625, null, '首行\r\n第二行 😀'], [], ['000042', 'changed'], [null, '无 ID']], { origin: 'A3' });
  alert.A4.z = '000000';
  alert.C4.z = 'yyyy/m/d h:mm:ss';
  const docs = workbook({
    '内部云': alert,
    '空白页': sheet([[''], []]),
    'GPU告警': sheet([['故障事件id', '序列号', '主机名称'], ['000042', 7, 'gpu-example']])
  });
  const gpu = { ...docs, sheet: 'GPU告警' };
  await request('preview', docs, reader, 403);
  await request('commit', docs, reader, 403);

  const selection = (await request('preview', docs)).json;
  assert.equal(selection.plan, null);
  assert.deepEqual(selection.sheets, ['内部云', 'GPU告警']);
  await request('preview', { ...docs, sheet: '空白页' }, alice, 400);
  await request('preview', { ...docs, sheet: '不存在' }, alice, 400);
  const chosen = { ...docs, sheet: '内部云' };
  const plan = (await request('preview', chosen)).json.plan;
  assert.equal(plan.sheet, '内部云');
  assert.equal(plan.format, 'xlsx');
  assert.equal(plan.counts.matched, 1);
  assert.equal(plan.counts.new, 0);
  assert.deepEqual(plan.invalidRows.map((item) => item.line), [7]);
  assert.equal(plan.conflicts.length, 1);
  assert.deepEqual(plan.conflicts[0].candidates.map(({ value, lines }) => [value, lines]), [['worker', [4]], ['changed', [6]]]);
  const commit = { ...chosen, token: plan.token, revision: plan.revision, choices: [[0, 1]] };
  await request('commit', { ...commit, sheet: undefined }, alice, 400);
  await request('commit', { ...commit, sheet: gpu.sheet }, alice, 400);
  await request('commit', { ...commit, source: 'gpu' }, alice, 400);
  await request('commit', { ...commit, name: '另一个.xlsx' }, alice, 400);
  await request('commit', { ...commit, base64: workbook({ '内部云': sheet([pd, [42, 'other']]) }).base64 }, alice, 400);
  await request('commit', { ...commit, format: 'csv', text: csv.text }, alice, 400);
  await request('commit', commit, bob, 400);
  await request('commit', { ...commit, choices: [] }, alice, 400);

  const database = new DatabaseSync(s.filename);
  database.exec("CREATE TRIGGER test_xlsx_failure BEFORE INSERT ON timeline BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");
  await request('commit', commit, alice, 500);
  database.exec('DROP TRIGGER test_xlsx_failure;');
  database.close();
  const afterFailure = await s.workspace(alice);
  assert.deepEqual(afterFailure.records, previous.snapshot.records);
  assert.deepEqual(afterFailure.batches, previous.snapshot.batches);
  assert.equal(afterFailure.revision, previous.snapshot.revision);

  const imported = (await request('commit', commit)).json;
  assert.equal(imported.batch.format, 'xlsx');
  assert.equal(imported.batch.sheet, '内部云');
  assert.equal(imported.batch.updated, 1);
  assert.equal(imported.snapshot.records[0].uid, first.uid);
  assert.equal(imported.snapshot.records[0].fields['备注'], '首行\r\n第二行 😀');
  assert.equal(imported.snapshot.records[0].fields['故障发生时间'], asOf);
  assert.equal(imported.snapshot.records[0].fields['\u00004'], '');
  assert.equal(imported.snapshot.records[0].work.history.at(-1).via, 'xlsx');
  assert.equal(imported.snapshot.records[0].work.history.length, 2);
  assert.deepEqual(imported.snapshot.batches[1], previous.batch);
  await request('commit', commit, alice, 409);

  const gpuPlan = (await request('preview', gpu)).json.plan;
  const gpuBatch = (await request('commit', { ...gpu, revision: gpuPlan.revision, token: gpuPlan.token, choices: [] })).json;
  assert.equal(gpuBatch.batch.source, 'gpu');
  assert.equal(gpuBatch.snapshot.records[0].fields['序列号'], '7');
  assert.equal(gpuBatch.snapshot.records[0].fields['故障事件id'], '000042');
  const hybridSheet = sheet([['故障事件id fev 样例', '记录类型', '故障发生时间', '故障恢复时间'], ['000042', 'ALERT', 44890.4065625, 44890.5]]);
  hybridSheet.C2.z = 'yyyy-mm-dd hh:mm:ss';
  hybridSheet.D2.z = 'yyyy-mm-dd hh:mm:ss';
  const hybrid = workbook({ '混合云': hybridSheet }, 'Hybrid.xlsx', true);
  const hybridPlan = (await request('preview', hybrid)).json.plan;
  const hybridBatch = (await request('commit', { ...hybrid, sheet: hybridPlan.sheet, revision: hybridPlan.revision, token: hybridPlan.token, choices: [] })).json;
  assert.equal(hybridBatch.batch.source, 'hybrid');
  const fields = hybridBatch.snapshot.records[0].fields;
  assert.equal(fields['记录类型 ALERT/UNPAIRED_RECOVER'], 'ALERT');
  assert.equal(fields['故障发生时间（告警时间）'], asOf);
  assert.equal(fields['故障恢复时间（支持人工编辑）'], '2026-11-26 12:00:00');
  assert.equal(new Set(hybridBatch.snapshot.records.map((ticket) => ticket.uid)).size, 3);
  await s.stop();
  await s.start();
  const reopened = await s.workspace(alice);
  assert.deepEqual(reopened.records, hybridBatch.snapshot.records);
  assert.deepEqual(reopened.batches, hybridBatch.snapshot.batches);
});

test('XLSX only reads stored formula results and rejects unreadable cells and files before writing', { timeout: 30_000 }, async (t) => {
  const s = await testService(t);
  const account = await s.bootstrap();
  const cookie = account.cookie;
  const preview = (doc, status) => s.api('import/preview', doc, cookie, status);
  const initial = await s.workspace(account);
  const plain = workbook({ '告警': sheet([pd, [9, 'worker']]) });

  const broken = { ...plain, base64: Buffer.from('故障事件id,PD应用实例\nTEST,worker').toString('base64') };
  assert.match((await preview(broken, 400)).json.message, /另存为/);
  assert.match((await preview({ ...plain, base64: plain.base64 + ' ' }, 400)).json.message, /重新上传/);
  assert.match((await preview({ ...plain, name: '旧格式.xls' }, 400)).json.message, /\.xlsx/);
  const wide = sheet([pd, ['LIMIT', 'worker']]);
  XLSX.utils.sheet_add_aoa(wide, [['limit']], { origin: 'IW2' });
  assert.match((await preview(workbook({ '告警': wide }), 400)).json.message, /上限/);

  const number = sheet([pd, [1234567890123456, 'worker']]);
  assert.match((await preview(workbook({ '告警': number }), 400)).json.message, /精度.*文本/);
  const missing = sheet([pd, ['ID', { t: 'n', f: '6*7' }]]);
  assert.match((await preview(workbook({ '告警': missing }), 400)).json.message, /B2.*没有保存结果/);
  const error = sheet([pd, ['ID', { t: 'e', v: 7 }]]);
  assert.match((await preview(workbook({ '告警': error }), 400)).json.message, /B2.*Excel 错误/);
  const saved = workbook({ '告警': sheet([pd, ['ID', { t: 'n', f: '6*7', v: 5 }]]) });
  const { plan } = (await preview(saved, 200)).json;
  assert.deepEqual((await s.workspace(account)).records, initial.records);
  assert.deepEqual((await s.workspace(account)).batches, initial.batches);
  assert.equal((await s.workspace(account)).revision, initial.revision);
  const result = (await s.api('import/commit', { ...saved, sheet: plan.sheet, token: plan.token, revision: plan.revision, choices: [] }, cookie)).json;
  assert.equal(result.snapshot.records[0].fields['PD应用实例'], '5');
});

test('XLSX only uses physically declared cells of the header row to define anonymous columns', { timeout: 30_000 }, async (t) => {
  const service = await testService(t);
  const account = await service.bootstrap();
  const data = sheet([
    ['故障事件id', '主机名称'],
    ['TAIL', 'node-a', '第三列备注甲'],
    ['SHORT', 'node-b'],
    ['EXTRA', 'node-c', '已声明第三列', '未声明第四列']
  ], { origin: 'A3' });
  const doc = replaceWorkbookPart(workbook({ GPU: data }), 'xl/worksheets/sheet1.xml', (xml) => xml
    .replace('<sheetData>', '<sheetData><row r="1"><c r="F1" s="0"/></row>')
    .replace(/(<row r="3"[^>]*>.*?)(<\/row>)/u, '$1<c r="C3" s="0"/>$2')
    .replace(/(<row r="4"[^>]*>.*?)(<\/row>)/u, '$1<c r="E4" s="0"/>$2'));
  const { batch, snapshot } = await importWithoutConflicts(service, account, doc);
  const expectedIssue = [{ line: 6, message: '数据的列数多于表头' }];
  assert.equal(batch.counts.rows, 2);
  assert.deepEqual(batch.issues, expectedIssue);
  const records = new Map(snapshot.records.map((record) => [record.fields[ID], record.fields]));
  const anonymous = ANONYMOUS + '3';
  assert.equal(records.get('TAIL')[anonymous], '第三列备注甲');
  assert.equal(records.get('SHORT')[anonymous], '');
  assert.equal(records.has('EXTRA'), false);
  assert.equal(Object.hasOwn(records.get('TAIL'), ANONYMOUS + '4'), false);
  const equivalent = {
    name: '等价.csv', source: '',
    text: '\r\n\r\n故障事件id,主机名称,\r\nTAIL,node-a,第三列备注甲\r\nSHORT,node-b,\r\nEXTRA,node-c,已声明第三列,未声明第四列'
  };
  const { plan } = (await service.api('import/preview', equivalent, account.cookie)).json;
  assert.equal(plan.counts.matched, 2);
  assert.deepEqual(plan.invalidRows, expectedIssue);
  assert.deepEqual(plan.conflicts, []);
});

test('XLSX inline and shared rich text decode each run before joining and match CSV audit values', { timeout: 30_000 }, async (t) => {
  const service = await testService(t);
  const account = await service.bootstrap();
  const rich = [
    '<r><t xml:space="preserve">值为 _x</t></r>',
    '<r><t>0041_，本段 _x0042_，转义下划线 _x005F_x0043_&#13;\n</t></r>',
    '<r><t>第三段 _x<![CDATA[0044_]]> _xD83D_</t></r>',
    '<r><t>_xDE00_</t></r>'
  ].join('');
  const decoded = '值为 _x0041_，本段 B，转义下划线 _x0043_\r\n第三段 D 😀';
  const plain = '单段 _x0041_ 和 _x005F_x0042_';
  for (const format of ['inline', 'shared']) {
    const id = 'RICH-' + format;
    const data = sheet([
      ['故障事件id', 'PD应用实例', '备注', '单段备注'],
      [id, 'worker', 'RICH_SLOT', plain]
    ]);
    const base = workbook({ PD: data }, format + '.xlsx');
    const doc = format === 'inline'
      ? replaceWorkbookPart(base, 'xl/worksheets/sheet1.xml', (xml) => xml.replace(/<c r="C2" t="s"><v>\d+<\/v><\/c>/u, `<c r="C2" t="inlineStr"><is>${rich}</is></c>`))
      : replaceWorkbookPart(base, 'xl/sharedStrings.xml', (xml) => xml.replace('<si><t>RICH_SLOT</t></si>', `<si>${rich}</si>`));
    const { batch, snapshot } = await importWithoutConflicts(service, account, doc);
    const record = snapshot.records.find((item) => item.fields[ID] === id);
    assert.equal(record.fields['备注'], decoded);
    assert.equal(record.fields['单段备注'], '单段 A 和 _x0042_');
    assert.deepEqual(batch.effects[0].fields.find(({ key }) => key === '备注'), { key: '备注', before: null, after: decoded });
    assert.deepEqual(record.work.history.at(-1).changes.find(({ key }) => key === '备注'),
      { area: 'source', key: '备注', before: null, after: decoded });
    const equivalent = {
      name: '等价.csv', source: '',
      text: `故障事件id,PD应用实例,备注,单段备注\r\n${id},worker,"${decoded}",单段 A 和 _x0042_`
    };
    const { plan } = (await service.api('import/preview', equivalent, account.cookie)).json;
    assert.equal(plan.counts.matched, 1);
    assert.deepEqual(plan.conflicts, []);
  }
});
