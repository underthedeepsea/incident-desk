'use strict';

const { createHmac, randomBytes, timingSafeEqual } = require('node:crypto');
const D = require('./v2/data.js');
const F = require('./v2/workflow.js');
const { readXlsx, maxFileBytes, identifierCell } = require('./xlsx-import.cjs');

class RequestError extends Error {
  constructor(message, status = 400, code = 'invalid') {
    super(message);
    this.status = status;
    this.code = code;
  }
}

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);

function revisionOf(payload) {
  if (!isObject(payload) || !Number.isSafeInteger(payload.revision) || payload.revision < 0) {
    throw new RequestError('缺少有效的工作区修订号。');
  }
  return payload.revision;
}

function findTicket(state, uid) {
  const record = state.records.find((item) => item.uid === uid);
  if (!record) throw new RequestError('未找到该工单。', 404, 'not_found');
  return record;
}

function withRecord(state, record, at, insert = false) {
  const records = insert ? [record, ...state.records] : state.records.map((item) => item.uid === record.uid ? record : item);
  return { next: { ...state, records, clockAt: at }, uid: record.uid, changed: true };
}

function rule(operation) {
  try {
    return operation();
  } catch (error) {
    if (error.constructor !== Error) throw error;
    throw new RequestError(error.message);
  }
}

function changeWork(state, uid, payload, at, actor, canAssign) {
  const { operation, input } = payload;
  if (typeof operation !== 'string' || !isObject(input) || Object.values(input).some((value) => typeof value !== 'string')
    || (operation === 'impact' && typeof input.impact !== 'string')) {
    throw new RequestError('请提交有效的处置操作和字段。');
  }
  const current = findTicket(state, uid);
  const record = rule(() => F.updateWork(current, operation, input, at, actor, canAssign));
  return withRecord(state, record, at);
}

function editFields(state, uid, payload, at, actor) {
  const { source, fields } = payload;
  const previous = uid ? findTicket(state, uid) : null;
  if (typeof source !== 'string' || !Object.hasOwn(D.sources, source) || (previous && source !== previous.source)) {
    throw new RequestError('请选择有效的告警来源。');
  }
  if (!isObject(fields) || Object.entries(fields).some(([key, value]) =>
    !key.trim() || !key.isWellFormed() || typeof value !== 'string' || !value.isWellFormed() || (key.includes(D.ANONYMOUS) && !/^\u0000[1-9]\d*$/u.test(key))
  )) {
    throw new RequestError('请填写有效的来源字段。');
  }
  const merged = { ...previous?.fields, ...fields };
  const id = Object.hasOwn(merged, D.ID) ? merged[D.ID] : '';
  if (D.isBlank(id) || id.includes(D.ANONYMOUS)) throw new RequestError('请填写故障事件 ID。');
  if (state.records.some((item) => item.uid !== uid && item.source === source && D.valueOf(item, D.ID) === id)) {
    throw new RequestError('同一来源已经存在相同的事件 ID，请输入唯一 ID。');
  }
  const keys = Object.keys(fields).filter((key) => !previous || !Object.hasOwn(previous.fields, key) || previous.fields[key] !== fields[key]);
  if (previous && !keys.length) return { next: state, uid, changed: false };
  const work = previous ? { ...previous.work } : F.ticket(at);
  work.history = [...work.history, { type: previous ? 'fields' : 'created', at, actor }];
  return withRecord(state, { uid: uid || D.newUid(), source, fields: merged, work }, at, !previous);
}

function changeLinks(state, uid, payload, at, actor) {
  if (typeof payload.target !== 'string' || typeof payload.remove !== 'boolean') {
    throw new RequestError('请选择另一条现有工单。');
  }
  const next = rule(() => F.updateLinks(state, uid, payload.target, payload.remove, at, actor));
  return { next, uid, changed: true };
}

function createImporter() {
  // No server state is written for a preview. A service restart invalidates its outstanding tokens.
  const secret = randomBytes(32);
  function documentOf(payload) {
    if (!isObject(payload) || typeof payload.name !== 'string' || !payload.name.trim()
      || typeof payload.source !== 'string' || (payload.source !== '' && !Object.hasOwn(D.sources, payload.source))) {
      throw new RequestError('请选择有效的告警表格和告警来源。');
    }
    const { name, source, format = 'csv' } = payload;
    if (format === 'csv' && typeof payload.text === 'string' && payload.text.isWellFormed()) {
      return { name, source, format, content: payload.text };
    }
    if (format === 'xlsx' && /\.xlsx$/iu.test(name) && typeof payload.base64 === 'string' &&
      (payload.sheet === undefined || (typeof payload.sheet === 'string' && payload.sheet.length <= 31))) {
      if (payload.base64.length > 4 * Math.ceil(maxFileBytes / 3)) {
        throw new RequestError('XLSX 文件超过 8 MiB，请拆分后再上传。', 413, 'too_large');
      }
      return { name, source, format, sheet: payload.sheet, content: payload.base64 };
    }
    throw new RequestError('请选择 UTF-8 CSV 或 Excel .xlsx 文件，确认文件格式后重新上传。');
  }

  function signature(revision, doc, sessionToken) {
    return createHmac('sha256', secret).update(JSON.stringify([revision, doc.name, doc.source, doc.format, doc.sheet, doc.content, sessionToken])).digest();
  }

  function requirePreview(revision, doc, token, sessionToken) {
    if ((doc.format === 'xlsx' && !doc.sheet) || typeof token !== 'string' || !/^[A-Za-z0-9_-]{43}$/u.test(token)
      || !timingSafeEqual(Buffer.from(token, 'base64url'), signature(revision, doc, sessionToken))) {
      throw new RequestError('预览无效，请重新生成预览后再确认。', 400, 'invalid_preview');
    }
  }

  function calculate(state, doc, xlsx) {
    return rule(() => D.planImport(state, xlsx
      ? D.readRows(xlsx.rows, doc.source, 'XLSX', identifierCell)
      : D.readCsv(doc.content, doc.source)));
  }

  return {
    async prepareXlsx(payload, sessionToken, commit) {
      const doc = documentOf(payload);
      if (commit) requirePreview(revisionOf(payload), doc, payload.token, sessionToken);
      const bytes = Buffer.from(doc.content, 'base64');
      if (bytes.length > maxFileBytes) throw new RequestError('XLSX 文件超过 8 MiB，请拆分后再上传。', 413, 'too_large');
      if (bytes.toString('base64') !== doc.content) throw new RequestError('XLSX 文件数据不完整，请重新上传。');
      let xlsx;
      try {
        xlsx = await readXlsx(bytes, doc.sheet);
      } catch (error) {
        throw new RequestError(error.message);
      }
      if (!xlsx.names.length) throw new RequestError('XLSX 没有可见的数据工作表，请取消隐藏告警表或补齐数据后重试。');
      if (doc.sheet && !xlsx.sheet) throw new RequestError('所选工作表为空或不存在，请重新选择告警工作表。');
      return { ...xlsx, doc: { ...doc, sheet: xlsx.sheet } };
    },
    preview(state, payload, sessionToken, xlsx) {
      if (xlsx && !xlsx.sheet) return { plan: null, sheets: xlsx.names };
      const doc = xlsx?.doc ?? documentOf(payload);
      const plan = calculate(state, doc, xlsx);
      return { sheets: xlsx?.names, plan: {
        source: plan.source, revision: plan.revision, counts: plan.counts,
        invalidRows: plan.invalidRows, conflicts: plan.conflicts,
        ...(xlsx ? { format: doc.format, sheet: doc.sheet } : {}),
        token: signature(state.revision, doc, sessionToken).toString('base64url')
      } };
    },
    commit(state, payload, at, actor, sessionToken, xlsx) {
      const doc = xlsx?.doc ?? documentOf(payload);
      requirePreview(state.revision, doc, payload.token, sessionToken);
      const plan = calculate(state, doc, xlsx);
      if (!plan.counts.rows) throw new RequestError('此文件没有可导入的记录。');
      const choices = new Map();
      if (Array.isArray(payload.choices)) {
        for (const pair of payload.choices) {
          if (!Array.isArray(pair) || pair.length !== 2) throw new RequestError('请提交有效的冲突选择。');
          const [index, candidate] = pair;
          if (!Number.isInteger(index) || !Number.isInteger(candidate) || choices.has(index)
            || !plan.conflicts[index]?.candidates[candidate]) {
            throw new RequestError('请提交有效的冲突选择。');
          }
          choices.set(index, candidate);
        }
      } else throw new RequestError('请提交有效的冲突选择。');
      if (choices.size !== plan.conflicts.length) throw new RequestError('请先为所有冲突字段选择要保存的值。');
      const next = rule(() => F.batchSnapshot(state, plan, choices, doc, at, actor));
      return { next, batch: next.batches[0] };
    }
  };
}

module.exports = { RequestError, revisionOf, findTicket, changeWork, editFields, changeLinks, createImporter };
