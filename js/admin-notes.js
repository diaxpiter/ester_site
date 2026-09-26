// ============================================================
//  ADMIN: NOTAS — iPhone-Notes-style notes inside Central. A list on the
//  left (search, pinned first, newest first), the open note on the right:
//  a big title line, then a list of blocks — plain text, headings and
//  checkboxes. Saves itself a moment after typing stops; there is no
//  "Guardar" button.
//
//  One Firestore doc per note in `notes` (admin-only in firestore.rules):
//    { title, blocks: [{ t: 'p'|'h'|'c', html, text, done }], pinned,
//      createdAt, updatedAt }   (dates are ISO strings)
//  `html` holds the line with its formatting — only <b>, <i>, <u> and <br>
//  survive cleanInline(); `text` is the same line as plain text, used for
//  search, previews and link detection. Notes saved before formatting
//  existed only have `text`; normalize() turns it into `html`.
//
//  Bold / italic / underline: toolbar buttons, or Ctrl/Cmd+B / I / U.
//
//  Keyboard follows the iPhone: Enter on a checkbox line starts another
//  checkbox, Enter on an empty checkbox line turns it back into text, and
//  Backspace at the start of a heading/checkbox line turns it into text
//  (then, on a text line, joins it to the line above).
//
//  The first time Notas opens with no notes, the old Central tabs (Rotina,
//  Pastas, Atalhos) are written out as starter notes so nothing is lost —
//  see seedNotes() below.
// ============================================================
import {
  doc, getDoc, setDoc, deleteDoc, collection, getDocs
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-firestore.js";
import { db, escapeHtml, toast, askConfirm } from './core.js';

const NOTES = collection(db, "notes");
const SAVE_DELAY_MS = 700;

let notes = [];          // [{ id, title, blocks, pinned, createdAt, updatedAt }]
let currentId = null;
let loaded = false;
let wired = false;
let saveTimer = null;
let dirtyId = null;
let focusIdx = -1;       // last focused block, so the toolbar knows which line to change

const el = id => document.getElementById(id);
const current = () => notes.find(n => n.id === currentId) || null;
const nowIso = () => new Date().toISOString();
const isNarrow = () => window.matchMedia('(max-width: 760px)').matches;

// ---------- starter notes (the old Central tabs) ----------
const LINK_GROUPS = [
  ['Trabalho do dia', [
    ['drive', 'Drive da empresa', ''], ['clientes', '01_CLIENTES', ''], ['templates', '03_TEMPLATES', ''],
    ['gmail', 'Faturas no Gmail', 'https://mail.google.com/mail/u/0/#search/fatura+OR+recibo+OR+invoice']
  ]],
  ['Dinheiro', [
    ['folha', 'Folha financeira', ''], ['despesa', 'Lançar despesa', ''], ['precario', 'Tabela de preços', ''],
    ['banco', 'Conta da empresa', ''], ['financas', 'Portal das Finanças', 'https://www.portaldasfinancas.gov.pt/'],
    ['ss', 'Segurança Social Direta', 'https://app.seg-social.pt/sso/']
  ]],
  ['Mostrar ao cliente', [
    ['site', 'esterprod.com', 'https://esterprod.com'], ['insta', '@estephanie.e', 'https://instagram.com/estephanie.e'],
    ['maps', 'Perfil no Google', ''], ['port', 'Portfólio', '']
  ]]
];
const P = text => ({ t: 'p', html: escapeHtml(text), text, done: false });
const H = text => ({ t: 'h', html: escapeHtml(text), text, done: false });
const C = text => ({ t: 'c', html: escapeHtml(text), text, done: false });

// ---------- inline formatting ----------
// Rebuilds a line's HTML from scratch, keeping only text, <br> and bold /
// italic / underline — whatever form the browser used for them (<strong>,
// <em>, or a <span style>). Everything else is unwrapped to its text, and no
// attribute survives, so nothing pasted or stored can carry markup through.
const INLINE_TAGS = { B: 'b', STRONG: 'b', I: 'i', EM: 'i', U: 'u' };
function cleanInline(html){
  const tpl = document.createElement('template');
  tpl.innerHTML = html || '';
  const out = document.createElement('div');
  const walk = (src, dst) => {
    src.childNodes.forEach(node => {
      if(node.nodeType === Node.TEXT_NODE){ dst.appendChild(document.createTextNode(node.nodeValue)); return; }
      if(node.nodeType !== Node.ELEMENT_NODE) return;
      const tag = node.tagName;
      if(tag === 'SCRIPT' || tag === 'STYLE' || tag === 'TEMPLATE') return;
      if(tag === 'BR'){ dst.appendChild(document.createElement('br')); return; }
      let target = dst;
      const wrap = name => { const e = document.createElement(name); target.appendChild(e); target = e; };
      if(INLINE_TAGS[tag]) wrap(INLINE_TAGS[tag]);
      else{
        if(tag === 'DIV' || tag === 'P'){ if(dst.childNodes.length) dst.appendChild(document.createElement('br')); }
        const style = node.getAttribute('style') || '';
        if(/font-weight:\s*(bold|[6-9]00)/i.test(style)) wrap('b');
        if(/font-style:\s*italic/i.test(style)) wrap('i');
        if(/text-decoration[^;]*underline/i.test(style)) wrap('u');
      }
      walk(node, target);
    });
  };
  walk(tpl.content, out);
  out.querySelectorAll('b, i, u').forEach(e => { if(!e.textContent) e.remove(); });
  return out.innerHTML.replace(/(<br>)+$/, '');
}
function htmlToText(html){
  const d = document.createElement('div');
  d.innerHTML = (html || '').replace(/<br>/g, ' ');
  return d.textContent;
}
// The line's HTML split at the caret: [before, after].
function splitAtCaret(node){
  const sel = window.getSelection();
  if(!sel.rangeCount || !node.contains(sel.anchorNode)) return [node.innerHTML, ''];
  const r = sel.getRangeAt(0);
  if(!r.collapsed) r.deleteContents();
  const tail = document.createRange();
  tail.selectNodeContents(node);
  tail.setStart(r.startContainer, r.startOffset);
  const holder = document.createElement('div');
  holder.appendChild(tail.extractContents());
  return [cleanInline(node.innerHTML), cleanInline(holder.innerHTML)];
}
const withHtml = (b, html) => ({ ...b, html, text: htmlToText(html) });

function starterNotes(links){
  const linkBlocks = [P('Os atalhos que estavam na Central. Toque em ↗ para abrir.')];
  LINK_GROUPS.forEach(([group, items]) => {
    linkBlocks.push(H(group));
    items.forEach(([key, label, def]) => {
      const url = (typeof links[key] === 'string' && links[key].trim()) || def;
      linkBlocks.push(P(url ? `${label}: ${url}` : `${label}: (sem link)`));
    });
  });
  return [
    { id: 'inicio-rotina-sexta', title: 'Rotina de sexta · 15 minutos', blocks: [
      P('Marcado no calendário como se fosse um cliente. Desmarque as caixas na segunda.'),
      C('Lançar em Financeiro tudo o que entrou esta semana'),
      C('Lançar as despesas da semana e arrastar os talões para 02_SAIDAS'),
      C('Passar a Pago o que já entrou na conta'),
      C('Ver A receber: quem está em atraso leva mensagem hoje'),
      C('Emitir os recibos verdes dos pagamentos recebidos'),
      C('Enviar as faturas dos trabalhos entregues esta semana')
    ]},
    { id: 'inicio-rotina-mes', title: 'Dia 1 do mês · 30 minutos', blocks: [
      C('Comparar o saldo real do banco com a receita do mês em Financeiro'),
      C('Transferir os 30% (impostos e Segurança Social) e os 10% (reserva) para a poupança'),
      C('Fechar a pasta do mês em 01_ENTRADAS e 02_SAIDAS e abrir a do mês seguinte'),
      C('Rever as subscrições: cancelar o que não se usou este mês'),
      C('Rever a lista de desejos: aprovar, adiar ou descartar cada linha'),
      C('Olhar para o ano em Financeiro e ver que meses são fracos todos os anos'),
      H('A regra dos três bolsos'),
      P('Cada valor parte-se em três no momento em que entra, não no fim do mês.'),
      P('30% · Impostos e Segurança Social · poupança separada, nunca se toca'),
      P('10% · Reserva e equipamento · a mesma poupança, subconta diferente'),
      P('60% · Livre · conta do dia a dia'),
      H('Antes de comprar seja o que for'),
      C('Está na lista de desejos há sete dias ou mais?'),
      C('O bolso dos impostos está cheio até hoje?'),
      C('Destrava trabalho já pedido, ou é para um cliente que ainda não existe?'),
      C('Alugar por um dia resolve o mesmo?'),
      P('Se sim a tudo: comprar, guardar a fatura em 04_EQUIPAMENTO e lançar na folha no mesmo dia.')
    ]},
    { id: 'inicio-pastas', title: 'Pastas do drive', blocks: [
      H('ESTER (drive da empresa)'),
      P('00_DOC · documentos soltos, contratos, seguros'),
      P('01_CLIENTES · uma pasta por cliente, partilhada com ele (Bruto / Entregas / Admin)'),
      P('02_FINANCEIRO · 00_PAINEL, 01_ENTRADAS, 02_SAIDAS, 03_FISCAL, 04_EQUIPAMENTO'),
      P('03_TEMPLATES · orçamento, email, contrato, tabela de preços'),
      H('Nome dos ficheiros'),
      P('A data à frente ordena a pasta sozinha; o nome da entidade faz a pesquisa do Drive encontrar tudo de uma vez.'),
      P('01_ENTRADAS · AAAA-MM-DD_REC_Cliente_valor'),
      P('02_SAIDAS · AAAA-MM-DD_DESP_Fornecedor_o-que-é_valor'),
      P('04_EQUIPAMENTO · AAAA-MM-DD_EQP_Marca-modelo_valor'),
      P('03_TEMPLATES · AAAA-MM-DD_ORC_Cliente_valor')
    ]},
    { id: 'inicio-links', title: 'Links', blocks: linkBlocks }
  ];
}

// Runs once ever: only when there are no notes AND the central doc hasn't
// been marked as seeded (so deleting every note later doesn't bring them
// back). Fixed ids make it safe if the phone and the computer race.
async function seedNotes(){
  const centralRef = doc(db, "dashboard", "central");
  const snap = await getDoc(centralRef);
  const data = snap.exists() ? (snap.data() || {}) : {};
  if(data.notesSeeded) return [];
  const base = Date.now();
  const seeded = starterNotes(data.links || {}).map((n, i) => {
    const at = new Date(base - i * 1000).toISOString(); // keeps the order above
    return { ...n, pinned: false, createdAt: at, updatedAt: at };
  });
  await Promise.all(seeded.map(({ id, ...rest }) => setDoc(doc(NOTES, id), rest)));
  await setDoc(centralRef, { notesSeeded: true }, { merge: true });
  return seeded;
}

// ---------- Firestore ----------
async function fetchNotes(){
  const snap = await getDocs(NOTES);
  return snap.docs.map(d => normalize({ id: d.id, ...d.data() }));
}
function normalize(n){
  const blocks = Array.isArray(n.blocks) && n.blocks.length ? n.blocks : [P('')];
  return {
    id: n.id, title: n.title || '', pinned: !!n.pinned,
    createdAt: n.createdAt || nowIso(), updatedAt: n.updatedAt || n.createdAt || nowIso(),
    blocks: blocks.map(b => {
      const html = typeof b.html === 'string' ? cleanInline(b.html) : escapeHtml(String(b.text || ''));
      return { t: ['p', 'h', 'c'].includes(b.t) ? b.t : 'p', html, text: htmlToText(html), done: !!b.done };
    })
  };
}
function scheduleSave(){
  const n = current();
  if(!n) return;
  n.updatedAt = nowIso();
  dirtyId = n.id;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(flushSave, SAVE_DELAY_MS);
}
async function flushSave(){
  clearTimeout(saveTimer);
  if(!dirtyId) return;
  const n = notes.find(x => x.id === dirtyId);
  dirtyId = null;
  if(!n) return;
  const { id, ...rest } = n;
  rest.blocks = n.blocks.map(b => {
    const html = cleanInline(b.html);
    return { t: b.t, html, text: htmlToText(html), done: !!b.done };
  });
  try{
    await setDoc(doc(NOTES, id), rest);
  }catch(err){
    dirtyId = id;
    toast('Não foi possível guardar a nota — sem ligação?', true);
  }
}

// ---------- helpers ----------
function sorted(list){
  return list.slice().sort((a, b) => (b.pinned - a.pinned) || (a.updatedAt < b.updatedAt ? 1 : -1));
}
function noteLabel(n){
  if(n.title.trim()) return n.title.trim();
  const first = n.blocks.find(b => b.text.trim());
  return first ? first.text.trim() : 'Nova nota';
}
function notePreview(n){
  const rest = n.blocks.filter(b => b.text.trim()).map(b => b.text.trim());
  if(!n.title.trim()) rest.shift();
  return rest[0] || 'Sem texto';
}
function whenLabel(iso){
  const d = new Date(iso);
  const today = new Date(); today.setHours(0, 0, 0, 0);
  const day = new Date(d); day.setHours(0, 0, 0, 0);
  const diff = Math.round((today - day) / 86400000);
  const hm = `${String(d.getHours()).padStart(2, '0')}:${String(d.getMinutes()).padStart(2, '0')}`;
  if(diff === 0) return hm;
  if(diff === 1) return 'Ontem';
  return `${String(d.getDate()).padStart(2, '0')}/${String(d.getMonth() + 1).padStart(2, '0')}/${d.getFullYear()}`;
}
function firstUrl(text){
  const m = text.match(/https?:\/\/[^\s]+/);
  return m ? m[0] : '';
}
// Caret offset inside a plaintext contenteditable, and back.
function caretOffset(node){
  const sel = window.getSelection();
  if(!sel.rangeCount || !node.contains(sel.anchorNode)) return node.textContent.length;
  const r = sel.getRangeAt(0).cloneRange();
  r.selectNodeContents(node);
  r.setEnd(sel.anchorNode, sel.anchorOffset);
  return r.toString().length;
}
function placeCaret(node, offset){
  node.focus();
  const sel = window.getSelection();
  const range = document.createRange();
  let remaining = offset;
  const walker = document.createTreeWalker(node, NodeFilter.SHOW_TEXT);
  let t;
  while((t = walker.nextNode())){
    if(remaining <= t.length){ range.setStart(t, remaining); range.collapse(true); sel.removeAllRanges(); sel.addRange(range); return; }
    remaining -= t.length;
  }
  range.selectNodeContents(node);
  range.collapse(false);
  sel.removeAllRanges();
  sel.addRange(range);
}
function blockText(i){ return el('notesBody').querySelector(`.nb-text[data-i="${i}"]`); }

// ---------- render ----------
function renderList(){
  const q = el('notesSearch').value.trim().toLowerCase();
  const list = sorted(notes).filter(n => !q || (n.title + ' ' + n.blocks.map(b => b.text).join(' ')).toLowerCase().includes(q));
  const host = el('notesList');
  if(!list.length){
    host.innerHTML = `<p class="notes-list-empty">${notes.length ? 'Nenhuma nota com esse texto.' : 'Ainda não há notas.'}</p>`;
    return;
  }
  host.innerHTML = list.map(n => `
    <button type="button" class="notes-item${n.id === currentId ? ' is-active' : ''}" data-note-id="${escapeHtml(n.id)}">
      <span class="notes-item-title">${n.pinned ? '<span class="notes-pin">Fixada</span>' : ''}${escapeHtml(noteLabel(n))}</span>
      <span class="notes-item-sub"><b>${whenLabel(n.updatedAt)}</b> ${escapeHtml(notePreview(n))}</span>
    </button>`).join('');
}
function renderEditor(focus){
  const n = current();
  const has = !!n;
  el('notesEmpty').classList.toggle('hidden', has);
  ['notesTitle', 'notesBody', 'notesMeta'].forEach(id => el(id).classList.toggle('hidden', !has));
  el('notesEditorPane').querySelectorAll('.notes-tool').forEach(b => { b.disabled = !has; });
  if(!has){ el('notesBody').innerHTML = ''; return; }
  el('notesMeta').textContent = 'Editada ' + (whenLabel(n.updatedAt).includes(':') ? 'hoje às ' + whenLabel(n.updatedAt) : whenLabel(n.updatedAt).toLowerCase());
  el('notesPinBtn').textContent = n.pinned ? 'Desafixar' : 'Fixar';
  const title = el('notesTitle');
  if(title.textContent !== n.title) title.textContent = n.title;
  el('notesBody').innerHTML = n.blocks.map((b, i) => {
    const url = b.t !== 'h' ? firstUrl(b.text) : '';
    const check = b.t === 'c'
      ? `<button type="button" class="nb-check" data-check="${i}" role="checkbox" aria-checked="${b.done}" aria-label="Marcar como feito">${b.done ? '✓' : ''}</button>`
      : '';
    const open = url ? `<a class="nb-open" href="${escapeHtml(url)}" target="_blank" rel="noopener" aria-label="Abrir link">↗</a>` : '';
    return `<div class="nb nb-${b.t}${b.done ? ' is-done' : ''}">${check}<div class="nb-text" data-i="${i}" contenteditable="true" role="textbox">${cleanInline(b.html)}</div>${open}</div>`;
  }).join('');
  if(focus){
    const node = focus.title ? title : blockText(focus.i);
    if(node) placeCaret(node, focus.offset ?? node.textContent.length);
  }
}
function syncPanes(){
  el('notesRoot').classList.toggle('is-open', !!currentId);
}
function openNote(id, focus){
  flushSave();
  currentId = id;
  focusIdx = -1;
  syncPanes(); // before renderEditor: on a phone the editor must be visible to take focus
  renderList();
  renderEditor(focus);
}

// ---------- editing ----------
function setBlocks(n, blocks, focus){
  n.blocks = blocks.length ? blocks : [P('')];
  scheduleSave();
  renderEditor(focus);
  renderList();
}
function onBodyKeydown(e){
  const t = e.target.closest('.nb-text');
  if(!t) return;
  const n = current();
  const i = Number(t.dataset.i);
  const b = n.blocks[i];
  if(e.key === 'Enter' && !e.shiftKey && !e.isComposing){
    e.preventDefault();
    // Empty checkbox line + Enter = stop the list (iPhone behavior).
    if(b.t === 'c' && !t.textContent.trim()){
      const blocks = n.blocks.slice(); blocks[i] = P('');
      return setBlocks(n, blocks, { i, offset: 0 });
    }
    // Split at the caret, formatting included on both halves.
    const [before, after] = splitAtCaret(t);
    const blocks = n.blocks.slice();
    blocks[i] = withHtml(b, before);
    blocks.splice(i + 1, 0, withHtml({ t: b.t === 'c' ? 'c' : 'p', done: false }, after));
    return setBlocks(n, blocks, { i: i + 1, offset: 0 });
  }
  if(e.key === 'Backspace' && caretOffset(t) === 0 && !window.getSelection().toString()){
    if(b.t !== 'p'){
      e.preventDefault();
      const blocks = n.blocks.slice(); blocks[i] = withHtml({ t: 'p', done: false }, cleanInline(t.innerHTML));
      return setBlocks(n, blocks, { i, offset: 0 });
    }
    if(i > 0){
      e.preventDefault();
      const blocks = n.blocks.slice();
      const prev = blocks[i - 1];
      const join = htmlToText(prev.html).length;
      blocks[i - 1] = withHtml(prev, cleanInline(prev.html + t.innerHTML));
      blocks.splice(i, 1);
      return setBlocks(n, blocks, { i: i - 1, offset: join });
    }
  }
  if(e.key === 'ArrowUp' && i > 0 && caretOffset(t) === 0){ e.preventDefault(); placeCaret(blockText(i - 1), 0); }
  if(e.key === 'ArrowDown' && i < n.blocks.length - 1 && caretOffset(t) === t.textContent.length){ e.preventDefault(); placeCaret(blockText(i + 1), 0); }
}
function applyTool(kind){
  const n = current();
  if(!n) return;
  const blocks = n.blocks.slice();
  if(focusIdx < 0 || focusIdx >= blocks.length){
    // Nothing focused: add a new line of that kind at the end.
    blocks.push({ t: kind, html: '', text: '', done: false });
    return setBlocks(n, blocks, { i: blocks.length - 1, offset: 0 });
  }
  const b = blocks[focusIdx];
  const node = blockText(focusIdx);
  const off = node ? caretOffset(node) : b.text.length;
  blocks[focusIdx] = { ...b, t: b.t === kind ? 'p' : kind, done: false };
  setBlocks(n, blocks, { i: focusIdx, offset: off });
}

async function newNote(){
  const id = doc(NOTES).id;
  const at = nowIso();
  notes.push({ id, title: '', blocks: [P('')], pinned: false, createdAt: at, updatedAt: at });
  el('notesSearch').value = '';
  openNote(id, { title: true, offset: 0 });
  dirtyId = id;
  await flushSave();
}
async function deleteCurrent(){
  const n = current();
  if(!n) return;
  const ok = await askConfirm({ title: 'Apagar nota', message: `Apagar "${noteLabel(n)}"? Não dá para desfazer.`, confirmText: 'Apagar' });
  if(!ok) return;
  clearTimeout(saveTimer);
  if(dirtyId === n.id) dirtyId = null;
  try{
    await deleteDoc(doc(NOTES, n.id));
  }catch(err){
    toast('Não foi possível apagar — sem ligação?', true);
    return;
  }
  notes = notes.filter(x => x.id !== n.id);
  const next = sorted(notes)[0];
  currentId = null;
  if(next && !isNarrow()) openNote(next.id); else { renderList(); renderEditor(); syncPanes(); }
  toast('Nota apagada');
}

function wire(){
  el('notesList').addEventListener('click', (e) => {
    const item = e.target.closest('[data-note-id]');
    if(item) openNote(item.dataset.noteId);
  });
  el('notesSearch').addEventListener('input', renderList);
  el('notesNewBtn').addEventListener('click', newNote);
  el('notesBackBtn').addEventListener('click', () => { flushSave(); currentId = null; renderList(); syncPanes(); });
  el('notesDeleteBtn').addEventListener('click', deleteCurrent);
  el('notesPinBtn').addEventListener('click', () => {
    const n = current(); if(!n) return;
    n.pinned = !n.pinned;
    scheduleSave();
    el('notesPinBtn').textContent = n.pinned ? 'Desafixar' : 'Fixar';
    renderList();
  });
  // Toolbar buttons must not steal focus (or the selection) from the line
  // being edited — pointerdown covers touch, mousedown older browsers.
  el('notesEditorPane').querySelectorAll('[data-note-tool], [data-note-fmt]').forEach(b => {
    b.addEventListener('pointerdown', e => e.preventDefault());
    b.addEventListener('mousedown', e => e.preventDefault());
  });
  el('notesEditorPane').querySelectorAll('[data-note-tool]').forEach(b => {
    b.addEventListener('click', () => applyTool(b.dataset.noteTool));
  });
  // Bold / italic / underline on the selection (or on what's typed next).
  // styleWithCSS off so browsers write <b>/<i>/<u>, not <span style>.
  try{ document.execCommand('styleWithCSS', false, false); }catch(e){}
  const fmtButtons = el('notesEditorPane').querySelectorAll('[data-note-fmt]');
  fmtButtons.forEach(b => b.addEventListener('click', () => {
    const sel = window.getSelection();
    if(!sel.rangeCount || !sel.anchorNode || !sel.anchorNode.parentElement || !sel.anchorNode.parentElement.closest('#notesBody .nb-text')){
      toast('Toque primeiro numa linha da nota');
      return;
    }
    document.execCommand(b.dataset.noteFmt);
    syncFmtButtons();
  }));
  // Light up B / I / U when the caret sits in formatted text.
  const syncFmtButtons = () => {
    const sel = window.getSelection();
    const inBody = sel.rangeCount && sel.anchorNode && el('notesBody').contains(sel.anchorNode);
    fmtButtons.forEach(b => {
      let on = false;
      if(inBody){ try{ on = document.queryCommandState(b.dataset.noteFmt); }catch(e){} }
      b.classList.toggle('is-on', on);
      b.setAttribute('aria-pressed', String(on));
    });
  };
  document.addEventListener('selectionchange', syncFmtButtons);

  const title = el('notesTitle');
  title.addEventListener('input', () => { const n = current(); if(!n) return; n.title = title.textContent; scheduleSave(); renderList(); });
  title.addEventListener('keydown', (e) => {
    if(e.key !== 'Enter' || e.isComposing) return;
    e.preventDefault();
    const n = current();
    if(!n.blocks.length) n.blocks.push(P(''));
    placeCaret(blockText(0), 0);
  });
  title.addEventListener('focus', () => { focusIdx = -1; });

  const body = el('notesBody');
  body.addEventListener('keydown', onBodyKeydown);
  body.addEventListener('focusin', (e) => { const t = e.target.closest('.nb-text'); if(t) focusIdx = Number(t.dataset.i); });
  body.addEventListener('input', (e) => {
    const t = e.target.closest('.nb-text');
    const n = current();
    if(!t || !n) return;
    const b = n.blocks[Number(t.dataset.i)];
    b.html = t.innerHTML; // cleaned on save, not per keystroke (that would move the caret)
    b.text = t.textContent;
    scheduleSave();
    renderList();
  });
  body.addEventListener('click', (e) => {
    const c = e.target.closest('[data-check]');
    if(!c) return;
    const n = current();
    const b = n.blocks[Number(c.dataset.check)];
    b.done = !b.done;
    c.closest('.nb').classList.toggle('is-done', b.done);
    c.setAttribute('aria-checked', String(b.done));
    c.textContent = b.done ? '✓' : '';
    scheduleSave();
  });
  // Paste as plain text on every browser (plaintext-only covers most, not all).
  el('notesEditorPane').addEventListener('paste', (e) => {
    if(!e.target.closest('[contenteditable]')) return;
    e.preventDefault();
    document.execCommand('insertText', false, (e.clipboardData || window.clipboardData).getData('text/plain'));
  });
  document.addEventListener('visibilitychange', () => { if(document.visibilityState === 'hidden') flushSave(); });
  window.addEventListener('pagehide', flushSave);
}

export async function loadNotes(){
  if(!wired){ wire(); wired = true; }
  if(!loaded){
    el('notesList').innerHTML = '<span class="loading-dot"></span>';
    try{
      notes = await fetchNotes();
      if(!notes.length) notes = await seedNotes();
      loaded = true;
    }catch(err){
      el('notesList').innerHTML = '<p class="notes-list-empty">Não foi possível carregar as notas.</p>';
      return;
    }
  }
  if(!currentId && !isNarrow() && notes.length) currentId = sorted(notes)[0].id;
  renderList();
  renderEditor();
  syncPanes();
}
