// ============================================================
//  ADMIN: LEMBRETES — which payment-reminder emails went out yesterday and
//  today, and which will go out tomorrow, without opening Brevo.
//
//  Past days are FACTS read from emailReminderRuns, the one-doc-per-run log
//  written by vercel-cron/api/send-reminders.js. Tomorrow (and today, until
//  today's run has happened) is a FORECAST: the same -1..3 day window, phase
//  split and emailRemindersSent dedup keys as that cron, replayed here over
//  the current installments. Keep the two in sync if the cron's rules change.
//
//  Both collections are admin-read-only in firestore.rules; only the cron's
//  service account writes them. "Enviado" means Brevo accepted the message,
//  not that it reached the inbox.
// ============================================================
import {
  getDocs, getDoc, doc, collection, query, orderBy, limit
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, escapeHtml, escapeAttr, formatDatePt, money, setAdminHash, show,
  daysUntil, addDaysIso, pad2, toast
} from './core.js';
import { fetchAllInstallments, waReminderHref } from './admin-debts-agenda.js';
import { loadAdminEdit, openProject } from './admin-clients.js';

// vercel.json schedules the cron at 08:00 UTC. On Vercel's Hobby plan a cron
// may fire any time inside that hour, so "late" only starts after 09:30 UTC.
const CRON_UTC_HOUR = 8;
const LATE_AFTER_UTC_MIN = 9 * 60 + 30;
const SENDER_EMAIL = 'contato@esterprod.com';
const HISTORY_DAYS = 14;
const WEEK_DAYS = 7;
const WEEKDAYS_PT = ['dom', 'seg', 'ter', 'qua', 'qui', 'sex', 'sáb'];

function localIso(d){ return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`; }
function timePt(isoTs){ const d = new Date(isoTs); return `${pad2(d.getHours())}:${pad2(d.getMinutes())}`; }
function dayLabel(iso){
  const [y, m, d] = iso.split('-').map(Number);
  return `${WEEKDAYS_PT[new Date(y, m - 1, d).getDay()]} ${pad2(d)}/${pad2(m)}`;
}
// The cron's expected local run window, e.g. "09:00 e as 10:00" in summer.
function cronWindowText(){
  const now = new Date();
  const start = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), CRON_UTC_HOUR));
  const end = new Date(start.getTime() + 3600000);
  return `entre as ${pad2(start.getHours())}:00 e as ${pad2(end.getHours())}:00`;
}
function cronIsLate(){
  const now = new Date();
  return now.getUTCHours() * 60 + now.getUTCMinutes() > LATE_AFTER_UTC_MIN;
}

// Same phase/key rules as the cron: "advance" (1–3 days before) keeps the
// original key without a suffix, so it goes out only once across those days.
function phaseFor(due){ return due === -1 ? 'overdue' : due === 0 ? 'today' : 'advance'; }
function reminderKey(clientId, projectId, idx, phase){
  return phase === 'advance' ? `${clientId}:${projectId}:${idx}` : `${clientId}:${projectId}:${idx}:${phase}`;
}

// A day can have several runs (the cron plus any manual trigger). Merge them
// per reminder, keeping the most meaningful outcome: a send beats a failure
// beats a missing email beats "already sent".
const OUTCOME_RANK = { sent: 4, failed: 3, 'no-email': 2, skipped: 1 };
function mergeRunEntries(runs){
  const byKey = new Map();
  runs.slice().sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1)).forEach(run => {
    (run.considered || []).forEach(e => {
      const prev = byKey.get(e.reminderKey);
      if(!prev || (OUTCOME_RANK[e.outcome] || 0) >= (OUTCOME_RANK[prev.outcome] || 0)){
        byKey.set(e.reminderKey, { ...e, at: run.startedAt });
      }
    });
  });
  return [...byKey.values()];
}
function dayHealth(runs){
  if(!runs.length) return 'miss';
  if(runs.some(r => r.error || r.failed > 0)) return 'warn';
  return 'ok';
}

// Everything a row needs, whichever source it came from. Run entries written
// before the cron logged names/amounts fall back to the live installment.
function toRow(e, inst){
  const i = inst || {};
  return {
    clientId: e.clientId, projectId: e.projectId, idx: e.idx,
    clientName: e.clientName || i.clientName || 'Cliente',
    projectName: e.projectName || i.project || 'Projeto',
    count: e.count || i.count || 1,
    amount: e.amount != null ? Number(e.amount) || 0 : (i.amount || 0),
    to: e.to || i.email || '',
    subject: e.subject || '',
    dueDate: e.dueDate, due: e.due, phase: e.phase,
    outcome: e.outcome, error: e.error || '', at: e.at || null,
    inst: i
  };
}


export async function loadReminders(){
  setAdminHash('lembretes');
  show('view-admin-reminders');
  const healthEl = document.getElementById('remHealth');
  const daysEl = document.getElementById('remDays');
  const weekEl = document.getElementById('remWeek');
  healthEl.className = 'rem-health';
  healthEl.innerHTML = '<span class="loading-dot"></span>';
  daysEl.innerHTML = '';
  weekEl.innerHTML = '';

  let runs, sentKeys, installments;
  try{
    const [runsSnap, sentSnap, inst] = await Promise.all([
      getDocs(query(collection(db, 'emailReminderRuns'), orderBy('startedAt', 'desc'), limit(100))),
      getDocs(collection(db, 'emailRemindersSent')),
      fetchAllInstallments()
    ]);
    runs = runsSnap.docs.map(d => d.data());
    sentKeys = new Set(sentSnap.docs.map(d => d.id));
    installments = inst;
  }catch(err){
    console.error(err);
    healthEl.innerHTML = '<p class="panel-empty">Não foi possível carregar os lembretes. Confirma que as regras do Firestore foram publicadas.</p>';
    return;
  }

  const instByKey = new Map(installments.map(r => [`${r.clientId}:${r.projectId}:${r.idx}`, r]));
  const findInst = e => instByKey.get(`${e.clientId}:${e.projectId}:${e.idx}`);

  const now = new Date();
  const todayIso = localIso(now);
  const yesterdayIso = addDaysIso(todayIso, -1);
  const tomorrowIso = addDaysIso(todayIso, 1);

  const runsByDay = new Map();
  runs.forEach(r => {
    const day = localIso(new Date(r.startedAt));
    if(!runsByDay.has(day)) runsByDay.set(day, []);
    runsByDay.get(day).push(r);
  });
  const firstLoggedDay = runs.length ? localIso(new Date(runs[runs.length - 1].startedAt)) : todayIso;
  const todayRuns = runsByDay.get(todayIso) || [];
  const ranToday = todayRuns.length > 0;

  // Forecast: replay the cron day by day, adding each planned key to the
  // "sent" set so an advance notice isn't predicted twice in the same week.
  const chaseable = installments.filter(r => !r.paid && !r.pontual && r.email !== SENDER_EMAIL);
  const simSent = new Set(sentKeys);
  const forecast = new Map(); // day offset -> rows
  for(let d = ranToday ? 1 : 0; d <= WEEK_DAYS; d++){
    const rows = [];
    chaseable.forEach(r => {
      const due = daysUntil(r.iso) - d;
      if(due < -1 || due > 3) return;
      const phase = phaseFor(due);
      const key = reminderKey(r.clientId, r.projectId, r.idx, phase);
      if(simSent.has(key)) return;
      const e = { clientId: r.clientId, projectId: r.projectId, idx: r.idx, dueDate: r.iso, due, phase,
        outcome: r.email ? 'planned' : 'no-email', to: r.email };
      if(r.email) simSent.add(key);
      rows.push(toRow(e, r));
    });
    forecast.set(d, rows);
  }

  renderHealth(healthEl, { todayRuns, ranToday, runsByDay, todayIso, firstLoggedDay, merged: mergeRunEntries(todayRuns) });

  const yRuns = runsByDay.get(yesterdayIso) || [];
  const yesterdayCol = {
    title: 'Ontem', iso: yesterdayIso, kind: 'past',
    rows: mergeRunEntries(yRuns).map(e => toRow(e, findInst(e))),
    empty: yRuns.length ? 'Nenhum lembrete neste dia.'
      : (yesterdayIso < firstLoggedDay ? 'Ainda não havia registo neste dia.' : 'O envio automático não correu neste dia.')
  };
  const todayCol = ranToday
    ? { title: 'Hoje', iso: todayIso, kind: 'past', rows: mergeRunEntries(todayRuns).map(e => toRow(e, findInst(e))), empty: 'Nenhum lembrete hoje.' }
    : { title: 'Hoje', iso: todayIso, kind: 'forecast', rows: forecast.get(0) || [], empty: 'Nenhum lembrete previsto para hoje.' };
  const tomorrowCol = { title: 'Amanhã', iso: tomorrowIso, kind: 'forecast', rows: forecast.get(1) || [], empty: 'Nenhum lembrete previsto para amanhã.' };
  daysEl.innerHTML = [yesterdayCol, todayCol, tomorrowCol].map(renderDay).join('');

  renderWeek(weekEl, installments, forecast);
}

// ---------- health strip ----------
function renderHealth(el, { todayRuns, ranToday, runsByDay, todayIso, firstLoggedDay, merged }){
  let state, title, sub = '';
  if(ranToday){
    const last = todayRuns.slice().sort((a, b) => (a.startedAt < b.startedAt ? 1 : -1))[0];
    const first = todayRuns.slice().sort((a, b) => (a.startedAt < b.startedAt ? -1 : 1))[0];
    const count = o => merged.filter(e => e.outcome === o).length;
    const failed = count('failed');
    const errored = todayRuns.find(r => r.error);
    if(errored){
      state = 'bad';
      title = `O envio automático correu às ${timePt(errored.startedAt)} mas parou com um erro`;
      sub = escapeHtml(errored.error);
    }else{
      state = failed ? 'warn' : 'ok';
      title = failed
        ? `O envio automático correu hoje às ${timePt(first.startedAt)}, com ${failed} falha${failed === 1 ? '' : 's'}`
        : `O envio automático correu hoje às ${timePt(first.startedAt)}`;
    }
    const parts = [
      `${count('sent')} enviado${count('sent') === 1 ? '' : 's'}`,
      count('skipped') ? `${count('skipped')} já enviado${count('skipped') === 1 ? '' : 's'} antes` : '',
      `${failed} falha${failed === 1 ? '' : 's'}`,
      count('no-email') ? `${count('no-email')} sem email` : '',
      todayRuns.length > 1 ? `${todayRuns.length} execuções` : (last.durationMs != null ? `${(last.durationMs / 1000).toLocaleString('pt-PT', { maximumFractionDigits: 1 })} s` : '')
    ].filter(Boolean);
    if(!errored) sub = parts.join(' · ');
  }else if(cronIsLate()){
    state = 'bad';
    title = 'O envio automático ainda não correu hoje';
    sub = `Devia ter corrido ${cronWindowText()}. Verifica o Cron Job do projeto na Vercel.`;
  }else{
    state = 'idle';
    title = 'O envio automático ainda não correu hoje';
    sub = `Corre ${cronWindowText()}. A coluna de hoje mostra o que está previsto.`;
  }

  const bars = [];
  for(let i = HISTORY_DAYS - 1; i >= 0; i--){
    const day = addDaysIso(todayIso, -i);
    const dayRuns = runsByDay.get(day) || [];
    let cls, label;
    if(day < firstLoggedDay && !dayRuns.length){ cls = 'none'; label = 'sem registo'; }
    else if(i === 0 && !dayRuns.length && !cronIsLate()){ cls = 'pending'; label = 'ainda não correu'; }
    else{
      const h = dayHealth(dayRuns);
      cls = h;
      label = h === 'ok' ? 'correu sem falhas' : h === 'warn' ? 'correu com falhas' : 'não correu';
    }
    bars.push(`<i class="rem-bar is-${cls}${i === 0 ? ' is-today' : ''}" title="${formatDatePt(day)} · ${label}"></i>`);
  }

  el.className = `rem-health is-${state}`;
  el.innerHTML = `
    <div class="rem-health-main">
      <span class="rem-dot" aria-hidden="true"></span>
      <div>
        <div class="rem-health-title">${escapeHtml(title)}</div>
        <div class="rem-health-sub">${sub}</div>
      </div>
    </div>
    <div class="rem-streak">
      <div class="rem-streak-label">Últimos ${HISTORY_DAYS} dias</div>
      <div class="rem-bars" role="img" aria-label="Estado do envio automático nos últimos ${HISTORY_DAYS} dias">${bars.join('')}</div>
    </div>`;
}

// ---------- day columns ----------
const ROW_ORDER = { failed: 0, 'no-email': 1, sent: 2, planned: 3, skipped: 4 };

function phaseChip(r){
  if(r.phase === 'overdue') return '<span class="rem-chip is-late">Atraso · multa 5%</span>';
  if(r.phase === 'today') return '<span class="rem-chip is-today">Vence hoje</span>';
  const d = Number(r.due);
  return `<span class="rem-chip">Aviso ${d === 1 ? '1 dia' : `${d} dias`} antes</span>`;
}
function statusChip(r, kind, colIso){
  if(r.outcome === 'sent') return `<span class="rem-chip is-sent">Enviado ${r.at ? timePt(r.at) : ''}</span>`;
  if(r.outcome === 'failed') return '<span class="rem-chip is-fail">Falhou</span>';
  if(r.outcome === 'no-email') return `<span class="rem-chip is-late">${kind === 'forecast' ? 'Não vai sair' : 'Não saiu'} · sem email</span>`;
  if(r.outcome === 'planned') return `<span class="rem-chip is-plan">Previsto · ${dayLabel(colIso)}</span>`;
  // skipped — the cron stores "already sent <iso>" as its reason
  const m = /already sent (\d{4}-\d{2}-\d{2})/.exec(r.error || '');
  return `<span class="rem-chip is-muted">Já enviado${m ? ` ${formatDatePt(m[1]).slice(0, 5)}` : ''}</span>`;
}
function rowAmount(r){
  if(!r.amount) return '—';
  return money.format(r.phase === 'overdue' ? r.amount * 1.05 : r.amount);
}
function failureAdvice(r){
  // "today"/"overdue" notices only exist for one day, so a failed one is
  // gone for good; an advance notice with days to spare is retried tomorrow.
  if(r.phase === 'advance' && Number(r.due) > 1) return 'O envio automático tenta de novo amanhã.';
  return 'Este aviso não volta a ser enviado sozinho. Avisa por WhatsApp ou corrige o email.';
}

function renderRow(r, kind, colIso){
  const parcela = r.count > 1 ? ` · parcela ${r.idx + 1}/${r.count}` : '';
  const dl = [
    r.to ? ['Para', escapeHtml(r.to)] : null,
    r.subject ? ['Assunto', escapeHtml(r.subject)] : null,
    ['Vence', formatDatePt(r.dueDate)],
    r.phase === 'overdue' && r.amount ? ['Valor', `${money.format(r.amount)} + ${money.format(r.amount * 0.05)} de multa`] : null,
    r.outcome === 'failed' && r.error ? ['Erro', `<span class="rem-err">${escapeHtml(r.error)}</span>`] : null
  ].filter(Boolean).map(([k, v]) => `<dt>${k}</dt><dd>${v}</dd>`).join('');

  let note = '';
  const actions = [];
  const wa = (r.outcome === 'failed' || r.outcome === 'no-email') && r.inst && r.inst.iso ? waReminderHref(r.inst) : null;
  if(r.outcome === 'failed'){
    note = failureAdvice(r);
    if(wa) actions.push(`<a class="btn" href="${escapeAttr(wa)}" target="_blank" rel="noopener">Avisar por WhatsApp</a>`);
    actions.push(`<button type="button" class="btn btn-ghost" data-rem-act="email" data-client="${escapeAttr(r.clientId)}">Corrigir email</button>`);
  }else if(r.outcome === 'no-email'){
    note = 'Este cliente não tem email na ficha, por isso o envio automático salta-o.';
    actions.push(`<button type="button" class="btn" data-rem-act="email" data-client="${escapeAttr(r.clientId)}">Adicionar email</button>`);
    if(wa) actions.push(`<a class="btn btn-ghost" href="${escapeAttr(wa)}" target="_blank" rel="noopener">Avisar por WhatsApp</a>`);
  }else if(r.outcome === 'planned'){
    note = 'Se o cliente já pagou, marca a parcela como paga no projeto e este lembrete não sai.';
    actions.push(`<button type="button" class="btn btn-ghost" data-rem-act="project" data-client="${escapeAttr(r.clientId)}" data-project="${escapeAttr(r.projectId)}">Já pagou? Abrir projeto</button>`);
  }else if(r.outcome === 'skipped'){
    note = 'O aviso antecipado só sai uma vez, por isso não se repetiu.';
  }

  const open = r.outcome === 'failed';
  const cls = r.outcome === 'failed' ? ' is-fail' : r.outcome === 'no-email' ? ' is-gap' : r.outcome === 'skipped' ? ' is-muted' : '';
  return `
    <div class="rem-row${cls}" role="button" tabindex="0" aria-expanded="${open}">
      <div class="rem-row-top"><span class="rem-who">${escapeHtml(r.clientName)}</span><span class="rem-amt">${rowAmount(r)}</span></div>
      <div class="rem-what">${escapeHtml(r.projectName)}${parcela}</div>
      <div class="rem-chips">${phaseChip(r)}${statusChip(r, kind, colIso)}</div>
      <div class="rem-detail">
        <dl>${dl}</dl>
        ${note ? `<p class="rem-note">${note}</p>` : ''}
        ${actions.length ? `<div class="rem-actions">${actions.join('')}</div>` : ''}
      </div>
    </div>`;
}

function renderDay(col){
  const rows = col.rows.slice().sort((a, b) =>
    (ROW_ORDER[a.outcome] ?? 9) - (ROW_ORDER[b.outcome] ?? 9) || a.clientName.localeCompare(b.clientName));
  const n = o => rows.filter(r => r.outcome === o).length;
  const plural = (k, one, many) => `${k} ${k === 1 ? one : many}`;
  const summary = col.kind === 'forecast'
    ? [n('planned') ? plural(n('planned'), 'previsto', 'previstos') : '', n('no-email') ? `${n('no-email')} sem email` : '']
    : [n('sent') ? plural(n('sent'), 'enviado', 'enviados') : '', n('failed') ? plural(n('failed'), 'falha', 'falhas') : '',
       n('no-email') ? `${n('no-email')} sem email` : '', n('skipped') ? plural(n('skipped'), 'já enviado antes', 'já enviados antes') : ''];
  const summaryText = summary.filter(Boolean).join(' · ');
  return `
    <section class="rem-day${col.kind === 'forecast' ? ' is-forecast' : ''}" aria-label="${col.title}">
      <div class="rem-day-head"><h3>${col.title}${col.kind === 'forecast' ? '<span class="rem-tag">previsão</span>' : ''}</h3><span class="rem-day-date">${dayLabel(col.iso)}</span></div>
      ${summaryText ? `<div class="rem-day-count">${summaryText}</div>` : ''}
      ${rows.length ? rows.map(r => renderRow(r, col.kind, col.iso)).join('') : `<p class="rem-empty">${col.empty}</p>`}
    </section>`;
}

// ---------- week line ----------
function renderWeek(el, installments, forecast){
  // A client without email shows up on every day of its window, so count
  // those per installment, not per day.
  let planned = 0;
  const noEmailKeys = new Set();
  for(let d = 1; d <= WEEK_DAYS; d++){
    (forecast.get(d) || []).forEach(r => {
      if(r.outcome === 'planned') planned++;
      else noEmailKeys.add(`${r.clientId}:${r.projectId}:${r.idx}`);
    });
  }
  const noEmail = noEmailKeys.size;
  const dueSoon = installments.filter(r => !r.paid && daysUntil(r.iso) >= 0 && daysUntil(r.iso) <= WEEK_DAYS);
  const auto = dueSoon.filter(r => !r.pontual);
  const pontual = dueSoon.filter(r => r.pontual);
  const total = auto.reduce((s, r) => s + r.amount, 0);
  const parts = [
    `${planned} lembrete${planned === 1 ? '' : 's'} previsto${planned === 1 ? '' : 's'}`,
    `${auto.length} pagamento${auto.length === 1 ? '' : 's'} a vencer, no total de <strong>${money.format(total)}</strong>`
  ];
  const extra = [];
  if(noEmail) extra.push(noEmail === 1 ? '1 pagamento não vai ter lembrete porque o cliente não tem email.' : `${noEmail} pagamentos não vão ter lembrete porque os clientes não têm email.`);
  if(pontual.length) extra.push(pontual.length === 1 ? '1 pagamento de um trabalho pontual não tem lembrete automático.' : `${pontual.length} pagamentos de trabalhos pontuais não têm lembrete automático.`);
  el.innerHTML = `
    <h3>Próximos ${WEEK_DAYS} dias</h3>
    <p>${parts.join(' · ')}.${extra.length ? ` ${extra.join(' ')}` : ''}</p>
    <p class="rem-foot">“Enviado” quer dizer que o Brevo aceitou o email. Não confirma que chegou à caixa de entrada.</p>`;
}

// ---------- interactions ----------
async function openClient(clientId, projectId){
  try{
    const snap = await getDoc(doc(db, 'clients', clientId));
    if(!snap.exists()){ toast('Este cliente já não existe.', true); return; }
    loadAdminEdit(clientId, snap.data());
    if(projectId) openProject(projectId);
    else{
      const input = document.getElementById('adminEmail');
      if(input){ input.focus(); input.scrollIntoView({ block: 'center' }); }
    }
  }catch(err){
    console.error(err);
    toast('Não foi possível abrir o cliente.', true);
  }
}

const daysRoot = document.getElementById('remDays');
daysRoot.addEventListener('click', (e) => {
  const act = e.target.closest('[data-rem-act]');
  if(act){
    e.stopPropagation();
    openClient(act.dataset.client, act.dataset.remAct === 'project' ? act.dataset.project : null);
    return;
  }
  if(e.target.closest('a')) return;
  const row = e.target.closest('.rem-row');
  if(row) row.setAttribute('aria-expanded', row.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
});
daysRoot.addEventListener('keydown', (e) => {
  if(e.key !== 'Enter' && e.key !== ' ') return;
  const row = e.target.classList && e.target.classList.contains('rem-row') ? e.target : null;
  if(!row) return;
  e.preventDefault();
  row.setAttribute('aria-expanded', row.getAttribute('aria-expanded') === 'true' ? 'false' : 'true');
});
