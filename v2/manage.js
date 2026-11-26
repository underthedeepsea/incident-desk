'use strict';

(() => {
  const D = window.IncidentData;
  const F = window.IncidentFlow;
  const list = document.querySelector('#account-list');
  const roleList = document.querySelector('#role-list');
  const history = document.querySelector('#account-history');
  const createAccount = document.querySelector('#create-account');
  const createRole = document.querySelector('#create-role');
  const message = document.querySelector('#account-message');
  const errorBox = document.querySelector('#account-error');
  const esc = (value) => String(value).replace(/[&<>"']/gu, (character) =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const actions = {
    account_created: '创建账号', account_updated: '更新账号', password_changed: '更改密码', password_reset: '重置密码',
    admin_recovery: '恢复管理员密码', role_created: '创建角色', role_updated: '更新角色'
  };
  const detailLabels = { displayName: '真实姓名', role: '角色', roleName: '角色', active: '状态', name: '角色名称', permissions: '功能' };
  const enabled = (active) => active ? '启用' : '停用';
  let currentId = '';
  let busy = false;

  function actionDetail(key, value, roleNames, permissionNames) {
    const label = (item) => {
      if (key === 'role') return roleNames.get(item) ?? item;
      if (key === 'active') return enabled(item);
      return item;
    };
    if (key === 'permissions') {
      const labels = (items) => items.map((item) => permissionNames.get(item) ?? item).join('、');
      return detailLabels[key] + ' ' + (Array.isArray(value[0]) ? value.map(labels).join(' → ') : labels(value));
    }
    return detailLabels[key] + ' ' + (Array.isArray(value) ? value.map(label).join(' → ') : label(value));
  }

  async function refresh() {
    const result = await D.request('accounts');
    const roles = result.roles;
    const roleNames = new Map(roles.map(({ id, name }) => [id, name]));
    const permissionNames = new Map(result.businessPermissions.map(({ id, name }) => [id, name]));
    permissionNames.set('accounts.manage', '管理账号与角色');
    const roleOptions = (selected) => roles.map(({ id, name }) =>
      `<option value="${esc(id)}" ${selected === id ? 'selected' : ''}>${esc(name)}</option>`).join('');
    const checkboxes = (permissions) => result.businessPermissions.map(({ id, name }) =>
      `<label><input type="checkbox" name="permission" value="${esc(id)}"
        ${permissions.includes(id) ? 'checked' : ''} ${id === 'view' ? 'disabled' : ''}> <span>${esc(name)}</span></label>`).join('');
    const createRoleSelect = createAccount.elements.role;
    createRoleSelect.innerHTML = roleOptions(createRoleSelect.value || 'operator');
    document.querySelector('#create-role-permissions').innerHTML = checkboxes(['view']);
    roleList.innerHTML = roles.map((role) => `<details class="batch-entry account-entry">
      <summary>${esc(role.name)}${role.builtIn ? ' · 内置' : ''}</summary>
      <div>${role.builtIn ? `<ul class="builtin-permissions">${role.permissions.map((id) => `<li>${esc(permissionNames.get(id))}</li>`).join('')}</ul>`
        : `<form class="role-form" method="post" data-path="roles/${esc(role.id)}" action="/api/roles/${esc(role.id)}">
          <input type="hidden" name="revision" value="${role.revision}">
          <label class="editor-field"><span>角色名称</span><input name="name" value="${esc(role.name)}" maxlength="80" required></label>
          <fieldset class="role-permissions"><legend>业务功能</legend><div>${checkboxes(role.permissions)}</div></fieldset>
          <button type="submit" class="button secondary">保存角色</button>
        </form>`}</div></details>`).join('');

    list.innerHTML = result.accounts.map((account) => `<details class="batch-entry account-entry">
      <summary>${esc(F.actorLabel(account))} · ${esc(account.roleName)} · ${enabled(account.active)}${account.mustChange ? ' · 待改密' : ''}</summary>
      <div>
        <form class="account-form" method="post" data-path="accounts/${esc(account.id)}" action="/api/accounts/${esc(account.id)}">
          <label class="editor-field"><span>真实姓名</span><input name="displayName" value="${esc(account.displayName)}" maxlength="80" required></label>
          <label class="editor-field"><span>角色</span><select name="role">${roleOptions(account.role)}</select></label>
          <label class="editor-field"><span>状态</span><select name="active"><option value="true" ${account.active ? 'selected' : ''}>启用</option><option value="false" ${account.active ? '' : 'selected'}>停用</option></select></label>
          <button type="submit" class="button secondary">保存账号</button>
        </form>
        ${account.id !== currentId ? `<form class="account-form account-reset" method="post" data-path="accounts/${esc(account.id)}/password" action="/api/accounts/${esc(account.id)}/password">
          <label class="editor-field"><span>新临时密码（至少 15 个字符）</span><input name="password" type="password" autocomplete="new-password" minlength="15" maxlength="256" required></label>
          <button type="submit" class="button secondary">重置密码</button>
        </form>` : ''}
      </div></details>`).join('');
    history.innerHTML = `<ol class="timeline">${result.history.map((event) => `<li><i></i><div><strong>${esc(actions[event.action] ?? event.action)}</strong>
      <p class="timeline-meta"><time datetime="${new Date(event.at).toISOString()}">${F.auditStamp(event.at)}（北京时间）</time>
      · ${esc(event.actor ? F.actorLabel(event.actor) : '部署端维护')} → ${esc(event.subject.name ?? F.actorLabel(event.subject))}</p>
      ${Object.keys(event.details).length ? `<p>${esc(Object.entries(event.details)
        .filter(([key]) => key !== 'role' || !Object.hasOwn(event.details, 'roleName'))
        .map(([key, value]) => actionDetail(key, value, roleNames, permissionNames)).join(' · '))}</p>` : ''}
      </div></li>`).join('')}</ol>`;
  }

  function report(error) {
    errorBox.textContent = error.message;
    errorBox.hidden = false;
  }

  document.querySelector('#manage-main').addEventListener('submit', async (event) => {
    event.preventDefault();
    if (busy) return;
    busy = true;
    const form = event.target;
    const submit = form.querySelector('button');
    const path = form.dataset.path || 'accounts';
    const data = new FormData(form);
    const editingRole = path.startsWith('roles');
    const input = editingRole ? { name: data.get('name'), permissions: ['view', ...data.getAll('permission')] } : Object.fromEntries(data);
    if (data.has('revision')) input.revision = Number(data.get('revision'));
    if (Object.hasOwn(input, 'active')) input.active = input.active === 'true';
    submit.disabled = true;
    message.hidden = true;
    errorBox.hidden = true;
    try {
      await D.request(path, input);
      form.reset();
      if (form === createRole) form.closest('details').open = false;
      message.textContent = editingRole ? '角色变更已保存。' : '账号变更已保存。';
      message.hidden = false;
      await refresh();
    } catch (error) {
      report(error);
    } finally {
      submit.disabled = false;
      busy = false;
    }
  });

  D.request('session').then(({ account }) => {
    currentId = account.id;
    D.watchSession(account);
    return refresh();
  }).then(() => {
    createAccount.querySelector('button').disabled = false;
    createRole.querySelector('button').disabled = false;
  }).catch(report);
})();
