// ============================================================
//  CORE — Firebase bootstrap, config constants, workflow model,
//  date/money utils, and generic UI helpers shared by every other
//  module. No feature-file imports here by design (leaf module).
// ============================================================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";

// ============================================================
// SETUP NOTES
// 1. Firebase project + Email/Password auth + Firestore already configured below.
// 2. Your admin account (ADMIN_EMAIL) must exist in Firebase Authentication.
//    Since client self-signup has been removed, create/reset it from the
//    Firebase console: Authentication → Users → Add user.
// 3. Publish the Firestore security rules from the accompanying
//    firestore.rules file so clients can read their own doc by link,
//    while only you (admin) can list all clients or write.
// ============================================================
export const firebaseConfig = {
  apiKey: "AIzaSyB45wdtfie9OcotzrXeryVwHJ0JhLMf0fQ",
  authDomain: "ester-website-ee664.firebaseapp.com",
  projectId: "ester-website-ee664",
  storageBucket: "ester-website-ee664.firebasestorage.app",
  messagingSenderId: "629337538658",
  appId: "1:629337538658:web:dd811d2218c043113f913b"
};
export const ADMIN_EMAIL = "contatoestephanie@gmail.com";
// "Leave a Google review" link shown to a client once their project is complete —
// create a free Google Business Profile, then paste its review link/short-URL here.
// Left empty on purpose (no profile yet): the button stays hidden until filled in.
export const GOOGLE_REVIEW_LINK = "";
// ============================================================

// Contract packs (from Packs.md). Monthly packs run in 3-month batches.
// 2026-07-22 monthly-pack price update: clients already signed under the OLD
// ids/names/prices must keep seeing exactly what they contracted, so those
// entries are kept verbatim below with `legacy:true` (still resolve via PACKS
// for existing projects, but hidden from the "new project" pack selector by
// populatePackSelect()). The updated offering lives under brand-new ids.
export const PACK_GROUPS = [
  { label: "Pacotes Mensais (3 meses)", category: "monthly", packs: [
    { id: "monthly-pro-2026",       name: "Plano Pro",       price: "595€" },
    { id: "monthly-essencial-2026", name: "Plano Essencial", price: "420€" },
    { id: "monthly-start-2026",     name: "Plano Start",     price: "290€" },
    { id: "monthly-pro",       name: "Pack Pro",       price: "495€", legacy: true },
    { id: "monthly-essential", name: "Pack Essential", price: "390€", legacy: true },
    { id: "monthly-basic",     name: "Pack Basic",     price: "285€", legacy: true }
  ]},
  { label: "Pacotes Diários", category: "daily", packs: [
    { id: "daily-pro",   name: "Daily Pack Pro",   price: "570€" },
    { id: "daily-basic", name: "Daily Pack Basic", price: "300€" }
  ]},
  { label: "Pacotes de Aulas", category: "classes", packs: [
    { id: "classes-start",     name: "Start Plan",     price: "450€" },
    { id: "classes-essential", name: "Essential Plan", price: "630€" },
    { id: "classes-pro",       name: "Pro Plan",       price: "820€" }
  ]},
  { label: "Trabalhos Pontuais", category: "pontual", packs: [
    { id: "pontual-custom", name: "Trabalho Personalizado", price: "", custom: true },
    // Kept resolvable (not selectable for new projects) so already-onboarded
    // pontual clients (e.g. Amarelu) keep seeing their original pack/price.
    { id: "pontual-1h", name: "1 hora",   price: "50€", legacy: true },
    { id: "pontual-2h", name: "Direção Amarelu",  price: "100€", legacy: true }
  ]}
];
export const MONTHLY_BATCH_MONTHS = 3;
// Flat lookup by pack id → { name, price, category }
export const PACKS = {};
PACK_GROUPS.forEach(g => g.packs.forEach(p => { PACKS[p.id] = { ...p, category: g.category }; }));

// Per-project workflow phases for a linear (non-monthly) pack, in order.
// Grouped into a handful of named phases (rather than one flat 12-14-item
// list) so the admin UI can present them as a few collapsible milestones
// instead of a long sequential checklist.
export const WORKFLOW_PHASES = [
  { name: 'Contrato & Pagamento', steps: [
    'Reunião para apresentar proposta', 'Solicitar dados para contrato',
    'Envio do contrato', 'Pagamento recebido', 'Emissão de recibo'
  ] },
  { name: 'Preparação', steps: [
    'Pasta do projeto no Drive', 'Organização do projeto',
    'Reunião para brainstorm'
  ] },
  { name: 'Pós-produção', steps: ['Edição do material'] }
];
export const MONTHLY_MONTH_LABELS = ['1º mês', '2º mês', '3º mês'];
export const REC_MIN = 1;   // at least 1 recording; no upper cap — admin adds more freely
export const clampRec = n => Math.max(REC_MIN, Number(n) || REC_MIN);
// True when a project uses the branched 3-month workflow (monthly packs).
export function isMonthlyWorkflow(p){
  const pack = p && p.pack ? PACKS[p.pack] : null;
  return !!(pack && pack.category === 'monthly');
}
// True for one-off service clients (avulso/pontual packs) — payments are still
// tracked normally, but there's no contract/Drive/production checklist.
export function isPontualWorkflow(p){
  const pack = p && p.pack ? PACKS[p.pack] : null;
  return !!(pack && pack.category === 'pontual');
}
// True only for "Trabalho Personalizado" (pontual-custom) — the one pontual
// pack flexible enough to also get recording dates (open-ended, unlike the
// capped 1-3 slider every other non-monthly pack uses). See recordingSlots().
export function isCustomPontualWorkflow(p){
  const pack = p && p.pack ? PACKS[p.pack] : null;
  return !!(pack && pack.custom);
}
// Per-month recording counts [m1, m2, m3] for a monthly project. `override` (an
// array) wins; then the saved `recordingCounts`; then a legacy flat `recordingCount`
// repeated across the 3 months. No upper cap — the admin adds sessions freely via
// the "+ Adicionar gravação" button on each month's card; an explicit 0 (every
// session removed) is kept as 0, a genuinely missing entry defaults to 1.
export function monthlyRecCounts(p, override){
  let arr;
  if(Array.isArray(override)) arr = override;
  else if(Array.isArray(p.recordingCounts)) arr = p.recordingCounts;
  else { const flat = p.recordingCount || 1; arr = [flat, flat, flat]; }
  const out = [];
  for(let m = 0; m < MONTHLY_BATCH_MONTHS; m++){
    const v = arr[m];
    out.push(v == null ? 1 : Math.max(0, Number(v) || 0));
  }
  return out;
}
// Ordered workflow steps for a project. Monthly (3-month) packs get the branched
// structure — a common head, then 3 independent month cycles (Drive folder set up
// once, in month 1). Every other pack keeps the linear list. Each step has a stable
// `key` (used to persist completion), a `label`, and a `group` for the UI.
export function workflowModel(p, override){
  if(isPontualWorkflow(p)) return []; // avulso packs: payments only, no checklist
  if(!isMonthlyWorkflow(p)){
    const rec = Math.max(0, (typeof override === 'number') ? override : (p.recordingCount || 1));
    const steps = [];
    let i = 0;
    WORKFLOW_PHASES[0].steps.forEach(label => steps.push({ key: 's' + (i++), label, group: WORKFLOW_PHASES[0].name }));
    WORKFLOW_PHASES[1].steps.forEach(label => steps.push({ key: 's' + (i++), label, group: WORKFLOW_PHASES[1].name }));
    for(let r = 1; r <= rec; r++) steps.push({ key: 's' + (i++), label: rec > 1 ? `Gravação ${r}` : 'Gravação', group: 'Gravação' });
    WORKFLOW_PHASES[2].steps.forEach(label => steps.push({ key: 's' + (i++), label, group: WORKFLOW_PHASES[2].name }));
    return steps;
  }
  // No "Comum" head here on purpose — those steps (proposal meeting, contract
  // data, sending the contract) always happen BEFORE the project is created on
  // the platform, so they're never tracked as in-platform workflow steps.
  const counts = monthlyRecCounts(p, override);
  const steps = [];
  for(let m = 1; m <= MONTHLY_BATCH_MONTHS; m++){
    const mo = MONTHLY_MONTH_LABELS[m - 1] || (m + 'º mês');
    const g = 'Mês ' + m;
    const rec = counts[m - 1];
    steps.push({ key: `m${m}-pay`, label: `Pagamento ${m} recebido`, group: g });
    steps.push({ key: `m${m}-script`, label: `Roteirização (${mo})`, group: g });
    for(let r = 1; r <= rec; r++){
      steps.push({ key: `m${m}-grav${r}`, label: rec > 1 ? `Gravação ${r} (${mo})` : `Gravação (${mo})`, group: g });
    }
    steps.push({ key: `m${m}-edit`,  label: `Edição do material (${mo})`,       group: g });
  }
  return steps;
}
// Set of completed step keys for a saved project (handles both models).
export function workflowDoneSet(p){
  if(Array.isArray(p.workflowDone)) return new Set(p.workflowDone);
  // Legacy projects stored a count — map it onto the first N step keys.
  const model = workflowModel(p);
  return new Set(model.slice(0, p.workflowProgress || 0).map(s => s.key));
}
// Completion stats for a project (drives the client progress bar + the badge).
export function workflowStats(p){
  const model = workflowModel(p);
  const done = workflowDoneSet(p);
  const doneCount = model.filter(s => done.has(s.key)).length;
  return { done: doneCount, total: model.length, frac: model.length ? doneCount / model.length : 0 };
}
// A project is complete once every workflow step has been checked off.
export function isProjectComplete(p){
  const s = workflowStats(p);
  return s.total > 0 && s.done >= s.total;
}
// Simplified client-facing stage names — a lot coarser than the admin's own
// step-by-step checklist (which mixes in admin-only bookkeeping), used for the
// client dashboard's "Fluxo do projeto" timeline.
export const FLOW_STAGES = ['Início', 'Pagamento', 'Roteirização', 'Gravação', 'Edição em Andamento', 'Entrega'];
// Which of the 6 FLOW_STAGES a project is currently at, derived from the
// admin's own workflow progress. -1 for avulso/pontual packs, which have no
// production workflow at all (payment-only) — callers should hide the
// timeline entirely in that case. "Início" is implicitly already passed the
// moment a project exists, so the returned index is whichever stage is
// actually in progress (the first not-yet-done step maps onto it), not a
// stage that still needs to happen before the next one starts.
export function projectFlowStage(p){
  if(isPontualWorkflow(p)) return -1;
  const monthly = isMonthlyWorkflow(p);
  const model = workflowModel(p, monthly ? monthlyRecCounts(p) : (p.recordingCount || 0));
  if(!model.length) return -1;
  const done = workflowDoneSet(p);
  const next = model.find(s => !done.has(s.key));
  if(!next) return 5; // every step done => Entrega
  if(monthly){
    if(next.key.endsWith('-pay')) return 1;
    if(next.key.endsWith('-script')) return 2;
    if(next.key.includes('-grav')) return 3;
    if(next.key.endsWith('-edit')) return 4;
    return 0;
  }
  if(next.group === 'Contrato & Pagamento') return /pagamento|recibo/i.test(next.label) ? 1 : 0;
  if(next.group === 'Preparação') return 2;
  if(next.group === 'Gravação') return 3;
  if(next.group === 'Pós-produção') return 4;
  return 0;
}
// Recording "slots" for a project (each gets a schedulable date + calendar button).
// Monthly (3-month) packs get recordings PER MONTH (3 × per-month count, open-ended
// — the admin adds/removes sessions per month freely). Every other pack gets a flat,
// open-ended list driven by however many recording dates exist (or are being
// edited) — same add/remove pattern used to be exclusive to "Trabalho
// Personalizado" and is now how every non-monthly pack works. `idx` is the flat
// index into the stored recordingDates array.
export function recordingSlots(p, override){
  const slots = [];
  if(isMonthlyWorkflow(p)){
    const counts = monthlyRecCounts(p, override);
    for(let m = 1; m <= MONTHLY_BATCH_MONTHS; m++){
      const mo = MONTHLY_MONTH_LABELS[m - 1] || (m + 'º mês');
      const rec = counts[m - 1];
      for(let r = 1; r <= rec; r++){
        slots.push({ idx: slots.length, month: m, label: rec > 1 ? `Gravação ${r} (${mo})` : `Gravação (${mo})` });
      }
    }
  } else {
    const n = Array.isArray(p.recordingDates) ? p.recordingDates.length : 0;
    for(let r = 1; r <= n; r++) slots.push({ idx: slots.length, label: `Gravação ${r}` });
  }
  return slots;
}

// Social Security prospection: (((income × 0.7) × 0.214) × 0.75) ÷ 3 per month.
// Each quarter is DECLARED the month right after it ends, and its contribution
// is split across the 3 months that follow the declaration — e.g. the Jan–Mar
// quarter is declared in April, paid in May/June/July. See admin-finance.js's
// quarterDeclMonth/quarterPayMonths for the month-by-month mapping this drives.
export const SS_INCOME_FACTOR = 0.7, SS_RATE = 0.214, SS_ADJUST = 0.75;
export const QUARTERS = [
  { label: 'T1', months: 'Jan–Mar' },
  { label: 'T2', months: 'Abr–Jun' },
  { label: 'T3', months: 'Jul–Set' },
  { label: 'T4', months: 'Out–Dez' }
];
export const money = new Intl.NumberFormat('pt-PT', { style: 'currency', currency: 'EUR' });

// Date helpers. Inputs/stored values are ISO "YYYY-MM-DD".
export function formatDatePt(iso){
  if(!iso) return '';
  const [y, m, d] = iso.split('-');
  return `${d}/${m}/${y}`;
}

// ---------- dd/mm/aaaa date fields (keyboard + calendar), stored as ISO ----------
// "yyyy-mm-dd" -> "dd/mm/yyyy"
export function isoToPt(iso){ return formatDatePt(iso); }
// "dd/mm/yyyy" -> "yyyy-mm-dd" (or "" if incomplete/invalid, e.g. 31/02/2026)
export function ptToIso(pt){
  const m = /^(\d{2})\/(\d{2})\/(\d{4})$/.exec((pt || '').trim());
  if(!m) return '';
  const d = +m[1], mo = +m[2], y = +m[3];
  const dt = new Date(y, mo - 1, d);
  if(dt.getFullYear() !== y || dt.getMonth() !== mo - 1 || dt.getDate() !== d) return '';
  return `${String(y).padStart(4, '0')}-${String(mo).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}
// Read/write the ISO value of an enhanced date input.
export function getISO(el){ return el.dataset.iso || ptToIso(el.value); }
export function setISO(el, iso){ el.dataset.iso = iso || ''; el.value = isoToPt(iso); }
// Enhance a text input: mask typing to dd/mm/aaaa + wire the calendar button.
export function enhanceDateField(input){
  if(!input || input.dataset.enhanced) return;
  input.dataset.enhanced = '1';
  input.addEventListener('input', () => {
    let v = input.value.replace(/[^\d]/g, '').slice(0, 8);
    if(v.length >= 5) v = v.slice(0, 2) + '/' + v.slice(2, 4) + '/' + v.slice(4);
    else if(v.length >= 3) v = v.slice(0, 2) + '/' + v.slice(2);
    input.value = v;
    input.dataset.iso = ptToIso(v);
  });
  const btn = input.parentNode.querySelector('.date-cal');
  if(btn){
    const dp = document.createElement('input');
    dp.type = 'date';
    dp.style.cssText = 'position:absolute;right:0;bottom:0;width:1px;height:1px;opacity:0;pointer-events:none;';
    input.parentNode.appendChild(dp);
    btn.addEventListener('click', () => {
      dp.value = getISO(input) || '';
      if(dp.showPicker) dp.showPicker(); else dp.focus();
    });
    dp.addEventListener('change', () => {
      if(!dp.value) return;
      setISO(input, dp.value);
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
    });
  }
}
export function addMonthsIso(iso, n){
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, (m - 1) + n, d);
  const yy = dt.getFullYear();
  const mm = String(dt.getMonth() + 1).padStart(2, '0');
  const dd = String(dt.getDate()).padStart(2, '0');
  return `${yy}-${mm}-${dd}`;
}
// Whole days from today (local midnight) until an ISO date. Negative = overdue.
export function daysUntil(iso){
  const [y, m, d] = iso.split('-').map(Number);
  const due = new Date(y, m - 1, d);
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  return Math.round((due - today) / 86400000);
}
// Countdown text + status class (green upcoming / orange today / red overdue) for a due date.
export function paymentStatus(iso){
  const days = daysUntil(iso);
  if(days < 0) return { text: `Em atraso há ${Math.abs(days)} dia${Math.abs(days) === 1 ? '' : 's'}`, mod: 'overdue' };
  if(days === 0) return { text: 'Vence hoje', mod: 'today' };
  return { text: days === 1 ? 'Falta 1 dia' : `Faltam ${days} dias`, mod: 'upcoming' };
}
// A project's payment dates. Uses the stored `paymentDates` array when present
// (admin can set each date freely). Falls back to deriving from the legacy
// `paymentDue` + monthly increments for projects saved before custom dates.
export function projectPaymentDates(p){
  if(Array.isArray(p.paymentDates)) return p.paymentDates;
  if(!p.paymentDue) return [];
  const pack = p.pack ? PACKS[p.pack] : null;
  const isMonthly = pack && pack.category === 'monthly';
  const split = p.splitPayments !== false;
  const n = (isMonthly && split) ? MONTHLY_BATCH_MONTHS : 1;
  return Array.from({ length: n }, (_, i) => addMonthsIso(p.paymentDue, i));
}
// A project's delivery dates. Uses the stored `deliveryDates` array when present
// (admin adds/removes batches freely, like payments/recordings). Falls back to
// the legacy single `deliveryDate` field for projects saved before this existed.
export function projectDeliveryDates(p){
  if(Array.isArray(p.deliveryDates)) return p.deliveryDates;
  return p.deliveryDate ? [p.deliveryDate] : [];
}

// Numeric price of a pack (e.g. "495€" -> 495). 0 if unknown.
export function packPriceNumber(packId){
  const p = packId ? PACKS[packId] : null;
  if(!p || !p.price) return 0;
  const n = parseFloat(String(p.price).replace(/[^\d.,]/g, '').replace(',', '.'));
  return isFinite(n) ? n : 0;
}

export const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);

// ============================================================
//  LIGHT/DARK THEME (default dark, persisted, no-flash via the <head> script)
// ============================================================
// Flat single-color icons (currentColor, so they inherit --off-white like the
// rest of the nav) instead of emoji, which render as tiny multicolor glyphs
// that clash with the rest of the site's flat visual language.
const SUN_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round"><circle cx="12" cy="12" r="4.5"/><path d="M12 2.5v3M12 18.5v3M4.2 4.2l2.1 2.1M17.7 17.7l2.1 2.1M2.5 12h3M18.5 12h3M4.2 19.8l2.1-2.1M17.7 6.3l2.1-2.1"/></svg>`;
const MOON_ICON = `<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor"><path d="M20.2 14.8A8.7 8.7 0 0 1 9.2 3.8a8.98 8.98 0 1 0 11 11z"/></svg>`;
export function applyThemeIcon(){
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  document.getElementById('themeToggle').innerHTML = isLight ? MOON_ICON : SUN_ICON;
}
applyThemeIcon();
// Flips the data-theme attribute + persists it + repaints the toggle icon.
export function toggleTheme(){
  const next = document.documentElement.getAttribute('data-theme') === 'light' ? 'dark' : 'light';
  document.documentElement.setAttribute('data-theme', next);
  try{ localStorage.setItem('esterTheme', next); }catch(e){}
  applyThemeIcon();
}

// Build the admin pack <select> once (grouped by family, with prices).
// Legacy packs (old id kept only so already-signed clients keep their
// original name/price — see PACK_GROUPS above) are excluded here: a new
// project should only ever be created against the current offering.
(function populatePackSelect(){
  const sel = document.getElementById('adminPack');
  if(!sel) return;
  let html = '<option value="">— Selecionar —</option>';
  PACK_GROUPS.forEach(g => {
    const visible = g.packs.filter(p => !p.legacy);
    if(!visible.length) return;
    html += `<optgroup label="${g.label}">`;
    visible.forEach(p => { html += `<option value="${p.id}">${p.name}${p.price ? ' — ' + p.price : ''}</option>`; });
    html += '</optgroup>';
  });
  sel.innerHTML = html;
})();

export const views = ["view-admin-auth","view-client-error","view-dashboard","view-admin","view-admin-leads","view-admin-edit","view-admin-project","view-admin-debts","view-admin-finance"];
// The "due soon / overdue" nudge only belongs on A receber — every other view
// hides it here so callers don't each need to remember to. checkDueSoon()
// (admin-debts-agenda.js) is what re-populates and un-hides it.
const DUE_BANNER_VIEWS = new Set(['view-admin-debts']);
export function show(id){
  views.forEach(v => document.getElementById(v).classList.toggle('hidden', v !== id));
  // Show the floating save only while editing a client or a project.
  const fs = document.getElementById('floatingSave');
  if(fs) fs.classList.toggle('show', id === 'view-admin-edit' || id === 'view-admin-project');
  if(!DUE_BANNER_VIEWS.has(id)){
    const banner = document.getElementById('dueSoonBanner');
    if(banner) banner.classList.add('hidden');
  }
  // Always start a new view at the top — otherwise, switching views on mobile
  // keeps the previous scroll position (e.g. Finance opening at the bottom).
  window.scrollTo({ top: 0, behavior: 'instant' });
}

// Toast confirmation, shown top-centered where the user is editing.
let toastTimer = null;
export function toast(text, isError){
  const t = document.getElementById('toast');
  if(!t) return;
  t.textContent = text;
  t.className = 'toast show' + (isError ? ' error' : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { t.classList.remove('show'); }, 2600);
}
// Floating save routes to whichever editor is open; also bound to Ctrl/Cmd+S.
function triggerSave(){
  if(!document.getElementById('view-admin-project').classList.contains('hidden')){
    document.getElementById('adminSaveProjectBtn').click();
  } else if(!document.getElementById('view-admin-edit').classList.contains('hidden')){
    document.getElementById('adminSaveDetailsBtn').click();
  }
}
document.getElementById('floatingSave').addEventListener('click', triggerSave);
document.addEventListener('keydown', (e) => {
  if((e.ctrlKey || e.metaKey) && (e.key === 's' || e.key === 'S')){
    const editing = !document.getElementById('view-admin-edit').classList.contains('hidden')
      || !document.getElementById('view-admin-project').classList.contains('hidden');
    if(editing){ e.preventDefault(); triggerSave(); }
  }
});

// Remember the current top-level admin view in the URL hash, so a page refresh
// stays put (Clientes / A receber / Financeiro) instead of falling back to the list.
export function setAdminHash(h){
  try{ history.replaceState(null, '', location.pathname + (h ? '#' + h : '')); }
  catch(e){ /* ignore */ }
}
export function msg(el, text, type){
  el.textContent = text;
  el.className = "form-msg show " + type;
}

export function escapeHtml(str){
  const d = document.createElement('div');
  d.textContent = str || '';
  return d.innerHTML;
}
// For use inside a double-quoted HTML attribute value (escapes quotes too).
export function escapeAttr(str){ return escapeHtml(str).replace(/"/g, '&quot;'); }

// ---------- "Adicionar ao calendário": build + download a .ics in the browser ----------
export const CAL_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="4" width="18" height="18" rx="2"></rect><line x1="16" y1="2" x2="16" y2="6"></line><line x1="8" y1="2" x2="8" y2="6"></line><line x1="3" y1="10" x2="21" y2="10"></line></svg>';
export function pad2(n){ return String(n).padStart(2, '0'); }
export function addDaysIso(iso, n){
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(y, m - 1, d + n);
  return `${dt.getFullYear()}-${pad2(dt.getMonth() + 1)}-${pad2(dt.getDate())}`;
}
// Open a Google Calendar event (most clients use Google Calendar, not the native
// iPhone one). With a time => a 1h timed event (wall time in Europe/Lisbon, where the
// shoot happens, so it shows correctly for viewers in any timezone). Without a time =>
// all-day (date-only `dates=start/end`, end exclusive = next day).
// Opens the calendar.google.com template; on mobile this hands off to the GCal app.
export function gcalTimedRange(dateIso, time, endTime){
  const [y, mo, d] = dateIso.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  const start = new Date(y, mo - 1, d, hh, mm);
  let end;
  if(endTime && /^\d{2}:\d{2}$/.test(endTime)){
    const [eh, em] = endTime.split(':').map(Number);
    end = new Date(y, mo - 1, d, eh, em);
    if(end.getTime() <= start.getTime()) end = new Date(start.getTime() + 60 * 60 * 1000);
  } else {
    end = new Date(start.getTime() + 60 * 60 * 1000);   // default 1h when no end set
  }
  const fmt = dt => `${dt.getFullYear()}${pad2(dt.getMonth() + 1)}${pad2(dt.getDate())}T${pad2(dt.getHours())}${pad2(dt.getMinutes())}00`;
  return fmt(start) + '/' + fmt(end);
}
export function openGoogleCalendarEvent({ dateIso, time, endTime, summary, description }){
  if(!dateIso) return;
  const timed = !!(time && /^\d{2}:\d{2}$/.test(time));
  const dates = timed
    ? gcalTimedRange(dateIso, time, endTime)
    : dateIso.replace(/-/g, '') + '/' + addDaysIso(dateIso, 1).replace(/-/g, '');
  let url = 'https://calendar.google.com/calendar/render?action=TEMPLATE'
    + '&text=' + encodeURIComponent(summary || '')
    + '&dates=' + dates
    + '&details=' + encodeURIComponent(description || '');
  if(timed) url += '&ctz=Europe/Lisbon';
  openExternal(url);
}
// Open an external URL reliably — even from an installed (standalone) PWA on iOS,
// where window.open('_blank') just shows a blank in-app WebView. A real anchor
// click, fired synchronously inside the user gesture, hands off to Safari / the
// Google Calendar app instead.
export function openExternal(url){
  const a = document.createElement('a');
  a.href = url;
  a.target = '_blank';
  a.rel = 'noopener noreferrer';
  document.body.appendChild(a);
  a.click();
  setTimeout(() => a.remove(), 0);
}
// Delegated: any ".cal-btn" (rebuilt on each dashboard snapshot) opens Google Calendar.
// Currently used for recording dates the admin schedules for the client.
document.addEventListener('click', (e) => {
  const btn = e.target.closest && e.target.closest('.cal-btn');
  if(!btn) return;
  const name = btn.dataset.title || '';
  const label = btn.dataset.label || ('Gravação ' + ((Number(btn.dataset.idx) || 0) + 1));
  const summary = label + (name ? ' — ' + name : ' — Ester');
  openGoogleCalendarEvent({
    dateIso: btn.dataset.date,
    time: btn.dataset.time,
    endTime: btn.dataset.endtime,
    summary,
    description: 'Sessão de gravação' + (name ? ' do projeto ' + name : '') + ' com a Ester.'
  });
});
export function clientLink(id){
  return `${location.origin}${location.pathname}?c=${id}`;
}

export function genId(){ return 'p' + Math.random().toString(36).slice(2, 10); }

// Normalize a client doc into a projects array. Legacy (single-project) docs
// get their old top-level fields wrapped into one project for backward compat.
export function getProjects(data){
  if(Array.isArray(data.projects)) return data.projects;
  const hasLegacy = data.pack || data.contractStart || data.paymentDue ||
    data.driveLink || data.trelloLink || data.workflow ||
    (Array.isArray(data.paymentsPaid) && data.paymentsPaid.length);
  if(hasLegacy){
    return [{
      id: 'legacy',
      name: (data.pack && PACKS[data.pack]) ? PACKS[data.pack].name : 'Projeto',
      pack: data.pack || '',
      contractStart: data.contractStart || '',
      paymentDue: data.paymentDue || '',
      splitPayments: data.splitPayments !== false,
      paymentsPaid: data.paymentsPaid || [],
      driveLink: data.driveLink || '',
      workflow: data.workflow || {}
    }];
  }
  return [];
}

// Website-styled confirmation dialog. Resolves true (confirm) / false (cancel).
// Cancel is the default: it's focused and triggered by Esc, Enter, or backdrop click.
const confirmModal = document.getElementById('confirmModal');
export function askConfirm({ title = 'Confirmar', message = '', confirmText = 'Deletar', cancelText = 'Cancelar' } = {}){
  return new Promise(resolve => {
    const okBtn = document.getElementById('confirmOk');
    const cancelBtn = document.getElementById('confirmCancel');
    document.getElementById('confirmTitle').textContent = title;
    document.getElementById('confirmMessage').textContent = message;
    okBtn.textContent = confirmText;
    cancelBtn.textContent = cancelText;
    confirmModal.classList.remove('hidden');
    cancelBtn.focus();

    function close(result){
      confirmModal.classList.add('hidden');
      okBtn.removeEventListener('click', onOk);
      cancelBtn.removeEventListener('click', onCancel);
      confirmModal.removeEventListener('click', onBackdrop);
      document.removeEventListener('keydown', onKey);
      resolve(result);
    }
    function onOk(){ close(true); }
    function onCancel(){ close(false); }
    function onBackdrop(e){ if(e.target === confirmModal) close(false); }
    function onKey(e){ if(e.key === 'Escape') close(false); }
    okBtn.addEventListener('click', onOk);
    cancelBtn.addEventListener('click', onCancel);
    confirmModal.addEventListener('click', onBackdrop);
    document.addEventListener('keydown', onKey);
  });
}
