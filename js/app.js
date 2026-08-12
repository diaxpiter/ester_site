// ============================================================
//  APP — entry point: theme wiring, router, nav, and the client-vs-admin
//  bootstrap. Imports every feature module so this is the one place that
//  needs to know they all exist.
// ============================================================
import {
  onAuthStateChanged, signOut, signInWithEmailAndPassword
} from "https://www.gstatic.com/firebasejs/10.12.2/firebase-auth.js";
import {
  auth, ADMIN_EMAIL, show, msg, toggleTheme, enhanceDateField
} from './core.js';
import { loadAdminList } from './admin-clients.js';
import { loadLeads } from './admin-leads.js';
import { loadFinance } from './admin-finance.js';
import { loadDebts } from './admin-debts-agenda.js';
import { loadClientDashboard } from './client-dashboard.js';

// ============================================================
//  LIGHT/DARK THEME toggle click
// ============================================================
document.getElementById('themeToggle').addEventListener('click', () => {
  toggleTheme();
});

// Enhance the static date fields once (dynamic payment dates are enhanced on render).
['adminContractStart','adminDeliveryDate','finDate','finFilterFrom','finFilterTo'].forEach(id => {
  const el = document.getElementById(id);
  if(el) enhanceDateField(el);
});

// Remember the current top-level admin view in the URL hash, so a page refresh
// stays put (Clientes / A receber / Financeiro) instead of falling back to the list.
function routeAdmin(){
  const h = (location.hash || '').replace('#', '');
  if(h === 'financeiro') loadFinance();
  else if(h === 'a-receber') loadDebts();
  else if(h === 'leads') loadLeads();
  else loadAdminList(); // default landing page (fresh login, 'clientes', or any unknown hash)
  setSubnavActive(h);
}

// ============================================================
//  ADMIN: sub-nav tabs — "Clientes/Leads" and "Financeiro/A receber" are
// grouped behind one top-level nav entry each (see renderAdminNav below) and
// switch via an in-page pill pair instead, so the main menu stays at 4 items
// instead of 6. Both tab-bar instances (one per paired view) share this one
// click handler, keyed by data-subnav-group so clicking either pair's button
// updates every copy of that group's active state across the DOM.
// ============================================================
function setSubnavActive(hash){
  const key = hash === 'leads' ? 'leads' : hash === 'a-receber' ? 'a-receber'
    : hash === 'financeiro' ? 'financeiro' : hash === 'clientes' ? 'clientes' : '';
  if(!key) return;
  document.querySelectorAll('.subnav-tab').forEach(b => b.classList.toggle('is-active', b.dataset.subnav === key));
}
document.addEventListener('click', (e) => {
  const tab = e.target.closest('.subnav-tab');
  if(!tab) return;
  const target = tab.dataset.subnav;
  if(target === 'clientes') loadAdminList();
  else if(target === 'leads') loadLeads();
  else if(target === 'financeiro') loadFinance();
  else if(target === 'a-receber') loadDebts();
  setSubnavActive(target);
});

const navDynamic = document.getElementById('navDynamic');
function renderClientNav(){
  navDynamic.innerHTML = '';
}
function renderAdminNav(){
  // Only 2 top-level destinations — "Leads" lives inside Clientes and "A
  // receber" lives inside Financeiro, each reachable via the in-page
  // subnav-tab pair on those views (see setSubnavActive above). Clientes is
  // also the default landing page (see routeAdmin above).
  navDynamic.innerHTML = `
    <button id="navHamburger" class="nav-hamburger" aria-label="Abrir menu" aria-expanded="false"><span></span><span></span><span></span></button>
    <div class="nav-menu" id="navMenu">
      <a href="#" id="navClientsLink">Clientes</a>
      <a href="#" id="navFinanceLink">Financeiro</a>
    </div>
  `;
  const menu = document.getElementById('navMenu');
  const burger = document.getElementById('navHamburger');
  const closeMenu = () => {
    menu.classList.remove('open');
    burger.classList.remove('is-open');
    burger.setAttribute('aria-expanded', 'false');
  };
  burger.addEventListener('click', (e) => {
    e.stopPropagation();
    const open = menu.classList.toggle('open');
    burger.classList.toggle('is-open', open);
    burger.setAttribute('aria-expanded', open ? 'true' : 'false');
  });
  // Tap anywhere outside the open dropdown closes it.
  document.addEventListener('click', (e) => {
    if(menu.classList.contains('open') && !menu.contains(e.target) && e.target !== burger) closeMenu();
  });
  document.getElementById('navClientsLink').addEventListener('click', (e) => { e.preventDefault(); closeMenu(); loadAdminList(); });
  document.getElementById('navFinanceLink').addEventListener('click', (e) => { e.preventDefault(); closeMenu(); loadFinance(); });
}

// ============================================================
//  ADMIN LOGIN
// ============================================================
document.getElementById('loginForm').addEventListener('submit', async (e) => {
  e.preventDefault();
  const email = document.getElementById('loginEmail').value;
  const password = document.getElementById('loginPassword').value;
  const msgEl = document.getElementById('loginMsg');
  try{
    await signInWithEmailAndPassword(auth, email, password);
  }catch(err){
    msg(msgEl, "Não foi possível entrar — verifique seu email e senha.", "error");
  }
});

// ============================================================
//  ROUTER — decide client mode vs admin mode from the URL
// ============================================================
const params = new URLSearchParams(location.search);
// Installed as an app (home-screen icon), the launch URL can lose the "?c=" query.
// So: remember the client id whenever we see one, and — ONLY when running as an
// installed app — fall back to the stored id. In a normal browser tab we never
// fall back, so the admin's plain /portal bookmark still reaches the admin login.
const isStandalone = window.matchMedia('(display-mode: standalone)').matches || window.navigator.standalone === true;
let linkClientId = params.get('c');
if(linkClientId){
  try{ localStorage.setItem('esterClientId', linkClientId); }catch(e){}
} else if(isStandalone){
  try{ linkClientId = localStorage.getItem('esterClientId'); }catch(e){}
}

// Per-context PWA identity. The client area (?c=) and the admin area are the SAME
// file, distinguished by the presence of a client id.
try{
  const isClient = !!linkClientId;

  // iOS reads the apple-touch-icon from the DOM at "Add to Home Screen" time —
  // set the per-context one so each gets its own home-screen icon.
  // (A client with a custom uploaded icon overrides this later in renderClientDashboard.)
  const appleIcon = document.getElementById('appleIcon');
  if(appleIcon) appleIcon.href = isClient ? 'images/icons/icone_portal.png' : 'images/icons/icone_admin.png';

  // Launch URL: the CLIENT must keep its ?c= hash. iOS honors a manifest's
  // start_url (16.4+), and Safari pre-fetches any static <link rel="manifest">
  // during parse — so even removing it later leaves the launch URL pinned to the
  // hashless start_url. Fix: NEVER put a manifest in the static HTML. Add it via
  // JS for ADMIN only (start_url portal.html is correct there, and it keeps the
  // page installable on Android). Client gets NO manifest → iOS uses the CURRENT
  // url (with ?c=) as the home-screen launch url.
  if(!isClient){
    const m = document.createElement('link');
    m.rel = 'manifest';
    m.href = 'manifest.webmanifest';
    document.head.appendChild(m);
  }
}catch(e){}

// Register the PWA service worker so the portal is installable ("Add to Home Screen").
if('serviceWorker' in navigator){
  window.addEventListener('load', () => { navigator.serviceWorker.register('sw.js').catch(() => {}); });
}

if(linkClientId){
  // -------- CLIENT MODE (magic link, no auth) --------
  renderClientNav();
  loadClientDashboard(linkClientId);
} else {
  // -------- ADMIN MODE (Firebase auth) --------
  onAuthStateChanged(auth, (user) => {
    if(!user){
      renderClientNav();
      show('view-admin-auth');
      return;
    }
    if(user.email !== ADMIN_EMAIL){
      // Not the admin — don't leave a stray session around.
      signOut(auth);
      return;
    }
    renderAdminNav();
    routeAdmin();     // restore the last view (Clientes / A receber / Financeiro) on refresh
  });
}
