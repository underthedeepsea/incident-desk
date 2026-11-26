'use strict';

const { closeSync, createReadStream, createWriteStream, existsSync, fsyncSync, linkSync, mkdtempSync, openSync, rmSync } = require('node:fs');
const { dirname, join } = require('node:path');
const { backup, DatabaseSync } = require('node:sqlite');
const { pipeline } = require('node:stream/promises');
const { transaction, checkSchema } = require('./database.cjs');
const { databasePath } = require('./settings.cjs');

function assertEmpty(filename) {
  if ([filename, filename + '-wal', filename + '-shm', filename + '-journal'].some(existsSync)) {
    throw new Error('恢复目标须为空，数据库及其 SQLite 旁文件均不可存在。');
  }
}
function finalize(filename) {
  const db = new DatabaseSync(filename);
  try {
    checkSchema(db, { allowLegacy: true });
    if (db.prepare('PRAGMA integrity_check').all().some((row) => row.integrity_check !== 'ok') ||
        db.prepare('PRAGMA foreign_key_check').get()) throw new Error('数据库完整性检查失败。');
    transaction(db, () => {
      checkSchema(db, { migrate: true });
      db.exec('DELETE FROM sessions');
    });
    db.exec('PRAGMA journal_mode = DELETE;');
  } finally {
    db.close();
  }
}

function flush(filename) {
  const fd = openSync(filename, 'r');
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

async function main() {
  const [command, ...rest] = process.argv.slice(2);
  if (!['export', 'restore'].includes(command) || rest.length) {
    throw new Error('用法：node backup.cjs export > 备份.sqlite3，或停机后 node backup.cjs restore < 备份.sqlite3。');
  }
  const filename = databasePath();
  if (command === 'restore') assertEmpty(filename);
  const directory = mkdtempSync(join(dirname(filename), '.incident-desk-snapshot-'));
  const staged = join(directory, 'snapshot.sqlite3');
  try {
    if (command === 'export') {
      const db = new DatabaseSync(filename, { readOnly: true });
      try {
        checkSchema(db, { allowLegacy: true });
        db.exec('PRAGMA busy_timeout = 5000;');
        await backup(db, staged);
      } finally {
        db.close();
      }
      finalize(staged);
      await pipeline(createReadStream(staged), process.stdout);
    } else {
      await pipeline(process.stdin, createWriteStream(staged, { flags: 'wx', mode: 0o600 }));
      finalize(staged);
      assertEmpty(filename);
      flush(staged);
      linkSync(staged, filename);
      flush(dirname(filename));
      console.error('数据库已恢复。旧会话已清除，用户须重新登录。');
    }
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

process.umask(0o077);
main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
