'use strict';

const { readFileSync } = require('node:fs');
const { join } = require('node:path');
const { DatabaseSync } = require('node:sqlite');
const { migrateRoles } = require('./roles.cjs');

const applicationId = 0x49445031;
const schemaVersion = 2;

function transaction(db, operation, begin = 'BEGIN IMMEDIATE') {
  db.exec(begin);
  try {
    const result = operation();
    db.exec('COMMIT');
    return result;
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  }
}

function checkSchema(db, { initialize = false, migrate = false, allowLegacy = false } = {}) {
  const { application_id } = db.prepare('PRAGMA application_id').get();
  const { user_version } = db.prepare('PRAGMA user_version').get();
  if (application_id === applicationId && user_version === schemaVersion) return;
  if (initialize && application_id === 0 && user_version === 0 &&
      db.prepare('SELECT count(*) AS n FROM sqlite_schema').get().n === 0) {
    db.exec(readFileSync(join(__dirname, 'schema.sql'), 'utf8'));
  } else if (application_id !== applicationId || user_version !== 1 || (!migrate && !allowLegacy)) {
    throw new Error('数据库不是受支持版本的生产工作台。');
  }
  if (migrate || initialize) {
    if (db.prepare('PRAGMA foreign_key_check').get()) throw new Error('数据库外键完整性检查失败。');
    migrateRoles(db);
    db.exec(`PRAGMA user_version = ${schemaVersion}`);
  }
}

function openDatabase(filename) {
  const db = new DatabaseSync(filename);
  try {
    db.exec('PRAGMA busy_timeout = 5000; PRAGMA foreign_keys = ON;');
    transaction(db, () => checkSchema(db, { initialize: true, migrate: true }));
    if (db.prepare('PRAGMA journal_mode = WAL').get().journal_mode !== 'wal') {
      throw new Error('当前卷不能启用 SQLite WAL。');
    }
    db.exec('PRAGMA synchronous = FULL;');
    return db;
  } catch (error) {
    db.close();
    throw error;
  }
}

module.exports = { openDatabase, transaction, checkSchema };
