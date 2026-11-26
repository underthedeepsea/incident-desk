'use strict';

const { createHash, randomBytes, randomUUID, scrypt, timingSafeEqual } = require('node:crypto');
const { promisify } = require('node:util');
const { RequestError } = require('./commands.cjs');
const { transaction } = require('./database.cjs');
const { limits } = require('./settings.cjs');
const { businessPermissions, createRoles, permission } = require('./roles.cjs');

const derive = promisify(scrypt);
const scryptOptions = { N: 2 ** 15, r: 8, p: 3, maxmem: 64 * 1024 * 1024 };
const dummyHash = Buffer.alloc(48).toString('base64url');
const tokenPattern = /^[A-Za-z0-9_-]{43}$/u;
const sessionMs = limits.sessionHours * 60 * 60 * 1000;
const windowMs = 15 * 60 * 1000;
const userLimit = 8;
const totalLimit = 240;
const digest = (token) => createHash('sha256').update(token).digest('hex');
// A browser tab can bind its requests to the session it loaded without receiving the bearer cookie.
const sessionKey = (token) => typeof token === 'string' && tokenPattern.test(token)
  ? digest('incident-desk-page:' + digest(token)) : undefined;
const usernamePattern = /^[a-z0-9][a-z0-9._-]{2,63}$/u;
const safeName = (value) => typeof value === 'string' && value.trim().length > 0 && value.trim().length <= 80 &&
  !/[\p{C}\p{Zl}\p{Zp}]/u.test(value);
const identity = (row) => ({ id: row.id, username: row.username, displayName: row.display_name });
const denied = () => new RequestError('请登录后继续。', 401, 'sign_in');
const wrongPassword = () => new RequestError('账号或密码有误。', 401, 'invalid_login');

function validatePassword(value) {
  if (typeof value !== 'string' || !value.isWellFormed() || [...value].length < 15 || Buffer.byteLength(value) > 256 || value.includes('\0')) {
    throw new RequestError('密码至少 15 个字符，UTF-8 长度最多 256 字节。');
  }
}

function createAccounts(db) {
  const roles = createRoles(db);
  let inFlight = 0;
  let loginWindow = 0;
  let loginCount = 0;
  const userAttempts = new Map();
  const byUsername = db.prepare('SELECT * FROM accounts WHERE username = ?');
  const byId = db.prepare('SELECT * FROM accounts WHERE id = ?');
  const activeAdminCount = db.prepare("SELECT count(*) AS n FROM accounts WHERE role = 'admin' AND active = 1");
  const accountCount = db.prepare('SELECT count(*) AS n FROM accounts');
  const accountList = db.prepare('SELECT id, username, display_name, role, custom_role_id, active, must_change FROM accounts ORDER BY display_name, username');
  const insert = db.prepare(`INSERT INTO accounts (id, username, display_name, role, custom_role_id, password_hash, active, must_change)
    VALUES (?, ?, ?, ?, ?, ?, 1, 1)`);
  const update = db.prepare('UPDATE accounts SET display_name = ?, role = ?, custom_role_id = ?, active = ? WHERE id = ?');
  const assignableAccounts = db.prepare(`SELECT id, username, display_name,
    (active = 1 AND (role IN ('admin', 'operator') OR EXISTS (
      SELECT 1 FROM custom_role_permissions WHERE role_id = accounts.custom_role_id AND permission = ?
    ))) AS assignable FROM accounts ORDER BY display_name, username`);
  const assignableAccount = db.prepare(`SELECT 1 FROM accounts WHERE id = ? AND active = 1
    AND (role IN ('admin', 'operator') OR EXISTS (
      SELECT 1 FROM custom_role_permissions WHERE role_id = accounts.custom_role_id AND permission = ?
    ))`);
  const newPassword = db.prepare('UPDATE accounts SET password_hash = ?, must_change = ? WHERE id = ?');
  const lookup = db.prepare(`SELECT a.* FROM accounts a JOIN sessions s ON a.id = s.account_id
    WHERE s.digest = ? AND s.expires_at > ? AND a.active = 1`);
  const revoke = db.prepare('DELETE FROM sessions WHERE account_id = ?');
  const revokeOne = db.prepare('DELETE FROM sessions WHERE digest = ?');
  const oldSessions = db.prepare('DELETE FROM sessions WHERE expires_at <= ?');
  const newSession = db.prepare('INSERT INTO sessions VALUES (?, ?, ?)');
  const writeHistory = db.prepare('INSERT INTO account_history (at, actor_json, subject_json, action, details_json) VALUES (?, ?, ?, ?, ?)');
  const readHistory = db.prepare('SELECT at, actor_json, subject_json, action, details_json FROM account_history ORDER BY sequence DESC LIMIT 100');

  function profile(row) {
    const role = roles.get(row.custom_role_id ?? row.role);
    return {
      ...identity(row), role: role.id, roleName: role.name, permissions: role.permissions,
      active: Boolean(row.active), mustChange: Boolean(row.must_change)
    };
  }

  async function deriveKey(password, salt) {
    if (inFlight >= 2) throw new RequestError('账号服务正在处理其他请求，请稍后重试。', 429, 'try_later');
    inFlight += 1;
    try {
      return await derive(password, salt, 32, scryptOptions);
    } finally {
      inFlight -= 1;
    }
  }

  async function hashPassword(password) {
    validatePassword(password);
    const salt = randomBytes(16);
    return Buffer.concat([salt, await deriveKey(password, salt)]).toString('base64url');
  }

  async function verifyPassword(password, hash) {
    if (typeof password !== 'string' || !password.isWellFormed() || Buffer.byteLength(password) > 256 || password.includes('\0')) return false;
    const stored = Buffer.from(hash ?? dummyHash, 'base64url');
    return timingSafeEqual(stored.subarray(16), await deriveKey(password, stored.subarray(0, 16)));
  }

  function credentials(input) {
    const username = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : '';
    const displayName = input?.displayName;
    const role = roles.get(input?.role);
    if (!usernamePattern.test(username) || !safeName(displayName) || !role) {
      throw new RequestError('请填写有效的账号、真实姓名和角色。账号为 3–64 位，使用字母、数字、点、下划线或连字符。');
    }
    return { username, displayName: displayName.trim(), role };
  }

  function history(at, actor, subject, action, details = {}) {
    writeHistory.run(at, JSON.stringify(actor), JSON.stringify(subject), action, JSON.stringify(details));
  }

  function establish(row, at) {
    const token = randomBytes(32).toString('base64url');
    oldSessions.run(at);
    newSession.run(digest(token), row.id, at + sessionMs);
    return { token, account: { ...profile(row), sessionKey: sessionKey(token) } };
  }

  function context(token, restriction = permission.view, at = Date.now()) {
    const row = typeof token === 'string' && tokenPattern.test(token) ? lookup.get(digest(token), at) : undefined;
    if (!row) throw denied();
    if (restriction !== 'session' && row.must_change) {
      throw new RequestError('请先更改临时密码。', 403, 'password_change');
    }
    const account = profile(row);
    if (restriction !== 'session' && !account.permissions.includes(restriction)) {
      throw new RequestError('当前账号没有此操作权限。', 403, 'forbidden');
    }
    return { ...account, sessionKey: sessionKey(token), actor: identity(row) };
  }

  function add(input, hash, actor, at) {
    const { username, displayName, role } = credentials(input);
    if (byUsername.get(username)) throw new RequestError('该账号已存在。', 409, 'account_exists');
    const id = randomUUID();
    insert.run(id, username, displayName, role.builtIn ? role.id : 'reader', role.builtIn ? null : role.id, hash);
    const row = byId.get(id);
    history(at, actor, identity(row), 'account_created', { role: role.id, ...(role.builtIn ? {} : { roleName: role.name }) });
    return profile(row);
  }

  return {
    context,
    async bootstrap(input) {
      if (accountCount.get().n) throw new RequestError('已有账号，请由工作台管理员继续维护。');
      const account = { ...input, role: 'admin' };
      credentials(account);
      const hash = await hashPassword(input.password);
      return transaction(db, () => {
        if (accountCount.get().n) throw new RequestError('已有账号，请由工作台管理员继续维护。');
        return add(account, hash, null, Date.now());
      });
    },
    async recoverAdmin(input) {
      const hash = await hashPassword(input.password);
      return transaction(db, () => {
        const row = byUsername.get(input.username.trim().toLowerCase());
        if (!row?.active || row.role !== 'admin') throw new RequestError('请选择一名启用的管理员。');
        newPassword.run(hash, 1, row.id);
        revoke.run(row.id);
        history(Date.now(), null, identity(row), 'admin_recovery');
        return profile(row);
      });
    },
    async login(input) {
      const username = typeof input?.username === 'string' ? input.username.trim().toLowerCase() : '';
      const now = Date.now();
      if (now >= loginWindow + windowMs) {
        loginWindow = now;
        loginCount = 0;
        userAttempts.clear();
      }
      const attempts = userAttempts.get(username) ?? 0;
      if (attempts >= userLimit || loginCount >= totalLimit) {
        throw new RequestError('登录尝试过于频繁，请稍后重试。', 429, 'try_later');
      }
      loginCount += 1;
      if (usernamePattern.test(username)) userAttempts.set(username, attempts + 1);
      const row = usernamePattern.test(username) ? byUsername.get(username) : undefined;
      if (!(await verifyPassword(input?.password, row?.password_hash)) || !row?.active) throw wrongPassword();
      return transaction(db, () => {
        const latest = byId.get(row.id);
        if (!latest?.active || latest.password_hash !== row.password_hash) throw wrongPassword();
        userAttempts.delete(username);
        return establish(latest, Date.now());
      });
    },
    logout(token) {
      if (typeof token === 'string' && tokenPattern.test(token)) revokeOne.run(digest(token));
    },
    async changePassword(token, input) {
      const current = context(token, 'session');
      const row = byId.get(current.id);
      if (!(await verifyPassword(input?.currentPassword, row.password_hash))) {
        throw new RequestError('当前密码有误。');
      }
      if (input.currentPassword === input.password) throw new RequestError('新密码须与当前密码不同。');
      const hash = await hashPassword(input.password);
      return transaction(db, () => {
        const active = context(token, 'session');
        const latest = byId.get(active.id);
        if (latest.password_hash !== row.password_hash) throw denied();
        const at = Date.now();
        newPassword.run(hash, 0, active.id);
        revoke.run(active.id);
        history(at, active.actor, identity(latest), 'password_changed');
        return establish(byId.get(active.id), at);
      });
    },
    people() {
      return assignableAccounts.all(permission.action).map((row) => ({ ...identity(row), assignable: Boolean(row.assignable) }));
    },
    canAssign(id) {
      return typeof id === 'string' && Boolean(assignableAccount.get(id, permission.action));
    },
    list(token) {
      return transaction(db, () => {
        context(token, permission.manage);
        return {
          accounts: accountList.all().map(profile),
          roles: roles.list(),
          businessPermissions,
          history: readHistory.all().map((row) => ({
            at: row.at, actor: JSON.parse(row.actor_json), subject: JSON.parse(row.subject_json),
            action: row.action, details: JSON.parse(row.details_json)
          }))
        };
      }, 'BEGIN');
    },
    saveRole(token, input, id) {
      return transaction(db, () => {
        const { actor } = context(token, permission.manage);
        const { role, before, unchanged } = roles.save(input, id);
        if (!unchanged) {
          const details = before ? {} : { permissions: role.permissions };
          if (before && before.name !== role.name) details.name = [before.name, role.name];
          if (before && JSON.stringify(before.permissions) !== JSON.stringify(role.permissions)) {
            details.permissions = [before.permissions, role.permissions];
          }
          history(Date.now(), actor, { id: role.id, name: role.name }, before ? 'role_updated' : 'role_created', details);
        }
        return role;
      });
    },
    async add(token, input) {
      context(token, permission.manage);
      credentials(input);
      const hash = await hashPassword(input.password);
      return transaction(db, () => add(input, hash, context(token, permission.manage).actor, Date.now()));
    },
    update(token, id, input) {
      return transaction(db, () => {
        const actor = context(token, permission.manage).actor;
        const previous = byId.get(id);
        if (!previous) throw new RequestError('未找到该账号。', 404, 'not_found');
        const previousRole = roles.get(previous.custom_role_id ?? previous.role);
        const { displayName, role } = credentials({ ...input, username: previous.username });
        if (typeof input.active !== 'boolean') throw new RequestError('请选择账户状态。');
        const active = Number(input.active);
        if (previous.active && previous.role === 'admin' && (!active || role.id !== 'admin') && activeAdminCount.get().n === 1) {
          throw new RequestError('至少需要保留一名启用的管理员。');
        }
        const fields = {
          displayName: [previous.display_name, displayName], role: [previousRole.id, role.id], active: [Boolean(previous.active), input.active]
        };
        const diff = Object.fromEntries(Object.entries(fields).filter(([, [before, after]]) => before !== after));
        if (!Object.keys(diff).length) return profile(previous);
        update.run(displayName, role.builtIn ? role.id : 'reader', role.builtIn ? null : role.id, active, id);
        if (!active || diff.role) revoke.run(id);
        if (diff.role && (!previousRole.builtIn || !role.builtIn)) diff.roleName = [previousRole.name, role.name];
        const latest = byId.get(id);
        history(Date.now(), actor, identity(latest), 'account_updated', diff);
        return profile(latest);
      });
    },
    async resetPassword(token, id, input) {
      const current = context(token, permission.manage);
      if (current.id === id) throw new RequestError('请通过“更改密码”更新自己的密码。');
      const hash = await hashPassword(input?.password);
      return transaction(db, () => {
        const actor = context(token, permission.manage).actor;
        const row = byId.get(id);
        if (!row) throw new RequestError('未找到该账号。', 404, 'not_found');
        newPassword.run(hash, 1, id);
        revoke.run(id);
        history(Date.now(), actor, identity(row), 'password_reset');
      });
    }
  };
}

module.exports = { createAccounts, sessionKey, sessionMs };
