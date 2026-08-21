// ============================================================
//  CLIENT DASHBOARD (read-only, by link id) — the public client-facing view.
// ============================================================
import { onSnapshot, doc, updateDoc } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import {
  db, show, msg, escapeHtml, escapeAttr, getProjects, isProjectComplete,
  formatDatePt, paymentStatus, daysUntil, addMonthsIso, projectPaymentDates,
  projectDeliveryDates, FLOW_STAGES, projectFlowStage,
  PACKS, MONTHLY_BATCH_MONTHS, recordingSlots, CAL_SVG, GOOGLE_REVIEW_LINK
} from './core.js';

// Live: a real-time listener so the client sees the admin's edits instantly,
// with no refresh (Firestore onSnapshot — re-fires whenever the doc changes).
let clientUnsub = null;
// The client id currently shown — set once per page load by loadClientDashboard
// and read by the testimonial-submit and "open project board" handlers below,
// which fire later (in response to user actions on the rendered dashboard).
let currentClientId = null;
// Last snapshot rendered — kept so the per-project calendar's ‹ › nav can
// re-render locally (a cursor change is a pure UI state change, not new data)
// without waiting for the next Firestore onSnapshot tick.
let lastClientData = null;

export function loadClientDashboard(clientId){
  currentClientId = clientId;
  if(clientUnsub){ clientUnsub(); clientUnsub = null; }
  clientUnsub = onSnapshot(
    doc(db, "clients", clientId),
    (snap) => {
      if(!snap.exists()){ show('view-client-error'); return; }
      renderClientDashboard(snap.data());
    },
    () => { show('view-client-error'); }
  );
}

function renderClientDashboard(data){
  lastClientData = data;
  // Custom per-client home-screen icon (uploaded by admin) overrides the default.
  // iOS reads apple-touch-icon at "Add to Home Screen" time, which happens after
  // this render, so setting it here is in time.
  if(data.iconDataUrl){
    const appleIcon = document.getElementById('appleIcon');
    if(appleIcon) appleIcon.href = data.iconDataUrl;
  }
  document.getElementById('dashName').textContent = `${data.firstName || ''} ${data.lastName || ''}`.trim() || "você";
  const rows = [
    ['Nome', `${data.firstName || ''} ${data.lastName || ''}`.trim()],
    ['Nacionalidade', data.nationality || ''],
    ['Número', data.phone || ''],
    ['NIF', data.nif || '']
  ].filter(([, v]) => v);
  document.getElementById('dashDetails').innerHTML = rows.map(([k, v]) =>
    `<span class="dash-line"><span class="dash-key">${k}:</span> ${escapeHtml(v)}</span>`).join('');

  // Project cards in a carousel. Preserve the horizontal scroll position so a
  // live update doesn't yank the client back to the first project mid-view.
  const projects = getProjects(data);
  const container = document.getElementById('projectsContainer');
  const prevScroll = container.scrollLeft;
  document.getElementById('projectsEmpty').classList.toggle('hidden', projects.length > 0);
  container.innerHTML = projects.map(clientProjectCard).join('');
  setupProjectCarousel(projects.length);
  container.scrollLeft = prevScroll;

  // Testimonial: offer the form once at least one project is finished.
  const anyComplete = projects.some(isProjectComplete);
  document.getElementById('testimonialPanel').classList.toggle('hidden', !anyComplete);
  if(anyComplete){
    const input = document.getElementById('testimonialInput');
    // Don't clobber text the client is actively typing on a live re-render.
    if(document.activeElement !== input) input.value = (data.testimonial && data.testimonial.text) || '';
    document.getElementById('testimonialSubmitBtn').textContent =
      (data.testimonial && data.testimonial.text) ? 'Atualizar depoimento' : 'Enviar depoimento';
    // Hidden until a real Google Business Profile review link is configured
    // (js/core.js GOOGLE_REVIEW_LINK) — no dead "coming soon" button meanwhile.
    const reviewBtn = document.getElementById('googleReviewBtn');
    reviewBtn.classList.toggle('hidden', !GOOGLE_REVIEW_LINK);
    if(GOOGLE_REVIEW_LINK) reviewBtn.href = GOOGLE_REVIEW_LINK;
    document.getElementById('referralBtn').href = 'https://wa.me/?text=' + encodeURIComponent(
      'Conheces uma marca de beleza que precise de vídeo ou fotografia? Recomendo a Ester (Estephanie Cerqueira) — https://esterprod.com'
    );
  }

  show('view-dashboard');
}

document.getElementById('testimonialSubmitBtn').addEventListener('click', async () => {
  const msgEl = document.getElementById('testimonialMsg');
  const text = document.getElementById('testimonialInput').value.trim();
  if(!text){ msg(msgEl, 'Escreva algo antes de enviar.', 'error'); return; }
  if(!currentClientId) return;
  try{
    await updateDoc(doc(db, 'clients', currentClientId), {
      testimonial: { text, updatedAt: new Date().toISOString() }
    });
    msg(msgEl, 'Obrigada pelo depoimento!', 'ok');
    document.getElementById('testimonialSubmitBtn').textContent = 'Atualizar depoimento';
  }catch(err){
    msg(msgEl, 'Não foi possível enviar. Tente novamente.', 'error');
  }
});

// Wire the projects carousel (arrows + dots + swipe). No-op for 0/1 projects.
function setupProjectCarousel(count){
  const track = document.getElementById('projectsContainer');
  const dotsEl = document.getElementById('projectsDots');
  const nav = document.getElementById('projNav');
  const prev = document.getElementById('projPrev');
  const next = document.getElementById('projNext');
  dotsEl.innerHTML = '';
  const multi = count > 1;
  nav.classList.toggle('hidden', !multi);
  if(!multi) return;

  for(let i = 0; i < count; i++){
    const b = document.createElement('button');
    if(i === 0) b.classList.add('active');
    b.addEventListener('click', () => scrollToCard(i));
    dotsEl.appendChild(b);
  }
  const cardWidth = () => {
    const card = track.querySelector('.project-card');
    return card ? card.offsetWidth + 2 : track.offsetWidth; // + flex gap
  };
  const currentIndex = () => Math.round(track.scrollLeft / cardWidth());
  function scrollToCard(i){ track.scrollTo({ left: i * cardWidth(), behavior: 'smooth' }); }
  prev.onclick = () => scrollToCard(Math.max(0, currentIndex() - 1));
  next.onclick = () => scrollToCard(Math.min(count - 1, currentIndex() + 1));
  track.onscroll = () => {
    const idx = currentIndex();
    dotsEl.querySelectorAll('button').forEach((d, j) => d.classList.toggle('active', j === idx));
    prev.disabled = idx <= 0;
    next.disabled = idx >= count - 1;
  };
  prev.disabled = true;
  next.disabled = count <= 1;
}

// Period text for a project ("04/05 – 04/08 (3 meses)" or "Início: ...").
function projectPeriod(p){
  const pack = p.pack ? PACKS[p.pack] : null;
  if(!pack || !p.contractStart) return '';
  if(pack.category === 'monthly'){
    const end = addMonthsIso(p.contractStart, MONTHLY_BATCH_MONTHS);
    return `Período: ${formatDatePt(p.contractStart)} – ${formatDatePt(end)}`;
  }
  return `Início: ${formatDatePt(p.contractStart)}`;
}
// Payment lines HTML for a project (paid instalments show "✓ Pago").
function projectPaymentsHtml(p){
  const dates = projectPaymentDates(p);
  if(dates.length === 0) return '<p class="proj-period">A combinar</p>';
  const paidArr = p.paymentsPaid || [];
  const notes = p.paymentNotes || [];
  const multi = dates.length > 1;
  return dates.map((iso, i) => {
    const idx = multi ? `<span class="pay-idx">${i + 1}.</span>` : '';
    const noteHtml = notes[i] ? ` <span class="days">· ${escapeHtml(notes[i])}</span>` : '';
    if(!iso) return `<div class="pay-line">${idx}<span class="days">Data a definir</span>${noteHtml}</div>`;
    const s = paidArr[i] ? { text: '✓ Pago', mod: 'paid' } : paymentStatus(iso);
    return `<div class="pay-line ${s.mod}">${idx}<strong>${formatDatePt(iso)}</strong> <span class="days">· ${s.text}</span>${noteHtml}</div>`;
  }).join('');
}
// Client-facing recording-date status (green upcoming / orange today / muted past).
function recordingStatus(iso){
  const days = daysUntil(iso);
  if(days < 0) return { text: 'Já realizada', mod: 'paid' };
  if(days === 0) return { text: 'É hoje', mod: 'today' };
  return { text: days === 1 ? 'Falta 1 dia' : `Faltam ${days} dias`, mod: 'upcoming' };
}
// "Gravações agendadas": recording dates the admin set, each with an .ics button
// (only for dates still to come). Hidden when no recording has a date.
function clientRecordingsHtml(p){
  const slots = recordingSlots(p);
  const dates = Array.isArray(p.recordingDates) ? p.recordingDates : [];
  const times = Array.isArray(p.recordingTimes) ? p.recordingTimes : [];
  const endTimes = Array.isArray(p.recordingEndTimes) ? p.recordingEndTimes : [];
  const rows = [];
  slots.forEach(slot => {
    const iso = dates[slot.idx];
    if(!iso) return;
    const time = times[slot.idx] || '';
    const endTime = endTimes[slot.idx] || '';
    const s = recordingStatus(iso);
    const timeLabel = time ? (endTime ? `${time}–${endTime}` : time) : '';
    const when = formatDatePt(iso) + (timeLabel ? ` às ${timeLabel}` : '');
    const cal = daysUntil(iso) >= 0
      ? `<button type="button" class="cal-btn" data-date="${iso}" data-time="${escapeAttr(time)}" data-endtime="${escapeAttr(endTime)}" data-idx="${slot.idx}" data-label="${escapeAttr(slot.label)}" data-pid="${escapeAttr(p.id || '')}" data-title="${escapeAttr(p.name || '')}">${CAL_SVG}Adicionar ao calendário</button>`
      : '';
    rows.push(`<div class="pay-line ${s.mod}"><strong>${escapeHtml(slot.label)}</strong> · ${when} <span class="days">· ${s.text}</span></div>${cal}`);
  });
  if(rows.length === 0) return '';
  return `
    <div class="rec-section">
      <div class="pay-title">Gravações agendadas</div>
      ${rows.join('')}
    </div>`;
}
// One client-facing project card.
// ---------- read-only per-project calendar (replaces the old linear progress timeline) ----------
// Shows the contract start date, scheduled recording dates, and expected/paid
// payment dates on a native month grid — color-coded by activity type — so
// the client sees their project's whole schedule at a glance instead of just
// a step-completion bar. Purely a client-side view: no write access.
const CAL_MONTH_NAMES = ['Janeiro','Fevereiro','Março','Abril','Maio','Junho','Julho','Agosto','Setembro','Outubro','Novembro','Dezembro'];
const CAL_DOW_LABELS = ['D','S','T','Q','Q','S','S'];
// projectId -> { y, m } (m: 0–11) — which month each project's calendar is showing.
// Persists across re-renders (a new Firestore snapshot shouldn't reset where the client was looking).
const calCursor = new Map();
// projectId -> open/closed state of the collapsible calendar (defaults to open,
// so the client sees it right away; the client can still collapse it, and that
// choice persists across re-renders same as calCursor).
const calDetailsOpen = new Map();

function todayIsoLocal(){
  const t = new Date();
  return `${t.getFullYear()}-${String(t.getMonth() + 1).padStart(2, '0')}-${String(t.getDate()).padStart(2, '0')}`;
}
// All calendar-worthy dates for a project: contract start, every dated
// recording slot, and every payment instalment (paid or still due).
function projectCalendarEvents(p){
  const events = [];
  if(p.contractStart) events.push({ iso: p.contractStart, type: 'start', label: 'Início do contrato' });
  const recDates = Array.isArray(p.recordingDates) ? p.recordingDates : [];
  recordingSlots(p).forEach(slot => {
    const iso = recDates[slot.idx];
    if(iso) events.push({ iso, type: 'recording', label: slot.label });
  });
  const payDates = projectPaymentDates(p);
  const paidArr = p.paymentsPaid || [];
  payDates.forEach((iso, i) => {
    if(!iso) return;
    const label = payDates.length > 1 ? `Pagamento ${i + 1}/${payDates.length}` : 'Pagamento';
    events.push({ iso, type: paidArr[i] ? 'paid' : 'payment', label });
  });
  const deliveryDates = projectDeliveryDates(p).filter(Boolean);
  deliveryDates.forEach((iso, i) => {
    events.push({ iso, type: 'delivery', label: deliveryDates.length > 1 ? `Entrega ${i + 1}` : 'Entrega do material' });
  });
  return events;
}
// First render defaults to the earliest event still today-or-later, so the
// client lands on whatever's relevant next; falls back to the earliest event
// overall (all-past project), then to the current month (no events yet).
function defaultCalCursor(events){
  const now = new Date();
  if(events.length === 0) return { y: now.getFullYear(), m: now.getMonth() };
  const todayYm = todayIsoLocal().slice(0, 7);
  const isos = events.map(e => e.iso).sort();
  const pick = isos.find(iso => iso.slice(0, 7) >= todayYm) || isos[0];
  const [y, m] = pick.split('-').map(Number);
  return { y, m: m - 1 };
}
function projectCalendarHtml(p){
  const pid = p.id || '';
  const events = projectCalendarEvents(p);
  if(!calCursor.has(pid)) calCursor.set(pid, defaultCalCursor(events));
  if(!calDetailsOpen.has(pid)) calDetailsOpen.set(pid, true);
  const { y, m } = calCursor.get(pid);
  const byDay = new Map();
  events.forEach(e => {
    if(!byDay.has(e.iso)) byDay.set(e.iso, []);
    byDay.get(e.iso).push(e);
  });
  const startDow = new Date(y, m, 1).getDay();
  const daysInMonth = new Date(y, m + 1, 0).getDate();
  const todayIso = todayIsoLocal();
  let cells = '';
  for(let i = 0; i < startDow; i++) cells += `<div class="cal-cell empty"></div>`;
  for(let d = 1; d <= daysInMonth; d++){
    const iso = `${y}-${String(m + 1).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const dayEvents = byDay.get(iso) || [];
    const dots = dayEvents.map(e => `<span class="cal-dot cal-dot-${e.type}" title="${escapeAttr(e.label)}"></span>`).join('');
    const cls = 'cal-cell' + (iso === todayIso ? ' is-today' : '') + (dayEvents.length ? ' has-event' : '');
    cells += `<div class="${cls}"><span class="cal-daynum">${d}</span><span class="cal-dots">${dots}</span></div>`;
  }
  const dow = CAL_DOW_LABELS.map(d => `<div class="cal-dow">${d}</div>`).join('');
  const open = calDetailsOpen.get(pid) ? ' open' : '';
  return `
    <details class="proj-progress cal-details" data-cal-pid="${escapeAttr(pid)}"${open}>
      <summary class="pay-title">Calendário</summary>
      <div class="fin-yearbar cal-nav">
        <button type="button" class="cal-prev" data-cal-pid="${escapeAttr(pid)}" aria-label="Mês anterior">‹</button>
        <span>${CAL_MONTH_NAMES[m]} ${y}</span>
        <button type="button" class="cal-next" data-cal-pid="${escapeAttr(pid)}" aria-label="Mês seguinte">›</button>
      </div>
      <div class="cal-grid">${dow}${cells}</div>
      <div class="cal-legend">
        <span><span class="cal-dot cal-dot-start"></span>Início do contrato</span>
        <span><span class="cal-dot cal-dot-recording"></span>Gravação</span>
        <span><span class="cal-dot cal-dot-payment"></span>Pagamento previsto</span>
        <span><span class="cal-dot cal-dot-paid"></span>Pagamento efetuado</span>
        <span><span class="cal-dot cal-dot-delivery"></span>Entrega do material</span>
      </div>
    </details>`;
}
// Re-renders only this one project's calendar node in place, instead of the
// whole dashboard — a cursor change is a pure UI-state change, not new data.
// A full renderClientDashboard() replaces the entire projects carousel's
// innerHTML, which discards the clicked ‹/› button mid-click and drops the
// page's vertical scroll back to the top; touching only this subtree avoids
// that entirely (no scroll position to "restore" because nothing else moves).
function shiftProjectCalendar(pid, delta){
  const cur = calCursor.get(pid);
  if(!cur) return;
  cur.m += delta;
  if(cur.m < 0){ cur.m = 11; cur.y--; }
  else if(cur.m > 11){ cur.m = 0; cur.y++; }
  if(!lastClientData) return;
  const project = getProjects(lastClientData).find(p => (p.id || '') === pid);
  if(!project) return;
  const el = document.querySelector(`.cal-details[data-cal-pid="${pid}"]`);
  if(el) el.outerHTML = projectCalendarHtml(project);
}

// ---------- project calendar nav (delegated) ----------
document.addEventListener('click', (e) => {
  const calPrev = e.target.closest('.cal-prev');
  if(calPrev){ shiftProjectCalendar(calPrev.dataset.calPid, -1); return; }
  const calNext = e.target.closest('.cal-next');
  if(calNext){ shiftProjectCalendar(calNext.dataset.calPid, 1); return; }
});
// `toggle` doesn't bubble, so delegate via the capture phase instead — remembers
// each project's open/closed state so it survives the next Firestore re-render.
document.addEventListener('toggle', (e) => {
  if(e.target.matches && e.target.matches('.cal-details')){
    calDetailsOpen.set(e.target.dataset.calPid, e.target.open);
  }
}, true);

// "Fluxo do projeto" — a coarse, client-facing timeline (Início → Pagamento →
// Roteirização → Gravação → Edição → Entrega) derived from the admin's own
// step-by-step workflow. Hidden for avulso/pontual projects (no production
// workflow to summarize — projectFlowStage returns -1 there).
function clientTimelineHtml(p){
  const stage = projectFlowStage(p);
  if(stage < 0) return '';
  const steps = FLOW_STAGES.map((label, i) => {
    const cls = i < stage ? ' done' : (i === stage ? ' current' : '');
    return `<div class="flow-step${cls}"><span class="flow-dot"></span><span class="flow-label">${escapeHtml(label)}</span></div>`;
  }).join('<span class="flow-connector"></span>');
  return `
    <div class="rec-section">
      <div class="pay-title">Fluxo do projeto</div>
      <div class="flow-timeline">${steps}</div>
    </div>`;
}

function clientProjectCard(p){
  const pack = p.pack ? PACKS[p.pack] : null;
  const period = projectPeriod(p);
  const drive = p.driveLink
    ? `<a class="round-btn" href="${encodeURI(p.driveLink)}" target="_blank" rel="noopener" title="Google Drive"><img src="images/logos/google-drive-color-icon.png" alt="Google Drive"></a>` : '';
  const doneBadge = isProjectComplete(p) ? '<span class="badge-done">✓ Concluído</span>' : '';
  return `
    <div class="project-card">
      <div class="proj-card-head">
        <h3>${escapeHtml(p.name || 'Projeto')}</h3>
        ${doneBadge}
      </div>
      <p class="proj-plan">${pack ? escapeHtml(pack.name) : 'A combinar'}</p>
      ${period ? `<p class="proj-period">${period}</p>` : ''}
      ${clientTimelineHtml(p)}
      ${projectCalendarHtml(p)}
      <div class="rec-section">
        <div class="pay-title">Materiais</div>
        <div class="round-links">${drive}</div>
      </div>
      ${clientRecordingsHtml(p)}
      <div class="rec-section">
        <div class="pay-title">Pagamentos</div>
        ${projectPaymentsHtml(p)}
      </div>
    </div>`;
}
