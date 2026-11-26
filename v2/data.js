'use strict';

const incidentData = (() => {
  const ID = '故障事件id';
  const STATUS = '当前状态';
  const SYMPTOM = '故障现象';
  const ROOT = '故障根因';
  const BU = '影响BU';
  const RECOVERY = '故障恢复时间（支持人工编辑）';
  const ANONYMOUS = '\u0000';
  const sources = {
    pd: {
      name: '内部云 PD 告警',
      short: '内部云 PD',
      start: '故障发生时间',
      end: RECOVERY,
      markers: ['PD应用实例', 'Pod名称', '节点卡类型', '命名空间', '用户集群'],
      fields: ['恢复手段', SYMPTOM, BU, '影响业务时长', ROOT, '故障根因一级类型', RECOVERY, STATUS, ID, 'PD应用实例', 'Pod名称', '节点IP', '节点卡类型', '命名空间', '用户集群', '资源池集群', '故障发生时间', '创建时间', '更新时间']
    },
    hybrid: {
      name: '混合云告警',
      short: '混合云',
      start: '故障发生时间（告警时间）',
      end: RECOVERY,
      markers: ['告警名称（ARMS）', '集群名称（ARMS）', '应用名称（ARMS）', '通知策略（ARMS）', '告警内容（ARMS）', '记录类型 ALERT/UNPAIRED_RECOVER', '完整原始推送体'],
      fields: [RECOVERY, '恢复手段', SYMPTOM, BU, '影响业务时长', ROOT, '故障根因一级类型', STATUS, ID, '告警名称（ARMS）', '集群名称（ARMS）', '应用名称（ARMS）', '通知策略（ARMS）', '告警内容（ARMS）', '故障发生时间（告警时间）', '记录类型 ALERT/UNPAIRED_RECOVER', '完整原始推送体', '创建时间', '更新时间']
    },
    gpu: {
      name: 'GPU 节点告警',
      short: 'GPU 节点',
      start: '故障发生时间',
      end: '故障恢复时间',
      markers: ['故障来源', '序列号', '主机名称', '主机IP', 'GPU型号'],
      fields: ['恢复手段', SYMPTOM, BU, '影响业务时长', ROOT, '故障类型', STATUS, '故障来源', ID, '序列号', '主机名称', '主机IP', 'GPU型号', '资源池集群', '故障发生时间', '故障恢复时间']
    }
  };
  const stages = {
    open: { label: '处理中', color: '#ec6b32' },
    resolved: { label: '已恢复', color: '#6e9982' },
    available: { label: '可用', color: '#a9b9b1' },
    unavailable: { label: '不可用', color: '#bc5871' },
    pending: { label: '待处理', color: '#e6ab5d' },
    other: { label: '其他 / 未填写', color: '#b6a8a0' }
  };
  const pad = (value) => String(value).padStart(2, '0');
  function shiftDay(day, delta) {
    const date = new Date(day + 'T12:00:00Z');
    date.setUTCDate(date.getUTCDate() + delta);
    return date.toISOString().slice(0, 10);
  }
  function datePart(value) {
    const match = /^(\d{4})([-/.])(\d{1,2})\2(\d{1,2})(?=$|[ Tt])/u.exec(String(value).trim());
    if (!match) return '';
    const day = `${match[1]}-${pad(match[3])}-${pad(match[4])}`;
    const date = new Date(day + 'T12:00:00Z');
    return Number.isFinite(date.valueOf()) && date.toISOString().slice(0, 10) === day ? day : '';
  }
  function timePart(value) {
    const match = /^[\d/.-]+[ Tt]+(\d{1,2}):(\d{2})(?::(\d{2}))?/u.exec(value.trim());
    if (!match) return '';
    const [, hour, minute, second] = match;
    if (Number(hour) > 23 || Number(minute) > 59 || Number(second ?? 0) > 59) return '';
    return `${pad(hour)}:${minute}${second === undefined ? '' : ':' + second}`;
  }
  function statusKey(value) {
    const matching = Object.keys(stages).find((key) => stages[key].label === value.trim());
    return matching || 'other';
  }
  function valueOf(record, key) {
    return Object.hasOwn(record.fields, key) ? record.fields[key] : '';
  }
  const isBlank = (value) => !value.trim();
  const fieldName = (key) => key.startsWith(ANONYMOUS) ? (key === ANONYMOUS + '1' ? '序号（原空表头）' : `未命名列 ${key.slice(1)}`) : key;
  const identity = (source, id) => JSON.stringify([source, id]);
  const getTime = (record, type) => valueOf(record, sources[record.source][type]);
  function newUid() {
    const crypto = globalThis.crypto;
    return crypto.randomUUID?.() ?? [...crypto.getRandomValues(new Uint8Array(16))].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  }
  function parseCsv(text) {
    const rows = [];
    const input = text.replace(/^\uFEFF/u, '');
    let values = [];
    let value = '';
    let state = 'start';
    let line = 1;
    let rowLine = 1;
    const finishField = () => {
      values.push(value);
      value = '';
      state = 'start';
    };
    const finishRow = () => {
      finishField();
      rows.push({ values, line: rowLine });
      values = [];
    };
    for (let index = 0; index < input.length; index += 1) {
      const char = input[index];
      if (char === '\r' || char === '\n') {
        const newline = char === '\r' && input[index + 1] === '\n' ? '\r\n' : char;
        if (newline.length === 2) index += 1;
        if (state === 'quoted') value += newline;
        else finishRow();
        line += 1;
        if (state !== 'quoted') rowLine = line;
      } else if (state === 'quoted') {
        if (char !== '"') value += char;
        else if (input[index + 1] === '"') {
          value += '"';
          index += 1;
        } else state = 'closed';
      } else if (char === ',') finishField();
      else if (char === '"' && state === 'start') state = 'quoted';
      else if (char === '"' || state === 'closed') {
        throw new Error(`CSV 第 ${line} 行第 ${values.length + 1} 列的引号格式有误。`);
      } else {
        value += char;
        state = 'plain';
      }
    }
    if (state === 'quoted') throw new Error(`CSV 第 ${rowLine} 行有未闭合的引号。`);
    if (state !== 'start' || values.length) finishRow();
    return rows;
  }

  const compactHeader = (header) => header.trim().replace(/\s+/gu, '').replace(/\(/gu, '（').replace(/\)/gu, '）').toLowerCase();
  function canonicalHeader(header, index, source) {
    if (isBlank(header)) return ANONYMOUS + (index + 1);
    const name = compactHeader(header);
    if (name === '故障事件id' || (source === 'hybrid' && name.startsWith('故障事件idfev'))) return ID;
    if (source === 'hybrid' && name === '记录类型') return '记录类型 ALERT/UNPAIRED_RECOVER';
    if (source === 'hybrid' && name === '故障发生时间') return sources.hybrid.start;
    if (source !== 'gpu' && name === '故障恢复时间') return RECOVERY;
    return sources[source].fields.find((field) => compactHeader(field) === name) || header;
  }
  function detectSource(headers) {
    const names = new Set(headers.map(compactHeader));
    const matches = Object.keys(sources).filter((source) => sources[source].markers.some((marker) => names.has(compactHeader(marker))));
    if (names.has('记录类型') || [...names].some((name) => name.startsWith('故障事件idfev'))) {
      if (!matches.includes('hybrid')) matches.push('hybrid');
    }
    return matches.length === 1 ? matches[0] : '';
  }
  function readCsv(text, selectedSource) {
    const parsed = parseCsv(text);
    const heading = parsed.findIndex((row) => row.values.some((value) => !isBlank(value)));
    if (heading < 0) throw new Error('CSV 文件没有表头或数据。');
    const header = parsed[heading].values;
    const source = selectedSource || detectSource(header);
    if (!source) throw new Error('无法从表头辨认告警来源，请先选择此文件的表格来源。');
    const fields = header.map((value, index) => {
      if (value.includes(ANONYMOUS)) throw new Error(`第 ${index + 1} 列的表头含有无效字符。`);
      return canonicalHeader(value, index, source);
    });
    const idIndex = fields.indexOf(ID);
    if (idIndex < 0) throw new Error(`第 ${parsed[heading].line} 行表头缺少“故障事件id”列。`);
    const duplicate = fields.find((field, index) => fields.indexOf(field) !== index);
    if (duplicate) throw new Error(`表头含重复字段“${fieldName(duplicate)}”，请保留唯一列名。`);
    const rows = [];
    const invalidRows = [];
    for (const row of parsed.slice(heading + 1)) {
      if (row.values.every(isBlank)) continue;
      if (row.values.length > fields.length) {
        invalidRows.push({ line: row.line, message: '数据的列数多于表头' });
      } else if (isBlank(row.values[idIndex] ?? '') || row.values[idIndex].includes(ANONYMOUS)) {
        invalidRows.push({ line: row.line, message: '缺少有效的故障事件 ID' });
      } else {
        rows.push({
          line: row.line,
          id: row.values[idIndex],
          fields: Object.fromEntries(fields.map((field, index) => [field, row.values[index] ?? '']))
        });
      }
    }
    if (!rows.length && !invalidRows.length) throw new Error('CSV 表头下面没有数据行。');
    return { source, rows, invalidRows };
  }

  function planImport(snapshot, incoming) {
    const fromSystem = new Map(snapshot.records.map((record) => [identity(record.source, valueOf(record, ID)), record]));
    const grouped = new Map();
    for (const row of incoming.rows) {
      if (!grouped.has(row.id)) grouped.set(row.id, []);
      grouped.get(row.id).push(row);
    }
    const counts = { rows: incoming.rows.length, new: 0, matched: 0, filled: 0, equal: 0, preserved: 0, duplicates: incoming.rows.length - grouped.size };
    const changes = [];
    const conflicts = [];
    for (const [id, rows] of grouped) {
      const existing = fromSystem.get(identity(incoming.source, id));
      counts[existing ? 'matched' : 'new'] += 1;
      const fields = new Map(Object.entries(existing?.fields ?? {}));
      const selected = [];
      for (const key of Object.keys(rows[0].fields)) {
        const current = fields.get(key) ?? '';
        const options = new Map();
        for (const row of rows) {
          const cell = row.fields[key];
          if (isBlank(cell)) {
            if (!isBlank(current)) counts.preserved += 1;
            continue;
          }
          if (!options.has(cell)) options.set(cell, []);
          options.get(cell).push(row.line);
        }
        const equal = options.get(current)?.length ?? 0;
        const repeated = [...options.values()].reduce((total, lines) => total + lines.length - 1, 0);
        counts.equal += equal + repeated - Math.max(0, equal - 1);
        if (!options.size || (options.size === 1 && options.has(current))) continue;
        if (options.size === 1 && isBlank(current)) {
          fields.set(key, options.keys().next().value);
          if (existing) counts.filled += 1;
          continue;
        }
        const result = {
          index: conflicts.length, id, field: key,
          candidates: [...(!isBlank(current) ? [{ value: current, system: true, lines: options.get(current) ?? [] }] : []),
            ...[...options].filter(([value]) => isBlank(current) || value !== current).map(([value, lines]) => ({ value, system: false, lines }))]
        };
        selected.push(result);
        conflicts.push(result);
      }
      // Include newly seen blank extension columns, so their cells remain editable.
      const columns = new Set(Object.keys(rows[0].fields));
      for (const key of columns) if (!fields.has(key)) fields.set(key, rows[0].fields[key]);
      changes.push({ existing, fields, selected });
    }
    return { source: incoming.source, revision: snapshot.revision, counts, invalidRows: incoming.invalidRows, conflicts, changes };
  }
  function applyImport(snapshot, plan, choices) {
    if (snapshot.revision !== plan.revision) throw new Error('工单已在其他操作中更新，请重新生成预览。');
    const replacements = new Map();
    const inserted = [];
    for (const change of plan.changes) {
      const fields = new Map(change.fields);
      for (const conflict of change.selected) {
        const candidate = conflict.candidates[choices.get(conflict.index)];
        if (!candidate) throw new Error('请先为所有冲突字段选择要保存的值。');
        fields.set(conflict.field, candidate.value);
      }
      const newFields = Object.fromEntries(fields);
      if (change.existing) {
        const oldFields = change.existing.fields;
        if (Object.keys(newFields).length !== Object.keys(oldFields).length || Object.entries(newFields).some(([key, value]) => !Object.hasOwn(oldFields, key) || oldFields[key] !== value)) {
          replacements.set(change.existing.uid, { ...change.existing, fields: newFields });
        }
      } else {
        inserted.push({ uid: newUid(), source: plan.source, fields: newFields });
      }
    }
    return {
      records: [...inserted, ...snapshot.records.map((record) => replacements.get(record.uid) ?? record)],
      inserted: inserted.length, updated: replacements.size
    };
  }

  let pageSession;
  function bindSession(account) { pageSession = account.sessionKey; }

  function watchSession(account) {
    bindSession(account);
    let checking = false;
    async function check() {
      if (document.hidden || checking) return;
      checking = true;
      try {
        await request('session');
      } catch {
        // A disconnected tab will retry after focus or on the next check.
      } finally {
        checking = false;
      }
    }
    document.addEventListener('visibilitychange', check);
    window.addEventListener('focus', check);
    window.addEventListener('pageshow', (event) => { if (event.persisted) check(); });
    window.setInterval(check, 30_000);
  }

  async function request(path, payload) {
    let response;
    try {
      const headers = {};
      if (pageSession && path !== 'session/login') headers['X-Incident-Session'] = pageSession;
      const options = { headers };
      if (payload !== undefined) {
        headers['Content-Type'] = 'application/json';
        options.method = 'POST';
        options.body = JSON.stringify(payload);
      }
      response = await fetch('/api/' + path, options);
    } catch {
      throw new Error('无法连接工作台，请稍后重试。');
    }
    const result = await response.json();
    if (!response.ok) {
      const error = new Error(result.message ?? '本次请求未完成。');
      error.code = result.code;
      if (typeof window === 'object') {
        if (error.code === 'session_changed') window.location.replace('/v2/');
        const onLoginForm = ['session/login', 'session/password'].includes(path);
        if (!onLoginForm && error.code === 'sign_in') window.location.replace('/login');
        if (!onLoginForm && error.code === 'password_change') window.location.replace('/login?password=1');
      }
      if (result.snapshot) error.snapshot = withClock(result.snapshot);
      throw error;
    }
    if (result.snapshot) withClock(result.snapshot);
    return result;
  }
  function withClock(snapshot) {
    snapshot.receivedAt = performance.now();
    return snapshot;
  }
  const read = async () => (await request('workspace')).snapshot;

  return { ID, STATUS, SYMPTOM, ROOT, BU, ANONYMOUS, sources, stages, pad, shiftDay, datePart, timePart, statusKey, valueOf, isBlank, fieldName, identity, getTime, newUid,
    readCsv, planImport, applyImport, read, request, bindSession, watchSession };
})();
if (typeof module === 'object' && module.exports) module.exports = incidentData;
else window.IncidentData = incidentData;
