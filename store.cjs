'use strict';

const D = require('./v2/data.js');
const F = require('./v2/workflow.js');
const { transaction } = require('./database.cjs');

const workFields = {
  status: '处置状态', owner: '负责人', priority: '优先级', impact: '业务影响',
  createdAt: '工单创建时间', cycleAt: '时限起算时间'
};

class StaleRevision extends Error {
  constructor(state, account) {
    super('Workspace revision changed');
    this.state = state;
    this.account = account;
  }
}

function diffObject(area, before, after) {
  const differences = [];
  for (const key of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const left = Object.hasOwn(before, key) ? before[key] : null;
    const right = Object.hasOwn(after, key) ? after[key] : null;
    if (left !== right) differences.push({ area, key, before: left, after: right });
  }
  return differences;
}

function createStore(db, accounts) {
  const workspace = db.prepare('SELECT revision, clock_at AS clockAt FROM workspace WHERE singleton = 1');
  const revision = db.prepare('UPDATE workspace SET revision = ?, clock_at = ? WHERE singleton = 1');
  const tickets = db.prepare('SELECT * FROM tickets ORDER BY sort_key');
  const minKey = db.prepare('SELECT coalesce(min(sort_key), 0) AS first FROM tickets');
  const insertTicket = db.prepare(`INSERT INTO tickets
    (source, event_id, fields_json, status, owner, priority, impact, created_at, cycle_at, uid, sort_key)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
  const editTicket = db.prepare(`UPDATE tickets SET source = ?, event_id = ?, fields_json = ?, status = ?,
    owner = ?, priority = ?, impact = ?, created_at = ?, cycle_at = ? WHERE uid = ?`);
  const events = db.prepare('SELECT uid, event_json FROM timeline ORDER BY uid, ordinal');
  const insertEvent = db.prepare('INSERT INTO timeline (uid, ordinal, event_json) VALUES (?, ?, ?)');
  const links = db.prepare('SELECT left_uid AS left, right_uid AS right, linked_at AS at FROM links ORDER BY sequence');
  const insertLink = db.prepare('INSERT INTO links (left_uid, right_uid, linked_at) VALUES (?, ?, ?)');
  const deleteLink = db.prepare('DELETE FROM links WHERE left_uid = ? AND right_uid = ?');
  const batches = db.prepare('SELECT batch_json FROM batches ORDER BY sequence DESC');
  const insertBatch = db.prepare('INSERT INTO batches (id, batch_json) VALUES (?, ?)');
  const account = db.prepare('SELECT id, username, display_name AS displayName FROM accounts WHERE id = ?');

  function read() {
    const histories = new Map();
    for (const event of events.all()) {
      if (!histories.has(event.uid)) histories.set(event.uid, []);
      histories.get(event.uid).push(JSON.parse(event.event_json));
    }
    const records = tickets.all().map((row) => ({
      uid: row.uid, source: row.source, fields: JSON.parse(row.fields_json),
      work: {
        status: row.status, owner: row.owner ?? '', priority: row.priority, impact: row.impact,
        createdAt: row.created_at, cycleAt: row.cycle_at, history: histories.get(row.uid) ?? []
      }
    }));
    return {
      ...workspace.get(), records, links: links.all(),
      batches: batches.all().map((row) => JSON.parse(row.batch_json))
    };
  }

  function saveTicket(record, previous, sortKey) {
    const work = record.work;
    const values = [
      record.source, D.valueOf(record, D.ID), JSON.stringify(record.fields),
      work.status, work.owner || null, work.priority, work.impact, work.createdAt, work.cycleAt, record.uid
    ];
    if (previous) editTicket.run(...values);
    else insertTicket.run(...values, sortKey);
    for (let ordinal = previous?.work.history.length ?? 0; ordinal < work.history.length; ordinal += 1) {
      insertEvent.run(record.uid, ordinal, JSON.stringify(work.history[ordinal]));
    }
  }

  function recordChange(record, previous, refs, recordsByUid) {
    const oldWork = previous?.work;
    const work = record.work;
    const changes = diffObject('source', previous?.fields ?? {}, record.fields);
    if (!previous) changes.unshift({ area: 'ticket', key: 'source', before: null, after: record.source });
    const workValues = (value) => Object.fromEntries(Object.keys(workFields).map((key) => [key, value[key]]));
    for (const field of diffObject('work', oldWork ? workValues(oldWork) : {}, workValues(work))) {
      if (field.key === 'owner') {
        field.beforeLabel = field.before ? F.actorLabel(account.get(field.before)) : '';
        field.afterLabel = field.after ? F.actorLabel(account.get(field.after)) : '';
      }
      changes.push(field);
    }
    const event = refs.batch
      ? { type: 'batch', at: refs.batch.at, actor: refs.batch.actor, id: refs.batch.id }
      : work.history.at(-1);
    if (event.target) {
      const target = recordsByUid.get(event.target);
      const label = D.sources[target.source].short + ' · ' + D.valueOf(target, D.ID);
      changes.push({
        area: 'ticket', key: 'link',
        before: event.type === 'unlink' ? event.target : null, after: event.type === 'link' ? event.target : null,
        beforeLabel: event.type === 'unlink' ? label : '', afterLabel: event.type === 'link' ? label : ''
      });
    }
    const entry = {
      ...event, via: refs.batch ? refs.batch.format ?? 'csv' : 'manual', revision: refs.revision, changes
    };
    return {
      ...record,
      work: { ...work, history: [...(oldWork?.history ?? []), entry] }
    };
  }

  const linkKey = ({ left, right }) => JSON.stringify([left, right]);

  return {
    ready() {
      workspace.get();
    },
    view(sessionToken, permission, operation) {
      return transaction(db, () => {
        const viewer = accounts.context(sessionToken, permission);
        return operation(read(), viewer);
      }, 'BEGIN');
    },
    change(sessionToken, permission, expectedRevision, transform) {
      return transaction(db, () => {
        const account = accounts.context(sessionToken, permission);
        const before = read();
        if (before.revision !== expectedRevision) throw new StaleRevision(before, account);
        const outcome = transform(before, account.actor);
        const { next } = outcome;
        if (next === before) return { ...outcome, state: before, account };
        const revisionAfter = expectedRevision + 1;
        const previousRecords = new Map(before.records.map((record) => [record.uid, record]));
        const recordsByUid = new Map(next.records.map((record) => [record.uid, record]));
        const newCount = next.records.length - before.records.length;
        const firstKey = minKey.get().first - newCount;
        const records = next.records.map((record, index) => {
          const previous = previousRecords.get(record.uid);
          if (previous === record) return record;
          const saved = recordChange(record, previous, { batch: outcome.batch, revision: revisionAfter }, recordsByUid);
          saveTicket(saved, previous, firstKey + index);
          return saved;
        });
        if (next.links !== before.links) {
          const oldKeys = new Set(before.links.map(linkKey));
          const newKeys = new Set(next.links.map(linkKey));
          for (const link of before.links) {
            if (!newKeys.has(linkKey(link))) deleteLink.run(link.left, link.right);
          }
          for (const link of next.links) {
            if (!oldKeys.has(linkKey(link))) insertLink.run(link.left, link.right, link.at);
          }
        }
        for (const batch of next.batches.slice(0, next.batches.length - before.batches.length).reverse()) {
          insertBatch.run(batch.id, JSON.stringify(batch));
        }
        revision.run(revisionAfter, next.clockAt);
        return { ...outcome, state: { ...next, records, revision: revisionAfter }, account };
      });
    }
  };
}

module.exports = { createStore, StaleRevision };
