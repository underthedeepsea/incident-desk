'use strict';

const { resolve } = require('node:path');

const limits = {
  slaHours: { P1: 2, P2: 8, P3: 24, P4: 72 },
  sessionHours: 12,
  bodyBytes: 64 * 1024 * 1024
};

function databasePath(env = process.env) {
  if (!env.INCIDENT_DB) throw new Error('请通过 INCIDENT_DB 指定生产数据库路径。');
  return resolve(env.INCIDENT_DB);
}

function settings(env = process.env) {
  const publicOrigin = new URL(env.PUBLIC_ORIGIN ?? 'about:blank');
  if (publicOrigin.protocol !== 'https:' || publicOrigin.origin !== env.PUBLIC_ORIGIN || publicOrigin.username || publicOrigin.password) {
    throw new Error('PUBLIC_ORIGIN 必须是无末尾斜杠的 HTTPS 源，例如 https://tickets.example.com。');
  }
  const port = Number(env.PORT ?? '8080');
  if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Error('PORT 必须是有效的 TCP 端口。');
  const slaHours = {};
  for (const [priority, fallback] of Object.entries(limits.slaHours)) {
    const value = Number(env['SLA_' + priority + '_HOURS'] ?? fallback);
    if (!Number.isFinite(value) || value < 1 / 60 || value > 8760) throw new Error('各级处置时限须介于 1 分钟和 8760 小时之间。');
    slaHours[priority] = value;
  }
  return { publicOrigin, port, slaHours, filename: databasePath(env), host: env.HOST ?? '127.0.0.1' };
}

module.exports = { limits, databasePath, settings };
