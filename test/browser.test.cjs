'use strict';

const assert = require('node:assert/strict');
const { test } = require('node:test');
const { mkdir } = require('node:fs/promises');
const { join } = require('node:path');
const { chromium } = require(process.env.PLAYWRIGHT_MODULE || 'playwright');
const { run, testService, temporary, permanent } = require('./support.cjs');

const heading = (page, name) => page.getByRole('heading', { name, exact: true });
const clickNav = (page, route) => page.locator(`#navigation a[href="#${route}"]`).click();
const open = (page, id) => page.getByRole('button', { name: '查看工单 ' + id }).click();
const drawer = (page) => page.locator('#ticket-dialog');
const submit = (page, selector) => page.locator(selector + ' button[type=submit]').click();
const screenshotDir = process.env.AUDIT_TEST_ARTIFACTS;

async function capture(page, name) {
  const { content, viewport } = await page.evaluate(() => ({
    content: document.documentElement.scrollWidth, viewport: window.innerWidth
  }));
  assert.ok(content <= viewport, `${name} horizontal document overflow: ${content}/${viewport}`);
  if (!screenshotDir) return;
  await mkdir(screenshotDir, { recursive: true });
  await page.screenshot({ path: join(screenshotDir, name + '.png'), fullPage: true });
}

async function signIn(page, username, first = true) {
  await heading(page, '登录工作台').waitFor();
  await page.locator('#login-form [name=username]').fill(username);
  await page.locator('#login-form [name=password]').fill(first ? temporary : permanent);
  await submit(page, '#login-form');
  if (first) {
    await heading(page, '更改密码').waitFor();
    await page.locator('#password-form [name=currentPassword]').fill(temporary);
    await page.locator('#password-form [name=password]').fill(permanent);
    await page.locator('#password-form [name=confirmation]').fill(permanent);
    await submit(page, '#password-form');
  }
  await heading(page, '值班工作台').waitFor();
}

test('two browser accounts, filtered audit with multiline and empty values, original queues and delayed preview', { timeout: 85_000 }, async (t) => {
  const s = await testService(t);
  const bootstrap = run('admin.cjs', s.filename, ['bootstrap', 'alice', '王明'], temporary);
  assert.equal(bootstrap.status, 0, bootstrap.stderr.toString());
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
  t.after(() => browser.close());
  const errors = [];
  async function newPage(viewport) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport, locale: 'zh-CN', timezoneId: 'Asia/Shanghai' });
    const page = await context.newPage();
    page.setDefaultTimeout(9000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install();
    await page.goto(s.origin + '/');
    return page;
  }

  const a = await newPage({ width: 1440, height: 960 });
  await capture(a, '01-login-1440');
  await signIn(a, 'alice');
  assert.equal(await a.locator('#account-name').textContent(), '王明');
  assert.doesNotMatch(await a.locator('body').innerText(), /演示|陈澄/u);
  await capture(a, '02-empty-workbench-1440');
  assert.equal(await a.locator('.account-menu a[href="/accounts"]').count(), 0);
  await a.locator('#navigation').getByRole('link', { name: '账号与权限' }).click();
  await heading(a, '账号与权限').waitFor();
  const newAccount = a.locator('#create-account');
  await newAccount.locator('[name=username]').fill('bob');
  await newAccount.locator('[name=displayName]').fill('李平');
  await newAccount.locator('[name=password]').fill(temporary);
  await submit(a, '#create-account');
  await a.locator('#account-list summary').filter({ hasText: '李平（bob）' }).waitFor();
  await capture(a, '03-accounts-1440');
  await a.getByRole('link', { name: '返回工作台' }).click();
  await heading(a, '值班工作台').waitFor();
  await clickNav(a, 'tickets');
  await a.getByRole('button', { name: '新建工单' }).click();
  await drawer(a).getByLabel('故障事件id', { exact: false }).fill('PD-BROWSER-001');
  await drawer(a).getByLabel('故障根因', { exact: true }).fill('第一行\n<b>只作为文本</b>');
  await drawer(a).getByRole('button', { name: '保存工单' }).click();
  await a.getByRole('status').getByText('工单已创建').waitFor();
  await drawer(a).getByRole('button', { name: '关闭工单' }).click();

  const b = await newPage({ width: 320, height: 860 });
  await signIn(b, 'bob');
  assert.equal(await b.locator('#account-name').textContent(), '李平');
  assert.equal(await b.locator('#account-manage').count(), 0);
  await clickNav(b, 'tickets');
  await open(b, 'PD-BROWSER-001');
  await drawer(b).getByRole('button', { name: '来源数据' }).click();
  await drawer(b).getByLabel('故障根因', { exact: true }).fill('');
  await drawer(b).getByRole('button', { name: '保存工单' }).click();
  await b.getByRole('status').getByText('来源数据已保存').waitFor();
  await drawer(b).getByRole('button', { name: '时间线' }).click();
  await drawer(b).getByLabel('按字段筛选').selectOption({ label: '来源 · 故障根因' });
  const entries = drawer(b).locator('.timeline > li');
  assert.equal(await entries.count(), 2);
  const metadata = await entries.locator('.timeline-meta').allTextContents();
  assert.match(metadata[0], /李平（bob） · 人工操作/u);
  assert.match(metadata[1], /王明（alice） · 人工操作/u);
  const values = await entries.first().locator('.audit-diff dd p').allTextContents();
  assert.deepEqual(values, ['改前第一行\n<b>只作为文本</b>', '改后空值']);
  assert.equal(await entries.first().locator('.audit-value b').count(), 0);
  await capture(b, '04-field-audit-320');
  await drawer(b).getByRole('button', { name: '处置台' }).click();
  await drawer(b).getByRole('button', { name: '认领工单' }).click();
  await drawer(b).getByRole('button', { name: '确认认领' }).click();
  await b.getByRole('status').getByText('认领工单已保存').waitFor();
  await drawer(b).getByRole('button', { name: '更新影响与优先级' }).click();
  await drawer(b).getByLabel('优先级').selectOption('P1');
  await drawer(b).getByRole('button', { name: '确认更新影响与优先级' }).click();
  await b.getByRole('status').getByText('更新影响与优先级已保存').waitFor();
  await drawer(b).getByRole('button', { name: '关闭工单' }).click();

  await clickNav(b, 'dashboard');
  await b.locator('[data-queue=deadline]').click();
  await b.getByText('没有符合条件的工单').waitFor();
  const focus = b.locator('#ticket-search');
  await focus.fill('PD-BROWSER-001');
  await b.clock.fastForward(61 * 60 * 1000);
  await b.getByRole('button', { name: '查看工单 PD-BROWSER-001' }).waitFor();
  assert.equal(await focus.inputValue(), 'PD-BROWSER-001');
  assert.equal(await focus.evaluate((input) => input === document.activeElement), true);
  await b.clock.fastForward(61 * 60 * 1000);
  await b.locator('#ticket-results .deadline-over').waitFor();

  await clickNav(b, 'dashboard');
  const after = await b.locator('#duty-clock').textContent();
  const received = Promise.withResolvers();
  const release = Promise.withResolvers();
  await b.route('**/api/import/preview', async (route) => {
    const result = await route.fetch();
    received.resolve();
    await release.promise;
    await route.fulfill({ response: result });
  });
  await clickNav(b, 'import');
  await b.locator('#csv-file').setInputFiles({
    name: '本轮告警.csv', mimeType: 'text/csv',
    buffer: Buffer.from('故障事件id,PD应用实例,故障根因\r\nPD-BROWSER-001,worker,由 CSV 写入')
  });
  await b.locator('[data-action=prepare-import]').click();
  await received.promise;
  await b.clock.fastForward(60 * 1000);
  release.resolve();
  await b.getByText('未发现字段冲突').waitFor();
  await clickNav(b, 'dashboard');
  assert.ok((await b.locator('#duty-clock').textContent()) > after);
  await clickNav(b, 'import');
  await b.locator('#commit-import').click();
  await heading(b, '导入完成').waitFor();
  await b.getByRole('button', { name: '查看批次' }).click();
  await heading(b, '批次详情').waitFor();
  assert.match(await b.locator('.page-description').textContent(), /李平（bob）/u);
  await capture(b, '05-batch-320');
  await b.locator('.batch-entry').filter({ hasText: 'PD-BROWSER-001' }).locator('summary').click();
  await b.getByRole('button', { name: '打开工单' }).click();
  await drawer(b).getByRole('button', { name: '时间线' }).click();
  await drawer(b).getByLabel('按字段筛选').selectOption({ label: '来源 · 故障根因' });
  assert.match(await drawer(b).locator('.timeline-meta').first().textContent(), /李平（bob） · CSV 导入/u);
  assert.match(await drawer(b).locator('.audit-diff').first().textContent(), /改前空值改后由 CSV 写入/u);
  await drawer(b).getByRole('button', { name: '关闭工单' }).click();

  await a.reload();
  await clickNav(a, 'tickets');
  await open(a, 'PD-BROWSER-001');
  await drawer(a).getByRole('button', { name: '时间线' }).click();
  await capture(a, '06-timeline-1440');
  assert.deepEqual(errors, []);
});

test('admin sidebar, assignable custom role, scoped controls and revocation in an open tab', { timeout: 70_000 }, async (t) => {
  const s = await testService(t);
  const bootstrap = run('admin.cjs', s.filename, ['bootstrap', 'alice', '王明'], temporary);
  assert.equal(bootstrap.status, 0, bootstrap.stderr.toString());
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
  t.after(() => browser.close());
  const errors = [];

  async function newPage(width) {
    const context = await browser.newContext({ ignoreHTTPSErrors: true, viewport: { width, height: 860 } });
    const page = await context.newPage();
    page.setDefaultTimeout(9000);
    page.on('pageerror', (error) => errors.push(error.message));
    await page.clock.install();
    await page.goto(s.origin + '/');
    return page;
  }

  const admin = await newPage(320);
  await signIn(admin, 'alice');
  const manage = admin.locator('#navigation').getByRole('link', { name: '账号与权限' });
  assert.equal(await manage.isVisible(), true);
  await capture(admin, '07-rbac-admin-sidebar-320');
  await admin.setViewportSize({ width: 550, height: 860 });
  await capture(admin, '08-rbac-admin-sidebar-550');
  await clickNav(admin, 'tickets');
  await admin.getByRole('button', { name: '新建工单' }).click();
  await drawer(admin).getByLabel('故障事件id', { exact: false }).fill('RBAC-UI-001');
  await drawer(admin).getByRole('button', { name: '保存工单' }).click();
  await admin.getByRole('status').getByText('工单已创建').waitFor();
  await drawer(admin).getByRole('button', { name: '关闭工单' }).click();
  await manage.click();
  await heading(admin, '账号与权限').waitFor();
  await admin.getByText('新建自定义角色', { exact: true }).click();
  const newRole = admin.locator('#create-role');
  await newRole.getByLabel('角色名称').fill('来源编辑员');
  assert.equal(await newRole.getByRole('checkbox', { name: /查看工作台/u }).isDisabled(), true);
  assert.equal(await newRole.getByRole('checkbox', { name: /查看工作台/u }).isChecked(), true);
  await newRole.getByRole('checkbox', { name: '编辑来源字段' }).check();
  await submit(admin, '#create-role');
  await admin.getByRole('status').getByText('角色变更已保存。').waitFor();
  const account = admin.locator('#create-account');
  await account.getByLabel('账号', { exact: true }).fill('scoped');
  await account.getByLabel('真实姓名').fill('周宁');
  await account.getByLabel('角色').selectOption({ label: '来源编辑员' });
  await account.locator('[name=password]').fill(temporary);
  await submit(admin, '#create-account');
  await admin.locator('#account-list summary').filter({ hasText: '周宁（scoped） · 来源编辑员' }).waitFor();
  const roleDetails = admin.locator('#role-list details').filter({ has: admin.locator('summary', { hasText: '来源编辑员' }) });
  await roleDetails.locator('summary').click();
  await capture(admin, '09-rbac-role-editor-550');

  const scoped = await newPage(320);
  await signIn(scoped, 'scoped');
  assert.equal(await scoped.locator('#account-role').textContent(), '来源编辑员');
  assert.equal(await scoped.locator('#account-manage').count(), 0);
  assert.equal(await scoped.locator('#navigation a[href="#import"]').count(), 0);
  const direct = await scoped.request.get(s.origin + '/accounts');
  assert.equal(direct.status(), 403);
  const deniedRoleList = await scoped.request.get(s.origin + '/api/roles');
  assert.equal(deniedRoleList.status(), 403);
  await scoped.evaluate(() => { window.location.hash = 'import'; });
  await scoped.waitForURL('**/#dashboard');
  await clickNav(scoped, 'tickets');
  assert.equal(await scoped.getByRole('button', { name: '新建工单' }).count(), 0);
  await open(scoped, 'RBAC-UI-001');
  assert.equal(await drawer(scoped).locator('.operation-set').count(), 0);
  await drawer(scoped).getByRole('button', { name: '关联工单', exact: true }).click();
  assert.equal(await drawer(scoped).getByRole('button', { name: '建立关联' }).count(), 0);
  await drawer(scoped).getByRole('button', { name: '来源数据' }).click();
  await drawer(scoped).getByLabel('故障根因', { exact: true }).fill('按角色授权保存');
  await drawer(scoped).getByRole('button', { name: '保存工单' }).click();
  await scoped.getByRole('status').getByText('来源数据已保存').waitFor();
  await drawer(scoped).getByRole('button', { name: '时间线' }).click();
  assert.match(await drawer(scoped).locator('.timeline-meta').first().textContent(), /周宁（scoped）/u);
  await capture(scoped, '10-rbac-custom-fields-320');

  await roleDetails.getByRole('checkbox', { name: '编辑来源字段' }).uncheck();
  await roleDetails.getByRole('checkbox', { name: '新建工单', exact: true }).check();
  await roleDetails.getByRole('button', { name: '保存角色' }).click();
  await admin.getByRole('status').getByText('角色变更已保存。').waitFor();
  await admin.locator('#account-history').getByText('更新角色', { exact: true }).waitFor();
  await scoped.clock.fastForward(31_000);
  await heading(scoped, '登录工作台').waitFor();
  await signIn(scoped, 'scoped', false);
  await clickNav(scoped, 'tickets');
  await scoped.getByRole('button', { name: '新建工单' }).waitFor();
  await open(scoped, 'RBAC-UI-001');
  await drawer(scoped).getByRole('button', { name: '来源数据' }).click();
  assert.equal(await drawer(scoped).getByLabel('故障根因', { exact: true }).inputValue(), '按角色授权保存');
  assert.equal(await drawer(scoped).getByLabel('故障根因', { exact: true }).isEditable(), false);
  assert.equal(await drawer(scoped).getByRole('button', { name: '保存工单' }).count(), 0);

  // The same browser can switch cookies in another tab. An old page cannot submit under the new account.
  const newLogin = await scoped.request.post(s.origin + '/api/session/login', {
    headers: { Origin: s.origin }, data: { username: 'alice', password: permanent }
  });
  assert.equal(newLogin.status(), 200);
  await scoped.evaluate(async () => {
    try {
      await window.IncidentData.request('tickets', {
        revision: 2, source: 'pd', fields: { 故障事件id: 'RBAC-WRONG-TAB' }
      });
    } catch (error) {
      if (error.code !== 'session_changed') throw error;
    }
  }).catch((error) => {
    if (!/Execution context was destroyed/u.test(error.message)) throw error;
  });
  await scoped.locator('#navigation').getByRole('link', { name: '账号与权限' }).waitFor();
  await clickNav(scoped, 'tickets');
  assert.equal(await scoped.getByRole('button', { name: '查看工单 RBAC-WRONG-TAB' }).count(), 0);
  assert.deepEqual(errors, []);
});

test('browser file selection and drag-and-drop import a chosen XLSX tab', { timeout: 35_000 }, async (t) => {
  const { writeFile } = require('node:fs/promises');
  const XLSX = require('xlsx');
  const s = await testService(t);
  await s.bootstrap();
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_EXECUTABLE, headless: true });
  t.after(() => browser.close());
  const context = await browser.newContext({ ignoreHTTPSErrors: true, locale: 'zh-CN', viewport: { width: 1000, height: 840 } });
  const page = await context.newPage();
  page.setDefaultTimeout(8000);
  const errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  await page.goto(s.origin + '/v2/');
  await signIn(page, 'alice', false);

  function bytes(sheets) {
    const book = XLSX.utils.book_new();
    for (const [name, rows] of Object.entries(sheets)) {
      XLSX.utils.book_append_sheet(book, XLSX.utils.aoa_to_sheet(rows), name);
    }
    return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' });
  }

  await clickNav(page, 'import');
  const file = join(s.directory, '真实上传.xlsx');
  await writeFile(file, bytes({
    '备用GPU': [['故障事件id', '主机名称'], ['UNSELECTED', 'gpu']],
    '活动PD': [[], ['故障事件id', 'PD应用实例'], ['XLSX-APP', 'worker'], [null, '无 ID']]
  }));
  const prepare = page.locator('[data-action=prepare-import]');
  await page.locator('#csv-file').setInputFiles(file);
  await prepare.click();
  const selector = page.getByLabel('Excel 工作表');
  await selector.waitFor();
  assert.equal(await page.locator('#commit-import').count(), 0);
  assert.equal(await prepare.isDisabled(), true);
  await selector.selectOption('活动PD');
  await prepare.click();
  await heading(page, '合并预览').waitFor();
  await page.getByText('XLSX 第 4 行', { exact: false }).waitFor();
  await page.locator('#commit-import').click();
  await heading(page, '导入完成').waitFor();
  await page.getByRole('button', { name: '查看批次' }).click();
  await heading(page, '批次详情').waitFor();
  await page.getByText('真实上传.xlsx · XLSX · 活动PD', { exact: false }).waitFor();
  await clickNav(page, 'tickets');
  await open(page, 'XLSX-APP');
  await drawer(page).getByRole('button', { name: '时间线', exact: true }).click();
  await drawer(page).getByText('XLSX 导入批次', { exact: true }).waitFor();
  assert.match(await drawer(page).locator('.timeline-meta').first().textContent(), /XLSX 导入/u);
  await drawer(page).getByRole('button', { name: '关闭工单' }).click();
  assert.equal(await page.getByRole('button', { name: '查看工单 UNSELECTED' }).count(), 0);

  await clickNav(page, 'import');
  await page.getByRole('button', { name: '继续导入' }).click();
  const drag = await page.evaluateHandle((base64) => {
    const dataTransfer = new DataTransfer();
    const file = new File([Uint8Array.from(atob(base64), (char) => char.charCodeAt(0))], '拖入.xlsx');
    dataTransfer.items.add(file);
    return dataTransfer;
  }, bytes({ '混合云': [['故障事件id', '记录类型'], ['XLSX-DROP', 'ALERT']] }).toString('base64'));
  await page.locator('#drop-zone').dispatchEvent('drop', { dataTransfer: drag });
  await prepare.click();
  await heading(page, '合并预览').waitFor();
  await page.locator('#commit-import').click();
  await heading(page, '导入完成').waitFor();
  assert.deepEqual(errors, []);
});
