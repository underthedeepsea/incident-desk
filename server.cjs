'use strict';

const { createServer } = require('node:http');
const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { openDatabase } = require('./database.cjs');
const { createStore, StaleRevision } = require('./store.cjs');
const { createAccounts, sessionKey, sessionMs } = require('./accounts.cjs');
const { permission } = require('./roles.cjs');
const { limits, settings } = require('./settings.cjs');
const { RequestError, revisionOf, findTicket, changeWork, editFields, changeLinks, createImporter } = require('./commands.cjs');
const F = require('./v2/workflow.js');

const cookieName = '__Host-incident_session';
const ticketPermissions = { action: permission.action, fields: permission.fields, links: permission.links };
const headers = {
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
  'X-Frame-Options': 'DENY',
  'Referrer-Policy': 'no-referrer',
  'Strict-Transport-Security': 'max-age=31536000',
  'Content-Security-Policy': "default-src 'none'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self'; connect-src 'self'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'"
};
const files = {
  '/login': ['login.html', 'text/html'],
  '/accounts': ['manage.html', 'text/html'],
  '/v2/': ['index.html', 'text/html'],
  '/v2/index.html': ['index.html', 'text/html'],
  '/v2/styles.css': ['styles.css', 'text/css'],
  '/v2/duty.css': ['duty.css', 'text/css'],
  '/v2/production.css': ['production.css', 'text/css'],
  '/v2/data.js': ['data.js', 'text/javascript'],
  '/v2/workflow.js': ['workflow.js', 'text/javascript'],
  '/v2/login.js': ['login.js', 'text/javascript'],
  '/v2/manage.js': ['manage.js', 'text/javascript'],
  '/v2/app.js': ['app.js', 'text/javascript']
};

function sessionToken(request) {
  return request.headers.cookie?.split(';').map((part) => part.trim())
    .find((part) => part.startsWith(cookieName + '='))?.slice(cookieName.length + 1);
}

const cookie = (token) => `${cookieName}=${token ?? ''}; Path=/; Secure; HttpOnly; SameSite=Strict; Max-Age=${token ? sessionMs / 1000 : 0}`;

async function jsonBody(request, limit) {
  if (request.headers['content-type']?.split(';', 1)[0].trim().toLowerCase() !== 'application/json') {
    throw new RequestError('请提交 JSON 格式的数据。', 415, 'media_type');
  }
  if (Number(request.headers['content-length']) > limit) {
    throw new RequestError('上传资料超过请求大小上限。', 413, 'too_large');
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    size += chunk.length;
    if (size > limit) throw new RequestError('上传资料超过请求大小上限。', 413, 'too_large');
    chunks.push(chunk);
  }
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(chunks)));
  } catch {
    throw new RequestError('请求含有无效的 UTF-8 或 JSON。');
  }
}

function send(response, status, payload, extra = {}, head = false, type = 'application/json') {
  const body = type === 'application/json' ? Buffer.from(JSON.stringify(payload)) : payload;
  response.writeHead(status, {
    ...headers, ...extra, 'Content-Type': type + '; charset=utf-8', 'Content-Length': body.length
  });
  response.end(head ? undefined : body);
}

function redirect(response, path) {
  response.writeHead(302, { ...headers, Location: path }).end();
}

function serve({ host, port, filename, publicOrigin, slaHours }) {
  const db = openDatabase(filename);
  const accounts = createAccounts(db);
  const store = createStore(db, accounts);
  const importer = createImporter();
  F.setSla(slaHours);
  function snapshot(state, account) {
    const owners = new Set(state.records.map((record) => record.work.owner));
    const people = accounts.people().filter((person) => owners.has(person.id) || (account.permissions.includes(permission.action) && person.assignable));
    return { ...state, account, people, slaHours, clock: { at: F.now(state), fixed: false } };
  }
  function mutate(token, required, payload, operation) {
    const { state, uid, changed, batch, account } = store.change(token, required, revisionOf(payload),
      (before, actor) => operation(before, F.now(before), actor));
    return { snapshot: snapshot(state, account), uid, changed, batch };
  }

  const server = createServer({ requestTimeout: 60_000, headersTimeout: 15_000 }, async (request, response) => {
    const token = sessionToken(request);
    const head = request.method === 'HEAD';
    const get = request.method === 'GET' || head;
    try {
      if (get && request.url === '/healthz') {
        store.ready();
        send(response, 200, { status: 'ok' }, {}, head);
        return;
      }
      if (!request.url?.startsWith('/') || request.url.startsWith('//') ||
          request.headers.host !== publicOrigin.host ||
          (request.headers.origin && request.headers.origin !== publicOrigin.origin) ||
          (request.method === 'POST' && request.headers.origin !== publicOrigin.origin)) {
        throw new RequestError('请使用配置的工作台 HTTPS 地址并从同源提交。', 403, 'origin');
      }
      const key = new URL(request.url, publicOrigin).pathname;
      if (get && (key === '/' || key === '/v2')) {
        redirect(response, '/v2/');
        return;
      }
      if (get && Object.hasOwn(files, key)) {
        const [file, type] = files[key];
        if (file === 'index.html' || file === 'manage.html') {
          try {
            accounts.context(token, file === 'manage.html' ? permission.manage : permission.view);
          } catch (error) {
            if (!(error instanceof RequestError) || error.code === 'forbidden') throw error;
            redirect(response, error.code === 'password_change' ? '/login?password=1' : '/login');
            return;
          }
        }
        send(response, 200, readFileSync(join(__dirname, 'v2', file)), {}, head, type);
        return;
      }
      const expectedSession = request.headers['x-incident-session'];
      if (key.startsWith('/api/') && key !== '/api/session/login' && expectedSession !== undefined &&
          expectedSession !== sessionKey(token)) {
        throw new RequestError('此页面的登录会话已切换，请重新打开工作台。', 409, 'session_changed');
      }
      if (key === '/api/session') {
        if (get) {
          send(response, 200, { account: accounts.context(token, 'session') }, {}, head);
          return;
        }
      }
      if (request.method === 'POST') {
        if (key === '/api/session/login') {
          const result = await accounts.login(await jsonBody(request, 16 * 1024));
          accounts.logout(token);
          send(response, 200, { account: result.account }, { 'Set-Cookie': cookie(result.token) });
          return;
        }
        if (key === '/api/session/logout') {
          accounts.logout(token);
          send(response, 200, { ok: true }, { 'Set-Cookie': cookie() });
          return;
        }
        if (key === '/api/session/password') {
          accounts.context(token, 'session');
          const result = await accounts.changePassword(token, await jsonBody(request, 16 * 1024));
          send(response, 200, { account: result.account }, { 'Set-Cookie': cookie(result.token) });
          return;
        }
      }
      if (get && key === '/api/accounts') {
        send(response, 200, accounts.list(token), {}, head);
        return;
      }
      if (request.method === 'POST' && key.startsWith('/api/accounts')) {
        accounts.context(token, permission.manage);
        const target = /^\/api\/accounts\/([\w-]+)(?:\/(password))?$/u.exec(key);
        if (key === '/api/accounts') {
          const account = await accounts.add(token, await jsonBody(request, 16 * 1024));
          send(response, 201, { account });
          return;
        }
        if (target) {
          const input = await jsonBody(request, 16 * 1024);
          if (target[2]) {
            await accounts.resetPassword(token, target[1], input);
            send(response, 200, { ok: true });
          } else send(response, 200, { account: accounts.update(token, target[1], input) });
          return;
        }
      }
      if (get && key === '/api/roles') {
        const { roles, businessPermissions } = accounts.list(token);
        send(response, 200, { roles, businessPermissions }, {}, head);
        return;
      }
      const role = /^\/api\/roles\/([\w-]+)$/u.exec(key);
      if (request.method === 'POST' && (key === '/api/roles' || role)) {
        accounts.context(token, permission.manage);
        const input = await jsonBody(request, 16 * 1024);
        send(response, role ? 200 : 201, { role: accounts.saveRole(token, input, role?.[1]) });
        return;
      }
      if (get) {
        const view = (operation) => send(response, 200, store.view(token, permission.view, operation), {}, head);
        if (key === '/api/workspace') {
          view((state, viewer) => ({ snapshot: snapshot(state, viewer) }));
          return;
        }
        if (key === '/api/tickets') {
          view(({ revision, records }) => ({ revision, records }));
          return;
        }
        const ticket = /^\/api\/tickets\/([\w-]+)(?:\/(links))?$/u.exec(key);
        if (ticket) {
          view((state) => {
            const record = findTicket(state, ticket[1]);
            const links = state.links.filter((link) => link.left === record.uid || link.right === record.uid);
            return { revision: state.revision, record: ticket[2] ? undefined : record, links };
          });
          return;
        }
        if (key === '/api/batches') {
          view(({ revision, batches }) => ({ revision, batches }));
          return;
        }
        const entry = /^\/api\/batches\/([\w-]+)$/u.exec(key);
        if (entry) {
          view(({ revision, batches }) => {
            const batch = batches.find((item) => item.id === entry[1]);
            if (!batch) throw new RequestError('未找到该导入批次。', 404, 'not_found');
            return { revision, batch };
          });
          return;
        }
        if (key === '/api/dashboard') {
          view((data, viewer) => {
            const state = snapshot(data, viewer);
            const queues = Object.fromEntries(Object.keys(F.queueLabels).map((queue) => [
              queue, state.records.filter((record) => F.matches(record, queue, state.clock.at, viewer.id)).length
            ]));
            const trend = F.trend(state.records, F.day(state.clock.at), 14, state.clock.at);
            return { revision: state.revision, clock: state.clock, queues, trend };
          });
          return;
        }
        accounts.context(token, permission.view);
      }
      if (request.method === 'POST') {
        if (key === '/api/tickets') {
          accounts.context(token, permission.create);
          const payload = await jsonBody(request, limits.bodyBytes);
          send(response, 201, mutate(token, permission.create, payload,
            (before, at, actor) => editFields(before, '', payload, at, actor)));
          return;
        }
        if (key === '/api/import/preview' || key === '/api/import/commit') {
          accounts.context(token, permission.csv);
          const payload = await jsonBody(request, limits.bodyBytes);
          if (key === '/api/import/preview') {
            const result = store.view(token, permission.csv, (state, viewer) => ({
              plan: importer.preview(state, payload, token), snapshot: snapshot(state, viewer)
            }));
            send(response, 200, result);
          } else {
            send(response, 200, mutate(token, permission.csv, payload,
              (before, at, actor) => importer.commit(before, payload, at, actor, token)));
          }
          return;
        }
        const ticket = /^\/api\/tickets\/([\w-]+)\/(action|fields|links)$/u.exec(key);
        if (ticket) {
          const [, uid, action] = ticket;
          const required = ticketPermissions[action];
          accounts.context(token, required);
          const payload = await jsonBody(request, limits.bodyBytes);
          const command = { action: changeWork, fields: editFields, links: changeLinks }[action];
          send(response, 200, mutate(token, required, payload,
            (before, at, actor) => command(before, uid, payload, at, actor, accounts.canAssign)));
          return;
        }
        accounts.context(token, permission.view);
      }
      throw new RequestError('未找到该页面或接口。', 404, 'not_found');
    } catch (error) {
      request.resume();
      if (response.headersSent || request.aborted || response.destroyed) return;
      if (error instanceof StaleRevision) {
        send(response, 409, { code: 'stale', message: '工单已更新，请载入最新数据后重试。', snapshot: snapshot(error.state, error.account) });
      } else if (error instanceof RequestError) {
        send(response, error.status, { code: error.code, message: error.message }, {}, head);
      } else {
        console.error('工作台请求失败', error.code ?? error.name);
        send(response, 500, { code: 'failed', message: '请求未完成，请联系管理员。' }, {}, head);
      }
    }
  });
  server.on('close', () => db.close());
  server.listen(port, host);
  return server;
}

if (require.main === module) {
  process.umask(0o077);
  const server = serve(settings());
  server.on('listening', () => {
    const { address, port } = server.address();
    console.log(`工单服务已监听 ${address}:${port}`);
  });
  server.on('error', (error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, () => {
      server.close();
      setTimeout(() => server.closeAllConnections(), 25_000).unref();
    });
  }
}

module.exports = { serve };
