'use strict';

(() => {
  const D = window.IncidentData;
  const loginForm = document.querySelector('#login-form');
  const passwordForm = document.querySelector('#password-form');
  const heading = document.querySelector('#login-heading');
  const message = document.querySelector('#login-error');
  const changing = new URLSearchParams(window.location.search).get('password') === '1';

  if (changing) {
    loginForm.hidden = true;
    passwordForm.hidden = false;
    heading.textContent = '更改密码';
    document.title = '更改密码 · 计算智算工单分析系统';
    const submit = passwordForm.querySelector('button');
    submit.disabled = true;
    D.request('session').then(({ account }) => {
      D.bindSession(account);
      submit.disabled = false;
    }).catch((error) => {
      message.textContent = error.message;
      message.hidden = false;
    });
  }

  document.addEventListener('submit', async (event) => {
    event.preventDefault();
    const form = event.target;
    const submit = form.querySelector('button');
    const data = Object.fromEntries(new FormData(form));
    message.hidden = true;
    submit.disabled = true;
    try {
      if (form === passwordForm && data.password !== data.confirmation) throw new Error('两次输入的新密码不一致。');
      delete data.confirmation;
      const { account } = await D.request(form === loginForm ? 'session/login' : 'session/password', data);
      window.location.replace(account.mustChange ? '/login?password=1' : '/v2/');
    } catch (error) {
      message.textContent = error.message;
      message.hidden = false;
      submit.disabled = false;
    }
  });
})();
