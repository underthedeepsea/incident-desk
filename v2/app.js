'use strict';

(() => {
  const D = window.IncidentData;
  const F = window.IncidentFlow;
  const main = document.querySelector('#main');
  const navigation = document.querySelector('#navigation');
  const dialog = document.querySelector('#ticket-dialog');
  const toast = document.querySelector('#toast');
  const pages = {
    dashboard: { title: '值班工作台', nav: '值班工作台', icon: 'overview' },
    tickets: { title: '工单列表', nav: '工单列表', icon: 'list' },
    import: { title: 'CSV 导入', nav: 'CSV 导入', icon: 'upload' },
    batches: { title: '导入批次', nav: '导入批次', icon: 'file' }
  };
  const icons = {
    account: '<circle cx="12" cy="8" r="3.2"/><path d="M5 20v-2a5 5 0 0 1 5-5h4a5 5 0 0 1 5 5v2z"/>',
    overview: '<rect x="3.5" y="3.5" width="7" height="7" rx="1.35"/><rect x="13.5" y="3.5" width="7" height="7" rx="1.35"/><rect x="3.5" y="13.5" width="7" height="7" rx="1.35"/><rect x="13.5" y="13.5" width="7" height="7" rx="1.35"/>',
    list: '<rect x="5" y="4" width="14" height="16" rx="2"/><path d="M9 8.5h6M9 12h6m-6 3.5h4"/>',
    upload: '<path d="M12 15V4m-4 4 4-4 4 4M5 14v4.5A1.5 1.5 0 0 0 6.5 20h11a1.5 1.5 0 0 0 1.5-1.5V14"/>',
    chevron: '<path d="m9 6 6 6-6 6"/>',
    arrow: '<path d="M4.5 12h14m-5-5 5 5-5 5"/>',
    calendar: '<rect x="4" y="6" width="16" height="14" rx="2"/><path d="M4 10h16M8 4v4m8-4v4"/>',
    pulse: '<path d="M3 12h4l3-6 4 12 3-6h4"/>',
    clock: '<circle cx="12" cy="12" r="8"/><path d="M12 8v4l2 2"/>',
    check: '<circle cx="12" cy="12" r="8"/><path d="m8.5 12.2 2.3 2.3 4.7-5"/>',
    rate: '<path d="M5 19V6m0 13h14m-10-4 3-3 3 1 4-5m-4 0h4v4"/>',
    local: '<rect x="4" y="4.5" width="16" height="11" rx="2"/><path d="M8 19.5h8m-4-4v4"/>',
    search: '<circle cx="10.5" cy="10.5" r="5.5"/><path d="m15 15 4 4"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    close: '<path d="m6 6 12 12M18 6 6 18"/>',
    file: '<path d="M14.5 3.5H7A2 2 0 0 0 5 5.5v13A2 2 0 0 0 7 20.5h10a2 2 0 0 0 2-2V8zM14 4v4.5h4.5M9 12h6m-6 4h6"/>',
    info: '<circle cx="12" cy="12" r="8"/><path d="M12 11.5v4m0-7.4h.01"/>',
    alert: '<path d="m10.5 5-6.3 11a1.7 1.7 0 0 0 1.5 2.5h12.6a1.7 1.7 0 0 0 1.5-2.5L13.5 5a1.7 1.7 0 0 0-3 0ZM12 9.2v3.5m0 2.7h.01"/>',
    cloud: '<path d="M6.5 17.5h10.6a3.4 3.4 0 0 0 .5-6.8 5.5 5.5 0 0 0-10.4-1.3 4.1 4.1 0 0 0-.7 8.1Z"/>',
    hybrid: '<rect x="8.5" y="3.5" width="7" height="5" rx="1"/><rect x="3.5" y="15" width="6" height="5" rx="1"/><rect x="14.5" y="15" width="6" height="5" rx="1"/><path d="M12 8.5v3m-5.5 3.5v-3.5h11V15"/>',
    gpu: '<rect x="6.5" y="6.5" width="11" height="11" rx="1.5"/><rect x="9.5" y="9.5" width="5" height="5" rx=".7"/><path d="M9 3.5v3m6-3v3m-6 11v3m6-3v3M3.5 9h3m-3 6h3m11-6h3m-3 6h3"/>',
    empty: '<path d="M6 4h12a2 2 0 0 1 2 2l1 7v5a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-5l1-7a2 2 0 0 1 2-2Z"/><path d="M3 13h6a3 3 0 0 0 6 0h6"/>'
  };
  const sourceIcons = { pd: 'cloud', hybrid: 'hybrid', gpu: 'gpu' };
  const esc = (value) => String(value).replace(/[&<>"']/gu, (character) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[character]));
  const icon = (key, size = 20) => `<svg aria-hidden="true" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${icons[key]}</svg>`;
  const number = new Intl.NumberFormat('zh-CN');
  const state = {
    snapshot: null, page: 'dashboard', range: 14, end: "", distribution: 'source',
    filters: { query: '', source: '', status: '', queue: '', page: 1 }, batchId: '',
    upload: { source: '', doc: null, result: null, plan: null, waiting: false, committing: false, sequence: 0, error: '', choices: new Map() },
    editor: null
  };
  const allowed = (permission) => state.snapshot.account.permissions.includes(permission);
  const canSaveSource = (editor) => allowed(editor.uid ? 'ticket.fields' : 'ticket.create');
  const pageSize = 10;
  const compactPlot = window.matchMedia('(max-width: 625px)');
  let toastTimer;
  let ticketResultCount = 0;

  function acceptSnapshot(snapshot) {
    const current = state.snapshot;
    if (current && snapshot.revision < current.revision) return;
    const observedAt = performance.now();
    // Snapshots are versioned by data changes, but reads also carry a sample of the live clock.
    const at = Math.max(F.now(snapshot, observedAt), current ? F.now(current, observedAt) : -Infinity);
    state.snapshot = { ...snapshot, clock: { ...snapshot.clock, at }, receivedAt: observedAt };
    F.setSla(snapshot.slaHours);
  }
  function notify(message) {
    toast.innerHTML = icon('check') + `<span>${esc(message)}</span>`;
    toast.hidden = false;
    window.clearTimeout(toastTimer);
    toastTimer = window.setTimeout(() => { toast.hidden = true; }, 4200);
  }
  function titleMarkup(title, description, actions = '') {
    return `<section class="page-heading">
      <div><h1>${title}</h1><p class="page-description">${description}</p></div>
      ${actions ? `<div class="heading-actions">${actions}</div>` : ''}
    </section>`;
  }
  function button(action, label, glyph, type = 'secondary') {
    return `<button type="button" class="button ${type}" data-action="${action}">${glyph ? icon(glyph, 17) : ''}${label}</button>`;
  }
  function sourceOptions(selected, first) {
    return (first ? `<option value="">${first}</option>` : '') + Object.entries(D.sources).map(([key, source]) => `<option value="${key}" ${key === selected ? 'selected' : ''}>${source.name}</option>`).join('');
  }
  function statusBadge(value) {
    return `<span class="status-pill status-${D.statusKey(value)}"><i></i>${esc(D.isBlank(value) ? '未填写' : value)}</span>`;
  }
  function sourceBadge(key) {
    return `<span class="source-tag"><span class="source-icon source-${key}">${icon(sourceIcons[key], 15)}</span>${D.sources[key].short}</span>`;
  }
  function dayLabel(day, includeYear = false) {
    const [year, month, date] = day.split('-');
    return includeYear ? `${year}.${month}.${date}` : `${Number(month)}/${Number(date)}`;
  }
  function dateCell(value) {
    if (!value.trim()) return '未填写';
    const date = D.datePart(value);
    if (!date) return esc(value);
    const time = D.timePart(value);
    return `<span class="date-main">${date}</span>${time ? ` <span class="date-time">${esc(time)}</span>` : ''}`;
  }
  function emptyState(title, sub) {
    return `<div class="empty"><span>${icon('empty', 24)}</span><strong>${title}</strong><p>${sub}</p></div>`;
  }
  function workBadge(work) {
    return `<span class="work-pill work-${work.status}"><i></i>${F.statuses[work.status]}</span>`;
  }
  function priorityBadge(priority) {
    return `<span class="priority-badge priority-${priority.toLowerCase()}" title="${F.priorities[priority].label}">${priority}</span>`;
  }
  function ownerName(work) { return state.snapshot.people.find((person) => person.id === work.owner)?.displayName || '未分配'; }
  function duration(ms) {
    const minutes = Math.ceil(Math.abs(ms) / F.minute);
    if (minutes < 60) return `${minutes} 分钟`;
    const hours = Math.floor(minutes / 60);
    const days = Math.floor(hours / 24);
    return days ? `${days} 天 ${hours % 24} 小时` : `${hours} 小时${minutes % 60 ? ` ${minutes % 60} 分钟` : ''}`;
  }
  function deadlineLabel(work, at) {
    const deadline = F.sla(work, at);
    if (deadline.status === 'closed') return '已结束';
    return `${deadline.status === 'over' ? '超时' : '剩余'} ${duration(deadline.remaining)}`;
  }
  function deadlineBadge(work, at) {
    const deadline = F.sla(work, at);
    return `<span class="deadline deadline-${deadline.status}" data-sla-end="${deadline.end}" data-sla-closed="${deadline.status === 'closed'}" title="处置截止 ${F.stamp(deadline.end)}">${deadlineLabel(work, at)}</span>`;
  }
  function table(records, at, full = false) {
    if (!records.length) return emptyState('没有符合条件的工单', full ? '可以调整搜索关键词或筛选条件。' : '当前队列暂无待处理工单。');
    return `<div class="table-scroll"><table class="tickets-table duty-table">
      <thead><tr><th scope="col">故障工单</th><th scope="col">告警来源</th><th scope="col">工单状态</th><th scope="col">负责人</th><th scope="col">处置时限</th>${full ? '<th scope="col">来源状态</th>' : ''}<th scope="col"><span class="sr-only">操作</span></th></tr></thead>
      <tbody>${records.map((record) => {
        const id = D.valueOf(record, D.ID);
        const work = record.work;
        return `<tr>
          <td class="ticket-name"><div class="duty-ticket"><span>${priorityBadge(work.priority)}</span><div><button type="button" class="ticket-link" data-action="open-ticket" data-uid="${esc(record.uid)}">${esc(D.valueOf(record, D.SYMPTOM) || id)}</button><span class="ticket-id">${esc(id)}</span></div></div></td>
          <td>${sourceBadge(record.source)}</td><td>${workBadge(work)}</td><td>${esc(ownerName(work))}</td><td>${deadlineBadge(work, at)}</td>
          ${full ? `<td>${statusBadge(D.valueOf(record, D.STATUS))}</td>` : ''}
          <td><button class="row-arrow" type="button" aria-label="查看工单 ${esc(id)}" data-action="open-ticket" data-uid="${esc(record.uid)}">${icon('chevron', 17)}</button></td>
        </tr>`;
      }).join('')}</tbody></table></div>`;
  }

  function pathFrom(points) {
    const [first, ...rest] = points;
    return rest.reduce((path, point, index) => {
      const previous = points[index];
      const midway = ((previous[0] + point[0]) / 2).toFixed(1);
      return `${path} C ${midway} ${previous[1]} ${midway} ${point[1]} ${point[0]} ${point[1]}`;
    }, `M ${first[0]} ${first[1]}`);
  }
  function metrics(at) {
    const descriptions = {
      pending: ['list', '等待值班人员认领'],
      mine: ['local', '我负责的未关闭工单'],
      high: ['pulse', 'P1 / P2 未关闭工单'],
      deadline: ['clock', '距截止一小时内或已超时']
    };
    return `<section class="duty-metrics" aria-label="值班队列">${Object.entries(F.queueLabels).map(([key, label]) => {
      const [glyph, description] = descriptions[key];
      const count = state.snapshot.records.filter((record) => F.matches(record, key, at, state.snapshot.account.id)).length;
      return `<button class="duty-metric metric-${key}" type="button" data-action="queue-filter" data-queue="${key}">
        <span class="duty-metric-top"><span class="duty-metric-icon">${icon(glyph, 17)}</span><span>${label}</span>${icon('chevron', 15)}</span>
        <strong>${number.format(count)}</strong><small>${description}</small></button>`;
    }).join('')}</section>`;
  }
  function chart(days) {
    const width = compactPlot.matches ? 422 : 730;
    const left = compactPlot.matches ? 30 : 41;
    const right = width - left;
    const top = 15;
    const bottom = compactPlot.matches ? 150 : 167;
    const max = Math.max(...days.flatMap((day) => [day.added, day.recovered]), 4);
    const backlogMax = Math.max(...days.map((day) => day.backlog), 4);
    const unit = Math.ceil(max / 4);
    const backlogUnit = Math.ceil(backlogMax / 4);
    const y = (value, tick = unit) => Number((bottom - value / (tick * 4) * (bottom - top)).toFixed(1));
    const x = (index) => Number((left + index / (days.length - 1) * (right - left)).toFixed(1));
    const added = pathFrom(days.map((day, index) => [x(index), y(day.added)]));
    const recovered = pathFrom(days.map((day, index) => [x(index), y(day.recovered)]));
    const balance = days.map((day, index) => `${index ? ' H' : 'M'} ${x(index)} ${index ? 'V' : ''} ${y(day.backlog, backlogUnit)}`).join('');
    const labelCount = compactPlot.matches ? 5 : 8;
    const labels = new Set(Array.from({ length: labelCount }, (_, index) => Math.round(index * (days.length - 1) / (labelCount - 1))));
    const grids = Array.from({ length: 5 }, (_, index) => {
      const relative = y(index * unit);
      return `<line x1="${left}" x2="${right}" y1="${relative}" y2="${relative}" class="grid-line"/><text x="${left - 8}" y="${relative + 4}" text-anchor="end">${index * unit}</text><text x="${right + 7}" y="${relative + 4}" class="axis-backlog">${index * backlogUnit}</text>`;
    }).join('');
    return `<div class="plot duty-plot" id="trend-plot">
      <svg viewBox="0 0 ${width} ${bottom + 29}" role="img" aria-label="每日新增和恢复告警及未关闭工单趋势图">
        <defs><linearGradient id="trend-fill" x1="0" x2="0" y1="0" y2="1"><stop stop-color="#f77d40" stop-opacity=".18"/><stop offset="1" stop-color="#f77d40" stop-opacity=".01"/></linearGradient></defs>
        ${grids}<path d="${added} V${bottom} H${left} Z" fill="url(#trend-fill)"/>
        <path d="${balance}" class="trend-line backlog-line"/><path d="${recovered}" class="trend-line green"/><path d="${added}" class="trend-line orange"/>
        ${days.map((day, index) => `${days.length <= 14 ? `<circle cx="${x(index)}" cy="${y(day.added)}" r="3" class="trend-dot"/>` : ''}${labels.has(index) ? `<text x="${x(index)}" y="${bottom + 23}" text-anchor="middle" class="axis-date">${dayLabel(day.date)}</text>` : ''}`).join('')}
        <line y1="${top}" y2="${bottom}" class="trend-guide" id="trend-guide" visibility="hidden"/>
      </svg>
      <div class="trend-controls" style="left:${left / width * 100}%;right:${(width - right) / width * 100}%">
        ${days.map((day, index) => `<button type="button" class="trend-day" style="left:${index / (days.length - 1) * 100}%;width:${87 / (days.length - 1)}%" data-x="${x(index)}" data-percent="${x(index) / width * 100}" data-date="${day.date}" data-added="${day.added}" data-recovered="${day.recovered}" data-backlog="${day.backlog}" aria-label="${day.date}，新增告警 ${day.added} 件，恢复告警 ${day.recovered} 件，未关闭工单 ${day.backlog} 件"></button>`).join('')}
      </div><div class="trend-tooltip" id="trend-tooltip" hidden></div>
    </div>`;
  }
  function queueFocus(records, at) {
    const lead = records.find((record) => F.high(record.work)) ?? records[0];
    const empty = `<h3>当前没有待处置工单</h3><p>可以查看全部工单或导入告警。</p>`;
    return `<aside class="duty-side">
      <section class="focus-card"><div class="focus-title">${icon('pulse', 17)}优先关注</div>
      ${lead ? `<div class="focus-case"><div>${priorityBadge(lead.work.priority)}${workBadge(lead.work)}</div><h3>${esc(D.valueOf(lead, D.SYMPTOM) || D.valueOf(lead, D.ID))}</h3>
      <p>${esc(lead.work.impact || D.valueOf(lead, D.BU) || '影响范围待核实')}</p><div class="focus-deadline">${icon('clock', 17)}<span data-focus-uid="${esc(lead.uid)}">${esc(deadlineLabel(lead.work, at))}</span></div>
      ${`<button type="button" class="button" data-action="open-ticket" data-uid="${esc(lead.uid)}">查看并处理${icon('arrow', 16)}</button>`}</div>` : `<div class="focus-case">${empty}</div>`}</section>
      <section class="panel sla-summary"><h2>${icon('clock', 17)}处置时限</h2><div class="sla-grid">${Object.entries(F.priorities).map(([p, item]) => `<span>${priorityBadge(p)}<b>${item.hours} 小时</b></span>`).join('')}</div>
      <p>自进入工单队列或重开起计。挂起继续计时，结单结束。</p></section>
    </aside>`;
  }
  function statusDistribution(days) {
    const mode = state.distribution;
    const counts = new Map();
    const first = days[0].date;
    const last = days.at(-1).date;
    if (mode === 'workflow') {
      for (const key of Object.keys(F.statuses)) counts.set(key, 0);
    }
    for (const record of state.snapshot.records) {
      const sourceDate = F.sourceDay(D.getTime(record, 'start'));
      if (mode === 'source' && (sourceDate < first || sourceDate > last)) continue;
      const key = mode === 'workflow' ? record.work.status : D.valueOf(record, D.STATUS).trim();
      counts.set(key, (counts.get(key) ?? 0) + 1);
    }
    const total = [...counts.values()].reduce((sum, value) => sum + value, 0);
    const colors = { pending: '#d78b4d', active: '#d15d35', paused: '#917dad', verify: '#5a8aa0', closed: '#5b9277' };
    const entries = [...counts].sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0], 'zh-CN'));
    const segments = entries.filter(([, count]) => count).map(([status, count]) => {
      const sourceKey = D.statusKey(status);
      return `<span style="--segment:${mode === 'workflow' ? colors[status] : D.stages[sourceKey].color};width:${count / total * 100}%"></span>`;
    }).join('');
    const rows = entries.map(([status, count]) => {
      const badge = mode === 'workflow' ? workBadge({ status }) : statusBadge(status);
      return `<div>${badge}<strong>${number.format(count)}</strong><small>${total ? Math.round(count / total * 100) : 0}%</small></div>`;
    }).join('');
    return `<section class="panel duty-distribution" aria-labelledby="distribution-title">
      <div class="panel-heading"><div><h2 id="distribution-title">状态分布</h2><p>${mode === 'workflow' ? '当前工作区内全部工单' : '选中日期内发生的来源告警'}</p></div></div>
      <div class="distribution-content"><div class="range-tabs" aria-label="状态统计口径">${[['source','来源状态'],['workflow','工单状态']].map(([key,label]) => `<button type="button" data-action="distribution" data-mode="${key}" aria-pressed="${mode === key}">${label}</button>`).join('')}</div>
        <div class="distribution-total"><strong>${number.format(total)}</strong><span>${mode === 'source' ? '件来源告警' : '条工单'}</span></div>
        <div class="distribution-bar" aria-hidden="true">${segments}</div><div class="distribution-rows">${rows || '<p class="quiet">选中日期内没有告警。</p>'}</div>
      </div></section>`;
  }

  function renderDashboard(at = F.now(state.snapshot)) {
    const today = F.day(at);
    if (state.end > today) state.end = today;
    const open = state.snapshot.records.filter((record) => record.work.status !== 'closed').sort(F.activeSort);
    const days = F.trend(state.snapshot.records, state.end, state.range, at);
    const dateDescription = `<span class="date-caption">${icon('clock', 16)}<span><time id="duty-clock">${F.stamp(at)}</time><span class="dashboard-tz">（北京时间）</span></span></span>`;
    main.innerHTML = titleMarkup('值班工作台', dateDescription, allowed('csv.import') ? `<a class="button primary" href="#import">${icon('upload', 17)}导入 CSV</a>` : '') + metrics(at) +
      `<div class="duty-queue-layout"><section class="panel queue-panel" aria-labelledby="queue-title"><div class="panel-heading"><div><h2 id="queue-title">优先队列 <span>${number.format(open.length)}</span></h2><p>按优先级与处置截止时间排序</p></div><a class="text-link" href="#tickets" data-action="all-tickets">全部工单${icon('arrow', 16)}</a></div>
      ${table(open.slice(0, 5), at)}</section>${queueFocus(open, at)}</div>
      <div class="duty-analytics"><section class="panel trend-panel duty-trend" aria-labelledby="trend-title">
        <div class="panel-heading trend-heading"><div><h2 id="trend-title">告警与工单趋势</h2><p>${dayLabel(days[0].date, true)} 至 ${dayLabel(state.end, true)}</p></div>
        <div class="chart-options"><label class="end-date"><span class="sr-only">统计截止日期</span><input id="dashboard-end" type="date" value="${state.end}" min="1900-02-01" max="${today}"></label>
        <div class="range-tabs" aria-label="统计周期">${[7, 14, 30].map((range) => `<button type="button" data-action="range" data-range="${range}" aria-pressed="${range === state.range}">${range} 天</button>`).join('')}</div></div></div>
        <div class="chart-legend"><span><i class="legend-added"></i>日新增告警</span><span><i class="legend-recovered"></i>日恢复告警</span><span><i class="legend-backlog"></i>未关闭工单（右轴）</span></div>
        ${chart(days)}<p class="trend-note">告警按来源时间统计。未关闭工单按日末计算，今天截至当前北京时间。关联工单各自计数。</p></section>${statusDistribution(days)}</div>`;
    const plot = main.querySelector('#trend-plot');
    const tooltip = plot.querySelector('#trend-tooltip');
    const guide = plot.querySelector('#trend-guide');
    function showDay(button) {
      if (!button?.matches('.trend-day')) return;
      const { date, x, percent, added, recovered, backlog } = button.dataset;
      tooltip.style.left = Math.min(77, Math.max(23, Number(percent))) + '%';
      tooltip.innerHTML = `<strong>${dayLabel(date, true)}</strong><span>新增 <b>${added}</b></span><span>恢复 <b>${recovered}</b></span><span>未关闭 <b>${backlog}</b></span>`;
      tooltip.hidden = false;
      guide.setAttribute('x1', x);
      guide.setAttribute('x2', x);
      guide.setAttribute('visibility', 'visible');
    }
    function hideDay() { tooltip.hidden = true; guide.setAttribute('visibility', 'hidden'); }
    plot.addEventListener('pointerover', (event) => showDay(event.target));
    plot.addEventListener('pointerleave', hideDay);
    plot.addEventListener('focusin', (event) => showDay(event.target));
    plot.addEventListener('focusout', (event) => { if (!plot.contains(event.relatedTarget)) hideDay(); });
    plot.addEventListener('click', (event) => showDay(event.target));
  }
  function matchingTickets(at) {
    const { query, source, status, queue } = state.filters;
    const term = query.trim().toLocaleLowerCase();
    return state.snapshot.records.filter((record) => {
      if (source && record.source !== source) return false;
      if (status && record.work.status !== status) return false;
      if (queue && !F.matches(record, queue, at, state.snapshot.account.id)) return false;
      return !term || [record.work.impact, ownerName(record.work), ...Object.values(record.fields)].some((cell) => cell.toLocaleLowerCase().includes(term));
    });
  }
  function renderTicketResults(at = F.now(state.snapshot), matches = matchingTickets(at)) {
    const { queue } = state.filters;
    const results = main.querySelector('#ticket-results');
    const focused = results.contains(document.activeElement) ? document.activeElement : null;
    const left = results.querySelector('.table-scroll')?.scrollLeft ?? 0;
    ticketResultCount = matches.length;
    const pages = Math.max(1, Math.ceil(matches.length / pageSize));
    const page = Math.min(state.filters.page, pages);
    state.filters.page = page;
    const records = matches.sort(F.activeSort).slice((page - 1) * pageSize, page * pageSize);
    const queueChip = queue ? `<button class="filter-chip" type="button" data-action="clear-queue" aria-label="清除值班队列筛选"><span>${F.queueLabels[queue]}</span>${icon('close', 13)}</button>` : '';
    results.innerHTML = `<div class="result-summary"><span>共 <strong>${number.format(matches.length)}</strong> 条工单</span>${queueChip}</div>${table(records, at, true)}
      ${pages > 1 ? `<div class="pagination"><span>第 ${page} / ${pages} 页</span><button class="button secondary" type="button" data-action="prev-page" ${page === 1 ? 'disabled' : ''}>上一页</button><button class="button secondary" type="button" data-action="next-page" ${page === pages ? 'disabled' : ''}>下一页</button></div>` : ''}`;
    const scroller = results.querySelector('.table-scroll');
    if (scroller) scroller.scrollLeft = left;
    if (focused) {
      const replacement = [...results.querySelectorAll('button:not(:disabled)')].find((button) =>
        button.dataset.action === focused.dataset.action && button.dataset.uid === focused.dataset.uid && button.className === focused.className);
      (replacement ?? main.querySelector('#ticket-search')).focus({ preventScroll: true });
    }
  }
  function renderTickets() {
    const widget = '<option value="">全部工单状态</option>' + Object.entries(F.statuses).map(([key, value]) => `<option value="${key}" ${state.filters.status === key ? 'selected' : ''}>${value}</option>`).join('');
    main.innerHTML = titleMarkup('工单列表', '按告警来源与处置状态查找工单。', allowed('ticket.create') ? button('new-ticket', '新建工单', 'plus', 'primary') : '') +
      `<section class="panel ticket-panel" aria-label="工单搜索与结果"><div class="filters">
      <label class="search-field">${icon('search', 18)}<input id="ticket-search" type="search" value="${esc(state.filters.query)}" placeholder="搜索工单 ID、现象、负责人或字段"><span class="sr-only">搜索工单</span></label>
      <label><span class="sr-only">告警来源</span><select id="ticket-source">${sourceOptions(state.filters.source, '全部来源')}</select></label>
      <label><span class="sr-only">工单状态</span><select id="ticket-status">${widget}</select></label>${button('clear-filters', '清除筛选')}
      </div><div id="ticket-results"></div></section>`;
    renderTicketResults();
  }

  function importRules() {
    const rules = [
      ['check', '内容相同', '自动跳过相同的字段值。'],
      ['plus', '系统为空', '用 CSV 中的有值字段补齐。'],
      ['local', 'CSV 为空', '保留系统原有字段值。'],
      ['alert', '有值且不同', '逐项预览差异，确认后保存。']
    ];
    return `<section class="panel import-rules" aria-labelledby="rules-title"><div class="panel-heading"><div><h2 id="rules-title">字段合并规则</h2><p>按表格来源和事件 ID 精确匹配。</p></div></div>
      <div class="rule-list">${rules.map(([glyph, title, text]) => `<div class="rule"><span>${icon(glyph, 18)}</span><div><strong>${title}</strong><p>${text}</p></div></div>`).join('')}</div>
      <div class="import-format">${icon('info', 17)}<p>支持 UTF-8 CSV。首行应为表头，匿名列和扩展列均可保留编辑。缺少 ID 的行会标记并跳过。</p></div>
    </section>`;
  }
  function renderImport() {
    const upload = state.upload;
    const busy = upload.committing ? 'disabled' : '';
    let content = titleMarkup('CSV 导入', '从告警表格创建或补齐工单，写入前查看合并结果。');
    if (upload.result) {
      const { name, inserted, updated } = upload.result;
      content += `<section class="panel import-success"><span class="success-icon">${icon('check', 30)}</span><h2>${inserted || updated ? '导入完成' : '已记录批次'}</h2>
        <p>${esc(name)} · 新增 ${inserted} 条，更新 ${updated} 条${upload.result.skipped ? `，跳过 ${upload.result.skipped} 条无效记录` : ''}。</p>
        <div>${button('reset-import', '继续导入')}<button type="button" class="button primary" data-action="show-batch" data-batch="${esc(upload.result.id)}">查看批次${icon('arrow', 16)}</button></div></section>`;
    } else {
      content += `<div class="import-layout"><section class="panel file-panel" aria-labelledby="upload-title">
        <div class="panel-heading"><div><h2 id="upload-title">上传告警表格</h2><p>内部云 PD、混合云和 GPU 节点告警。</p></div></div>
        <div class="file-form"><label class="control-label" for="import-source">表格来源</label><select id="import-source" ${busy}>${sourceOptions(upload.source, '从 CSV 表头自动识别')}</select>
          <input id="csv-file" class="sr-only file-input" type="file" accept=".csv,text/csv" ${busy}>
          <label for="csv-file" class="drop-zone" id="drop-zone">
            <span class="upload-illustration">${icon(upload.doc ? 'file' : 'upload', 27)}</span>
            <strong>${upload.doc ? esc(upload.doc.name) : '点击选择 CSV，或拖放文件至此'}</strong>
            <span>${upload.doc ? '点击替换此文件' : '每次上传一个来源的告警表格'}</span>
          </label>
          ${upload.error && !upload.plan ? `<p class="form-error" role="alert">${icon('alert', 17)}${esc(upload.error)}</p>` : ''}
          <div class="file-actions"><button type="button" class="button primary" data-action="prepare-import" ${!upload.doc || upload.waiting ? 'disabled' : ''}>${upload.waiting ? '正在生成预览…' : '预览合并结果'}${icon('arrow', 17)}</button>
          ${upload.doc ? `<button class="button secondary" type="button" data-action="reset-import" ${busy}>清除文件</button>` : ''}</div>
        </div></section>${importRules()}</div>`;
    }
    main.innerHTML = content + (upload.plan ? importPreview() : '');
    const zone = main.querySelector('#drop-zone');
    if (zone) {
      zone.addEventListener('dragover', (event) => { event.preventDefault(); zone.classList.add('dragging'); });
      zone.addEventListener('dragleave', () => zone.classList.remove('dragging'));
      zone.addEventListener('drop', (event) => {
        event.preventDefault();
        zone.classList.remove('dragging');
        if (state.upload.committing) return;
        if (event.dataTransfer.files.length !== 1) {
          state.upload.error = '请一次拖入一个 CSV 文件。';
          renderImport();
        } else receiveFile(event.dataTransfer.files[0]);
      });
    }
    if (upload.plan) updateImportFeedback();
  }
  function importPreview() {
    const { plan, choices, committing } = state.upload;
    const busy = committing ? 'disabled' : '';
    const counts = plan.counts;
    const statistics = [
      ['新增工单', counts.new], ['匹配工单', counts.matched], ['自动补齐格', counts.filled], ['相同跳过格', counts.equal], ['保留原值格', counts.preserved], ['冲突字段', plan.conflicts.length]
    ];
    return `<section class="panel import-preview" id="import-preview" aria-labelledby="preview-heading">
      <div class="panel-heading"><div><h2 id="preview-heading" tabindex="-1">合并预览</h2><p>${D.sources[plan.source].name} · ${counts.rows} 条有效 CSV 数据${counts.duplicates ? `，含 ${counts.duplicates} 条同批重复记录` : ''}</p></div></div>
      <div class="preview-body"><div class="preview-stats">${statistics.map(([label, value]) => `<div><strong>${number.format(value)}</strong><span>${label}</span></div>`).join('')}</div>
      ${plan.invalidRows.length ? `<details class="invalid-rows" ${plan.invalidRows.length < 6 ? 'open' : ''}><summary>${plan.invalidRows.length} 行将跳过</summary><ul>${plan.invalidRows.map(({ line, message }) => `<li>CSV 第 ${line} 行：${message}</li>`).join('')}</ul></details>` : ''}
      ${plan.conflicts.length ? `<div class="conflict-group"><div class="conflict-heading"><div><h3>确认冲突字段</h3><p>每个字段选定一个要保存的值。同一 CSV 内出现多个值时，也需要确认。</p></div>
      ${plan.conflicts.some((conflict) => conflict.candidates.some((candidate) => candidate.system)) ? `<button type="button" class="button secondary" data-action="keep-system" ${busy}>保留可用的系统值</button>` : ''}</div>
      ${plan.conflicts.map((conflict) => `<fieldset class="conflict"><legend>${esc(D.fieldName(conflict.field))}<small>${esc(conflict.id)}</small></legend>
        <div class="conflict-options">${conflict.candidates.map((candidate, index) => `<label class="conflict-option"><input type="radio" name="conflict-${conflict.index}" data-conflict="${conflict.index}" value="${index}" ${choices.get(conflict.index) === index ? 'checked' : ''} ${busy}><span><strong>${candidate.system ? '系统值' : 'CSV 值'}${candidate.lines.length ? ` · 第 ${candidate.lines.join('、')} 行` : ''}</strong><span class="candidate-value">${esc(candidate.value)}</span></span></label>`).join('')}</div>
      </fieldset>`).join('')}</div>` : '<p class="preview-note">未发现字段冲突。</p>'}
      ${state.upload.error ? `<p class="form-error preview-error" role="alert">${icon('alert', 17)}${esc(state.upload.error)}</p>` : ''}
      <div class="preview-footer"><span id="import-feedback" aria-live="polite"></span><div><button type="button" class="button secondary" data-action="cancel-preview" ${busy}>取消预览</button><button type="button" id="commit-import" class="button primary" data-action="commit-import">${icon('check', 17)}确认并导入</button></div></div>
      </div></section>`;
  }
  function updateImportFeedback() {
    const upload = state.upload;
    const remaining = upload.plan.conflicts.length - upload.choices.size;
    main.querySelector('#import-feedback').textContent = upload.committing ? '正在写入工单…' : remaining ? `还有 ${remaining} 项待确认` : (upload.plan.counts.rows ? '确认后一次写入' : '此文件没有可导入的记录');
    main.querySelector('#commit-import').disabled = remaining > 0 || !upload.plan.counts.rows || upload.waiting;
  }
  function resetImport() {
    state.upload = { source: '', doc: null, result: null, plan: null, waiting: false, committing: false, sequence: state.upload.sequence + 1, error: '', choices: new Map() };
    renderImport();
  }
  async function receiveFile(file) {
    const upload = state.upload;
    if (upload.committing) return;
    const sequence = ++upload.sequence;
    upload.plan = null;
    upload.doc = null;
    upload.result = null;
    upload.error = '';
    upload.waiting = true;
    render();
    try {
      if (!/\.csv$/iu.test(file.name) && file.type !== 'text/csv') throw new Error('请选择扩展名为 .csv 的文件。');
      const bytes = await file.arrayBuffer();
      let text;
      try {
        text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
      } catch {
        throw new Error('无法读取文件编码，请将 CSV 保存为 UTF-8 后再上传。');
      }
      if (state.upload !== upload || sequence !== upload.sequence) return;
      upload.doc = { name: file.name, text };
    } catch (error) {
      if (state.upload !== upload || sequence !== upload.sequence) return;
      upload.error = error.message;
    } finally {
      if (state.upload === upload && sequence === upload.sequence) {
        upload.waiting = false;
        render();
      }
    }
  }
  async function prepareImport() {
    const upload = state.upload;
    if (!allowed('csv.import') || !upload.doc || upload.waiting) return;
    const sequence = ++upload.sequence;
    upload.plan = null;
    upload.choices = new Map();
    upload.error = '';
    upload.waiting = true;
    render();
    try {
      const { plan, snapshot } = await D.request('import/preview', { ...upload.doc, source: upload.source });
      if (state.upload !== upload || sequence !== upload.sequence) return;
      acceptSnapshot(snapshot);
      if (plan.revision < state.snapshot.revision) throw new Error('工单已经更新，请重新生成预览后再确认。');
      upload.plan = plan;
    } catch (error) {
      if (state.upload !== upload || sequence !== upload.sequence) return;
      upload.error = error.message;
    } finally {
      if (state.upload === upload && sequence === upload.sequence) {
        upload.waiting = false;
        render();
        if (upload.plan && state.page === 'import') main.querySelector('#preview-heading').focus();
      }
    }
  }
  async function saveImport() {
    const upload = state.upload;
    if (!allowed('csv.import') || upload.waiting || !upload.plan || upload.choices.size < upload.plan.conflicts.length) return;
    upload.waiting = true;
    upload.committing = true;
    upload.error = '';
    renderImport();
    try {
      const { snapshot, batch } = await D.request('import/commit', {
        ...upload.doc, source: upload.source, token: upload.plan.token, revision: upload.plan.revision, choices: [...upload.choices]
      });
      acceptSnapshot(snapshot);
      upload.result = { id: batch.id, name: batch.name, inserted: batch.inserted, updated: batch.updated, skipped: batch.issues.length };
      upload.plan = null;
      notify(batch.inserted || batch.updated ? '已写入工单和导入批次' : '仅记录批次，工单字段未改动');
    } catch (error) {
      if (error.snapshot) acceptSnapshot(error.snapshot);
      upload.error = error.code === 'stale' ? '工单已经更新，请重新生成预览后再确认。' : error.message;
    } finally {
      upload.waiting = false;
      upload.committing = false;
      render();
    }
  }

  const detailTabs = { action: '处置台', context: '告警上下文', timeline: '时间线', links: '关联工单', fields: '来源数据' };
  const operationFields = {
    pause: '挂起原因', note: '处置记录', verify: '验证依据与待检查项', close: '验证结果', reject: '验证未通过的原因', reopen: '重开原因'
  };
  function detailHeader(record, editor) {
    const id = D.valueOf(record, D.ID);
    return `<div class="drawer-heading incident-heading"><div>${sourceBadge(record.source)}<h2 id="ticket-title">${esc(D.valueOf(record, D.SYMPTOM) || id)}</h2>
      <div class="incident-heading-meta"><span class="ticket-id">${esc(id)}</span>${priorityBadge(record.work.priority)}${workBadge(record.work)}</div></div>
      <button class="icon-button" type="button" data-action="close-editor" aria-label="关闭工单">${icon('close', 21)}</button></div>
      <nav class="detail-tabs" aria-label="工单详情">${Object.entries(detailTabs).map(([tab, label]) => `<button type="button" data-action="detail-tab" data-tab="${tab}" aria-current="${tab === editor.tab ? 'true' : 'false'}">${label}</button>`).join('')}</nav>`;
  }
  function actionForm(record, operation) {
    if (!operation) return '';
    const { work } = record;
    const required = Object.hasOwn(operationFields, operation);
    let controls = '';
    if (operation === 'assign') controls += `<label class="editor-field"><span>新负责人</span><select name="owner" required><option value="">请选择</option>${state.snapshot.people.filter((person) => person.assignable && person.id !== work.owner).map((person) => `<option value="${esc(person.id)}">${esc(F.actorLabel(person))}${person.id === state.snapshot.account.id ? '（我）' : ''}</option>`).join('')}</select></label>`;
    if (operation === 'impact') controls += `<div class="action-fields"><label class="editor-field"><span>优先级</span><select name="priority">${Object.entries(F.priorities).map(([key, item]) => `<option value="${key}" ${key === work.priority ? 'selected' : ''}>${key} · ${item.label}</option>`).join('')}</select></label>
      <label class="editor-field"><span>业务影响</span><textarea name="impact" rows="3">${esc(work.impact)}</textarea></label></div>`;
    else if (operation !== 'claim') controls += `<label class="editor-field"><span>${operationFields[operation] ?? '补充说明（选填）'}</span><textarea name="note" rows="3" ${required ? 'required' : ''}></textarea></label>`;
    else controls += '<p>认领后，你将成为此工单负责人，工单进入处理中。</p>';
    return `<form id="workflow-form" class="workflow-form"><h4>${F.labels[operation]}</h4>${controls}
      <div><button type="button" data-action="cancel-operation" class="button secondary">取消</button><button type="submit" class="button primary">${operation === 'claim' ? '确认认领' : '确认' + F.labels[operation]}</button></div></form>`;
  }
  function infoRow(label, value) {
    return `<div><dt>${label}</dt><dd>${value || '<span class="quiet">未填写</span>'}</dd></div>`;
  }
  function actionView(record, editor) {
    const { work } = record;
    const rawState = D.valueOf(record, D.STATUS);
    const status = D.statusKey(rawState);
    const sourceRestored = ['resolved','available'].includes(status);
    const checkSource = !sourceRestored && Boolean(D.datePart(D.getTime(record, 'end')));
    const paused = work.status === 'paused' ? [...work.history].reverse().find((entry) => entry.type === 'pause') : null;
    const verification = work.status === 'verify' ? [...work.history].reverse().find((entry) => entry.type === 'verify') : null;
    const primary = { pending: 'claim', active: 'verify', paused: 'resume', verify: 'close', closed: 'reopen' }[work.status];
    const at = F.now(state.snapshot);
    const resourceKeys = {
      pd: [['PD 应用实例','PD应用实例'],['Pod','Pod名称']],
      hybrid: [['ARMS 应用','应用名称（ARMS）'],['ARMS 集群','集群名称（ARMS）']],
      gpu: [['GPU 主机','主机名称'],['主机 IP','主机IP']]
    }[record.source];
    const resources = resourceKeys.map(([label, key]) => [label, D.valueOf(record, key)]).filter(([, value]) => !D.isBlank(value));
    const recent = [...work.history].reverse().find((entry) => ['note','reject'].includes(entry.type) && entry.note);
    const items = [
      infoRow('负责人', esc(ownerName(work))),
      infoRow('来源状态', statusBadge(rawState)),
      infoRow('影响 BU', esc(D.valueOf(record, D.BU))),
      infoRow('源故障时间', dateCell(D.getTime(record, 'start'))),
      infoRow('源恢复时间', dateCell(D.getTime(record, 'end'))),
      infoRow('处置时限', deadlineBadge(work, at))
    ];
    return `<div class="detail-grid"><section class="detail-card"><h3>处置动作</h3>
      ${sourceRestored && work.status !== 'closed' ? `<p class="workflow-notice">${icon('check', 17)}<span>来源已恢复，可验证业务。工单状态继续按处置流程更新。</span></p>` : ''}
      ${checkSource ? `<p class="workflow-notice">${icon('info', 17)}<span>来源已有恢复时间，状态未标记为已恢复或可用，请核对来源记录。</span></p>` : ''}
      ${paused ? `<p class="workflow-notice">${icon('clock', 17)}<span>挂起原因 · ${esc(paused.note)}</span></p>` : ''}
      ${verification ? `<p class="workflow-notice">${icon('check', 17)}<span>验证依据 · ${esc(verification.note)}</span></p>` : ''}
      ${allowed('ticket.action') ? `<div class="operation-set">${F.available(work).map((operation) => `<button class="button ${operation === primary ? 'primary' : 'secondary'}" type="button" data-action="choose-operation" data-operation="${operation}" aria-pressed="${editor.operation === operation}">${F.labels[operation]}</button>`).join('')}</div>
      ${actionForm(record, editor.operation)}` : ''}
      ${resources.length ? `<div class="action-context"><h4>资源定位</h4><dl class="detail-facts">${resources.map(([label, value]) => infoRow(label, esc(value))).join('')}</dl></div>` : ''}
      ${recent && !editor.operation ? `<div class="action-context"><h4>${F.labels[recent.type]}</h4><p class="timeline-note">${esc(recent.note)}</p><p class="timeline-meta">${F.stamp(recent.at)} · ${esc(F.actorLabel(recent.actor))}</p></div>` : ''}
      </section><section class="detail-card"><h3>影响摘要</h3><p class="impact-summary">${esc(work.impact || '尚未记录业务影响')}</p><dl class="detail-facts">${items.join('')}</dl></section></div>`;
  }
  function contextView(record) {
    const device = {
      pd: ['PD应用实例','Pod名称','节点IP','节点卡类型','命名空间','用户集群','资源池集群'],
      hybrid: ['告警名称（ARMS）','集群名称（ARMS）','应用名称（ARMS）','通知策略（ARMS）','告警内容（ARMS）','记录类型 ALERT/UNPAIRED_RECOVER'],
      gpu: ['故障来源','故障类型','序列号','主机名称','主机IP','GPU型号','资源池集群']
    }[record.source];
    const incident = [D.SYMPTOM, D.BU, '影响业务时长', D.ROOT, '恢复手段'];
    const fields = (keys) => keys.map((key) => infoRow(esc(key), esc(D.valueOf(record, key)))).join('');
    const raw = D.valueOf(record, '完整原始推送体');
    return `<div class="detail-grid"><section class="detail-card"><h3>故障与恢复</h3><dl class="detail-facts">${fields(incident)}</dl></section>
      <section class="detail-card"><h3>${D.sources[record.source].name}上下文</h3><dl class="detail-facts">${fields(device)}</dl>
      ${raw ? `<details class="raw-context"><summary>完整原始推送体</summary><pre>${esc(raw)}</pre></details>` : ''}</section></div>`;
  }
  const workFieldLabels = {
    status: '处置状态', owner: '负责人', priority: '优先级', impact: '业务影响',
    createdAt: '工单创建时间', cycleAt: '时限起算时间'
  };
  const diffKey = (field) => encodeURIComponent(JSON.stringify([field.area, field.key]));
  function diffName(field) {
    if (field.area === 'source') return '来源 · ' + D.fieldName(field.key);
    if (field.area === 'work') return '处置 · ' + workFieldLabels[field.key];
    return field.key === 'source' ? '告警来源' : '关联工单';
  }
  function diffValue(field, side) {
    const value = field[side];
    if (value === null) return '<span class="quiet">未存在</span>';
    if (value === '') return '<span class="quiet">空值</span>';
    let label = field[side + 'Label'] || value;
    if (field.area === 'work' && field.key === 'status') label = F.statuses[value];
    if (field.area === 'work' && typeof value === 'number') label = F.auditStamp(value);
    if (field.area === 'ticket' && field.key === 'source') label = D.sources[value].name;
    return `<span class="audit-value">${esc(label)}</span>`;
  }
  function auditDiff(fields) {
    return `<dl class="audit-diff">${fields.map((field) => `<div><dt>${esc(diffName(field))}</dt>
      <dd><p><b>改前</b>${diffValue(field, 'before')}</p><p><b>改后</b>${diffValue(field, 'after')}</p></dd></div>`).join('')}</dl>`;
  }
  function timelineView(record, editor) {
    const entries = [...record.work.history];
    const batches = new Map(state.snapshot.batches.map((batch) => [batch.id, batch]));
    const recordedBatches = new Set(entries.filter((event) => event.via === 'csv').map((event) => event.id));
    for (const batch of batches.values()) {
      if (recordedBatches.has(batch.id) || !batch.decisions.some((decision) => decision.uid === record.uid)) continue;
      entries.push({ at: batch.at, type: 'batch', id: batch.id, actor: batch.actor, revision: batch.revision, via: 'csv', changes: [] });
    }
    entries.sort((left, right) => right.revision - left.revision);
    const fields = new Map(entries.flatMap((event) => event.changes.map((field) => [diffKey(field), diffName(field)])));
    const selected = fields.has(editor.auditField) ? editor.auditField : '';
    const visible = selected ? entries.filter((event) => event.changes.some((field) => diffKey(field) === selected)) : entries;
    return `<section class="detail-card"><div class="audit-heading"><h3>操作与导入记录</h3>
      <label class="editor-field"><span>按字段筛选</span><select id="audit-field"><option value="">全部字段与操作</option>
      ${[...fields].map(([key, name]) => `<option value="${esc(key)}" ${selected === key ? 'selected' : ''}>${esc(name)}</option>`).join('')}</select></label></div>
      <ol class="timeline">${visible.map((entry) => {
      const related = entry.target ? state.snapshot.records.find((candidate) => candidate.uid === entry.target) : null;
      const batch = batches.get(entry.id);
      const title = F.labels[entry.type] ?? (batch ? 'CSV 导入批次' : '新建工单');
      const changes = selected ? entry.changes.filter((field) => diffKey(field) === selected) : entry.changes;
      const decisions = batch?.decisions.filter((decision) => decision.uid === record.uid).length ?? 0;
      return `<li><i></i><div><strong>${title}</strong><p class="timeline-meta">
        <time datetime="${new Date(entry.at).toISOString()}">${F.auditStamp(entry.at)}（北京时间）</time> · ${esc(F.actorLabel(entry.actor))} · ${entry.via === 'csv' ? 'CSV 导入' : '人工操作'}</p>
        ${entry.note ? `<p class="timeline-note">${esc(entry.note)}</p>` : ''}
        ${batch ? `<p class="timeline-note">${esc(batch.name)}${decisions ? ` · ${decisions} 项冲突决策` : ''}</p>` : ''}
        ${changes.length ? auditDiff(changes) : '<p class="quiet">工单字段未改动</p>'}
        ${related ? `<button type="button" class="text-link" data-action="open-ticket" data-uid="${esc(related.uid)}">${esc(D.valueOf(related, D.ID))}${icon('arrow', 15)}</button>` : ''}
        ${batch ? `<button type="button" class="text-link" data-action="show-batch" data-batch="${esc(batch.id)}">查看该批次${icon('arrow', 15)}</button>` : ''}</div></li>`;
    }).join('')}</ol></section>`;
  }
  function linksView(record) {
    const ids = state.snapshot.links.filter((link) => link.left === record.uid || link.right === record.uid).map((link) => link.left === record.uid ? link.right : link.left);
    const candidates = state.snapshot.records.filter((item) => item.uid !== record.uid && !ids.includes(item.uid)).sort(F.activeSort);
    const linked = ids.map((uid) => state.snapshot.records.find((item) => item.uid === uid)).filter(Boolean);
    return `<section class="detail-card link-detail"><h3>关联工单</h3><p>关联适用于可能同因或互相影响的告警。各工单保留自己的事件 ID、生命周期与统计。</p>
      ${linked.length ? `<ul class="linked-list">${linked.map((item) => `<li><div>${sourceBadge(item.source)}<button class="ticket-link" type="button" data-action="open-ticket" data-uid="${esc(item.uid)}">${esc(D.valueOf(item, D.SYMPTOM) || D.valueOf(item, D.ID))}</button><span class="ticket-id">${esc(D.valueOf(item, D.ID))}</span></div>${allowed('ticket.links') ? `<button class="button secondary" type="button" data-action="unlink-ticket" data-target="${esc(item.uid)}">解除关联</button>` : ''}</li>`).join('')}</ul>` : '<p class="quiet link-empty">暂无关联工单</p>'}
      ${allowed('ticket.links') && candidates.length ? `<form id="link-form"><label class="editor-field"><span>选择另一条工单</span><select name="target" required><option value="">请选择工单</option>${candidates.map((item) => `<option value="${esc(item.uid)}">${esc(D.sources[item.source].short + ' · ' + D.valueOf(item, D.ID) + ' · ' + D.valueOf(item, D.SYMPTOM))}</option>`).join('')}</select></label><button type="submit" class="button primary">${icon('plus', 16)}建立关联</button></form>` : ''}</section>`;
  }
  function renderDetail(record, editor) {
    const views = { action: actionView, context: contextView, timeline: timelineView, links: linksView };
    dialog.innerHTML = `<div class="ticket-editor has-detail">${detailHeader(record, editor)}<div class="drawer-body detail-body">${views[editor.tab](record, editor)}</div>
      <div class="drawer-footer"><p id="editor-error" class="form-error" role="alert" hidden></p><div>${button('close-editor', '完成查看')}</div></div></div>`;
  }
  function renderBatches() {
    const selected = state.snapshot.batches.find((batch) => batch.id === state.batchId);
    if (!selected) {
      const list = state.snapshot.batches;
      main.innerHTML = titleMarkup('导入批次', '回查文件、字段合并及冲突决策。', allowed('csv.import') ? `<a class="button primary" href="#import">${icon('upload', 17)}导入 CSV</a>` : '') +
        `<section class="panel batch-panel" aria-label="CSV 批次记录">${list.length ? `<div class="table-scroll"><table class="tickets-table"><thead><tr><th scope="col">批次文件</th><th scope="col">来源</th><th scope="col">导入时间</th><th scope="col">导入人</th><th scope="col">有效记录</th><th scope="col">写入结果</th><th scope="col">冲突决策</th></tr></thead><tbody>
        ${list.map((batch) => `<tr><td><button class="ticket-link" type="button" data-action="show-batch" data-batch="${esc(batch.id)}">${esc(batch.name)}</button></td><td>${sourceBadge(batch.source)}</td><td>${F.stamp(batch.at)}</td><td>${esc(F.actorLabel(batch.actor))}</td><td>${batch.counts.rows}</td><td>${batch.inserted || batch.updated ? `新增 ${batch.inserted} · 更新 ${batch.updated}` : '仅记录批次'}</td><td>${batch.decisions.length}</td></tr>`).join('')}</tbody></table></div>` : emptyState('暂无导入批次', '导入完成后会在这里记录文件、统计和冲突决策。') }</section>`;
      return;
    }
    const batch = selected;
    const count = batch.counts;
    const stats = [['有效记录',count.rows],['新增工单',batch.inserted],['更新工单',batch.updated],['自动补齐格',count.filled],['相同跳过格',count.equal],['保留原值格',count.preserved]];
    main.innerHTML = titleMarkup('批次详情', `${esc(batch.name)} · ${D.sources[batch.source].name} · ${F.auditStamp(batch.at)}（北京时间） · ${esc(F.actorLabel(batch.actor))}`, button('back-batches', '返回批次列表')) +
      `<section class="panel batch-panel"><div class="panel-heading"><div><h2>${batch.effects.length ? '工单字段已写入' : '仅记录批次'}</h2><p>${batch.effects.length ? '可查看实际变更和发生冲突时的取值。' : '本次没有改动或新增工单。'}</p></div></div>
      <div class="preview-body"><div class="preview-stats">${stats.map(([label,value]) => `<div><strong>${number.format(value)}</strong><span>${label}</span></div>`).join('')}</div>
      ${batch.issues.length ? `<details class="invalid-rows"><summary>${batch.issues.length} 行已跳过</summary><ul>${batch.issues.map((item) => `<li>CSV 第 ${item.line} 行：${item.message}</li>`).join('')}</ul></details>` : ''}
      <section class="batch-section"><h3>冲突决策 <span>${batch.decisions.length}</span></h3>${batch.decisions.length ? batch.decisions.map((decision) => `<details class="batch-entry"><summary>${esc(decision.id)} · ${esc(D.fieldName(decision.field))} · ${decision.selected.system ? '采用系统值' : '采用 CSV 值'}</summary><div><p class="audit-value"><b>保存值</b> ${esc(decision.selected.value)}</p>
      ${decision.candidates.map((candidate) => `<p class="audit-value"><b>${candidate.system ? '系统值' : 'CSV 值'}${candidate.lines.length ? ' · 行 ' + candidate.lines.join('、') : ''}</b> ${esc(candidate.value)}</p>`).join('')}
      ${decision.uid ? `<button type="button" class="text-link" data-action="open-ticket" data-uid="${esc(decision.uid)}">打开工单${icon('arrow', 15)}</button>` : ''}</div></details>`).join('') : '<p class="quiet">本批次没有需要确认的冲突。</p>'}</section>
      <section class="batch-section"><h3>工单字段变更 <span>${batch.effects.length}</span></h3>${batch.effects.length ? batch.effects.map((effect) => `<details class="batch-entry"><summary>${effect.kind === 'inserted' ? '新增' : '更新'} · ${esc(effect.eventId)} · ${effect.fields.length} 个字段</summary>
      <div><button type="button" class="text-link" data-action="open-ticket" data-uid="${esc(effect.uid)}">打开工单${icon('arrow', 15)}</button><dl class="batch-diff">${effect.fields.map((field) => `<div><dt>${esc(D.fieldName(field.key))}</dt><dd><span>${field.before === null ? '未存在' : (esc(field.before) || '空值')}</span><span aria-label="改为">→</span><b>${esc(field.after) || '空值'}</b></dd></div>`).join('')}</dl></div></details>`).join('') : '<p class="quiet">没有变更记录。</p>'}</section></div></section>`;
  }

  function entryField(key, index, values, allowMultiline = false) {
    const name = key === D.STATUS ? '来源状态（CSV 当前状态）' : D.fieldName(key);
    const value = values.get(key) ?? '';
    const isLong = key === D.SYMPTOM || key === D.ROOT || key === '恢复手段' || key === '告警内容（ARMS）' || key === '完整原始推送体' || /[\r\n]/u.test(value);
    const attrs = `id="field-${index}" name="field-${index}" data-field="${index}"`;
    return `<label class="editor-field ${isLong ? 'editor-wide' : ''}" for="field-${index}"><span>${esc(name)}${key === D.ID ? '<b> *</b>' : ''}</span>
      ${isLong || allowMultiline ? `<textarea ${attrs} rows="3" ${key === D.ID ? 'required' : ''}></textarea>` : `<input type="text" ${attrs} ${key === D.STATUS ? 'list="editor-status" autocomplete="off"' : ''} ${key === D.ID ? 'required' : ''}>`}</label>`;
  }
  function readEditorFields() {
    const form = dialog.querySelector('form');
    if (!form) return;
    for (const input of form.querySelectorAll('[data-field]')) {
      const field = state.editor.keys[Number(input.dataset.field)];
      const previous = state.editor.values.get(field) ?? '';
      // Text controls normalize line endings. Carry through untouched CSV values.
      if (input.value !== previous.replace(/\r\n?/gu, '\n') && input.value !== previous) state.editor.values.set(field, input.value);
    }
  }
  function renderEditor() {
    const editor = state.editor;
    const record = state.snapshot.records.find((row) => row.uid === editor.uid);
    if (record && editor.tab !== 'fields') {
      renderDetail(record, editor);
      return;
    }
    const editable = canSaveSource(editor);
    const values = editor.values;
    const standard = D.sources[editor.source].fields;
    const headline = [D.ID, D.STATUS, D.SYMPTOM, D.BU, '影响业务时长', D.ROOT, '恢复手段'];
    const essential = headline.filter((key) => standard.includes(key));
    const remaining = standard.filter((key) => !essential.includes(key));
    const extra = [...values.keys()].filter((key) => !standard.includes(key));
    editor.keys = [...essential, ...remaining, ...extra];
    dialog.innerHTML = `<form class="ticket-editor ${record ? 'has-detail' : ''}" id="source-form">
      ${record ? detailHeader(record, editor) : `<div class="drawer-heading"><div><span>${sourceBadge(editor.source)}</span><h2 id="ticket-title">新建故障工单</h2>
      <p>填写事件 ID 后即可建立工单。</p></div><button class="icon-button" type="button" data-action="close-editor" aria-label="关闭工单">${icon('close', 21)}</button></div>`}
      <div class="drawer-body">
        ${editor.uid ? '' : `<label class="editor-field editor-source"><span>表格来源</span><select id="editor-source">${sourceOptions(editor.source)}</select></label>`}
        <fieldset class="field-group"><legend>故障信息</legend><div class="editor-grid">${essential.map((key, index) => entryField(key, index, values)).join('')}</div></fieldset>
        <fieldset class="field-group"><legend>来源与时间字段</legend><div class="editor-grid">${remaining.map((key, index) => entryField(key, index + essential.length, values)).join('')}</div></fieldset>
        ${extra.length ? `<fieldset class="field-group"><legend>CSV 附加字段</legend><div class="editor-grid">${extra.map((key, index) => entryField(key, index + essential.length + remaining.length, values, true)).join('')}</div></fieldset>` : ''}
        <datalist id="editor-status">${Object.entries(D.stages).filter(([stage]) => stage !== 'other').map(([, stage]) => `<option value="${stage.label}"></option>`).join('')}</datalist>
      </div>
      <div class="drawer-footer"><p id="editor-error" class="form-error" role="alert" hidden></p><div>${button('close-editor', editable ? '取消' : '完成查看')}${editable ? '<button type="submit" class="button primary">保存工单</button>' : ''}</div></div>
    </form>`;
    for (const input of dialog.querySelectorAll('[data-field]')) {
      input.value = values.get(editor.keys[Number(input.dataset.field)]) ?? '';
      input.readOnly = !editable;
    }
  }
  function openEditor(uid = '') {
    const record = state.snapshot.records.find((item) => item.uid === uid);
    if (uid ? !record : !allowed('ticket.create')) return;
    state.editor = { uid, source: record?.source ?? 'pd', values: new Map(Object.entries(record?.fields ?? {})), keys: [], revision: state.snapshot.revision, waiting: false, tab: uid ? 'action' : 'fields', operation: '', auditField: '' };
    renderEditor();
    if (!dialog.open) dialog.showModal();
  }
  async function saveAction(operation, input) {
    const editor = state.editor;
    const linking = operation === 'link' || operation === 'unlink';
    if (!editor?.uid || editor.waiting || !allowed(linking ? 'ticket.links' : 'ticket.action')) return;
    const current = state.snapshot.records.find((record) => record.uid === editor.uid);
    if (!current) return;
    const errorElement = dialog.querySelector('#editor-error');
    errorElement.hidden = true;
    editor.waiting = true;
    const controls = [...dialog.querySelectorAll('button, select, input, textarea')];
    controls.forEach((control) => { control.disabled = true; });
    try {
      const path = `tickets/${editor.uid}/${linking ? 'links' : 'action'}`;
      const command = linking ? { target: input.target, remove: operation === 'unlink' } : { operation, input };
      const result = await D.request(path, { revision: editor.revision, ...command });
      acceptSnapshot(result.snapshot);
      editor.revision = result.snapshot.revision;
      editor.operation = '';
      render();
      renderEditor();
      notify(F.labels[operation] + '已保存');
    } catch (error) {
      if (error.code === 'stale') {
        try {
          acceptSnapshot(error.snapshot ?? await D.read());
          render();
        } catch { /* Keep the editor available for the user. */ }
        errorElement.textContent = '工单已更新，请保留修改并关闭后重新打开工单。';
      } else errorElement.textContent = error.message;
      errorElement.hidden = false;
    } finally {
      editor.waiting = false;
      controls.forEach((control) => { control.disabled = false; });
    }
  }
  async function saveEditor() {
    const editor = state.editor;
    if (editor.waiting || !canSaveSource(editor)) return;
    readEditorFields();
    const errorElement = dialog.querySelector('#editor-error');
    const sayError = (message) => {
      errorElement.textContent = message;
      errorElement.hidden = false;
    };
    const id = editor.values.get(D.ID) ?? '';
    if (D.isBlank(id)) {
      sayError('请填写故障事件 ID。');
      return;
    }
    editor.waiting = true;
    dialog.querySelectorAll('button, select, input, textarea').forEach((control) => { control.disabled = true; });
    try {
      const fields = Object.fromEntries(editor.keys.filter((key) => editor.values.has(key)).map((key) => [key, editor.values.get(key)]));
      const path = editor.uid ? `tickets/${editor.uid}/fields` : 'tickets';
      const result = await D.request(path, { revision: editor.revision, source: editor.source, fields });
      acceptSnapshot(result.snapshot);
      if (!result.changed) {
        notify('来源数据没有改动');
        return;
      }
      render();
      openEditor(result.uid);
      if (editor.uid) { state.editor.tab = 'fields'; renderEditor(); }
      notify(editor.uid ? '来源数据已保存' : '工单已创建');
    } catch (error) {
      if (error.code === 'stale') {
        try {
          acceptSnapshot(error.snapshot ?? await D.read());
          render();
        } catch { /* The user can retry after storage becomes available. */ }
        sayError('工单已更新。请先保留你的修改，关闭窗口后重新打开工单。');
      } else sayError(error.message);
    } finally {
      editor.waiting = false;
      dialog.querySelectorAll('button, select, input, textarea').forEach((control) => { control.disabled = false; });
    }
  }

  function render() {
    const current = pages[state.page];
    if (!state.snapshot) return;
    const account = state.snapshot.account;
    navigation.innerHTML = Object.entries(pages).filter(([key]) => key !== 'import' || allowed('csv.import')).map(([key, page]) => `<a href="#${key}" class="nav-link ${state.page === key ? 'active' : ''}" ${state.page === key ? 'aria-current="page"' : ''}>${icon(page.icon, 19)}<span>${page.nav}</span></a>`).join('') +
      (account.role === 'admin' ? `<a href="/accounts" id="account-manage" class="nav-link account-nav-link">${icon('account', 19)}<span>账号与权限</span></a>` : '');
    document.querySelector('#breadcrumb').textContent = current.title;
    document.querySelector('#account-name').textContent = account.displayName;
    document.querySelector('#account-name').title = F.actorLabel(account);
    document.querySelector('#account-role').textContent = account.roleName;
    document.querySelector('#account-role').title = account.roleName;
    if (state.page === 'dashboard') renderDashboard();
    if (state.page === 'tickets') renderTickets();
    if (state.page === 'import') renderImport();
    if (state.page === 'batches') renderBatches();
  }
  function setRoute() {
    const path = window.location.hash.slice(1);
    if (!Object.hasOwn(pages, path)) return;
    if (path === 'import' && !allowed('csv.import')) {
      window.location.hash = 'dashboard';
      return;
    }
    const changed = state.page !== path;
    state.page = path;
    render();
    if (changed) {
      window.scrollTo(0, 0);
      main.focus({ preventScroll: true });
    }
  }
  function clearFilters() {
    state.filters = { query: '', source: '', status: '', queue: '', page: 1 };
  }

  function refreshClock() {
    if (!state.snapshot || document.hidden) return;
    const at = F.now(state.snapshot);
    if (state.page === 'tickets' && state.filters.queue === 'deadline') {
      const matches = matchingTickets(at);
      // For one data revision, an advancing clock can only add records to this queue.
      if (matches.length !== ticketResultCount) renderTicketResults(at, matches);
    }
    const date = main.querySelector('#dashboard-end');
    if (date && date.max !== F.day(at) && date !== document.activeElement) {
      if (state.end === date.max) state.end = F.day(at);
      renderDashboard(at);
    }
    const clock = main.querySelector('#duty-clock');
    if (clock) clock.textContent = F.stamp(at);
    for (const counter of main.querySelectorAll('[data-queue]')) {
      counter.querySelector('strong').textContent = number.format(state.snapshot.records.filter((record) => F.matches(record, counter.dataset.queue, at, state.snapshot.account.id)).length);
    }
    for (const badge of document.querySelectorAll('[data-sla-end][data-sla-closed="false"]')) {
      const remaining = Number(badge.dataset.slaEnd) - at;
      const status = remaining < 0 ? 'over' : remaining <= F.hour ? 'soon' : 'normal';
      badge.className = 'deadline deadline-' + status;
      badge.textContent = `${status === 'over' ? '超时' : '剩余'} ${duration(remaining)}`;
    }
    const focus = main.querySelector('[data-focus-uid]');
    if (focus) {
      const work = state.snapshot.records.find((record) => record.uid === focus.dataset.focusUid)?.work;
      if (work) focus.textContent = deadlineLabel(work, at);
    }
  }

  document.addEventListener('click', (event) => {
    const target = event.target.closest('[data-action]');
    if (!target || !state.snapshot) return;
    switch (target.dataset.action) {
      case 'sign-out':
        D.request('session/logout', {}).then(() => window.location.replace('/login')).catch((error) => notify(error.message));
        break;
      case 'range':
        state.range = Number(target.dataset.range);
        renderDashboard();
        main.querySelector(`[data-range="${state.range}"]`).focus();
        break;
      case 'distribution':
        state.distribution = target.dataset.mode;
        renderDashboard();
        main.querySelector(`[data-mode="${state.distribution}"]`).focus();
        break;
      case 'all-tickets':
        clearFilters();
        if (state.page === 'tickets') renderTickets();
        break;
      case 'queue-filter':
        clearFilters();
        state.filters.queue = target.dataset.queue;
        window.location.hash = 'tickets';
        break;
      case 'clear-queue':
        state.filters.queue = '';
        state.filters.page = 1;
        renderTicketResults();
        main.querySelector('#ticket-status').focus();
        break;
      case 'detail-tab':
        if (!state.editor?.waiting) {
          if (state.editor.tab === 'fields') readEditorFields();
          state.editor.tab = target.dataset.tab;
          state.editor.operation = '';
          renderEditor();
          dialog.querySelector(`[data-tab="${state.editor.tab}"]`).focus();
        }
        break;
      case 'choose-operation':
        state.editor.operation = target.dataset.operation;
        renderEditor();
        dialog.querySelector('#workflow-form textarea, #workflow-form select, #workflow-form button[type="submit"]').focus();
        break;
      case 'cancel-operation':
        state.editor.operation = '';
        renderEditor();
        break;
      case 'unlink-ticket':
        saveAction('unlink', { target: target.dataset.target });
        break;
      case 'show-batch':
        state.batchId = target.dataset.batch;
        if (dialog.open) dialog.close();
        if (state.page === 'batches') renderBatches();
        else window.location.hash = 'batches';
        break;
      case 'back-batches':
        state.batchId = '';
        renderBatches();
        break;
      case 'clear-filters':
        clearFilters();
        renderTickets();
        main.querySelector('#ticket-search').focus();
        break;
      case 'prev-page':
      case 'next-page':
        state.filters.page += target.dataset.action === 'prev-page' ? -1 : 1;
        renderTicketResults();
        break;
      case 'open-ticket':
        openEditor(target.dataset.uid);
        break;
      case 'new-ticket':
        openEditor();
        break;
      case 'close-editor':
        if (!state.editor?.waiting) dialog.close();
        break;
      case 'reset-import':
        if (state.upload.committing) break;
        resetImport();
        break;
      case 'prepare-import':
        prepareImport();
        break;
      case 'cancel-preview':
        if (state.upload.committing) break;
        state.upload.plan = null;
        state.upload.choices = new Map();
        state.upload.error = '';
        renderImport();
        main.querySelector('[data-action="prepare-import"]').focus();
        break;
      case 'keep-system':
        if (state.upload.committing) break;
        for (const conflict of state.upload.plan.conflicts) {
          const index = conflict.candidates.findIndex((candidate) => candidate.system);
          if (index < 0) continue;
          state.upload.choices.set(conflict.index, index);
          main.querySelector(`[data-conflict="${conflict.index}"][value="${index}"]`).checked = true;
        }
        updateImportFeedback();
        break;
      case 'commit-import':
        saveImport();
        break;
    }
  });
  document.addEventListener('input', (event) => {
    if (event.target.id === 'ticket-search') {
      state.filters.query = event.target.value;
      state.filters.page = 1;
      renderTicketResults();
    }
  });
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (target.id === 'dashboard-end' && D.datePart(target.value) && target.validity.valid) {
      state.end = target.value;
      renderDashboard();
    } else if (target.id === 'ticket-source' || target.id === 'ticket-status') {
      state.filters[target.id === 'ticket-source' ? 'source' : 'status'] = target.value;
      state.filters.page = 1;
      renderTicketResults();
    } else if (target.id === 'import-source') {
      if (state.upload.committing) return;
      if (state.upload.waiting && state.upload.doc) {
        state.upload.sequence += 1;
        state.upload.waiting = false;
      }
      state.upload.source = target.value;
      state.upload.plan = null;
      state.upload.choices = new Map();
      state.upload.error = '';
      if (!state.upload.waiting) renderImport();
    } else if (target.id === 'csv-file' && target.files[0]) receiveFile(target.files[0]);
    else if (target.hasAttribute('data-conflict')) {
      state.upload.choices.set(Number(target.dataset.conflict), Number(target.value));
      updateImportFeedback();
    } else if (target.id === 'audit-field') {
      state.editor.auditField = target.value;
      renderEditor();
      dialog.querySelector('#audit-field').focus();
    } else if (target.id === 'editor-source' && target.value) {
      readEditorFields();
      const common = D.sources[target.value].fields;
      state.editor.values = new Map([...state.editor.values].filter(([key]) => common.includes(key)));
      state.editor.source = target.value;
      renderEditor();
      dialog.querySelector('#editor-source').focus();
    }
  });
  dialog.addEventListener('submit', (event) => {
    event.preventDefault();
    const form = event.target;
    if (form.id === 'source-form') saveEditor();
    if (form.id === 'workflow-form') saveAction(state.editor.operation, Object.fromEntries(new FormData(form)));
    if (form.id === 'link-form') saveAction('link', Object.fromEntries(new FormData(form)));
  });
  dialog.addEventListener('cancel', (event) => {
    if (state.editor?.waiting) event.preventDefault();
  });
  dialog.addEventListener('close', () => { if (!dialog.open) state.editor = null; });
  window.addEventListener('hashchange', setRoute);
  compactPlot.addEventListener('change', () => { if (state.snapshot && state.page === 'dashboard') renderDashboard(); });
  document.addEventListener('visibilitychange', refreshClock);

  async function start() {
    document.querySelector('#storage-icon').innerHTML = icon('local', 18);
    document.querySelector('#breadcrumb-arrow').innerHTML = icon('chevron', 13);
    try {
      acceptSnapshot(await D.read());
      D.watchSession(state.snapshot.account);
    } catch (error) {
      main.innerHTML = `<div class="loading" role="alert">${esc(error.message)}</div>`;
      return;
    }
    state.end = F.day(F.now(state.snapshot));
    setRoute();
    render();
    window.setInterval(refreshClock, 30_000);
  }
  start();
})();
