'use strict';

const incidentFlow = ((D) => {
  const minute = 60_000;
  const hour = 60 * minute;
  const statuses = {'pending':'待认领','active':'处理中','paused':'挂起','verify':'待验证','closed':'已关闭'};
  const priorities = { P1: { hours: 2, label: '紧急' }, P2: { hours: 8, label: '高' }, P3: { hours: 24, label: '一般' }, P4: { hours: 72, label: '低' } };
  const labels = {
    claim: '认领工单', assign: '转派负责人', pause: '挂起工单', resume: '恢复处理', verify: '提交验证', close: '验证通过并结单', reject: '验证未通过',
    reopen: '重新打开', note: '记录处置', impact: '更新影响与优先级', fields: '编辑来源数据', link: '关联工单', unlink: '解除关联'
  };
  const roleLabels = { admin: '管理员', operator: '操作员', reader: '只读' };
  const queueLabels = { pending: '待认领', mine: '我负责', high: '高优未结单', deadline: '即将 / 已超时' };
  const shanghai = (at) => new Date(at + 8 * hour).toISOString();
  const day = (at) => shanghai(at).slice(0, 10);
  const stamp = (at) => shanghai(at).slice(0, 16).replace('T', ' ');
  const endOfDay = (date) => Date.parse(date + 'T23:59:59.999+08:00');
  function ticket(createdAt, input = {}) {
    return { status: 'pending', owner: '', priority: 'P3', impact: '', createdAt, cycleAt: createdAt, history: [], ...input };
  }
  function now(state, observedAt = performance.now()) {
    if (state.clock) return state.clock.at + (state.clock.fixed ? 0 : Math.max(0, observedAt - state.receivedAt));
    return Math.max(state.clockAt, Date.now());
  }
  const auditStamp = (at) => shanghai(at).slice(0, 23).replace('T', ' ');
  const setSla = (hours) => {
    for (const [priority, item] of Object.entries(priorities)) item.hours = hours[priority];
  };
  const actorLabel = (actor) => actor ? `${actor.displayName}（${actor.username}）` : '';
  const high = (work) => work.priority === 'P1' || work.priority === 'P2';
  function sla(work, at) {
    const end = work.cycleAt + priorities[work.priority].hours * hour;
    const remaining = end - at;
    return { end, remaining, status: work.status === 'closed' ? 'closed' : remaining < 0 ? 'over' : remaining <= hour ? 'soon' : 'normal' };
  }
  function matches(record, queue, at, accountId) {
    const work = record.work;
    if (queue === 'pending') return work.status === 'pending';
    if (queue === 'mine') return work.owner === accountId && work.status !== 'closed';
    if (queue === 'high') return high(work) && work.status !== 'closed';
    if (queue === 'deadline') return ['over','soon'].includes(sla(work, at).status);
    return true;
  }
  function activeSort(left, right) {
    return Number(left.work.status === 'closed') - Number(right.work.status === 'closed')
      || left.work.priority.localeCompare(right.work.priority)
      || sla(left.work, 0).end - sla(right.work, 0).end
      || right.work.createdAt - left.work.createdAt
      || left.uid.localeCompare(right.uid);
  }
  function available(work) {
    const byStatus = {
      pending: ['claim','assign'],
      active: ['assign','note','pause','verify'],
      paused: ['assign','note','resume'],
      verify: ['assign','note','close','reject'],
      closed: ['reopen']
    };
    return [...byStatus[work.status], 'impact'];
  }
  function updateWork(record, operation, input, at, actor, canAssign) {
    const original = record.work;
    if (!available(original).includes(operation)) throw new Error('此工单的当前状态不支持该操作。');
    const note = (input.note ?? '').trim();
    const work = { ...original, history: [...original.history] };
    const event = { type: operation, at, actor, note };
    const needsNote = ['note','pause','verify','close','reject','reopen'].includes(operation);
    if (needsNote && !note) throw new Error('请填写本次操作的说明。');
    switch (operation) {
      case 'claim':
        work.owner = actor.id;
        work.status = 'active';
        break;
      case 'assign':
        if (!canAssign(input.owner) || input.owner === original.owner) throw new Error('请选择一位不同的负责人。');
        work.owner = input.owner;
        if (work.status === 'pending') work.status = 'active';
        event.owner = input.owner;
        break;
      case 'pause': work.status = 'paused'; break;
      case 'resume': work.status = 'active'; break;
      case 'verify': work.status = 'verify'; break;
      case 'close': work.status = 'closed'; break;
      case 'reject': work.status = 'active'; break;
      case 'reopen':
        work.status = work.owner ? 'active' : 'pending';
        work.cycleAt = at;
        break;
      case 'impact':
        if (!Object.hasOwn(priorities, input.priority)) throw new Error('请选择有效优先级。');
        if (input.priority === original.priority && input.impact === original.impact) throw new Error('业务影响与优先级没有变化。');
        work.priority = input.priority;
        work.impact = input.impact;
        event.note = `${original.priority} → ${work.priority}${work.impact ? '\n' + work.impact : ''}`;
        break;
    }
    work.history.push(event);
    return { ...record, work };
  }
  function updateLinks(snapshot, uid, target, remove, at, actor) {
    const records = snapshot.records;
    if (uid === target || !records.some((record) => record.uid === uid) || !records.some((record) => record.uid === target)) throw new Error('请选择另一条现有工单。');
    const [left, right] = [uid, target].sort();
    const found = snapshot.links.some((link) => link.left === left && link.right === right);
    if (found === !remove) throw new Error(remove ? '该工单关联已解除。' : '该工单已关联。');
    const links = remove ? snapshot.links.filter((link) => link.left !== left || link.right !== right) : [...snapshot.links, { left, right, at }];
    return {
      ...snapshot, clockAt: at, links,
      records: records.map((record) => {
        if (record.uid !== left && record.uid !== right) return record;
        const event = { type: remove ? 'unlink' : 'link', at, actor, target: record.uid === left ? right : left, note: '' };
        return { ...record, work: { ...record.work, history: [...record.work.history, event] } };
      })
    };
  }
  function backlog(records, dates, at = Infinity) {
    const changes = [];
    for (const record of records) {
      const { work } = record;
      changes.push([work.createdAt, 1]);
      for (const event of work.history) {
        if (event.type === 'close') changes.push([event.at, -1]);
        if (event.type === 'reopen') changes.push([event.at, 1]);
      }
    }
    changes.sort(([left], [right]) => left - right);
    let cursor = 0;
    let total = 0;
    return dates.map((date) => {
      const through = Math.min(endOfDay(date), at);
      while (cursor < changes.length && changes[cursor][0] <= through) {
        total += changes[cursor][1];
        cursor += 1;
      }
      return total;
    });
  }
  function sourceDay(value) {
    const localDay = D.datePart(value);
    if (!localDay) return '';
    const offset = /[ Tt]+(\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?)\s*(Z|[+-]\d{2}:?\d{2})$/iu.exec(value.trim());
    if (!offset) return localDay;
    const instant = Date.parse(localDay + 'T' + offset[1].padStart(5, '0').replace(/^(\d):/u, '0$1:') + offset[2]);
    return Number.isFinite(instant) ? day(instant) : localDay;
  }
  function trend(records, end, range, at) {
    const dates = Array.from({ length: range }, (_, index) => D.shiftDay(end, index - range + 1));
    const balances = backlog(records, dates, at);
    const byDate = new Map(dates.map((date, index) => [date, { date, added: 0, recovered: 0, backlog: balances[index] }]));
    for (const record of records) {
      const start = byDate.get(sourceDay(D.getTime(record, 'start')));
      const end = byDate.get(sourceDay(D.getTime(record, 'end')));
      if (start) start.added += 1;
      if (end) end.recovered += 1;
    }
    return [...byDate.values()];
  }
  function batchSnapshot(snapshot, plan, choices, doc, at, actor) {
    const outcome = D.applyImport(snapshot, plan, choices);
    const previous = new Map(snapshot.records.map((record) => [record.uid, record]));
    const effects = [];
    const records = outcome.records.map((incoming) => {
      const before = previous.get(incoming.uid);
      if (before === incoming) return incoming;
      const fields = Object.entries(incoming.fields).filter(([key, value]) => !before || !Object.hasOwn(before.fields, key) || before.fields[key] !== value)
        .map(([key, value]) => ({ key, before: before && Object.hasOwn(before.fields, key) ? before.fields[key] : null, after: value }));
      effects.push({ uid: incoming.uid, eventId: D.valueOf(incoming, D.ID), kind: before ? 'updated' : 'inserted', fields });
      return before ? incoming : { ...incoming, work: ticket(at) };
    });
    const uidById = new Map(records.filter((record) => record.source === plan.source).map((record) => [D.valueOf(record, D.ID), record.uid]));
    const decisions = plan.conflicts.map((conflict) => {
      const index = choices.get(conflict.index);
      const selected = conflict.candidates[index];
      return { id: conflict.id, uid: uidById.get(conflict.id), field: conflict.field, selected, candidates: conflict.candidates };
    });
    const batch = {
      id: D.newUid(), at, actor, revision: snapshot.revision + 1, name: doc.name, source: plan.source, counts: plan.counts, issues: plan.invalidRows, decisions,
      inserted: outcome.inserted, updated: outcome.updated, effects,
      ...(doc.format === 'xlsx' ? { format: doc.format, sheet: doc.sheet } : {})
    };
    return { ...snapshot, clockAt: at, records, batches: [batch, ...snapshot.batches] };
  }
  return { minute, hour, statuses, priorities, labels, roleLabels, queueLabels, day, stamp, auditStamp, setSla, actorLabel, ticket, now, high, sla, matches, activeSort, available, updateWork, updateLinks, backlog, sourceDay, trend, batchSnapshot };
})(typeof module === 'object' && module.exports ? require('./data.js') : window.IncidentData);
if (typeof module === 'object' && module.exports) module.exports = incidentFlow;
else window.IncidentFlow = incidentFlow;
