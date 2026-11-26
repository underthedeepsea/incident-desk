'use strict';

const { openDatabase } = require('./database.cjs');
const { createAccounts } = require('./accounts.cjs');
const { databasePath } = require('./settings.cjs');

async function fromStdin() {
  let bytes = 0;
  const parts = [];
  for await (const chunk of process.stdin) {
    bytes += chunk.length;
    if (bytes > 258) throw new Error('输入超过密码长度上限。');
    parts.push(chunk);
  }
  return new TextDecoder('utf-8', { fatal: true }).decode(Buffer.concat(parts)).replace(/\r?\n$/u, '');
}

async function main() {
  const [command, username, displayName, extra] = process.argv.slice(2);
  if (!username || !((command === 'bootstrap' && displayName && !extra) || (command === 'recover-admin' && !displayName))) {
    throw new Error('用法：node admin.cjs bootstrap <账号> <真实姓名>，或 node admin.cjs recover-admin <账号>。临时密码从标准输入传入。');
  }
  const password = await fromStdin();
  const db = openDatabase(databasePath());
  try {
    const accounts = createAccounts(db);
    const account = command === 'bootstrap'
      ? await accounts.bootstrap({ username, displayName, password })
      : await accounts.recoverAdmin({ username, password });
    console.log(`账号 ${account.username} 下次登录需要更改密码。`);
  } finally {
    db.close();
  }
}

process.umask(0o077);
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
