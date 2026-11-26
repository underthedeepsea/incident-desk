'use strict';

const { randomUUID } = require('node:crypto');
const { RequestError } = require('./commands.cjs');

const permission = Object.freeze({
  view: 'view', create: 'ticket.create', fields: 'ticket.fields', action: 'ticket.action', links: 'ticket.links',
  csv: 'csv.import', manage: 'accounts.manage'
});
const businessPermissions = [
  { id: permission.view, name: '查看工作台、工单、时间线与导入批次' },
  { id: permission.create, name: '新建工单' },
  { id: permission.fields, name: '编辑来源字段' },
  { id: permission.action, name: '处置工单与转派负责人' },
  { id: permission.links, name: '建立或解除工单关联' },
  { id: permission.csv, name: 'CSV 导入（可新建工单和更新来源字段）' }
];
const businessIds = businessPermissions.map(({ id }) => id);
const builtins = [
  { id: 'admin', name: '管理员', permissions: [...businessIds, permission.manage] },
  { id: 'operator', name: '操作员', permissions: businessIds },
  { id: 'reader', name: '只读', permissions: [permission.view] }
].map((role) => ({ ...role, builtIn: true }));
const builtinsById = new Map(builtins.map((role) => [role.id, role]));
const nameKey = (name) => name.normalize('NFKC').toLowerCase();
const reservedNames = new Set(builtins.flatMap(({ id, name }) => [id, nameKey(name)]));

function migrateRoles(db) {
  db.exec(`
    CREATE TABLE custom_roles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      name_key TEXT NOT NULL UNIQUE,
      revision INTEGER NOT NULL DEFAULT 0 CHECK (revision >= 0)
    ) STRICT;
    CREATE TABLE custom_role_permissions (
      role_id TEXT NOT NULL REFERENCES custom_roles(id),
      permission TEXT NOT NULL CHECK (permission IN ('${businessIds.slice(1).join("', '")}')),
      PRIMARY KEY (role_id, permission)
    ) STRICT;
    ALTER TABLE accounts ADD COLUMN custom_role_id TEXT REFERENCES custom_roles(id)
      CHECK (custom_role_id IS NULL OR role = 'reader');
    CREATE INDEX accounts_by_custom_role ON accounts(custom_role_id) WHERE custom_role_id IS NOT NULL;
  `);
}

function createRoles(db) {
  const byId = db.prepare('SELECT id, name, revision FROM custom_roles WHERE id = ?');
  const all = db.prepare('SELECT id, name, revision FROM custom_roles ORDER BY name_key, id');
  const byName = db.prepare('SELECT id FROM custom_roles WHERE name_key = ?');
  const grants = db.prepare('SELECT permission FROM custom_role_permissions WHERE role_id = ?');
  const addRole = db.prepare('INSERT INTO custom_roles (id, name, name_key) VALUES (?, ?, ?)');
  const updateRole = db.prepare('UPDATE custom_roles SET name = ?, name_key = ?, revision = revision + 1 WHERE id = ?');
  const clear = db.prepare('DELETE FROM custom_role_permissions WHERE role_id = ?');
  const addGrant = db.prepare('INSERT INTO custom_role_permissions (role_id, permission) VALUES (?, ?)');
  const revokeSessions = db.prepare('DELETE FROM sessions WHERE account_id IN (SELECT id FROM accounts WHERE custom_role_id = ?)');

  function describe(row) {
    const enabled = new Set(grants.all(row.id).map((grant) => grant.permission));
    return { ...row, builtIn: false, permissions: businessIds.filter((id) => id === permission.view || enabled.has(id)) };
  }

  function get(id) {
    const builtin = builtinsById.get(id);
    if (builtin) return builtin;
    const row = typeof id === 'string' ? byId.get(id) : undefined;
    return row ? describe(row) : undefined;
  }

  return {
    get,
    list: () => [...builtins, ...all.all().map(describe)],
    save(input, id) {
      if (id && builtinsById.has(id)) throw new RequestError('内置角色固定，无法编辑。', 403, 'forbidden');
      const before = id ? get(id) : undefined;
      if (id && !before) throw new RequestError('未找到该角色。', 404, 'not_found');
      if (before && before.revision !== input?.revision) {
        throw new RequestError('角色已更新，请重新载入后再修改。', 409, 'role_stale');
      }
      const name = typeof input?.name === 'string' ? input.name.trim() : '';
      if (!name || name.length > 80 || /[\p{C}\p{Zl}\p{Zp}]/u.test(name)) {
        throw new RequestError('请填写不超过 80 个字符的角色名称。');
      }
      const key = nameKey(name);
      const sameName = byName.get(key);
      if (reservedNames.has(key) || (sameName && sameName.id !== id)) {
        throw new RequestError('该角色名称已被使用。', 409, 'role_exists');
      }
      const supplied = input?.permissions;
      if (!Array.isArray(supplied) || !supplied.includes(permission.view) ||
          supplied.some((value) => !businessIds.includes(value)) || new Set(supplied).size !== supplied.length) {
        throw new RequestError('请提交有效的业务权限；查看权限必选。');
      }
      const permissions = businessIds.filter((value) => supplied.includes(value));
      const changed = !before || JSON.stringify(permissions) !== JSON.stringify(before.permissions);
      if (!changed && before.name === name) return { role: before, before, unchanged: true };
      const roleId = id ?? randomUUID();
      if (before) updateRole.run(name, key, roleId);
      else addRole.run(roleId, name, key);
      if (changed) {
        clear.run(roleId);
        for (const value of permissions) if (value !== permission.view) addGrant.run(roleId, value);
        if (before) revokeSessions.run(roleId);
      }
      return { role: get(roleId), before, unchanged: false };
    }
  };
}

module.exports = { permission, businessPermissions, migrateRoles, createRoles };
