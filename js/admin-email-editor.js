// ============================================================
//  ADMIN: ESCREVER EMAIL — manual payment emails that look exactly like the
//  automatic ones, for the cases the cron doesn't cover (pontual work, an
//  unusual fee, a correction). Replaces docs/templates/email-lembretes-
//  pagamento.html, which only lived on one computer.
//
//  Everything is editable: subject, inbox preview, greeting, each paragraph,
//  the closing lines, and the beige box, which takes any number of lines
//  (base value, + €, + %, − €, plain text) and adds up the total itself.
//
//  Texts start from a model (before due / due today / overdue) filled with
//  the payment's data. Once a text is edited by hand it's left alone when
//  the data or model changes; "Refazer texto" rebuilds everything.
//
//  The email shell mirrors vercel-cron/api/send-reminders.js's
//  esterEmailShell — keep the two in sync. The result is copied as HTML and
//  pasted into Gmail; nothing is sent from here.
// ============================================================
import {
  escapeHtml, escapeAttr, money, formatDatePt, daysUntil, addDaysIso, getISO, setISO,
  enhanceDateField, show, setAdminHash, toast, pad2
} from './core.js';
import { fetchAllInstallments } from './admin-debts-agenda.js';
import { loadReminders } from './admin-reminders.js';

const FINE_PCT = 5; // contract clause 2: one-time, not per day

const el = id => document.getElementById(id);
let wired = false;
let installments = [];
let st = null;

// ---------- text helpers ----------
// **bold** -> <strong>, everything else escaped.
function inline(text){
  return escapeHtml(text).replace(/\*\*(.+?)\*\*/g, '<strong>$1</strong>');
}
function dueText(due){
  if(due <= 0) return 'vence hoje';
  if(due === 1) return 'vence amanhã';
  return `vence em ${due} dias`;
}
function lateText(days){ return days === 1 ? 'há 1 dia' : `há ${days} dias`; }
function lineValue(l, base){
  const a = Number(l.amount) || 0;
  if(l.kind === 'base' || l.kind === 'add') return a;
  if(l.kind === 'pct') return base * a / 100;
  if(l.kind === 'sub') return -a;
  return 0;
}
function totals(){
  const base = st.lines.filter(l => l.kind === 'base').reduce((s, l) => s + (Number(l.amount) || 0), 0);
  const total = st.lines.reduce((s, l) => s + lineValue(l, base), 0);
  const showTotal = st.lines.some(l => ['add', 'pct', 'sub'].includes(l.kind));
  return { base, total, showTotal };
}

// ---------- the models ----------
function modelTexts(model, d){
  const iso = d.iso;
  const date = iso ? formatDatePt(iso) : 'dd/mm/aaaa';
  const amt = Number(d.amount) || 0;
  const project = d.project || 'Projeto';
  const parcela = d.parcela ? ` (${d.parcela.replace(/^\(|\)$/g, '')})` : '';
  const nameSp = d.name ? ` ${d.name}` : '';
  const outro = [
    'Caso o pagamento já tenha sido efetuado, por favor desconsidere esta mensagem.',
    'Qualquer dúvida ou necessidade de esclarecimento, estou à disposição.'
  ];
  if(model === 'late'){
    const days = Math.max(1, iso ? -daysUntil(iso) : 1);
    return {
      subject: `Pagamento em atraso — multa de ${FINE_PCT}% aplicada`,
      hello: `Oi${nameSp}, tudo bem?`,
      paras: [
        `Notamos que o pagamento referente a **${project}**${parcela} está em atraso ${lateText(days)} — o vencimento era em ${date}.`,
        `Conforme o contrato, incide uma multa única de ${FINE_PCT}% sobre o valor original a partir do primeiro dia de atraso. Este valor não se acumula por dia — é aplicado uma única vez.`
      ],
      outro,
      lines: [
        { label: 'Vencimento original', kind: 'base', text: date, amount: amt },
        { label: `Multa (${FINE_PCT}%)`, kind: 'pct', text: '', amount: FINE_PCT }
      ],
      totalLabel: 'Valor atualizado',
      preFn: (total) => amt > 0 ? `${money.format(total)} · em atraso ${lateText(days)} (venceu ${date}).` : `Pagamento em atraso ${lateText(days)} (venceu ${date}).`
    };
  }
  const due = model === 'today' ? 0 : Math.max(1, iso ? daysUntil(iso) : 3);
  const amountText = amt > 0 ? ` no valor de **${money.format(amt)}**` : '';
  return {
    subject: `Lembrete: pagamento ${dueText(due)}`,
    hello: `Oi${nameSp}! Tudo bem? ✨`,
    paras: [`Esta é uma mensagem de lembrete: o pagamento referente a **${project}**${parcela}${amountText} ${dueText(due)}.`],
    outro,
    lines: [{ label: 'Vencimento', kind: 'base', text: date, amount: amt }],
    totalLabel: 'Total',
    preFn: (total) => amt > 0 ? `${money.format(total)} · ${dueText(due)} (${date}).` : `Pagamento ${dueText(due)} (${date}).`
  };
}
// Fill every text the user hasn't edited by hand (all of them when `force`).
function applyModel(force){
  const t = modelTexts(st.model, st.data);
  st.preFn = t.preFn;
  ['subject', 'hello', 'paras', 'outro', 'lines', 'totalLabel', 'pre'].forEach(k => {
    if(force || !st.edited.has(k)){
      if(k !== 'pre') st[k] = Array.isArray(t[k]) ? JSON.parse(JSON.stringify(t[k])) : t[k];
    }
  });
  if(force) st.edited.clear();
}

// ---------- email HTML ----------
const LBL = 'font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#8c8c86;padding-bottom:6px;';
function boxHtml(){
  if(!st.lines.length) return '';
  const { base, total, showTotal } = totals();
  const single = st.lines.length === 1 && !showTotal;
  const rows = st.lines.map((l, i) => {
    const v = lineValue(l, base);
    const parts = [];
    if(l.text.trim()) parts.push(single ? `<strong>${escapeHtml(l.text)}</strong>` : escapeHtml(l.text));
    if(l.kind !== 'text'){
      const sign = l.kind === 'base' ? '' : (v < 0 ? '− ' : '+ ');
      if(l.kind !== 'base' || Number(l.amount) > 0) parts.push(sign + money.format(Math.abs(v)));
    }
    const last = i === st.lines.length - 1 && !showTotal;
    const size = single ? 'font-size:17px;line-height:1.4;' : 'font-size:15px;line-height:1.4;';
    return `<div style="${LBL}">${escapeHtml(l.label)}</div>` +
      `<div style="${size}color:#1f1f1e;${last ? '' : 'padding-bottom:14px;'}">${parts.join('&nbsp;&nbsp;&middot;&nbsp;&nbsp;') || '&nbsp;'}</div>`;
  }).join('');
  const totalRow = showTotal
    ? '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td height="1" bgcolor="#e2e0da" style="background-color:#e2e0da;font-size:0;line-height:0;">&nbsp;</td></tr><tr><td style="height:14px;font-size:0;line-height:0;">&nbsp;</td></tr></table>' +
      `<div style="${LBL}">${escapeHtml(st.totalLabel)}</div><div style="font-size:19px;line-height:1.3;color:#1f1f1e;"><strong>${money.format(total)}</strong></div>`
    : '';
  return '<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;margin:0 0 24px;">' +
    '<tr><td style="background-color:#f6f5f2;border-left:2px solid #0a0a0a;padding:16px 18px;font-family:Helvetica,Arial,sans-serif;word-break:break-word;">' +
    rows + totalRow + '</td></tr></table>';
}
function bodyHtml(){
  const paras = st.paras.filter(p => p.trim());
  const outro = st.outro.filter(p => p.trim());
  return `<p style="margin:0 0 18px;">${inline(st.hello)}</p>` +
    paras.map(p => `<p style="margin:0 0 22px;">${inline(p)}</p>`).join('') +
    boxHtml() +
    outro.map((p, i) => `<p style="margin:0${i < outro.length - 1 ? ' 0 14px' : ''};color:#5a5a57;">${inline(p)}</p>`).join('');
}
function preheaderBlock(text){
  const pad = '&#847;&zwnj;&nbsp;'.repeat(40);
  return `<div style="display:none !important;font-size:1px;line-height:1px;color:#ffffff;opacity:0;max-height:0;max-width:0;overflow:hidden;mso-hide:all;">${escapeHtml(text)}${pad}</div>`;
}
function emailHtml(){
  const sig = (label, inner, last) => `<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:13px;line-height:1.75;color:#f3f2ee;${last ? '' : 'padding-bottom:8px;'}word-break:break-word;"><span style="font-size:9px;letter-spacing:0.2em;text-transform:uppercase;color:#6f6f6a;">${label}</span>&nbsp;&nbsp;&nbsp;${inner}</td></tr>`;
  return preheaderBlock(st.pre) +
'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;background-color:#e8e7e3;"><tr><td align="center" style="padding:0;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="width:100%;max-width:100%;min-width:100%;border-collapse:collapse;">' +
'<tr><td bgcolor="#0a0a0a" align="center" style="background-color:#0a0a0a;padding:44px 32px 38px;">' +
'<div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;line-height:1.4;letter-spacing:0.32em;text-transform:uppercase;color:#8c8c86;padding-bottom:20px;">Produção Audiovisual&nbsp;&middot;&nbsp;Porto</div>' +
'<div style="font-family:Georgia,\'Times New Roman\',serif;font-style:italic;font-weight:400;font-size:60px;line-height:1.05;letter-spacing:0.02em;color:#f3f2ee;">ESTER</div>' +
'</td></tr>' +
'<tr><td height="2" bgcolor="#f0a24b" style="background-color:#f0a24b;font-size:0;line-height:0;">&nbsp;</td></tr>' +
'<tr><td bgcolor="#ffffff" style="background-color:#ffffff;padding:42px 36px 38px;font-family:Helvetica,Arial,sans-serif;font-size:15px;line-height:1.75;color:#1f1f1e;">' +
bodyHtml() +
'</td></tr>' +
'<tr><td bgcolor="#0a0a0a" style="background-color:#0a0a0a;padding:32px 36px 28px;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">' +
'<tr><td style="font-family:Georgia,\'Times New Roman\',serif;font-style:italic;font-size:24px;line-height:1.2;color:#f3f2ee;padding-bottom:5px;">Ester</td></tr>' +
'<tr><td style="font-family:Helvetica,Arial,sans-serif;font-size:12px;line-height:1.6;color:#8c8c86;padding-bottom:20px;">Estephanie Cerqueira&nbsp;&middot;&nbsp;Produção Audiovisual</td></tr>' +
'<tr><td height="1" bgcolor="#2b2b29" style="background-color:#2b2b29;font-size:0;line-height:0;">&nbsp;</td></tr>' +
'<tr><td style="height:20px;font-size:0;line-height:0;">&nbsp;</td></tr>' +
'</table>' +
'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;">' +
sig('WhatsApp', '<a href="https://wa.me/351913198057" target="_blank" style="color:#f3f2ee;text-decoration:none;">+351 913 198 057</a>') +
sig('Email', '<a href="mailto:contato@esterprod.com" style="color:#f3f2ee;text-decoration:none;">contato@esterprod.com</a>') +
sig('Portfólio', '<a href="https://esterprod.com" target="_blank" style="color:#f3f2ee;text-decoration:none;">esterprod.com</a>', true) +
'</table>' +
'</td></tr>' +
'<tr><td bgcolor="#0a0a0a" align="center" style="background-color:#0a0a0a;padding:0 36px 28px;">' +
'<table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="border-collapse:collapse;"><tr><td height="1" bgcolor="#2b2b29" style="background-color:#2b2b29;font-size:0;line-height:0;">&nbsp;</td></tr></table>' +
'<div style="font-family:Helvetica,Arial,sans-serif;font-size:10px;line-height:1.8;letter-spacing:0.16em;text-transform:uppercase;color:#6f6f6a;padding-top:16px;">Porto, Portugal</div>' +
'</td></tr>' +
'</table></td></tr></table>';
}

// ---------- render ----------
const KINDS = [['base', 'Valor'], ['add', '+ €'], ['pct', '+ %'], ['sub', '− €'], ['text', 'Texto']];
function renderLists(){
  const textList = (host, key) => {
    el(host).innerHTML = st[key].map((t, i) => `
      <div class="mail-row">
        <textarea rows="3" data-mail-list="${key}" data-i="${i}" aria-label="Parágrafo ${i + 1}">${escapeHtml(t)}</textarea>
        <button type="button" class="mail-x" data-mail-del="${key}" data-i="${i}" aria-label="Remover parágrafo">×</button>
      </div>`).join('');
  };
  textList('mailParas', 'paras');
  textList('mailOutro', 'outro');
  requestAnimationFrame(() => el('view-admin-email').querySelectorAll('.mail-row textarea').forEach(fitTextarea));
  el('mailLines').innerHTML = st.lines.map((l, i) => `
    <div class="mail-line" data-i="${i}">
      <input type="text" class="mail-line-label" data-line="label" value="${escapeAttr(l.label)}" aria-label="Nome da linha" placeholder="Nome da linha">
      <select data-line="kind" aria-label="Tipo">${KINDS.map(([v, t]) => `<option value="${v}"${v === l.kind ? ' selected' : ''}>${t}</option>`).join('')}</select>
      <input type="text" data-line="text" value="${escapeAttr(l.text)}" aria-label="Detalhe" placeholder="${l.kind === 'text' ? 'Texto' : 'Detalhe (opcional)'}">
      <input type="number" data-line="amount" value="${l.amount}" min="0" step="0.01" inputmode="decimal" aria-label="${l.kind === 'pct' ? 'Percentagem' : 'Valor em euros'}"${l.kind === 'text' ? ' hidden' : ''}>
      <button type="button" class="mail-x" data-mail-del="lines" data-i="${i}" aria-label="Remover linha">×</button>
    </div>`).join('');
}
// Paragraph boxes grow with their text instead of scrolling inside.
function fitTextarea(t){ t.style.height = 'auto'; t.style.height = (t.scrollHeight + 2) + 'px'; }
function renderPreview(){
  const { total } = totals();
  if(!st.edited.has('pre')) st.pre = st.preFn(total);
  const inputs = { mailSubject: 'subject', mailPre: 'pre', mailHello: 'hello', mailTotalLabel: 'totalLabel' };
  Object.entries(inputs).forEach(([id, k]) => { if(document.activeElement !== el(id)) el(id).value = st[k]; });
  el('mailTotalField').classList.toggle('hidden', !totals().showTotal);
  el('mailPreviewSubject').textContent = st.subject;
  el('mailPreviewPre').textContent = st.pre;
  el('mailPreview').innerHTML = emailHtml();
  el('mailEditedHint').textContent = st.edited.size
    ? 'Tem texto editado à mão. Mudar os dados acima já não o altera; "Refazer texto" volta ao modelo.'
    : '';
}
function renderAll(){ renderLists(); renderPreview(); }

// ---------- data ----------
function readData(){
  st.data = {
    name: el('mailName').value.trim(), project: el('mailProject').value.trim(),
    parcela: el('mailParcela').value.trim(), amount: el('mailAmount').value, iso: getISO(el('mailDate'))
  };
}
function writeData(d){
  el('mailName').value = d.name || ''; el('mailProject').value = d.project || '';
  el('mailParcela').value = d.parcela || ''; el('mailAmount').value = d.amount || '';
  setISO(el('mailDate'), d.iso || '');
}
function modelForIso(iso){
  if(!iso) return 'adv';
  const due = daysUntil(iso);
  return due < 0 ? 'late' : due === 0 ? 'today' : 'adv';
}
async function loadPrefill(){
  const sel = el('mailPrefill');
  try{
    installments = (await fetchAllInstallments()).filter(r => !r.paid);
  }catch(err){
    installments = [];
    toast('Não foi possível carregar os pagamentos — pode escrever do zero.', true);
  }
  sel.innerHTML = '<option value="">— Escrever do zero —</option>' + installments.map((r, i) => {
    const due = daysUntil(r.iso);
    const when = due < 0 ? `em atraso ${-due}d` : due === 0 ? 'vence hoje' : `vence ${formatDatePt(r.iso)}`;
    const parc = r.count > 1 ? ` ${r.idx + 1}/${r.count}` : '';
    return `<option value="${i}">${escapeHtml(`${r.clientName} · ${r.project}${parc} · ${when}${r.amount ? ' · ' + money.format(r.amount) : ''}`)}</option>`;
  }).join('');
}

// ---------- copy ----------
function copyBySelection(node){
  const sel = window.getSelection();
  const range = document.createRange();
  range.selectNodeContents(node);
  sel.removeAllRanges();
  sel.addRange(range);
  let ok = false;
  try{ ok = document.execCommand('copy'); }catch(e){}
  sel.removeAllRanges();
  return ok;
}
function copyText(text, label){
  if(!text){ toast(`${label} está vazio`, true); return; }
  const done = () => toast(`${label} copiado`);
  const fallback = () => {
    const ta = document.createElement('textarea');
    ta.value = text; ta.style.position = 'fixed'; ta.style.opacity = '0';
    document.body.appendChild(ta); ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    ok ? done() : toast('Não deu para copiar — selecione à mão', true);
  };
  if(navigator.clipboard && navigator.clipboard.writeText) navigator.clipboard.writeText(text).then(done, fallback);
  else fallback();
}
function copyEmail(){
  const node = el('mailPreview');
  const html = emailHtml();
  const done = () => toast('Email copiado — cole no corpo da mensagem no Gmail');
  if(navigator.clipboard && window.ClipboardItem){
    navigator.clipboard.write([new ClipboardItem({
      'text/html': new Blob([html], { type: 'text/html' }),
      'text/plain': new Blob([node.innerText], { type: 'text/plain' })
    })]).then(done, () => { copyBySelection(node) ? done() : toast('Não deu para copiar', true); });
    return;
  }
  copyBySelection(node) ? done() : toast('Não deu para copiar', true);
}

// ---------- events ----------
function wire(){
  enhanceDateField(el('mailDate'));
  el('emailBackLink').addEventListener('click', (e) => { e.preventDefault(); loadReminders(); });
  el('mailPrefill').addEventListener('change', () => {
    const r = installments[Number(el('mailPrefill').value)];
    if(!r) return;
    writeData({ name: r.firstName || r.clientName, project: r.note ? `${r.project} — ${r.note}` : r.project,
      parcela: r.count > 1 ? `parcela ${r.idx + 1}/${r.count}` : '', amount: r.amount || '', iso: r.iso });
    el('mailTo').value = r.email || '';
    el('mailModel').value = modelForIso(r.iso);
    st.model = el('mailModel').value;
    readData();
    applyModel(false);
    renderAll();
  });
  el('mailModel').addEventListener('change', () => { st.model = el('mailModel').value; applyModel(false); renderAll(); });
  ['mailName', 'mailProject', 'mailParcela', 'mailAmount', 'mailDate'].forEach(id => {
    el(id).addEventListener('input', () => { readData(); applyModel(false); renderAll(); });
  });
  el('mailResetBtn').addEventListener('click', () => { readData(); applyModel(true); renderAll(); toast('Texto refeito a partir do modelo'); });

  const view = el('view-admin-email');
  view.addEventListener('input', (e) => {
    const f = e.target.closest('[data-mail-field]');
    if(f){ st[f.dataset.mailField] = f.value; st.edited.add(f.dataset.mailField); renderPreview(); return; }
    const t = e.target.closest('[data-mail-list]');
    if(t){ st[t.dataset.mailList][Number(t.dataset.i)] = t.value; st.edited.add(t.dataset.mailList); fitTextarea(t); renderPreview(); return; }
    const ln = e.target.closest('[data-line]');
    if(ln){
      const l = st.lines[Number(ln.closest('.mail-line').dataset.i)];
      const k = ln.dataset.line;
      l[k] = k === 'amount' ? (parseFloat(ln.value) || 0) : ln.value;
      st.edited.add('lines');
      if(k === 'kind') renderLists();
      renderPreview();
    }
  });
  view.addEventListener('change', (e) => {
    // <select> fires change, not input, on some browsers.
    const ln = e.target.closest('select[data-line]');
    if(ln){ st.lines[Number(ln.closest('.mail-line').dataset.i)].kind = ln.value; st.edited.add('lines'); renderAll(); }
  });
  view.addEventListener('click', (e) => {
    const del = e.target.closest('[data-mail-del]');
    if(del){ const k = del.dataset.mailDel; st[k].splice(Number(del.dataset.i), 1); st.edited.add(k); renderAll(); return; }
    const add = e.target.closest('[data-mail-add]');
    if(add){
      const k = add.dataset.mailAdd; st[k].push(''); st.edited.add(k); renderAll();
      const boxes = el(k === 'paras' ? 'mailParas' : 'mailOutro').querySelectorAll('textarea');
      if(boxes.length) boxes[boxes.length - 1].focus();
      return;
    }
    const pre = e.target.closest('[data-mail-preset]');
    if(pre){
      const P = {
        multa: { label: `Multa (${FINE_PCT}%)`, kind: 'pct', text: '', amount: FINE_PCT },
        juros: { label: 'Juros de mora', kind: 'add', text: '', amount: 0 },
        desloc: { label: 'Taxa de deslocação', kind: 'add', text: '', amount: 0 },
        desconto: { label: 'Desconto', kind: 'sub', text: '', amount: 0 },
        texto: { label: 'Nota', kind: 'text', text: '', amount: 0 }
      }[pre.dataset.mailPreset];
      st.lines.push({ ...P });
      st.edited.add('lines');
      renderAll();
      const rows = el('mailLines').querySelectorAll('.mail-line');
      const last = rows[rows.length - 1];
      if(last) (last.querySelector(P.kind === 'text' ? '[data-line="text"]' : '[data-line="amount"]') || last.querySelector('input')).focus();
    }
  });
  el('mailCopyBtn').addEventListener('click', copyEmail);
  el('mailCopySubjectBtn').addEventListener('click', () => copyText(st.subject, 'Assunto'));
  el('mailCopyToBtn').addEventListener('click', () => copyText(el('mailTo').value.trim(), 'Destinatário'));
}

export async function loadEmailEditor(){
  setAdminHash('email');
  show('view-admin-email');
  if(!wired){ wire(); wired = true; }
  if(!st){
    st = { model: 'adv', data: {}, subject: '', pre: '', hello: '', paras: [], outro: [], lines: [], totalLabel: '', edited: new Set(), preFn: () => '' };
    const t = new Date();
    writeData({ iso: addDaysIso(`${t.getFullYear()}-${pad2(t.getMonth() + 1)}-${pad2(t.getDate())}`, 3) });
    el('mailModel').value = 'adv';
    readData();
    applyModel(true);
    renderAll();
  }
  loadPrefill();
}

// The "Escrever email" button lives on the Lembretes view.
document.getElementById('remWriteEmailBtn').addEventListener('click', loadEmailEditor);
