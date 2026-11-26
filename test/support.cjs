'use strict';

const assert = require('node:assert/strict');
const { createServer: httpServer, request: http } = require('node:http');
const { createServer: httpsServer, request: https } = require('node:https');
const { spawn, spawnSync } = require('node:child_process');
const { once } = require('node:events');
const { mkdtemp, readFile, rm } = require('node:fs/promises');
const { join } = require('node:path');
const { tmpdir } = require('node:os');

const root = join(__dirname, '..');
const temporary = 'Test-Temporary-Passphrase-27';
const permanent = 'Test-Permanent-Passphrase-61';
const wait = (duration) => new Promise((resolve) => setTimeout(resolve, duration));

function run(script, filename, args, input) {
  const result = spawnSync(process.execPath, [join(root, script), ...args], {
    env: { ...process.env, INCIDENT_DB: filename }, input, maxBuffer: 10 * 1024 * 1024
  });
  return result;
}

async function testService(t) {
  const directory = await mkdtemp(join(tmpdir(), 'incident-desk-prod-test-'));
  const filename = join(directory, 'workspace.sqlite3');
  const key = join(directory, 'test-key.pem');
  const cert = join(directory, 'test-cert.pem');
  const openssl = spawnSync('openssl', ['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-days', '1',
    '-subj', '/CN=127.0.0.1', '-keyout', key, '-out', cert]);
  assert.equal(openssl.status, 0, openssl.stderr?.toString());

  let service;
  let port;
  const proxy = httpsServer({ key: await readFile(key), cert: await readFile(cert) }, (request, response) => {
    const upstream = http({ host: '127.0.0.1', port, path: request.url, method: request.method, headers: request.headers },
      (incoming) => {
        response.writeHead(incoming.statusCode, incoming.headers);
        incoming.pipe(response);
      });
    upstream.on('error', () => response.writeHead(502).end());
    request.pipe(upstream);
  });
  proxy.listen(0, '127.0.0.1');
  await once(proxy, 'listening');
  const origin = `https://127.0.0.1:${proxy.address().port}`;

  async function start(path = filename) {
    const reservation = httpServer();
    reservation.listen(0, '127.0.0.1');
    await once(reservation, 'listening');
    port = reservation.address().port;
    await new Promise((resolve) => reservation.close(resolve));
    const env = { ...process.env, HOST: '127.0.0.1', PORT: String(port), INCIDENT_DB: path, PUBLIC_ORIGIN: origin };
    service = spawn(process.execPath, [join(root, 'server.cjs')], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let diagnostics = '';
    service.stderr.on('data', (chunk) => { diagnostics += chunk; });
    const deadline = Date.now() + 8000;
    while (Date.now() < deadline) {
      const response = await fetch(`http://127.0.0.1:${port}/healthz`).catch(() => null);
      if (response?.ok) {
        assert.deepEqual(await response.json(), { status: 'ok' });
        return;
      }
      if (service.exitCode !== null) break;
      await wait(50);
    }
    throw new Error('工作台未就绪。' + diagnostics);
  }

  async function stop(signal = 'SIGTERM') {
    if (!service || service.exitCode !== null || service.signalCode !== null) return;
    const exited = once(service, 'exit');
    service.kill(signal);
    await exited;
  }

  t.after(async () => {
    await stop();
    proxy.closeAllConnections();
    await new Promise((resolve) => proxy.close(resolve));
    await rm(directory, { recursive: true, force: true });
  });

  function request(path, { cookie, originHeader = origin, body, headers = {} } = {}) {
    const post = body !== undefined;
    return new Promise((resolve, reject) => {
      const req = https(origin + path, {
        rejectUnauthorized: false, method: post ? 'POST' : 'GET', headers: {
          ...(post ? { 'Content-Type': 'application/json' } : {}),
          ...(cookie ? { Cookie: cookie } : {}),
          ...(post && originHeader ? { Origin: originHeader } : {}),
          ...headers
        }
      }, (response) => {
        const parts = [];
        response.on('data', (chunk) => parts.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(parts).toString();
          const json = response.headers['content-type']?.startsWith('application/json') && text ? JSON.parse(text) : null;
          resolve({ status: response.statusCode, headers: response.headers, text, json });
        });
      });
      req.on('error', reject);
      req.end(post ? JSON.stringify(body) : undefined);
    });
  }

  async function api(path, body, cookie, expected = 200, extra) {
    const response = await request('/api/' + path, { ...extra, body, cookie });
    assert.equal(response.status, expected, JSON.stringify({ path, body: response.json }));
    return response;
  }

  async function login(username, password) {
    const response = await api('session/login', { username, password });
    const header = response.headers['set-cookie'][0];
    assert.match(header, /^__Host-incident_session=[\w-]{43}; Path=\/; Secure; HttpOnly; SameSite=Strict; Max-Age=43200$/u);
    return { account: response.json.account, cookie: header.split(';', 1)[0] };
  }

  async function changePassword(session, currentPassword = temporary, password = permanent) {
    const response = await api('session/password', { currentPassword, password }, session.cookie);
    return { account: response.json.account, cookie: response.headers['set-cookie'][0].split(';', 1)[0] };
  }

  async function addAccount(admin, username, role, displayName) {
    return (await api('accounts', { username, role, displayName, password: temporary }, admin.cookie, 201)).json.account;
  }

  async function bootstrap() {
    const result = run('admin.cjs', filename, ['bootstrap', 'alice', '王明'], temporary);
    assert.equal(result.status, 0, result.stderr.toString());
    return changePassword(await login('alice', temporary));
  }

  async function workspace(session) {
    return (await api('workspace', undefined, session.cookie)).json.snapshot;
  }

  await start();
  return { directory, filename, origin, start, stop, request, api, login, changePassword, addAccount, bootstrap, workspace };
}

module.exports = { testService, run, temporary, permanent, root };
