(function(){
  'use strict';

  const STORAGE_KEYS = {
    tasks: 'cf_tasks',
    notes: 'cf_notes',
    seq: 'cf_seq'
  };

  const STATUS = {
    pending: 'pending',
    completed: 'completed',
    rejected: 'rejected',
  };

  const state = {
    currentTab: 'to-me',
    sort: { key: 'dueDate', dir: 'asc' },
    filters: {},
    isAdmin: false,
    meLoaded: false,
    currentSubmitted: false
  };
  let settingsLoadVersion = 0;

  const el = id => document.getElementById(id);
  const qs = (sel, root=document) => root.querySelector(sel);
  const qsa = (sel, root=document) => Array.from(root.querySelectorAll(sel));

  // Simple API client
  const api = {
    token: null,
    async init(){
      // get token from sessionStorage
      this.token = sessionStorage.getItem('cf_token');
      // no auto-login: if no token, show login immediately
      if(!this.token){ showLogin(); return; }
      await this.loadMeta();
      render();
    },
    meta: { categories:[], companies:[], people:[] },
    async loadMeta(){
      if(!this.token) return;
      const r = await fetch('/api/meta', { headers: { Authorization: `Bearer ${this.token}` } });
      if(r.ok){ this.meta = await r.json(); seedFromMeta(this.meta); }
    },
    async list(role){
      const url = new URL('/api/tasks', location.origin);
      const f = { ...state.filters };
      // map category/company names to ids
      if(f.category){ const c = (this.meta.categories||[]).find(x=>x.name===f.category); if(c){ url.searchParams.set('category_id', String(c.id)); } }
      if(f.company){ const c = (this.meta.companies||[]).find(x=>x.name===f.company); if(c){ url.searchParams.set('company_id', String(c.id)); } }
      if(f.title){ url.searchParams.set('title', f.title); }
      if(f.assignee){ url.searchParams.set('assignee', f.assignee); }
      if(f.from){ url.searchParams.set('from', f.from); }
      if(f.to){ url.searchParams.set('to', f.to); }
      if(f.status){ url.searchParams.set('status', f.status); }
      if(role) url.searchParams.set('role', role);
      url.searchParams.set('sort', state.sort.key === 'dueDate' ? 'due_date' : state.sort.key);
      url.searchParams.set('dir', state.sort.dir);
      const r = await fetch(url, { headers: { Authorization: `Bearer ${this.token}` } });
      if(!r.ok) return { list: [] };
      return await r.json();
    },
    async me(){ const r = await fetch('/api/me', { headers:{ Authorization:`Bearer ${this.token}` } }); return r.ok? r.json(): { permissions:{} }; },
    setToken(tok){ this.token = tok; sessionStorage.setItem('cf_token', tok); try{ localStorage.setItem('cf_token', tok); }catch(_e){} },
    async get(id){ const r = await fetch(`/api/tasks/${id}`, { headers:{ Authorization:`Bearer ${this.token}` } }); return r.ok? r.json(): null; },
    async create(formData){ const r = await fetch('/api/tasks', { method:'POST', headers:{ Authorization:`Bearer ${this.token}` }, body: formData }); return r.ok? r.json(): null; },
    async update(id, formData){ const r = await fetch(`/api/tasks/${id}`, { method:'PUT', headers:{ Authorization:`Bearer ${this.token}` }, body: formData }); return r.ok; },
    async setStatus(id, status){ const r = await fetch(`/api/tasks/${id}/status`, { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${this.token}` }, body: JSON.stringify({ status }) }); return r.ok; },
    async notes(id){ const r = await fetch(`/api/tasks/${id}/notes`, { headers:{ Authorization:`Bearer ${this.token}` } }); return r.ok? r.json(): {notes: []}; },
    async addNote(id, fd){ const r = await fetch(`/api/tasks/${id}/notes`, { method:'POST', headers:{ Authorization:`Bearer ${this.token}` }, body: fd }); return r.ok; },
    async deleteAttachment(attId){ const r = await fetch(`/api/attachments/${attId}`, { method:'DELETE', headers:{ Authorization:`Bearer ${this.token}` } }); return r.ok; },
    async requestEdit(id){ const r = await fetch(`/api/tasks/${id}/request_edit`, { method:'POST', headers:{ Authorization:`Bearer ${this.token}` } }); return r.ok; }
  };

  function init(){
    // header
    el('year').textContent = new Date().getFullYear();
    const menuToggle = el('menuToggle');
    menuToggle.addEventListener('click', () => {
      const sidebar = el('sidebar');
      const open = !sidebar.classList.contains('open');
      sidebar.classList.toggle('open', open);
      menuToggle.setAttribute('aria-expanded', String(open));
    });

    // Auth/UI header
    // support persistent login: hydrate sessionStorage from localStorage token
    let token = sessionStorage.getItem('cf_token');
    if(!token){ try{ const lt = localStorage.getItem('cf_token'); if(lt){ sessionStorage.setItem('cf_token', lt); token = lt; } }catch(_e){} }
    const cu = document.getElementById('currentUser');
    const lb = document.getElementById('loginBtn');
    const lob = document.getElementById('logoutBtn');
    const soo = null;
    if(token){
      fetch('/api/me', { headers:{ Authorization:`Bearer ${token}` } }).then(r=>r.json()).then(me => {
        cu.textContent = me.user ? `${me.user.name} (${me.user.role})` : '';
        lb.style.display='none'; lob.style.display='inline-block';
        
        state.isAdmin = (me.user && (me.user.role==='superadmin' || me.user.role==='admin'));
        const isSuperAdmin = (me.user && me.user.role==='superadmin');
        const stdLink = document.querySelector('.menu a[href="#/standards"]'); if(stdLink) stdLink.parentElement.style.display = state.isAdmin? '' : 'none';
        const setLink = document.querySelector('.menu a[href="#/settings"]'); if(setLink) setLink.parentElement.style.display = state.isAdmin? '' : 'none';
        const expLink = document.querySelector('.menu a[href="#/export"]'); if(expLink) expLink.parentElement.style.display = state.isAdmin? '' : 'none';
        const impLink = document.querySelector('.menu a[href="#/import"]'); if(impLink) impLink.parentElement.style.display = state.isAdmin? '' : 'none';
        const addBtnTop = el('addTaskBtn'); if(addBtnTop) addBtnTop.style.display = state.isAdmin? '' : 'none';
        state.meLoaded = true; onHashChange();
      }).catch(()=>{ state.meLoaded = true; onHashChange(); });
    }else{
      cu.textContent = '';
      lb.style.display='inline-block'; lob.style.display='none';
      
      state.isAdmin = false; state.meLoaded = true;
      const stdLink = document.querySelector('.menu a[href="#/standards"]'); if(stdLink) stdLink.parentElement.style.display = 'none';
      const setLink = document.querySelector('.menu a[href="#/settings"]'); if(setLink) setLink.parentElement.style.display = 'none';
      const expLink = document.querySelector('.menu a[href="#/export"]'); if(expLink) expLink.parentElement.style.display = 'none';
      const impLink = document.querySelector('.menu a[href="#/import"]'); if(impLink) impLink.parentElement.style.display = 'none';
      const addBtnTop = el('addTaskBtn'); if(addBtnTop) addBtnTop.style.display = 'none';
    }
    lb.addEventListener('click', ()=>{ location.hash = '#/login'; showLogin(); });
    lob.addEventListener('click', ()=>{
      sessionStorage.removeItem('cf_token');
      try{ localStorage.removeItem('cf_token'); }catch(_e){}
      try{ localStorage.removeItem('cf_last_route'); }catch(_e){}
      location.hash = '#/login';
      showLogin();
    });

    // API init
    api.init();
    

    // search panel
    el('toggleSearch').addEventListener('click', () => {
      const p = el('searchPanel');
      const newHidden = !p.hasAttribute('hidden') ? true : false;
      if(newHidden) p.setAttribute('hidden', ''); else p.removeAttribute('hidden');
      el('toggleSearch').setAttribute('aria-expanded', String(!newHidden));
    });
    el('searchForm').addEventListener('submit', onSearch);
    el('resetFilters').addEventListener('click', () => { state.filters = {}; render(); });

    // tabs
    el('tabForMe').addEventListener('click', () => { try{ localStorage.setItem('cf_tasks_tab','to-me'); }catch(_e){} location.hash = '#/tasks?tab=to'; });
    el('tabByMe').addEventListener('click', () => { try{ localStorage.setItem('cf_tasks_tab','by-me'); }catch(_e){} location.hash = '#/tasks?tab=by'; });
    // settings sub-tabs
    const setTab = (id) => {
      ['Categories','Companies','Users','ReminderPolicies'].forEach(name => {
        el('tab'+name).setAttribute('aria-selected', String(name===id));
        el('panel'+name).hidden = name!==id;
      });
      if(id==='ReminderPolicies') loadReminderPolicies();
    };
    ['Categories','Companies','Users','ReminderPolicies'].forEach(name => el('tab'+name).addEventListener('click', ()=> setTab(name)));

    // column sort
    qsa('.th-sort').forEach(btn => btn.addEventListener('click', () => onSort(btn.dataset.sort)));

    // add/edit form
    el('addTaskBtn').addEventListener('click', () => { if(!state.isAdmin){ toast('Admin only'); return; } openEditor(); });
    el('backToList').addEventListener('click', () => showList());
    el('fCategory').addEventListener('change', onInlineAddCategory);
    el('fCompany').addEventListener('change', onInlineAddCompany);
    // sidebar nav routing
    qsa('.menu a').forEach(a => a.addEventListener('click', (e)=>{
      const href = e.currentTarget.getAttribute('href')||'';
      if(href.startsWith('#/')){ e.preventDefault();
        qsa('.menu a').forEach(x=> x.classList.remove('active'));
        e.currentTarget.classList.add('active');
        location.hash = href; onHashChange(); }
    }));

    // export/import/settings actions
    const hideAllPanels = ()=>{ ['panelExport','panelImport','panelSettings','panelStandards','panelForgot','panelReset','panelDashboard'].forEach(id=> el(id).hidden=true); };
    const backToHome = ()=>{ hideAllPanels(); showList(); };
    el('exportCsv').addEventListener('click', onExportCsv);
    const xf = document.getElementById('exportFilters');
    if(xf && !xf._bound){
      // hydrate selects from meta
      const seedExport = ()=>{
        const meta = api.meta||{categories:[], companies:[], people:[]};
        const xCategory = document.getElementById('xCategory'); if(xCategory){ xCategory.innerHTML='<option value="">Any</option>'; (meta.categories||[]).forEach(c=>{ const o=document.createElement('option'); o.value=String(c.id); o.textContent=c.name; xCategory.appendChild(o); }); }
        const xCompany = document.getElementById('xCompany'); if(xCompany){ xCompany.innerHTML='<option value="">Any</option>'; (meta.companies||[]).forEach(c=>{ const o=document.createElement('option'); o.value=String(c.id); o.textContent=c.name; xCompany.appendChild(o); }); }
        const xMaker = document.getElementById('xMaker'); if(xMaker){ xMaker.innerHTML='<option value="">Any</option>'; (meta.people||[]).forEach(p=>{ const o=document.createElement('option'); o.value=p; o.textContent=p||'Any'; xMaker.appendChild(o); }); }
      };
      if(sessionStorage.getItem('cf_token')){ seedExport(); }
      xf.addEventListener('change', ()=>{
        state.filters = {
          title: (document.getElementById('xTitle')||{value:''}).value.trim(),
          assignee: (document.getElementById('xMaker')||{value:''}).value,
          category_id: (document.getElementById('xCategory')||{value:''}).value,
          company_id: (document.getElementById('xCompany')||{value:''}).value,
          status: (document.getElementById('xStatus')||{value:''}).value,
          from: (document.getElementById('xFrom')||{value:''}).value,
          to: (document.getElementById('xTo')||{value:''}).value,
        };
      });
      xf.addEventListener('reset', ()=>{ state.filters = {}; });
      xf._bound = true;
    }
    el('backFromExport').addEventListener('click', backToHome);
    el('backFromImport').addEventListener('click', backToHome);
    const backFromDashboard = el('backFromDashboard'); if(backFromDashboard) backFromDashboard.addEventListener('click', backToHome);
    const tmplBtn = document.getElementById('downloadImportTemplate');
    if(tmplBtn){ tmplBtn.addEventListener('click', async ()=>{
      if(!sessionStorage.getItem('cf_token')) return toast('Login required');
      const url = `/api/tasks/import/template?token=${encodeURIComponent(sessionStorage.getItem('cf_token')||'')}`;
      const a = document.createElement('a'); a.href = url; a.download = 'compliances_import_template.csv'; document.body.appendChild(a); a.click(); a.remove();
    }); }
    el('backFromSettings').addEventListener('click', backToHome);
    const backFromStandards = el('backFromStandards'); if(backFromStandards) backFromStandards.addEventListener('click', backToHome);
    const backFromForgot = el('backFromForgot'); if(backFromForgot) backFromForgot.addEventListener('click', ()=>{ location.hash = '#/login'; showLogin(); });
    const backFromReset = el('backFromReset'); if(backFromReset) backFromReset.addEventListener('click', ()=>{ location.hash = '#/login'; showLogin(); });
    // forgot/reset handlers
    const ff = document.getElementById('forgotForm');
    if(ff && !ff._bound){
      ff.addEventListener('submit', async (e)=>{
        e.preventDefault();
        const emailEl = document.getElementById('forgotEmail');
        const email = emailEl ? emailEl.value.trim() : '';
        if(!email) return toast('Email required');
        const submitBtn = ff.querySelector('button[type="submit"]');
        const msgEl = document.getElementById('forgotMsg'); if(msgEl){ msgEl.style.display='none'; msgEl.textContent=''; }
        if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Sending…'; }
        try{ await fetch('/api/auth/forgot', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email }) }); }
        catch(_e){}
        const msg = 'If the email exists, a reset link has been sent.';
        toast(msg);
        if(msgEl){ msgEl.className='alert'; msgEl.style.display='block'; msgEl.textContent = msg; }
        if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Send reset link'; }
      });
      ff._bound = true;
    }
    const rf = document.getElementById('resetForm');
    if(rf && !rf._bound){
      rf.addEventListener('submit', async (e)=>{
        e.preventDefault();
        const pwdEl = document.getElementById('resetPassword');
        const password = pwdEl ? pwdEl.value : '';
        if(!password) return toast('Password required');
        const token = (location.hash.split('/')[2]||'');
        const submitBtn = rf.querySelector('button[type="submit"]');
        if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Updating…'; }
        let ok=false; let err='';
        try{ const r = await fetch('/api/auth/reset', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ token, password }) }); ok = r.ok; if(!ok){ const j = await r.json().catch(()=>({})); err = j.error||'Reset failed'; } }
        catch(_e){ err='Network error'; }
        if(ok){ toast('Password updated'); location.hash='#/login'; showLogin(); }
        else { toast(err); }
        if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Update password'; }
      });
      rf._bound = true;
    }
    el('importForm').addEventListener('submit', onImportCsv);
    el('catForm').addEventListener('submit', onAddCategory);
    el('compForm').addEventListener('submit', onAddCompany);
    // Robust submit interception for Add User even if the form is re-rendered
    document.addEventListener('submit', (ev)=>{
      const t = ev.target;
      if(t && t.id === 'userForm'){
        // Prevent default navigation and stop bubbling so no other handlers double-handle
        ev.preventDefault();
        ev.stopPropagation();
        onAddUser(ev);
        return false;
      }
    }, true);
    el('taskForm').addEventListener('submit', onSaveTask);
    el('fFiles').addEventListener('change', handleFileSelection);
    const dueNA = el('fDueNA');
    if(dueNA){
      dueNA.addEventListener('change', ()=>{
        const isNA = dueNA.checked;
        const inlineNa = qs('label.inline-na'); if(inlineNa) inlineNa.classList.toggle('na-selected', isNA);
        const date = el('fDue'); if(date){ date.disabled = isNA; if(isNA){ date.value=''; } }
      });
    }
    const dfcSel = el('fDisplayedFc'); if(dfcSel){
      dfcSel.addEventListener('change', ()=>{
        const wrap = el('fcImageWrap'); if(wrap) wrap.style.display = (dfcSel.value==='Yes') ? '' : 'none';
      });
    }
    // CC users removed
    el('markCompleted').addEventListener('click', onMarkCompleted);
    el('markAborted').addEventListener('click', onMarkRejected);
    el('reopenPending').addEventListener('click', onReopen);
    const delBtn = document.getElementById('deleteTask'); if(delBtn) delBtn.addEventListener('click', onDeleteTask);

    // notes
    el('noteForm').addEventListener('submit', onAddNote);

    // routing hash with route persistence
    window.addEventListener('hashchange', ()=>{
      const h = location.hash || '';
      if(!(h.startsWith('#/login') || h.startsWith('#/forgot') || h.startsWith('#/reset'))){
        try{ localStorage.setItem('cf_last_route', h); }catch(_e){}
      }
      onHashChange();
    });
    // restore last route only if no hash provided explicitly
    try{
      const saved = localStorage.getItem('cf_last_route') || '';
      const initHash = location.hash || '';
      if(sessionStorage.getItem('cf_token') && saved && saved !== '#/login' && !initHash){
        location.hash = saved;
      }
    }catch(_e){}
    onHashChange();
  }

  function ensureSeedData(){
    if(!localStorage.getItem(STORAGE_KEYS.seq)) localStorage.setItem(STORAGE_KEYS.seq, '1');
    if(!localStorage.getItem(STORAGE_KEYS.tasks)){
      const now = new Date();
      const sample = [
        makeTask({title:'Renew trade license', category:'Licenses', company:'Acme Ltd', assignee:'Me', assignedBy:'Manager', dueDate:addDays(now,3), status:STATUS.pending}),
        makeTask({title:'File TDS Q2', category:'TDS', company:'Acme Ltd', assignee:'Me', assignedBy:'CFO', dueDate:addDays(now,10), status:STATUS.pending}),
      ];
      localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(sample));
    }
    if(!localStorage.getItem(STORAGE_KEYS.notes)){
      localStorage.setItem(STORAGE_KEYS.notes, JSON.stringify({}));
    }
  }

  function makeTask(partial){
    const id = Number(localStorage.getItem(STORAGE_KEYS.seq) || '1');
    localStorage.setItem(STORAGE_KEYS.seq, String(id + 1));
    return {
      id,
      title: '',
      description: '',
      category: '',
      company: '',
      assignee: 'Me',
      assignedBy: 'Me',
      dueDate: new Date().toISOString().slice(0,10),
      repeat: { frequency: null },
      reminderDays: '',
      status: STATUS.pending,
      attachments: [], // {name,size,type,dataUrl}
      createdAt: new Date().toISOString(),
      ...partial
    };
  }

  function seedFromMeta(meta){
    const people = meta.people;
    // Filters remain with names
    const categoriesNames = (meta.categories||[]).map(c=>c.name);
    const companiesNames = (meta.companies||[]).map(c=>c.name);
    fillOptions(el('qCategory'), [''].concat(categoriesNames));
    fillOptions(el('qCompany'), [''].concat(companiesNames));
    fillOptions(el('qAssignee'), [''].concat(people));
    // Form selects use ids for reliability
    const fCat = el('fCategory'); if(fCat){ fCat.innerHTML=''; (meta.categories||[]).forEach(c=>{ const opt=document.createElement('option'); opt.value=String(c.id); opt.textContent=c.name; fCat.appendChild(opt); }); const add=document.createElement('option'); add.value='__ADD__'; add.textContent='+ Add new…'; fCat.appendChild(add); }
    const fCom = el('fCompany'); if(fCom){ fCom.innerHTML=''; (meta.companies||[]).forEach(c=>{ const opt=document.createElement('option'); opt.value=String(c.id); opt.textContent=c.name; fCom.appendChild(opt); }); const add=document.createElement('option'); add.value='__ADD__'; add.textContent='+ Add new…'; fCom.appendChild(add); }
    // Maker/Checker people lists
    fillOptions(el('fMaker'), people);
    fillOptions(el('fChecker'), people.filter(p => p));
    const sCat = el('stdCategory'); if(sCat){ sCat.innerHTML=''; (meta.categories||[]).forEach(c=>{ const opt=document.createElement('option'); opt.value=String(c.id); opt.textContent=c.name; sCat.appendChild(opt); }); }
    const sCom = el('stdApplyCompany'); if(sCom){ sCom.innerHTML=''; (meta.companies||[]).forEach(c=>{ const opt=document.createElement('option'); opt.value=String(c.id); opt.textContent=c.name; sCom.appendChild(opt); }); }
    // dashboard selects
    const dCat = el('dCategory'); if(dCat){ dCat.innerHTML = '<option value="">Any</option>'; (meta.categories||[]).forEach(c=>{ const o=document.createElement('option'); o.value=String(c.id); o.textContent=c.name; dCat.appendChild(o); }); }
    const dCom = el('dCompany'); if(dCom){ dCom.innerHTML = '<option value="">Any</option>'; (meta.companies||[]).forEach(c=>{ const o=document.createElement('option'); o.value=String(c.id); o.textContent=c.name; dCom.appendChild(o); }); }
    const dAss = el('dAssignee'); if(dAss){ dAss.innerHTML = '<option value="">Any</option>'; (people||[]).forEach(p=>{ const o=document.createElement('option'); o.value=p; o.textContent=p||'Any'; dAss.appendChild(o); }); }
    // export filters (populate if present)
    const xCategory = el('xCategory'); if(xCategory){ xCategory.innerHTML = '<option value="">Any</option>'; (meta.categories||[]).forEach(c=>{ const o=document.createElement('option'); o.value=String(c.id); o.textContent=c.name; xCategory.appendChild(o); }); }
    const xCompany = el('xCompany'); if(xCompany){ xCompany.innerHTML = '<option value="">Any</option>'; (meta.companies||[]).forEach(c=>{ const o=document.createElement('option'); o.value=String(c.id); o.textContent=c.name; xCompany.appendChild(o); }); }
    const xMaker = el('xMaker'); if(xMaker){ xMaker.innerHTML = '<option value="">Any</option>'; (people||[]).forEach(p=>{ const o=document.createElement('option'); o.value=p; o.textContent=p||'Any'; xMaker.appendChild(o); }); }
  }

  function fillOptions(select, items){
    select.innerHTML = '';
    items.forEach(v => {
      const opt = document.createElement('option');
      opt.value = v;
      opt.textContent = v || 'Any';
      select.appendChild(opt);
    });
  }

  async function onHashChange(){
    const h = location.hash.replace(/^#/, '');
    // wait for auth state if logged in
    if(sessionStorage.getItem('cf_token') && !state.meLoaded){ return; }
    // Public routes: allow forgot/reset without token
    if(h.startsWith('/forgot')){ document.body.classList.add('auth'); qsa('.card').forEach(c=> c.hidden=true); el('panelForgot').hidden=false; return; }
    if(h.startsWith('/reset/')){ document.body.classList.add('auth'); qsa('.card').forEach(c=> c.hidden=true); el('panelReset').hidden=false; return; }
    // Handle explicit login route
    if(h.startsWith('/login')){
      if(sessionStorage.getItem('cf_token')){
        try{
          const saved = localStorage.getItem('cf_last_route') || '';
          if(saved && !saved.startsWith('#/login') && !saved.startsWith('#/forgot') && !saved.startsWith('#/reset')){ location.hash = saved; }
          else { location.hash = '#/tasks'; }
        }catch(_e){ location.hash = '#/tasks'; }
        return;
      }
      return showLogin();
    }
    if(!sessionStorage.getItem('cf_token')){ return showLogin(); }
    document.body.classList.remove('auth');
    if(h.startsWith('/settings') && !state.isAdmin){ toast('Admin only'); return showList(); }
    if(h.startsWith('/standards') && !state.isAdmin){ toast('Admin only'); return showList(); }
    if(h.startsWith('/dashboard')){ return showDashboard(); }
    if(h.startsWith('/add')) return openEditor();
    if(h.startsWith('/edit/')){
      const id = Number(h.split('/')[2]);
      return openEditor(id);
    }
    const panels = ['panelExport','panelImport','panelSettings','panelStandards','panelDashboard'];
    // hide all main content cards (list, editor, others)
    qsa('.card').forEach(c=>{ c.hidden=true; });
    panels.forEach(id => { const e = el(id); if(e) e.hidden = true; });
    // tasks route with inner tab persistence
    if(h.startsWith('/tasks')){
      // show list but do not force hash; determine tab from query or storage
      showList(); setActiveMenu('#/tasks');
      const q = h.split('?')[1]||''; const qs = new URLSearchParams(q);
      const tabParam = qs.get('tab');
      let tab = 'to-me';
      if(tabParam === 'by') tab = 'by-me';
      else if(tabParam === 'to') tab = 'to-me';
      else { try{ tab = localStorage.getItem('cf_tasks_tab') || 'to-me'; }catch(_e){} }
      switchTab(tab);
      return;
    }
    if(h.startsWith('/export')){ if(!(state.isAdmin)){ toast('Admin only'); return showList(); } el('panelExport').hidden=false; setActiveMenu('#/export'); return; }
    if(h.startsWith('/import')){ if(!(state.isAdmin)){ toast('Admin only'); return showList(); } el('panelImport').hidden=false; setActiveMenu('#/import'); return; }
    if(h.startsWith('/settings')){ if(!(state.isAdmin)){ toast('Admin only'); return showList(); } el('panelSettings').hidden=false; loadSettings(); setActiveMenu('#/settings'); return; }
    if(h.startsWith('/standards')){ if(!(state.isAdmin)){ toast('Admin only'); return showList(); } el('panelStandards').hidden=false; loadStandards(); setActiveMenu('#/standards'); return; }
    if(!h || h==='/tasks'){ showList(); setActiveMenu('#/tasks'); return; }
  }

  function setActiveMenu(hash){
    qsa('.menu a').forEach(a => a.classList.toggle('active', a.getAttribute('href')===hash));
  }

  // Standards UI
  async function loadStandards(){
    if(!sessionStorage.getItem('cf_token')) return;
    const contentEl = document.querySelector('.content');
    contentEl?.classList.add('page-scroll');
    contentEl?.classList.remove('editor-open');
    const me = await api.me(); const isAdmin = !!(me.user && (me.user.role==='admin' || me.user.role==='superadmin'));
    const wrap = el('panelStandards'); if(!wrap) return;
    if(!isAdmin){ const tw=wrap.querySelector('.table-wrap'); if(tw) tw.innerHTML = '<div style="padding:12px">Admin only</div>'; return; }
    const r = await fetch('/api/standards', { headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } });
    const d = r.ok ? await r.json() : { standards: [] };
    const list = el('stdList'); if(list){ list.innerHTML='';
      (d.standards||[]).forEach(s => {
        const tr=document.createElement('tr');
        const rep = s.repeat_json ? JSON.parse(s.repeat_json) : {frequency:null};
        const freq = String((rep&&rep.frequency)||'').toLowerCase();
        const freqLabel = freq=== 'daily' ? 'Daily' : freq==='weekly' ? 'Weekly' : freq==='monthly' ? 'Monthly' : freq==='quarterly' ? 'Quarterly' : freq==='half_yearly' ? 'Half-yearly' : freq==='annually' ? 'Annually' : '';
        const crit = String(s.criticality||'');
        const critLabel = crit ? crit.charAt(0).toUpperCase()+crit.slice(1).toLowerCase() : '';
        const disp = (s.displayed_fc==null || String(s.displayed_fc).toUpperCase()==='NA') ? 'NA' : String(s.displayed_fc);
        tr.innerHTML = `<td>${escapeHTML(s.title)}</td><td>${escapeHTML(s.category||'')}</td><td>${escapeHTML(freqLabel)}</td><td>${escapeHTML(critLabel)}</td><td>${s.relevant_fc? 'Yes':'No'}</td><td>${escapeHTML(disp)}</td><td><button class="btn" data-id="${s.id}">Delete</button></td>`;
        list.appendChild(tr);
      });
      // append inline add row inside the same table
      const addTr=document.createElement('tr');
      addTr.innerHTML = `
        <td><input id="stdTitle" type="text" placeholder="Title" required style="width:100%"></td>
        <td><select id="stdCategory" style="width:100%"></select></td>
        <td>
          <select id="stdRepeat" style="width:100%">
            <option value='{"frequency":null}'>Do not repeat</option>
            <option value='{"frequency":"daily"}'>Daily</option>
            <option value='{"frequency":"weekly"}'>Weekly</option>
            <option value='{"frequency":"monthly"}'>Monthly</option>
            <option value='{"frequency":"quarterly"}'>Quarterly</option>
            <option value='{"frequency":"half_yearly"}'>Half-yearly</option>
            <option value='{"frequency":"annually"}'>Annually</option>
          </select>
        </td>
        <td>
          <select id="stdCriticality" style="width:100%">
            <option value="high">High</option>
            <option value="medium" selected>Medium</option>
            <option value="low">Low</option>
          </select>
        </td>
        <td>
          <select id="stdRelevantFc" style="width:100%">
            <option value="No">No</option>
            <option value="Yes">Yes</option>
          </select>
        </td>
        <td>
          <select id="stdDisplayedFc" style="width:100%">
            <option value="NA" selected>NA</option>
            <option value="Yes">Yes</option>
            <option value="No">No</option>
          </select>
        </td>
        <td><button class="btn primary" id="stdAddBtn" type="button">Add</button></td>`;
      list.appendChild(addTr);
      // populate categories for inline select
      const sCat = el('stdCategory');
      if(sCat){
        sCat.innerHTML = '';
        const cats = (api.meta && api.meta.categories) ? api.meta.categories : [];
        cats.forEach(c => { const opt=document.createElement('option'); opt.value=String(c.id); opt.textContent=c.name; sCat.appendChild(opt); });
      }
      list.querySelectorAll('button[data-id]').forEach(b => b.addEventListener('click', async (e)=>{
        const id = e.currentTarget.getAttribute('data-id'); if(!confirm('Delete standard?')) return;
        const rr = await fetch(`/api/standards/${id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } });
        if(rr.ok) loadStandards(); else toast('Delete failed');
      }));
    }
    const itemsWrap = el('stdApplyItems'); if(itemsWrap){
      itemsWrap.innerHTML='';
      // header with select all
      const hdr=document.createElement('div'); hdr.className='grid'; hdr.style.gridTemplateColumns='auto 1fr 1fr 1fr 1fr'; hdr.style.gap='8px';
      hdr.innerHTML = `<div><label class="na-toggle"><input type="checkbox" id="stdSelectAll" checked> <span>Select all</span></label></div>
        <div><strong>Compliance</strong></div>
        <div><strong>Maker</strong></div>
        <div><strong>Checker</strong></div>
        <div><strong>Due Date</strong></div>`;
      itemsWrap.appendChild(hdr);
      (d.standards||[]).forEach(s => {
        const row=document.createElement('div'); row.className='grid'; row.style.gridTemplateColumns='auto 1fr 1fr 1fr 1fr'; row.style.gap='8px';
        row.innerHTML = `<div><input type="checkbox" data-select data-sid="${s.id}" checked></div>
          <div>${escapeHTML(s.title)}</div>
          <div><label><span class="sr-only">Maker</span><select data-maker data-sid="${s.id}"></select></label></div>
          <div><label><span class="sr-only">Checker</span><select data-checker data-sid="${s.id}"></select></label></div>
          <div><label><span class="sr-only">Due Date</span><input type="date" data-due data-sid="${s.id}"></label></div>`;
        itemsWrap.appendChild(row);
        const makerSel = row.querySelector('[data-maker]');
        const checkerSel = row.querySelector('[data-checker]');
        if(makerSel){ fillOptions(makerSel, (api.meta.people||[])); makerSel.value = 'Me'; }
        if(checkerSel){ fillOptions(checkerSel, (api.meta.people||[]).filter(p => p)); checkerSel.value = 'Me'; }
      });
      const selectAll = document.getElementById('stdSelectAll');
      if(selectAll && !selectAll._bound){
        selectAll.addEventListener('change', ()=>{
          itemsWrap.querySelectorAll('[data-select]').forEach(cb => { cb.checked = selectAll.checked; });
        });
        selectAll._bound = true;
      }
    }
    // bind inline add button
    const addBtn = document.getElementById('stdAddBtn');
    if(addBtn && !addBtn._bound){
      addBtn.addEventListener('click', async ()=>{
        const title = el('stdTitle').value.trim();
        const category_id = el('stdCategory').value;
        const repeat_json = el('stdRepeat').value;
        const criticality = (document.getElementById('stdCriticality')||{value:''}).value;
        const relevant_fc = (document.getElementById('stdRelevantFc')||{value:'No'}).value;
        const displayed_fc = (document.getElementById('stdDisplayedFc')||{value:'NA'}).value;
        if(!title) return toast('Title required');
        const resp = await fetch('/api/standards', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ title, category_id, repeat_json, criticality, relevant_fc, displayed_fc }) });
        if(resp.ok){ el('stdTitle').value=''; loadStandards(); toast('Standard added'); } else { toast('Failed to add'); }
      });
      addBtn._bound = true;
    }
    // inline add-new for stdCategory
    const stdCatSel = el('stdCategory');
    if(stdCatSel && !stdCatSel._augmented){
      const cats = (api.meta && api.meta.categories) ? api.meta.categories : [];
      if(!Array.from(stdCatSel.options).some(o=> o.value==='__ADD__')){ const opt=document.createElement('option'); opt.value='__ADD__'; opt.textContent='+ Add new…'; stdCatSel.appendChild(opt); }
      stdCatSel.addEventListener('change', async ()=>{
        if(stdCatSel.value==='__ADD__'){
          const name = prompt('New category name');
          if(name && name.trim()){
            const r = await fetch('/api/categories', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ name: name.trim() }) });
            if(r.ok){ await api.loadMeta(); const cats2 = api.meta.categories||[]; stdCatSel.innerHTML=''; cats2.forEach(c=>{ const o=document.createElement('option'); o.value=String(c.id); o.textContent=c.name; stdCatSel.appendChild(o); }); const add=document.createElement('option'); add.value='__ADD__'; add.textContent='+ Add new…'; stdCatSel.appendChild(add); const created = cats2.find(c=> c.name===name.trim()); if(created){ stdCatSel.value=String(created.id); } toast('Category added'); }
            else { toast('Failed to add category'); stdCatSel.value=''; }
          } else { stdCatSel.value=''; }
        }
      });
      stdCatSel._augmented = true;
    }
    // add-new for stdApplyCompany
    const stdCompanySel = el('stdApplyCompany');
    if(stdCompanySel && !stdCompanySel._augmented){
      const ensureAdd = ()=>{ if(!Array.from(stdCompanySel.options).some(o=>o.value==='__ADD__')){ const opt=document.createElement('option'); opt.value='__ADD__'; opt.textContent='+ Add new…'; stdCompanySel.appendChild(opt); } };
      ensureAdd();
      stdCompanySel.addEventListener('change', async ()=>{
        if(stdCompanySel.value==='__ADD__'){
          const name = prompt('New location/site name');
          if(name && name.trim()){
            const r = await fetch('/api/companies', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ name: name.trim() }) });
            if(r.ok){ await api.loadMeta(); const comps2 = api.meta.companies||[]; stdCompanySel.innerHTML=''; comps2.forEach(c=>{ const o=document.createElement('option'); o.value=String(c.id); o.textContent=c.name; stdCompanySel.appendChild(o); }); ensureAdd(); const created = comps2.find(c=> c.name===name.trim()); if(created){ stdCompanySel.value=String(created.id); } toast('Location/Site added'); }
            else { toast('Failed to add location/site'); stdCompanySel.value=''; }
          } else { stdCompanySel.value=''; }
        }
      });
      stdCompanySel._augmented = true;
    }
    const af = el('stdApplyForm'); if(af && !af._bound){
      af.addEventListener('submit', async (e)=>{
        e.preventDefault();
        if(af._busy) return; af._busy = true;
        const company_id = el('stdApplyCompany').value;
        const defaultDue = el('stdApplyDueNA') && el('stdApplyDueNA').checked ? 'NA' : el('stdApplyDue').value;
        const selected = Array.from((el('stdApplyItems')||{querySelectorAll:()=>[]}).querySelectorAll('[data-select]')).filter(cb => cb.checked);
        const items = selected.map(cb => {
          const sid = cb.getAttribute('data-sid');
          const maker = ((el('stdApplyItems').querySelector(`[data-maker][data-sid="${sid}"]`)||{value:'Me'}).value||'Me');
          const checker = ((el('stdApplyItems').querySelector(`[data-checker][data-sid="${sid}"]`)||{value:''}).value||'');
          let due_date = ((el('stdApplyItems').querySelector(`[data-due][data-sid="${sid}"]`)||{value:''}).value||defaultDue||'');
          if(!due_date) due_date = 'NA';
          return { standard_id: Number(sid), maker, checker, due_date };
        });
        if(items.length===0){ af._busy=false; return toast('Select at least one compliance'); }
        const submitBtn = af.querySelector('button[type="submit"]');
        if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Creating…'; }
        try{
          const resp = await fetch('/api/standards/apply', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ company_id, items }) });
          if(resp.ok){ const j = await resp.json(); toast(`Created ${j.created} compliances`); showList(); }
          else { toast('Apply failed'); }
        }catch(_e){ toast('Apply failed'); }
        finally{ if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Apply Selected'; } af._busy=false; }
      });
      af._bound = true;
    }
    // Bind N/A UI for default due
    const stdDueNA = el('stdApplyDueNA');
    if(stdDueNA && !stdDueNA._bound){
      stdDueNA.addEventListener('change', ()=>{
        const isNA = stdDueNA.checked;
        const inlineNa = document.querySelector('#stdApplyForm label.inline-na');
        if(inlineNa) inlineNa.classList.toggle('na-selected', isNA);
        const date = el('stdApplyDue'); if(date){ date.disabled = isNA; if(isNA){ date.value=''; } }
      });
      stdDueNA._bound = true;
    }
  }

  function showLogin(){
    // gate everything behind login
    document.body.classList.add('auth');
    qsa('.card').forEach(c=> c.hidden = true);
    ;['panelExport','panelImport','panelSettings','panelStandards','panelForgot','panelReset','panelDashboard'].forEach(id=>{ const elx=document.getElementById(id); if(elx) elx.hidden=true; });
    el('panelLogin').hidden = false;
    // bind login form
    const lf = el('loginForm'); if(lf && !lf._bound){
      lf.addEventListener('submit', async (e)=>{
        e.preventDefault();
        const email = el('loginEmail').value.trim();
        const password = el('loginPassword').value;
        const errEl = document.getElementById('loginError'); if(errEl){ errEl.style.display='none'; errEl.textContent=''; }
        const btn = lf.querySelector('button[type="submit"]'); if(btn){ btn.disabled = true; btn.textContent = 'Signing in…'; }
        const r = await fetch('/api/auth/login', { method:'POST', headers:{'Content-Type':'application/json'}, body: JSON.stringify({ email, password })});
        if(r.ok){
          const d = await r.json();
          api.setToken(d.token);
          document.body.classList.remove('auth');
          // hydrate header/admin state immediately
          try{
            const meResp = await fetch('/api/me', { headers:{ Authorization:`Bearer ${api.token}` } });
            if(meResp.ok){
              const me = await meResp.json();
              const cu = document.getElementById('currentUser'); if(cu) cu.textContent = me.user ? `${me.user.name} (${me.user.role})` : '';
              const lb = document.getElementById('loginBtn'); const lob = document.getElementById('logoutBtn');
              if(lb) lb.style.display='none'; if(lob) lob.style.display='inline-block';
              state.isAdmin = (me.user && (me.user.role==='superadmin' || me.user.role==='admin'));
              const stdLink = document.querySelector('.menu a[href="#/standards"]'); if(stdLink) stdLink.parentElement.style.display = state.isAdmin? '' : 'none';
              const setLink = document.querySelector('.menu a[href="#/settings"]'); if(setLink) setLink.parentElement.style.display = state.isAdmin? '' : 'none';
              const expLink = document.querySelector('.menu a[href="#/export"]'); if(expLink) expLink.parentElement.style.display = state.isAdmin? '' : 'none';
              const impLink = document.querySelector('.menu a[href="#/import"]'); if(impLink) impLink.parentElement.style.display = state.isAdmin? '' : 'none';
              const addBtnTop = document.getElementById('addTaskBtn'); if(addBtnTop) addBtnTop.style.display = state.isAdmin? '' : 'none';
              state.meLoaded = true;
              try{ await api.loadMeta(); seedFromMeta(api.meta); }catch(_e){}
            } else { state.meLoaded = true; }
          }catch(_e){ state.meLoaded = true; }
          // navigate to last non-auth route if any; else tasks
          try{
            const saved = localStorage.getItem('cf_last_route') || '';
            if(saved && !saved.startsWith('#/login') && !saved.startsWith('#/forgot') && !saved.startsWith('#/reset')){
              location.hash = saved;
            } else {
              location.hash = '#/tasks';
            }
          }catch(_e){ location.hash = '#/tasks'; }
          onHashChange();
        }
        else {
          const j = await r.json().catch(()=>({}));
          if(errEl){ errEl.className='alert'; errEl.style.display='block'; errEl.textContent = j.error==='invalid_credentials'? 'Wrong email or password.' : 'Login failed.'; }
          toast('Invalid login');
        }
        if(btn){ btn.disabled = false; btn.textContent = 'Sign in'; }
      });
      lf._bound = true;
      // forgot link
      let forgot = document.getElementById('forgotLink');
      if(!forgot){ forgot = document.createElement('a'); forgot.id='forgotLink'; forgot.href='#/forgot'; forgot.textContent='Forgot password?'; forgot.style.marginLeft='8px'; lf.appendChild(forgot); }
    }
  }

  async function showList(){
    qs('#editor').hidden = true;
    const contentEl = document.querySelector('.content');
    contentEl?.classList.remove('editor-open');
    contentEl?.classList.remove('page-scroll');
    const listCard = qsa('.card')[0];
    listCard.hidden = false;
    // do not force the hash here; router controls it
    await render();
  }

  async function openEditor(id){
    const listCard = qsa('.card')[0];
    listCard.hidden = true;
    const editor = qs('#editor');
    editor.hidden = false;
    const contentEl = document.querySelector('.content');
    contentEl?.classList.add('editor-open');
    contentEl?.classList.remove('page-scroll');
    const isEdit = typeof id === 'number';
    el('editorTitle').textContent = isEdit ? 'Edit Compliance' : 'Add Compliance';
    el('saveBtn').textContent = isEdit ? 'Update' : 'Create';
    el('notes').hidden = !isEdit;
    el('taskId').value = isEdit ? String(id) : '';
    clearFilePreview();
    let t = null; let attachments = [];
    if(sessionStorage.getItem('cf_token') && isEdit){ const data = await api.get(id); t = data && data.task; attachments = (data && data.attachments) || []; }
    else if(isEdit){ t = getTasks().find(t => t.id === id); }
    if(t){
      el('fTitle').value = t.title || '';
      el('fDesc').value = t.description || '';
      // Set by id where possible
      if(t.category_id){ el('fCategory').value = String(t.category_id); }
      else if(t.category){ const m=(api.meta.categories||[]).find(c=>c.name===t.category); if(m) el('fCategory').value=String(m.id); }
      if(t.company_id){ el('fCompany').value = String(t.company_id); }
      else if(t.company){ const m=(api.meta.companies||[]).find(c=>c.name===t.company); if(m) el('fCompany').value=String(m.id); }
      const makerSel = el('fMaker'); if(makerSel) makerSel.value = t.assignee || 'Me';
      const checkerSel = el('fChecker'); if(checkerSel) checkerSel.value = t.checker || '';
    const dueRaw = (t.dueDate || t.due_date || '');
      const isNA = String(dueRaw).toUpperCase() === 'NA';
      const due = isNA ? '' : String(dueRaw).slice(0,10);
      el('fDue').value = due;
      const dueNA = el('fDueNA'); if(dueNA) dueNA.checked = isNA;
      const inlineNa = qs('label.inline-na'); if(inlineNa) inlineNa.classList.toggle('na-selected', isNA);
      const rep = t.repeat || (t.repeat_json ? JSON.parse(t.repeat_json) : {frequency:null});
      el('fRepeat').value = JSON.stringify(rep);
      // populate extended fields to avoid leaking values across compliances
      const vf = el('fValidFrom'); if(vf){
        const v = (t.valid_from || t.validFrom || '')
        vf.value = v ? String(v).slice(0,10) : '';
      }
      const crit = el('fCriticality'); if(crit){
        const v = (t.criticality || t.criticality || 'medium');
        crit.value = (String(v).toLowerCase()||'medium');
      }
      const lo = el('fLicenseOwner'); if(lo){
        lo.value = (t.license_owner || t.licenseOwner || '');
      }
      const rfc = el('fRelevantFc'); if(rfc){
        let v = t.relevant_fc;
        if(v === undefined) v = t.relevantFc;
        let val = 'No';
        if(typeof v === 'string'){ val = (String(v).toLowerCase()==='yes') ? 'Yes' : 'No'; }
        else if(typeof v === 'number'){ val = v ? 'Yes' : 'No'; }
        else if(typeof v === 'boolean'){ val = v ? 'Yes' : 'No'; }
        rfc.value = val;
      }
      const dfc = el('fDisplayedFc'); if(dfc){
        let v = (t.displayed_fc || t.displayedFc || '');
        // map NA to blank option
        if(String(v).toUpperCase()==='NA') v = '';
        dfc.value = v;
      }
      // toggle FC image field on load
      const fcWrap = el('fcImageWrap'); if(fcWrap) fcWrap.style.display = (el('fDisplayedFc') && el('fDisplayedFc').value==='Yes') ? '' : 'none';
      clearFilePreview();
      renderAttachmentsList(attachments || []);
      renderNotes(id);
    }else{
      el('taskForm').reset();
      const makerSel2 = el('fMaker'); if(makerSel2) makerSel2.value = 'Me';
      // set defaults for extended fields on create
      const vf2 = el('fValidFrom'); if(vf2) vf2.value = '';
      const crit2 = el('fCriticality'); if(crit2) crit2.value = 'medium';
      const lo2 = el('fLicenseOwner'); if(lo2) lo2.value = '';
      const rfc2 = el('fRelevantFc'); if(rfc2) rfc2.value = 'No';
      const dfc2 = el('fDisplayedFc'); if(dfc2) dfc2.value = '';
    }
    // permissions: disable UI if needed
    if(sessionStorage.getItem('cf_token')){
      const me = await api.me(); const p = me.permissions || {};
      const currentUserName = (me.user && me.user.name) || '';
      const isMaker = !!t && t.assignee === currentUserName;
      const isAdmin = !!(me.user && (me.user.role==='admin' || me.user.role==='superadmin'));
      const isSubmitted = !!(t && t.submitted_at);
      state.currentSubmitted = !!isSubmitted;
      const canEditThis = p.can_edit || (!isEdit ? p.can_create : isMaker);
      // enable/disable core fields based on canEditThis
      qsa('#taskForm input, #taskForm select, #taskForm textarea').forEach(x=> x.disabled = !canEditThis);
      const saveBtnEl = el('saveBtn'); if(saveBtnEl){
        // Hide Update button for checker (non-admin, not maker)
        if(isEdit && !(p.can_edit || isMaker)){
          saveBtnEl.style.display = 'none';
        } else {
          saveBtnEl.style.display = 'inline-block';
          saveBtnEl.disabled = !canEditThis;
        }
      }
      // Maker is editable for admins, locked for non-admin makers
      const makerSel = el('fMaker'); if(makerSel) makerSel.disabled = !(p.can_edit);
      const checkerSel = el('fChecker'); if(checkerSel) checkerSel.disabled = !p.can_edit;
      // Ensure maker/checker selects have a valid value even if current user's name is not in the people list
      const ensureOption = (sel, value) => {
        if(!sel) return;
        const v = value || '';
        if(!v) return;
        if(!Array.from(sel.options).some(o => o.value === v)){
          const opt = document.createElement('option'); opt.value = v; opt.textContent = v; sel.appendChild(opt);
        }
      };
      if(t){
        const desiredMaker = (t.assignee === currentUserName) ? 'Me' : (t.assignee||'');
        ensureOption(makerSel, desiredMaker);
        if(makerSel && desiredMaker) makerSel.value = desiredMaker;
        const desiredChecker = (t.checker === currentUserName) ? 'Me' : (t.checker||'');
        ensureOption(checkerSel, desiredChecker);
        if(checkerSel && desiredChecker) checkerSel.value = desiredChecker;
      }
      // create mode: hide non-create actions
      if(!isEdit){
        const ids = ['markCompleted','markAborted','reopenPending','deleteTask'];
        ids.forEach(id => { const b = document.getElementById(id); if(b) b.style.display='none'; });
      }
      // viewers can change status on their own compliances; enable buttons, server will enforce
      const markCompletedBtn = el('markCompleted');
      if(markCompletedBtn){
        // Hide for maker; only admin/checker can see
        if(isEdit && isMaker && !p.can_edit){ markCompletedBtn.style.display = 'none'; } else { markCompletedBtn.style.display = 'inline-block'; }
        // If unlocked and user is checker (not admin), show disabled hint
        const isUnlockedLocal = !!(t && (t.edit_unlocked || t.editUnlocked));
        const isCheckerLocal = !!t && t.checker === currentUserName;
        if(isUnlockedLocal && isCheckerLocal && !p.can_edit){
          markCompletedBtn.title = 'Open for edits. Wait for maker to submit for review';
          markCompletedBtn.style.opacity = '0.6';
          markCompletedBtn.style.cursor = 'not-allowed';
        }else{
          markCompletedBtn.title = '';
          markCompletedBtn.style.opacity = '';
          markCompletedBtn.style.cursor = '';
        }
      }
      const markAbortedBtn = el('markAborted');
      if(markAbortedBtn){
        // Hide reject for maker; only admin/checker should see it
        if(isEdit && isMaker && !p.can_edit){ markAbortedBtn.style.display = 'none'; } else { markAbortedBtn.style.display = 'inline-block'; }
        // If unlocked and user is checker (not admin), show disabled hint
        const isUnlockedLocal = !!(t && (t.edit_unlocked || t.editUnlocked));
        const isCheckerLocal = !!t && t.checker === currentUserName;
        if(isUnlockedLocal && isCheckerLocal && !p.can_edit){
          markAbortedBtn.title = 'Open for edits. Wait for maker to submit for review';
          markAbortedBtn.style.opacity = '0.6';
          markAbortedBtn.style.cursor = 'not-allowed';
        }else{
          markAbortedBtn.title = '';
          markAbortedBtn.style.opacity = '';
          markAbortedBtn.style.cursor = '';
        }
        markAbortedBtn.disabled = false;
      }
      // Reopen visible only to admin or checker, and only if submitted
      const reopenBtn = el('reopenPending');
      if(reopenBtn){
        const isChecker = !!t && t.checker === currentUserName;
        const canSeeReopen = (isEdit && (isAdmin || isChecker));
        reopenBtn.style.display = canSeeReopen ? 'inline-block' : 'none';
        // If not submitted OR already unlocked, treat as already open for edits
        const isUnlocked = !!(t && (t.edit_unlocked || t.editUnlocked));
        if(!isSubmitted || isUnlocked){
          reopenBtn.setAttribute('data-open','1');
          reopenBtn.title = 'Already open for edits';
          reopenBtn.style.opacity = '0.6';
          reopenBtn.style.cursor = 'not-allowed';
        }else{
          reopenBtn.removeAttribute('data-open');
          reopenBtn.title = '';
          reopenBtn.style.opacity = '';
          reopenBtn.style.cursor = '';
        }
        // If task is completed, disable reopen for checker (admin can still reopen)
        if(isChecker && !isAdmin && String(t.status).toLowerCase() === 'completed'){
          reopenBtn.setAttribute('data-completed','1');
          reopenBtn.title = 'Task is completed. Please contact admin for edits';
          reopenBtn.style.opacity = '0.6';
          reopenBtn.style.cursor = 'not-allowed';
        }else{
          reopenBtn.removeAttribute('data-completed');
        }
        reopenBtn.disabled = !(isAdmin || isChecker);
      }
      // show notes for admins and viewers; allow adding via server permission check
      // Only admins can view note list; everyone can add
      const notesSection = qs('#notes');
      if(notesSection){
        const isAdminUser = !!(me.user && (me.user.role==='admin' || me.user.role==='superadmin'));
        notesSection.hidden = !isEdit; // show the section in edit mode for all
        const listEl = document.getElementById('noteList'); if(listEl) listEl.style.display = isAdminUser ? '' : 'none';
      }
      // hide delete for viewers (admin only)
      const delBtn2 = document.getElementById('deleteTask'); if(delBtn2) delBtn2.style.display = p.can_edit ? 'inline-block' : 'none';
      // Lock maker from editing when submitted unless unlocked by checker/admin
      const isUnlocked = !!(t && (t.edit_unlocked || t.editUnlocked));
      if(isSubmitted && !isUnlocked && isMaker && !isAdmin){
        qsa('#taskForm input, #taskForm select, #taskForm textarea').forEach(x=> x.disabled = true);
        const saveBtnEl2 = el('saveBtn'); if(saveBtnEl2){ saveBtnEl2.style.display='none'; }
        // add Request Edit button inline next to Submit to checker
        let reqBtn = document.getElementById('requestEditBtn');
        const submitBtnInline = document.getElementById('submitToChecker');
        if(!reqBtn){
          reqBtn = document.createElement('button');
          reqBtn.id='requestEditBtn';
          reqBtn.type='button';
          reqBtn.className='btn';
          reqBtn.textContent='Request Edit';
          if(submitBtnInline && submitBtnInline.parentElement){
            submitBtnInline.insertAdjacentElement('afterend', reqBtn);
          } else {
            const actions = document.querySelector('#taskForm .form-actions');
            (actions||el('taskForm')).appendChild(reqBtn);
          }
        }
        reqBtn.onclick = onRequestEdit;
      } else {
        const reqBtn = document.getElementById('requestEditBtn'); if(reqBtn){ reqBtn.remove(); }
      }
      // Allow file uploads when canEditThis
      const fileInput = el('fFiles'); if(fileInput) fileInput.disabled = !canEditThis;
      const fcImage = el('fFcImage'); if(fcImage) fcImage.disabled = !canEditThis;
    }
    location.hash = isEdit ? `#/edit/${id}` : '#/add';
  }

  async function onRequestEdit(){
    const id = Number(el('taskId').value||0); if(!id) return;
    if(!sessionStorage.getItem('cf_token')) return toast('Login required');
    const btn = document.getElementById('requestEditBtn');
    if(btn){ btn.disabled = true; btn.textContent = 'Requesting…'; }
    const ok = await api.requestEdit(id);
    toast(ok? 'Edit request sent' : 'Request failed');
    if(btn){ btn.disabled = false; btn.textContent = 'Request Edit'; }
  }

  async function onReopen(){
    const id = Number(el('taskId').value||0); if(!id) return;
    const btn = document.getElementById('reopenPending');
    if(btn && btn.getAttribute('data-open')==='1'){
      return toast('Already open for edits');
    }
    if(btn && btn.getAttribute('data-completed')==='1'){
      return toast('Task is completed. Please contact admin for edits');
    }
    await markStatus(STATUS.pending);
  }

  function getTasks(){
    try{ return JSON.parse(localStorage.getItem(STORAGE_KEYS.tasks) || '[]'); }
    catch{ return []; }
  }
  function setTasks(arr){
    localStorage.setItem(STORAGE_KEYS.tasks, JSON.stringify(arr));
  }

  function onSearch(e){
    e.preventDefault();
    const f = new FormData(e.currentTarget);
    state.filters = {
      title: (f.get('title')||'').toString().trim().toLowerCase(),
      assignee: f.get('assignee')||'',
      category: f.get('category')||'',
      company: f.get('company')||'',
      from: f.get('from')||'',
      to: f.get('to')||'',
      status: f.get('status')||''
    };
    render();
  }

  function onSort(key){
    const dir = (state.sort.key === key && state.sort.dir === 'asc') ? 'desc' : 'asc';
    state.sort = { key, dir };
    render();
  }

  function switchTab(tab){
    state.currentTab = tab; // 'to-me' or 'by-me'
    el('tabForMe').setAttribute('aria-selected', String(tab==='to-me'));
    el('tabByMe').setAttribute('aria-selected', String(tab==='by-me'));
    qs('#panelForMe').hidden = tab!=='to-me';
    qs('#panelByMe').hidden = tab!=='by-me';
    render();
  }

  function applyFilters(items){
    const f = state.filters;
    return items.filter(t => {
      if(f.title && !(t.title||'').toLowerCase().includes(f.title)) return false;
      if(f.assignee && t.assignee !== f.assignee) return false;
      if(f.category && t.category !== f.category) return false;
      if(f.company && t.company !== f.company) return false;
      if(f.status && t.status !== f.status) return false;
      if(f.from && (t.dueDate||'') < f.from) return false;
      if(f.to && (t.dueDate||'') > f.to) return false;
      return true;
    });
  }

  function sortItems(items){
    // Primary sort by criticality: High > Medium > Low > others
    const critRank = v => {
      const s = String(v||'').toLowerCase();
      if(s==='high') return 0;
      if(s==='medium') return 1;
      if(s==='low') return 2;
      return 3;
    };
    const a1 = [...items].sort((a,b) => {
      const ra = critRank(a.criticality);
      const rb = critRank(b.criticality);
      if(ra !== rb) return ra - rb;
      // tie-breakers: due date asc, then title asc
      const da = (a.dueDate||a.due_date||'');
      const db = (b.dueDate||b.due_date||'');
      if(da !== db) return String(da).localeCompare(String(db));
      return String(a.title||'').localeCompare(String(b.title||''));
    });
    return a1;
  }

  async function render(){
    // Prefer API; fallback to local demo
    let listA = [], listB = [];
    const listForMeTBody = el('listForMe');
    const listByMeTBody = el('listByMe');
    if(listForMeTBody){ listForMeTBody.innerHTML = '<tr class="skeleton row"><td colspan="7"></td></tr><tr class="skeleton row"><td colspan="7"></td></tr><tr class="skeleton row"><td colspan="7"></td></tr>'; }
    if(listByMeTBody){ listByMeTBody.innerHTML = '<tr class="skeleton row"><td colspan="7"></td></tr><tr class="skeleton row"><td colspan="7"></td></tr><tr class="skeleton row"><td colspan="7"></td></tr>'; }
    if(sessionStorage.getItem('cf_token')){
      const a = await api.list('to-me');
      const b = await api.list('by-me');
      listA = a.list || []; listB = b.list || [];
    }else{
      ensureSeedData();
      const tasks = getTasks();
      const toMe = tasks.filter(t => t.assignee === 'Me');
      const byMe = tasks.filter(t => t.assignedBy === 'Me');
      listA = sortItems(applyFilters(toMe));
      listB = sortItems(applyFilters(byMe));
    }
    el('countForMe').textContent = String(listA.length);
    el('countByMe').textContent = String(listB.length);
    drawRows(el('listForMe'), listA, 'to-me');
    drawRows(el('listByMe'), listB, 'by-me');
  }

  function drawRows(tbody, arr, role){
    tbody.innerHTML = '';
    if(arr.length === 0){
      const tr = document.createElement('tr');
      const td = document.createElement('td');
      td.colSpan = 9;
      td.textContent = 'No compliances found. Use Add Compliance to create one.';
      tr.appendChild(td); tbody.appendChild(tr); return;
    }
    arr.forEach(t => {
      const tr = document.createElement('tr');
      tr.appendChild(cellActions(t));
      tr.appendChild(tdText(t.company));
      tr.appendChild(tdText(t.category));
      tr.appendChild(tdText(t.title));
      const crit = (t.criticality||'').toString();
      tr.appendChild(tdText(crit ? crit.charAt(0).toUpperCase()+crit.slice(1).toLowerCase() : ''));
      const due = t.dueDate || t.due_date;
      tr.appendChild(tdText(formatRelativeDue(due)));
      tr.appendChild(tdText(t.assignee || ''));
      tr.appendChild(tdText(t.checker || ''));
      tr.appendChild(tdText(cap((t.status||'').replace('aborted','rejected'))));
      tbody.appendChild(tr);
    });
  }

  // Export/Import
  async function onExportCsv(){
    if(!sessionStorage.getItem('cf_token')) return toast('API mode required');
    const url = new URL('/api/tasks/export', location.origin);
    // Build params from export filters if present; else fall back to current state.filters
    const get = id => (document.getElementById(id)||{value:''}).value;
    const hasExportForm = !!document.getElementById('exportFilters');
    const params = hasExportForm ? {
      title: get('xTitle').trim(),
      assignee: get('xMaker'),
      category_id: get('xCategory'),
      company_id: get('xCompany'),
      status: get('xStatus'),
      from: get('xFrom'),
      to: get('xTo')
    } : state.filters;
    Object.entries(params).forEach(([k,v]) => { if(v) url.searchParams.set(k, v); });
    const token = sessionStorage.getItem('cf_token');
    url.searchParams.set('token', token);
    // force download in same tab to ensure cookie-less token path works consistently
    window.location.href = url.toString();
  }
  async function onImportCsv(e){
    e.preventDefault();
    if(!sessionStorage.getItem('cf_token')) return toast('API mode required');
    const file = el('importFile').files && el('importFile').files[0];
    if(!file) return toast('Choose a CSV file');
    const submitBtn = e.currentTarget.querySelector('button[type="submit"]'); if(submitBtn){ submitBtn.disabled = true; submitBtn.textContent = 'Importing…'; }
    const fd = new FormData(); fd.append('file', file);
    const r = await fetch('/api/tasks/import', { method:'POST', headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: fd });
    if(r.ok){
      const d = await r.json(); toast(`Imported ${d.imported} rows`);
      const inp = document.getElementById('importFile'); if(inp){ inp.value = ''; }
    } else { toast('Import failed'); }
    if(submitBtn){ submitBtn.disabled = false; submitBtn.textContent = 'Import'; }
  }

  // Settings
  async function loadSettings(){
    if(!sessionStorage.getItem('cf_token')) return;
    const ver = ++settingsLoadVersion;
    const [cats, comps, users, adminMeta] = await Promise.all([
      fetch('/api/categories', { headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } }).then(r=>r.json()),
      fetch('/api/companies', { headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } }).then(r=>r.json()),
      fetch('/api/users', { headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } }).then(r=>r.json()),
      fetch('/api/admin/meta', { headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } }).then(r=>r.json()).catch(()=>({})),
    ]);
    if(ver !== settingsLoadVersion) return; // drop stale render
    // render
    const catList = el('catList'); catList.innerHTML='';
    (cats.categories||[]).forEach(c=>{ const tr=document.createElement('tr'); tr.innerHTML = `<td>${escapeHTML(c.name)}</td><td><button class="btn" data-type="cat" data-id="${c.id}">Delete</button></td>`; catList.appendChild(tr); });
    const compList = el('compList'); compList.innerHTML='';
    (comps.companies||[]).forEach(c=>{ const tr=document.createElement('tr'); tr.innerHTML = `<td>${escapeHTML(c.name)}</td><td><button class="btn" data-type="comp" data-id="${c.id}">Delete</button></td>`; compList.appendChild(tr); });
    const userList = el('userList'); userList.innerHTML='';
    const me = await api.me(); const isSuperAdmin = me.user && me.user.role==='superadmin';
    // lock add-user role selector for admins
    const addRoleSel = el('userRole'); if(addRoleSel){ if(!isSuperAdmin){ addRoleSel.value='viewer'; addRoleSel.disabled = true; } else { addRoleSel.disabled = false; } }
    const addUserForm = document.getElementById('userForm');
    if(addUserForm){ addUserForm.removeEventListener('submit', onAddUser); addUserForm.addEventListener('submit', onAddUser); }
    (users.users||[]).forEach(u=>{
      const tr=document.createElement('tr');
      const roleSelId = `role_${u.id}`;
      const catSelId = `user_cats_${u.id}`;
      tr.innerHTML = `<td>${escapeHTML(u.email)}</td>
        <td>${escapeHTML(u.name)}</td>
        <td>
          <select id="${roleSelId}" data-id="${u.id}" ${isSuperAdmin? '' : 'disabled'}>
            <option value="superadmin" ${u.role==='superadmin'?'selected':''}>superadmin</option>
            <option value="admin" ${u.role==='admin'?'selected':''}>admin</option>
            <option value="viewer" ${u.role==='viewer'?'selected':''}>viewer</option>
          </select>
        </td>
        <td>
          <select id="${catSelId}" multiple size="3" style="min-width:180px" ${isSuperAdmin? '' : 'disabled'}>
            ${(cats.categories||[]).map(c=>`<option value="${c.id}" ${Array.isArray(u.categories)&&u.categories.includes(c.id)?'selected':''}>${escapeHTML(c.name)}</option>`).join('')}
          </select>
        </td>
        <td>
          ${isSuperAdmin? `<button class="btn" data-type="user-save" data-id="${u.id}">Save</button>` : ''}
          ${isSuperAdmin? `<button class="btn" data-type="user" data-id="${u.id}">Delete</button>` : ''}
        </td>`;
      userList.appendChild(tr);
    });

    // Set default password hint and input value from server meta
    const pwInput = document.getElementById('userPassword');
    const pwHint = document.getElementById('defaultPwHint');
    const dpw = (adminMeta && adminMeta.default_password) || '';
    if(pwInput){ pwInput.value = dpw; }
    if(pwHint){ pwHint.textContent = dpw ? `default password: ${dpw}` : ''; }

    // delete handlers
    catList.querySelectorAll('button[data-type="cat"]').forEach(b=> b.addEventListener('click', async (e)=>{
      const id = e.currentTarget.getAttribute('data-id'); if(!confirm('Delete category?')) return;
      const r = await fetch(`/api/categories/${id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } });
      if(r.ok){ loadSettings(); toast('Deleted'); } else { const j = await r.json().catch(()=>({})); toast(j.error==='in_use' ? 'Cannot delete: in use' : 'Failed'); }
    }));
    compList.querySelectorAll('button[data-type="comp"]').forEach(b=> b.addEventListener('click', async (e)=>{
      const id = e.currentTarget.getAttribute('data-id'); if(!confirm('Delete location/site?')) return;
      const r = await fetch(`/api/companies/${id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } });
      if(r.ok){ loadSettings(); toast('Deleted'); } else { const j = await r.json().catch(()=>({})); toast(j.error==='in_use' ? 'Cannot delete: in use' : 'Failed'); }
    }));
    userList.querySelectorAll('button[data-type="user"]').forEach(b=> b.addEventListener('click', async (e)=>{
      const id = e.currentTarget.getAttribute('data-id'); if(!confirm('Delete user?')) return;
      const r = await fetch(`/api/users/${id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } });
      if(r.ok){ loadSettings(); toast('Deleted'); } else { const j = await r.json().catch(()=>({})); toast(j.error || 'Failed'); }
    }));
    if(isSuperAdmin){ userList.querySelectorAll('button[data-type="user-save"]').forEach(b=> b.addEventListener('click', async (e)=>{
      const id = e.currentTarget.getAttribute('data-id');
      const sel = document.getElementById(`role_${id}`);
      const role = sel ? sel.value : '';
      const catSel = document.getElementById(`user_cats_${id}`);
      const categories = (catSel && role==='admin') ? Array.from(catSel.selectedOptions).map(o=> Number(o.value)) : [];
      if(!role) return;
      const r = await fetch(`/api/users/${id}`, { method:'PUT', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ role, categories }) });
      if(r.ok){ loadSettings(); toast('Role updated'); } else { const j = await r.json().catch(()=>({})); toast(j.error || 'Failed to update'); }
    })); }
  }

  function setTab(name){
    const ids = ['Categories','Companies','Users','ReminderPolicies'];
    ids.forEach(id => {
      const panel = el('panel'+id); const tab = el('tab'+id);
      if(panel) panel.hidden = (id !== name);
      if(tab) tab.setAttribute('aria-selected', String(id===name));
    });
    if(name==='ReminderPolicies') loadReminderPolicies();
  }

  async function loadReminderPolicies(){
    const polWrap = el('polList'); if(!polWrap) return;
    const r = await fetch('/api/reminders/policies', { headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } });
    const d = r.ok ? await r.json() : { policies: [] };
    polWrap.innerHTML = '';
    const crits = ['high','medium','low'];
    const map = {};
    (d.policies||[]).forEach(p => { map[String(p.criticality).toLowerCase()] = p; });
    crits.forEach(c => {
      const p = map[c] || { criticality: c, start_before: c==='high'?45: c==='medium'?30:15, windows_json: c==='high'? '[[31,999,3],[16,30,2],[1,15,1]]' : (c==='medium'? '[[16,999,3],[1,15,2]]' : '[[8,999,7],[1,7,2]]'), on_due_days:1, overdue_days:1 };
      const tr = document.createElement('tr');
      tr.innerHTML = `
        <td style="text-transform:capitalize">${p.criticality}</td>
        <td><input type="number" value="${Number(p.start_before||0)}" data-field="start_before" data-c="${p.criticality}"></td>
        <td><button class="btn" data-save data-c="${p.criticality}">Save</button></td>`;
      polWrap.appendChild(tr);
    });
    polWrap.querySelectorAll('button[data-save]').forEach(b => b.addEventListener('click', async (e)=>{
      const c = e.currentTarget.getAttribute('data-c');
      const row = e.currentTarget.closest('tr');
      const body = {
        start_before: Number(row.querySelector('[data-field="start_before"]').value||0),
        windows_json: '',
        on_due_days: 1,
        overdue_days: 1
      };
      const rr = await fetch(`/api/reminders/policies/${c}`, { method:'PUT', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify(body) });
      if(rr.ok){ toast('Policy saved'); } else { toast('Save failed'); }
    }));
    const runBtn = document.getElementById('runRemindersNow');
    if(runBtn && !runBtn._bound){
      runBtn.addEventListener('click', async ()=>{
        const r2 = await fetch('/api/reminders/run', { method:'POST', headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } });
        if(r2.ok){ const j=await r2.json(); toast(`Sent ${j.sent} reminders`); } else { toast('Run failed'); }
      });
      runBtn._bound = true;
    }
  }

  async function onAddCategory(e){
    e.preventDefault(); const name = el('catName').value.trim(); if(!name) return; const btn = e.currentTarget.querySelector('button[type="submit"]'); if(btn){ btn.disabled = true; btn.textContent = 'Adding…'; }
    const r = await fetch('/api/categories', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ name }) });
    if(r.ok){ el('catName').value=''; loadSettings(); toast('Category added'); } else { toast('Failed'); }
    if(btn){ btn.disabled = false; btn.textContent = 'Add'; }
  }
  async function onAddCompany(e){
    e.preventDefault(); const name = el('compName').value.trim(); if(!name) return; const btn = e.currentTarget.querySelector('button[type="submit"]'); if(btn){ btn.disabled = true; btn.textContent = 'Adding…'; }
    const r = await fetch('/api/companies', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ name }) });
    if(r.ok){ el('compName').value=''; loadSettings(); toast('Location/Site added'); } else { toast('Failed'); }
    if(btn){ btn.disabled = false; btn.textContent = 'Add'; }
  }
  async function onAddUser(e){
    e.preventDefault(); e.stopPropagation();
    const email = el('userEmail').value.trim();
    const name = el('userName').value.trim();
    const password = el('userPassword').value || '';
    const role = el('userRole').value;
    if(!email || !name) return;
    const me = await api.me(); const isSuperAdmin = me.user && me.user.role==='superadmin';
    // Admins can only create viewer users
    if(!isSuperAdmin && role !== 'viewer'){ toast('Admins can only add viewer users'); return; }
    const formEl = document.getElementById('userForm');
    const btn = formEl ? formEl.querySelector('button[type="submit"]') : null; if(btn){ btn.disabled = true; btn.textContent = 'Adding…'; }
    // collect categories only when creating admin user
    let categories = [];
    if(role==='admin'){
      // use all categories by default for new admin until saved via table (optional UX)
      const metaCats = (await fetch('/api/categories', { headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } }).then(r=>r.json())).categories||[];
      categories = metaCats.map(c=> c.id);
    }
    const r = await fetch('/api/users', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ email, name, password, role, categories }) });
    if(r.ok){
      el('userEmail').value=''; el('userName').value=''; el('userPassword').value='';
      // refresh global meta so Assigned To list updates
      await api.loadMeta(); seedFromMeta(api.meta);
      loadSettings();
      toast('User added');
    } else { const j = await r.json().catch(()=>({})); toast(j.error || 'Failed'); }
    if(btn){ btn.disabled = false; btn.textContent = 'Add User'; }
  }

  async function onInlineAddCategory(){
    const sel = el('fCategory'); if(!sel) return;
    if(sel.value === '__ADD__'){
      const name = prompt('New category name');
      if(!name) { sel.selectedIndex = 0; return; }
      if(!sessionStorage.getItem('cf_token')){ toast('Login required to add'); sel.selectedIndex=0; return; }
      const r = await fetch('/api/categories', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ name }) });
      if(r.ok){ await api.loadMeta(); const m=(api.meta.categories||[]).find(c=>c.name===name); if(m) sel.value = String(m.id); toast('Category added'); } else { toast('Failed to add'); sel.selectedIndex=0; }
    }
  }
  async function onInlineAddCompany(){
    const sel = el('fCompany'); if(!sel) return;
    if(sel.value === '__ADD__'){
      const name = prompt('New location/site name');
      if(!name) { sel.selectedIndex = 0; return; }
      if(!sessionStorage.getItem('cf_token')){ toast('Login required to add'); sel.selectedIndex=0; return; }
      const r = await fetch('/api/companies', { method:'POST', headers:{ 'Content-Type':'application/json', Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` }, body: JSON.stringify({ name }) });
      if(r.ok){ await api.loadMeta(); const m=(api.meta.companies||[]).find(c=>c.name===name); if(m) sel.value = String(m.id); toast('Location/Site added'); } else { toast('Failed to add'); sel.selectedIndex=0; }
    }
  }

  function cellActions(t){
    const td = document.createElement('td');
    const edit = document.createElement('button');
    edit.className = 'btn';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => openEditor(t.id));
    td.appendChild(edit);
    return td;
  }
  function tdText(txt){ const td = document.createElement('td'); td.textContent = txt||''; return td; }

  async function onSaveTask(e){
    e.preventDefault();
    const id = Number(el('taskId').value || 0);
    const title = el('fTitle').value.trim();
    const categoryId = el('fCategory').value;
    const companyId = el('fCompany').value;
    const assignee = el('fMaker').value;
    const checker = el('fChecker').value;
    const dueDate = el('fDueNA').checked ? 'NA' : el('fDue').value;
    const validFrom = el('fValidFrom') ? el('fValidFrom').value : '';
    const criticality = el('fCriticality') ? el('fCriticality').value : '';
    const licenseOwner = el('fLicenseOwner') ? el('fLicenseOwner').value.trim() : '';
    const relevantFc = el('fRelevantFc') ? el('fRelevantFc').value : 'No';
    const displayedFc = el('fDisplayedFc') ? el('fDisplayedFc').value : '';
    const repeat = JSON.parse(el('fRepeat').value || '{"frequency":null}');
    const description = el('fDesc').value.trim();

    const errors = [];
    if(!title) errors.push('Title is required');
    if(!categoryId || categoryId==='__ADD__') errors.push('Category is required');
    if(!companyId || companyId==='__ADD__') errors.push('Location / Site is required');
    // In edit mode, maker is assigned by admin; do not block on empty select
    if(!assignee && !id) errors.push('Maker is required');
    // allow N/A due date by leaving it blank
    if(errors.length){ return toast(errors.join('\n')); }

    // Validate FC Image requirement and conditional minimum attachments
    const meInfo = sessionStorage.getItem('cf_token') ? (await api.me().catch(()=>null)) : null;
    const currentUserName = (meInfo && meInfo.user && meInfo.user.name) || '';
    let existingAtts = [];
    let existingHasFcImage = false;
    let existingGeneralCount = 0;
    let makerName = '';
    if(sessionStorage.getItem('cf_token') && id){
      try{
        const data = await api.get(id);
        existingAtts = (data && data.attachments) || [];
        existingHasFcImage = existingAtts.some(a => String(a.file_name||'').includes('__fc_image'));
        existingGeneralCount = existingAtts.filter(a => !String(a.file_name||'').includes('__fc_image')).length;
        makerName = (data && data.task && data.task.assignee) || '';
      }catch(_e){}
    }
    const fileInput = el('fFiles');
    const fcImageInput = el('fFcImage');
    const generalNewFiles = (fileInput && fileInput.files) ? Array.from(fileInput.files) : [];
    const fcNewFiles = (fcImageInput && fcImageInput.files) ? Array.from(fcImageInput.files) : [];
    const newGeneralCount = generalNewFiles.length;
    const newFcCount = fcNewFiles.length;
    // If Displayed in FC is Yes, enforce at least one FC image ONLY when editing an existing task
    if(id && String(displayedFc) === 'Yes' && !(existingHasFcImage || newFcCount > 0)){
      return toast('FC Image is required');
    }
    // Require at least one general attachment (excluding FC image) ONLY when maker updates an existing task
    const isMakerEdit = !!(id && currentUserName && makerName && makerName === currentUserName);
    if(isMakerEdit && (existingGeneralCount + newGeneralCount) < 1){
      return toast('Attachment required');
    }

    // Prevent updates when nothing changed (fields AND attachments)
    let hasFieldChanges = false;
    if(id){
      try{
        const data = await api.get(id);
        const t0 = (data && data.task) || {};
        const normalizeYesNo = (v)=> String(v||'').toLowerCase()==='yes' ? 1 : 0;
        const newCatId = categoryId && categoryId!=='__ADD__' ? Number(categoryId) : (t0.category_id||null);
        const newComId = companyId && companyId!=='__ADD__' ? Number(companyId) : (t0.company_id||null);
        const effMaker = assignee==='Me' ? currentUserName : assignee;
        const effChecker = checker==='Me' ? currentUserName : checker;
        const newRel = normalizeYesNo(relevantFc);
        const newDisp = displayedFc || null;
        const newRepeat = JSON.stringify(repeat);
        const checks = [
          [String(t0.title||''), String(title||'')],
          [String(t0.description||''), String(description||'')],
          [Number(t0.category_id||0), Number(newCatId||0)],
          [Number(t0.company_id||0), Number(newComId||0)],
          [String(t0.assignee||''), String(effMaker||'')],
          [String(t0.checker||''), String(effChecker||'')],
          [String(t0.due_date||''), String(dueDate||'')],
          [String(t0.valid_from||''), String(validFrom||'')],
          [String(t0.criticality||''), String(criticality||'')],
          [String(t0.license_owner||''), String(licenseOwner||'')],
          [Number(t0.relevant_fc||0), Number(newRel||0)],
          [String(t0.displayed_fc||''), String(newDisp||'')],
          [String(t0.repeat_json||''), String(newRepeat||'')],
        ];
        hasFieldChanges = checks.some(([a,b]) => a !== b);
      }catch(_e){ hasFieldChanges = true; }
      const hasNewFiles = (newGeneralCount + newFcCount) > 0;
      if(!hasFieldChanges && !hasNewFiles){ return toast('No changes detected'); }
    }

    const fd = new FormData();
    fd.append('title', title);
    fd.append('description', description);
    fd.append('category_id', categoryId && categoryId!=='__ADD__' ? categoryId : '');
    fd.append('company_id', companyId && companyId!=='__ADD__' ? companyId : '');
    fd.append('assignee', assignee);
    fd.append('checker', checker);
    fd.append('assigned_by', 'Me');
    fd.append('due_date', dueDate||'');
    fd.append('valid_from', validFrom||'');
    fd.append('criticality', criticality||'');
    fd.append('license_owner', licenseOwner||'');
    fd.append('relevant_fc', relevantFc||'No');
    fd.append('displayed_fc', displayedFc||'');
    fd.append('repeat_json', JSON.stringify(repeat));
    // CC removed
    collectFileChips().forEach(a => {
      // cannot reconstruct file from dataUrl; rely on direct input for API mode
    });
    const allNewFiles = generalNewFiles.concat(fcNewFiles);
    if(allNewFiles.length){
      const totalBytes = allNewFiles.reduce((s,f)=> s + (f.size||0), 0);
      if(totalBytes > 5 * 1024 * 1024){ return toast('Total attachments size must be <= 5MB'); }
      // Append general attachments as-is
      generalNewFiles.forEach(f => fd.append('attachments', f));
      // Append FC image(s) with filename marker
      fcNewFiles.forEach(f => {
        const dot = f.name.lastIndexOf('.');
        const base = dot > 0 ? f.name.slice(0,dot) : f.name;
        const ext = dot > 0 ? f.name.slice(dot) : '';
        const renamed = new File([f], `${base}__fc_image${ext}`, { type: f.type });
        fd.append('attachments', renamed);
      });
    }

    const saveBtn = el('saveBtn'); if(saveBtn){ saveBtn.disabled = true; saveBtn.textContent = id? 'Updating…' : 'Creating…'; }
    let createdId = null;
    if(sessionStorage.getItem('cf_token')){
      if(id){
        const ok = await api.update(id, fd);
        if(!ok) { toast('Update failed or not permitted'); if(saveBtn){ saveBtn.disabled=false; } return; }
      } else {
        const created = await api.create(fd);
        if(!created || !created.id){ toast('Create failed or not permitted'); if(saveBtn){ saveBtn.disabled=false; } return; }
        createdId = created.id;
        el('taskId').value = String(createdId);
      }
    }else{
      const tasks = getTasks();
      if(id){
        const idx = tasks.findIndex(t => t.id === id);
        if(idx >= 0){ tasks[idx] = { ...tasks[idx], title, category: categoryId, company: companyId, assignee, dueDate, repeat, description }; }
      }else{
        const t = makeTask({title, category: categoryId, company: companyId, assignee, dueDate, repeat, description});
        t.attachments = collectFileChips();
        tasks.push(t); el('taskId').value = String(t.id); createdId = t.id;
      }
      setTasks(tasks);
    }
    toast(id ? 'Updated' : 'Created');
    // no submit button anymore
    const nextId = id || createdId;
    // Clear file inputs to avoid re-upload on repeated saves
    try{ if(fileInput) fileInput.value=''; if(fcImageInput) fcImageInput.value=''; }catch(_e){}
    if(nextId){ showList(); }
    if(saveBtn){ saveBtn.disabled = false; saveBtn.textContent = id? 'Update' : 'Create'; }
  }

  async function onDeleteTask(){
    const id = Number(el('taskId').value||0); if(!id) return;
    if(!confirm('Delete this compliance?')) return;
    const me = await api.me(); const can = !!(me.permissions && (me.permissions.can_edit || me.permissions.can_manage_settings));
    if(!can){ return toast('Only admin can delete'); }
    await fetch(`/api/tasks/${id}`, { method:'DELETE', headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } });
    showList();
  }

  async function onSubmitToChecker(){
    const id = Number(el('taskId').value||0); if(!id) return;
    if(!sessionStorage.getItem('cf_token')) return toast('Login required');
    const btn = document.getElementById('submitToChecker');
    if(btn && btn.getAttribute('data-submitted')==='1'){
      return toast('Already submitted');
    }
    const r = await fetch(`/api/tasks/${id}/submit`, { method:'POST', headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')}` } });
    if(!r.ok){ return toast('Submit failed'); }
    state.currentSubmitted = true;
    toast('Submitted to checker');
    openEditor(id);
  }

  // Status transitions
  async function markStatus(status){
    const id = Number(el('taskId').value || 0);
    if(!id) return toast('Open a compliance first');
    if(sessionStorage.getItem('cf_token')){
      await api.setStatus(id, status);
    }else{
      const tasks = getTasks();
      const idx = tasks.findIndex(t => t.id === id);
      if(idx < 0) return toast('Not found');
      tasks[idx].status = status;
      setTasks(tasks);
    }
    toast(`Status: ${cap(status)}`);
    openEditor(id);
  }

  async function onMarkCompleted(){
    const id = Number(el('taskId').value||0); if(!id) return;
    // if unlocked for edits and current user is checker (not admin), block
    const data = await api.get(id);
    const t = data && data.task;
    const me = await api.me();
    const isAdmin = !!(me.user && (me.user.role==='admin' || me.user.role==='superadmin'));
    const isChecker = !!(t && me.user && t.checker === me.user.name);
    const isUnlocked = !!(t && (t.edit_unlocked || t.editUnlocked));
    if(isUnlocked && isChecker && !isAdmin){ return toast('Open for edits. Wait for maker to submit for review'); }
    return markStatus(STATUS.completed);
  }

  async function onMarkRejected(){
    const id = Number(el('taskId').value||0); if(!id) return;
    const data = await api.get(id);
    const t = data && data.task;
    const me = await api.me();
    const isAdmin = !!(me.user && (me.user.role==='admin' || me.user.role==='superadmin'));
    const isChecker = !!(t && me.user && t.checker === me.user.name);
    const isUnlocked = !!(t && (t.edit_unlocked || t.editUnlocked));
    if(isUnlocked && isChecker && !isAdmin){ return toast('Open for edits. Wait for maker to submit for review'); }
    return markStatus(STATUS.rejected);
  }

  // Attachments UI
  const MAX_FILE_SIZE = 2 * 1024 * 1024;
  function handleFileSelection(e){
    clearFilePreview();
    const files = Array.from(e.target.files||[]);
    files.forEach(file => {
      if(file.size > MAX_FILE_SIZE) return addFileChip({name:file.name, size:file.size, type:file.type, error:'Too large'});
      const reader = new FileReader();
      reader.onload = ev => addFileChip({name:file.name, size:file.size, type:file.type, dataUrl:ev.target.result});
      reader.readAsDataURL(file);
    });
  }
  function clearFilePreview(){ el('filePreview').innerHTML=''; }
  function renderAttachmentsList(list){
    const wrap = el('filePreview'); if(!wrap) return;
    // do not clear wrap here because caller controls sequence
    const token = sessionStorage.getItem('cf_token');
    const canEdit = !document.getElementById('saveBtn') || document.getElementById('saveBtn').style.display !== 'none';
    (list||[]).forEach(a => {
      const chip = document.createElement('span'); chip.className='file-chip';
      const link = document.createElement('a');
      const url = `/api/attachments/${a.id}/download${token? `?token=${encodeURIComponent(token)}`: ''}`;
      link.href = url;
      link.textContent = `${a.file_name} ${a.file_size? '('+pretty(a.file_size)+')':''}`;
      link.target = '_blank';
      chip.appendChild(link);
      if(canEdit){
        const del = document.createElement('button'); del.type='button'; del.setAttribute('aria-label','Delete attachment'); del.textContent='×';
        del.addEventListener('click', async ()=>{
          if(!confirm('Delete this attachment?')) return;
          const ok = await api.deleteAttachment(a.id);
          if(ok){ chip.remove(); toast('Attachment deleted'); } else { toast('Delete failed'); }
        });
        chip.appendChild(del);
      }
      wrap.appendChild(chip);
    });
    if((list||[]).length===0){ const d = document.createElement('div'); d.className='file-chip'; d.textContent='No attachments yet.'; wrap.appendChild(d); }
  }
  function addFileChip(att){
    const chip = document.createElement('span'); chip.className='file-chip';
    chip.dataset.name = att.name; chip.dataset.size = String(att.size||0); chip.dataset.type = att.type||''; chip.dataset.url = att.dataUrl||'';
    chip.textContent = `${att.name} ${(att.size? '('+pretty(att.size)+')':'')}` + (att.error? ` – ${att.error}`:'');
    const btn = document.createElement('button'); btn.type='button'; btn.setAttribute('aria-label','Remove'); btn.textContent='×'; btn.addEventListener('click', ()=>chip.remove());
    chip.appendChild(btn); el('filePreview').appendChild(chip);
  }
  // CC removed
  function collectFileChips(){
    return qsa('.file-chip', el('filePreview')).map(ch => ({
      name: ch.dataset.name,
      size: Number(ch.dataset.size||0),
      type: ch.dataset.type||'',
      dataUrl: ch.dataset.url||''
    }));
  }

  // Notes
  async function onAddNote(e){
    e.preventDefault();
    const id = Number(el('taskId').value||0);
    if(!id) return toast('Open a compliance first');
    const text = el('noteText').value.trim();
    const fileInput = el('noteFile');
    if(!text) return toast('Note text is required');
    if(sessionStorage.getItem('cf_token')){
      const btn = e.currentTarget.querySelector('button[type="submit"]'); if(btn){ btn.disabled = true; btn.textContent = 'Adding…'; }
      const fd = new FormData(); fd.append('text', text); if(fileInput.files && fileInput.files[0]) fd.append('file', fileInput.files[0]);
      await api.addNote(id, fd);
      el('noteText').value=''; el('noteFile').value='';
      renderNotes(id);
      toast('Note added');
      if(btn){ btn.disabled = false; btn.textContent = 'Add Note'; }
    }else{
      let file = null; if(fileInput.files && fileInput.files[0]){ const f = fileInput.files[0]; if(f.size > MAX_FILE_SIZE) return toast('Note attachment too large'); file = {name:f.name, size:f.size, type:f.type}; }
      const all = getNotes(); const list = all[id] || []; list.unshift({text, file, at: new Date().toISOString()}); all[id] = list; setNotes(all);
      el('noteText').value=''; el('noteFile').value=''; renderNotes(id); toast('Note added');
    }
  }
  function renderNotes(id){
    const wrap = el('noteList');
    wrap.innerHTML = '';
    let list = (getNotes()[id] || []);
    if(sessionStorage.getItem('cf_token')){
      api.notes(id).then(data => {
        const ls = data.notes || [];
        wrap.innerHTML = '';
        if(ls.length===0){ wrap.innerHTML = '<div class="note">No notes yet.</div>'; return; }
        const token = sessionStorage.getItem('cf_token');
        ls.forEach(n => {
          const d = document.createElement('div'); d.className='note';
          const meta = document.createElement('div'); meta.className='meta'; meta.textContent = new Date(n.created_at).toLocaleString();
          const body = document.createElement('div'); body.innerHTML = escapeHTML(n.text).replace(/\n/g,'<br>');
          d.appendChild(meta); d.appendChild(body);
          if(n.file_name){ const a = document.createElement('div'); a.className='meta'; const link = document.createElement('a'); link.href = `/api/notes/${n.id}/download${token? `?token=${encodeURIComponent(token)}`: ''}`; link.textContent = `Attachment: ${n.file_name} ${n.file_size? '('+pretty(n.file_size)+')':''}`; link.target='_blank'; a.appendChild(link); d.appendChild(a); }          wrap.appendChild(d);
        });
      });
      return;
    }
    if(list.length===0){ wrap.innerHTML = '<div class="note">No notes yet.</div>'; return; }
    list.forEach(n => {
      const d = document.createElement('div'); d.className='note';
      const meta = document.createElement('div'); meta.className='meta'; meta.textContent = new Date(n.at).toLocaleString();
      const body = document.createElement('div'); body.innerHTML = escapeHTML(n.text).replace(/\n/g,'<br>');
      d.appendChild(meta); d.appendChild(body);
      if(n.file){
        const a = document.createElement('div'); a.className='meta'; a.textContent = `Attachment: ${n.file.name} (${pretty(n.file.size)})`;
        d.appendChild(a);
      }
      wrap.appendChild(d);
    });
  }
  function getNotes(){ try{ return JSON.parse(localStorage.getItem(STORAGE_KEYS.notes) || '{}'); } catch{ return {}; } }
  function setNotes(obj){ localStorage.setItem(STORAGE_KEYS.notes, JSON.stringify(obj)); }

  // Helpers
  function cap(s){ return (s||'').charAt(0).toUpperCase()+ (s||'').slice(1); }
  function pretty(n){
    if(n===0) return '0 B';
    const units=['KB','MB','GB']; let i=-1; do{ n/=1024; i++; } while(n>1024 && i<units.length-1);
    return `${Math.max(n,0.1).toFixed(1)} ${units[i]}`;
  }
  function formatDate(d){
    if(!d) return '';
    const raw = String(d);
    if(raw.toUpperCase()==='NA') return 'NA';
    const dt = new Date(raw);
    if(isNaN(dt)) return raw;
    const day = String(dt.getDate()).padStart(2,'0');
    const monthNames = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sept','Oct','Nov','Dec'];
    const mon = monthNames[dt.getMonth()];
    const year = dt.getFullYear();
    return `${day}-${mon}-${year}`;
  }

  function formatRelativeDue(d){
    if(!d) return '';
    const raw = String(d);
    if(raw.toUpperCase()==='NA') return 'NA';
    const dt = new Date(raw);
    if(isNaN(dt)) return formatDate(raw);
    const today = new Date();
    const a = Date.UTC(today.getFullYear(), today.getMonth(), today.getDate());
    const b = Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate());
    const diff = Math.floor((b - a) / (24*3600*1000));
    if(diff === 0) return 'Today';
    if(diff === -1) return 'Yesterday';
    if(diff === 1) return 'Tomorrow';
    if(diff < -1) return 'Overdue';
    return formatDate(raw);
  }
  function escapeHTML(str){ const div=document.createElement('div'); div.textContent=str; return div.innerHTML; }
  function addDays(date, days){ const d = new Date(date); d.setDate(d.getDate()+days); return d.toISOString().slice(0,10); }

  function toast(msg){
    const t = el('toast'); t.textContent = msg; t.hidden=false; clearTimeout(t._to);
    t._to = setTimeout(()=>{ t.hidden=true; }, 1800);
    return false;
  }

  // Dashboard
  let charts = {};
  async function showDashboard(){
    // hide other main cards, show dashboard
    Array.from(document.querySelectorAll('#main > section.card')).forEach(sec => { sec.hidden = true; });
    const p = el('panelDashboard'); if(p) p.hidden = false;
    setActiveMenu('#/dashboard');
    const contentEl = document.querySelector('.content');
    contentEl?.classList.add('page-scroll');
    contentEl?.classList.remove('editor-open');
    // ensure modal is hidden
    const modal = el('chartModal'); if(modal){ modal.hidden = true; modal.setAttribute('aria-hidden','true'); }
    // ensure filters are bound once
    const form = el('dashboardFilters'); const resetBtn = el('dReset');
    if(form && !form._bound){
      form.addEventListener('submit', (e)=>{ e.preventDefault(); renderDashboard(); });
      if(resetBtn){ resetBtn.addEventListener('click', ()=> setTimeout(renderDashboard, 0)); }
      form._bound = true;
    }
    // load meta once to populate selects
    if(sessionStorage.getItem('cf_token')){ try{ await api.loadMeta(); seedFromMeta(api.meta); }catch(_){} }
    renderDashboard();
  }
  async function renderDashboard(){
    const url = new URL('/api/dashboard', location.origin);
    const s = (el('dStatus')||{value:''}).value||'';
    const catId = (el('dCategory')||{value:''}).value||'';
    const comId = (el('dCompany')||{value:''}).value||'';
    const assignee = (el('dAssignee')||{value:''}).value||'';
    const criticality = (el('dCriticality')||{value:''}).value||'';
    const from = (el('dFrom')||{value:''}).value||'';
    const to = (el('dTo')||{value:''}).value||'';
    if(s) url.searchParams.set('status', s);
    if(catId) url.searchParams.set('category_id', catId);
    if(comId) url.searchParams.set('company_id', comId);
    if(assignee) url.searchParams.set('assignee', assignee);
    if(criticality) url.searchParams.set('criticality', criticality);
    if(from) url.searchParams.set('from', from);
    if(to) url.searchParams.set('to', to);
    try{
      const r = await fetch(url, { headers:{ Authorization:`Bearer ${sessionStorage.getItem('cf_token')||''}` } });
      if(!r.ok){ drawDashboard(defaultDashboardData()); return; }
      const d = await r.json();
      drawDashboard(d || defaultDashboardData());
    }catch(_e){ drawDashboard(defaultDashboardData()); }
  }
  function drawDashboard(data){
    if(typeof Chart === 'undefined'){ return; }
    // Overall health (across current filters)
    const csAll = data.criticalityStatus||{ high:{}, medium:{}, low:{}, unknown:{} };
    const sumAll = (o)=> Number(o?.completed||0) + Number(o?.pending||0);
    const pctAll = (c, p)=>{ const t=c+p; return t>0? Math.round((c/t)*100):0; };
    const totalCompleted = Number(csAll.high?.completed||0)+Number(csAll.medium?.completed||0)+Number(csAll.low?.completed||0);
    const totalPending = Number(csAll.high?.pending||0)+Number(csAll.medium?.pending||0)+Number(csAll.low?.pending||0);
    const overallPctAll = pctAll(totalCompleted, totalPending);
    const highPctAll = pctAll(Number(csAll.high?.completed||0), Number(csAll.high?.pending||0));
    const medPctAll = pctAll(Number(csAll.medium?.completed||0), Number(csAll.medium?.pending||0));
    const lowPctAll = pctAll(Number(csAll.low?.completed||0), Number(csAll.low?.pending||0));
    // update stat boxes
    const setVal = (id, v)=>{ const n = document.getElementById(id); if(n) n.textContent = `${v}%`; };
    setVal('ovOverall', overallPctAll);
    setVal('ovHigh', highPctAll);
    setVal('ovMedium', medPctAll);
    setVal('ovLow', lowPctAll);
    // Top: Location/Site Health as a single percentage bar (with per-criticality in tooltip)
    const orgCrit = data.byCompanyCritStatus||[];
    const labelsOrg = orgCrit.map(x=>x.company);
    const orgCritRows = orgCrit.map(r=>({
      completed:{ high:Number(r.crit?.high?.completed||0), medium:Number(r.crit?.medium?.completed||0), low:Number(r.crit?.low?.completed||0) },
      pending:{ high:Number(r.crit?.high?.pending||0), medium:Number(r.crit?.medium?.pending||0), low:Number(r.crit?.low?.pending||0) }
    }));
    const pctLoc = (c, p) => { const t = c + p; return t>0 ? Math.round((c/t)*100) : 0; };
    const overallPct = orgCritRows.map(row => pctLoc(row.completed.high+row.completed.medium+row.completed.low, row.pending.high+row.pending.medium+row.pending.low));
    const highPct = orgCritRows.map(row => pctLoc(row.completed.high, row.pending.high));
    const medPct = orgCritRows.map(row => pctLoc(row.completed.medium, row.pending.medium));
    const lowPct = orgCritRows.map(row => pctLoc(row.completed.low, row.pending.low));
    setChartHeight('dbOrgHealth', labelsOrg.length);
    const orgCfg = { labels: labelsOrg, datasets:[ { label:'Overall', data: overallPct, backgroundColor:'#8b5cf6' } ] };
    orgCfg.__health = overallPct.map((v,i)=> ({ overall:v, high: highPct[i]||0, medium: medPct[i]||0, low: lowPct[i]||0 }));
    upsertChart('dbOrgHealth', 'bar', orgCfg, { responsive:true, maintainAspectRatio:false, scales:{ x:{ stacked:false, ticks:{ autoSkip:false, maxRotation:45 } }, y:{ stacked:false, beginAtZero:true, suggestedMax:100, max:100, ticks:{ callback:(v)=> `${v}%` } } }, plugins:{ tooltip:{ callbacks:{ label: tooltipHealthPercent } } } });

    // Due trend (buckets) split by criticality
    const critBuckets = (data && data.bucketsByCrit) || {};
    const baseOrder = ['Overdue','Today','7 Days','This Month'];
    const keysHigh = Object.keys(critBuckets.high||{});
    const keysMed = Object.keys(critBuckets.medium||{});
    const keysLow = Object.keys(critBuckets.low||{});
    const allKeysSet = new Set([...keysHigh, ...keysMed, ...keysLow]);
    const allKeys = Array.from(allKeysSet);
    const extras = allKeys.filter(k => !baseOrder.includes(k) && k !== 'Unknown');
    const present = baseOrder.filter(k => allKeys.includes(k));
    const bucketOrder = present.concat(extras).concat(allKeys.includes('Unknown')? ['Unknown'] : []);
    const getSeries = (crit)=> bucketOrder.map(k=> Number(((critBuckets[crit]||{})[k])||0));
    const bucketsHigh = getSeries('high');
    const bucketsMed = getSeries('medium');
    const bucketsLow = getSeries('low');
    const dueCfg = { labels: bucketOrder, datasets:[
      { label:'High', data: bucketsHigh, backgroundColor:'#ef4444' },
      { label:'Medium', data: bucketsMed, backgroundColor:'#f59e0b' },
      { label:'Low', data: bucketsLow, backgroundColor:'#10b981' }
    ] };
    // Plain tooltip with only the hovered dataset value
    upsertChart('dbBucketBar', 'bar', dueCfg, { responsive:true, maintainAspectRatio:false, scales:{ x:{ stacked:true, ticks:{ autoSkip:false } }, y:{ stacked:true, beginAtZero:true } }, plugins:{ tooltip:{ callbacks:{ label: (ctx)=>{
      try{
        if(ctx && ctx.parsed != null){ if(typeof ctx.parsed === 'number') return `${ctx.dataset.label}: ${ctx.parsed}`; if(ctx.parsed.y != null) return `${ctx.dataset.label}: ${ctx.parsed.y}`; }
        const raw = ctx && ctx.raw; if(raw != null){ if(typeof raw === 'number') return `${ctx.dataset.label}: ${raw}`; if(raw.y != null) return `${ctx.dataset.label}: ${raw.y}`; }
      }catch(_e){}
      return '';
    } } } }});

    // Status chart with per-criticality breakdown in tooltip (Pending/Completed only)
    const cstat = data.criticalityStatus||{ high:{}, medium:{}, low:{}, unknown:{} };
    const pendingCrit = { high:Number(cstat.high?.pending||0), medium:Number(cstat.medium?.pending||0), low:Number(cstat.low?.pending||0) };
    const completedCrit = { high:Number(cstat.high?.completed||0), medium:Number(cstat.medium?.completed||0), low:Number(cstat.low?.completed||0) };
    const pendingTotal = pendingCrit.high + pendingCrit.medium + pendingCrit.low + Number(cstat.unknown?.pending||0);
    const completedTotal = completedCrit.high + completedCrit.medium + completedCrit.low + Number(cstat.unknown?.completed||0);
    const statusCfg = { labels:['Pending','Completed'], datasets:[{ data:[pendingTotal, completedTotal], backgroundColor:['#f59e0b','#10b981'] }] };
    statusCfg.__crit = [
      { completed:{ high:0, medium:0, low:0 }, pending: pendingCrit },
      { completed: completedCrit, pending:{ high:0, medium:0, low:0 } }
    ];
    upsertChart('dbStatusPie', 'pie', statusCfg, { responsive:true, maintainAspectRatio:false, plugins:{ tooltip:{ callbacks:{ label: tooltipLabelOnlyCount } } } });

    // By Category stacked Completed/Pending with criticality breakdown in tooltip
    const cat = data.byCategoryStatus||[];
    setChartHeight('dbCategoryBar', cat.length);
    const catCrit = (data.byCategoryCritStatus||[]).map(r=>({category:r.category, crit:r.crit||{}}));
    const catCritRows = catCrit.map(r=>({ completed:{ high:Number(r.crit?.high?.completed||0), medium:Number(r.crit?.medium?.completed||0), low:Number(r.crit?.low?.completed||0) }, pending:{ high:Number(r.crit?.high?.pending||0), medium:Number(r.crit?.medium?.pending||0), low:Number(r.crit?.low?.pending||0) } }));
    const catCfg = { labels: cat.map(x=>x.category), datasets:[{ label:'Completed', data: cat.map(x=>x.completed||0), backgroundColor:'#10b981' }, { label:'Pending', data: cat.map(x=>x.pending||0), backgroundColor:'#f59e0b' }] };
    catCfg.__crit = catCritRows;
    upsertChart('dbCategoryBar', 'bar', catCfg, { plugins:{ tooltip:{ callbacks:{ label: tooltipLabelOnlyCount } } }, responsive:true, maintainAspectRatio:false, scales:{ x:{ stacked:true, ticks:{ autoSkip:false, maxRotation:45, minRotation:0 } }, y:{ stacked:true, beginAtZero:true } } });

    // By Location/Site stacked Completed/Pending with criticality breakdown in tooltip
    const com = data.byCompanyStatus||[];
    setChartHeight('dbCompanyBar', com.length);
    const companyCritRows = (data.byCompanyCritStatus||[]).map(r=>({ completed:{ high:Number(r.crit?.high?.completed||0), medium:Number(r.crit?.medium?.completed||0), low:Number(r.crit?.low?.completed||0) }, pending:{ high:Number(r.crit?.high?.pending||0), medium:Number(r.crit?.medium?.pending||0), low:Number(r.crit?.low?.pending||0) } }));
    const compCfg = { labels: com.map(x=>x.company), datasets:[{ label:'Completed', data: com.map(x=>x.completed||0), backgroundColor:'#10b981' }, { label:'Pending', data: com.map(x=>x.pending||0), backgroundColor:'#f59e0b' }] };
    compCfg.__crit = companyCritRows;
    upsertChart('dbCompanyBar', 'bar', compCfg, { plugins:{ tooltip:{ callbacks:{ label: tooltipLabelOnlyCount } } }, responsive:true, maintainAspectRatio:false, scales:{ x:{ stacked:true, ticks:{ autoSkip:false, maxRotation:45, minRotation:0 } }, y:{ stacked:true, beginAtZero:true } } });

    // Criticality stacked Completed/Pending
    const cs = data.criticalityStatus||{ high:{}, medium:{}, low:{}, unknown:{} };
    upsertChart('dbCriticalityPie', 'bar', { labels:['High','Medium','Low','Unknown'], datasets:[
      { label:'Completed', data:[cs.high?.completed||0, cs.medium?.completed||0, cs.low?.completed||0, cs.unknown?.completed||0], backgroundColor:'#10b981' },
      { label:'Pending', data:[cs.high?.pending||0, cs.medium?.pending||0, cs.low?.pending||0, cs.unknown?.pending||0], backgroundColor:'#f59e0b' }
    ] }, { responsive:true, maintainAspectRatio:false, scales:{ x:{ stacked:true }, y:{ stacked:true, beginAtZero:true } }, plugins:{ tooltip:{ callbacks:{ label: tooltipLabelOnlyCount } } } });

    const tr = data.trend||[];
    upsertChart('dbTrendLine', 'line', { labels: tr.map(x=>x[0]), datasets:[{ label:'Compliances by Due Month', data: tr.map(x=>x[1]), borderColor:'#a78bfa', backgroundColor:'rgba(167,139,250,.25)', fill:true, tension:.25 }] }, { responsive:true, maintainAspectRatio:false, plugins:{ legend:{display:false}, tooltip:{ callbacks:{ label: tooltipLabelOnlyCount } } } });

    // (Removed duplicate override of dbOrgHealth)
  }
  function upsertChart(canvasId, type, data, options){
    const ctx = document.getElementById(canvasId);
    if(!ctx) return;
    if(charts[canvasId]){ try{ charts[canvasId].destroy(); }catch(_){} }
    charts[canvasId] = new Chart(ctx, { type, data, options });
  }
  function setChartHeight(canvasId, itemCount){
    const canvas = document.getElementById(canvasId);
    if(!canvas || !canvas.parentElement) return;
    canvas.parentElement.style.height = (itemCount > 8) ? '360px' : '280px';
  }
  function defaultDashboardData(){
    return { total:0, buckets:{ Overdue:0, Yesterday:0, Today:0, Tomorrow:0, 'Within 5 Days':0, 'Within 15 Days':0, Later:0, Unknown:0 }, statusCounts:{ pending:0, completed:0, rejected:0 }, criticalityCounts:{ high:0, medium:0, low:0, unknown:0 }, byCategory:[], byCompany:[], byCompanyStatus:[], trend:[] };
  }
  function tooltipLabelOnlyCount(ctx){
    try{
      // base count
      let total = '';
      if(ctx && ctx.parsed != null){ if(typeof ctx.parsed === 'number') total = String(ctx.parsed); if(ctx.parsed && ctx.parsed.y != null) total = String(ctx.parsed.y); }
      const index = ctx && ctx.dataIndex;
      // Prefer dataset label; fallback to data.labels[index] (for pie slices like Pending/Completed)
      const label = (ctx && ctx.dataset && ctx.dataset.label) || ((ctx && ctx.chart && ctx.chart.data && Array.isArray(ctx.chart.data.labels)) ? ctx.chart.data.labels[index] : '');
      // augment with per-criticality breakdown when available on data.__crit
      const crit = (ctx && ctx.chart && ctx.chart.data && ctx.chart.data.__crit) || null;
      if(crit && typeof index === 'number'){
        const row = crit[index] || {completed:{}, pending:{}};
        const isPending = /pending/i.test(label);
        const b = isPending ? row.pending : row.completed;
        const h = Number(b.high||0), m = Number(b.medium||0), l = Number(b.low||0);
        const lines = [`${label}: ${total}`, `High: ${h}`, `Medium: ${m}`, `Low: ${l}`];
        // Return as array so Chart.js renders each line on its own row
        return lines;
      }
      // No __crit: show status/series label (e.g., Completed/Pending) followed by value
      if(label){ return `${label}: ${total}`; }
      return total || '';
    }catch(_e){ return ''; }
  }
  function tooltipHealthPercent(ctx){
    try{
      const index = ctx && ctx.dataIndex;
      const value = (ctx && ctx.parsed != null) ? (typeof ctx.parsed==='number'? ctx.parsed : (ctx.parsed.y||0)) : (ctx && ctx.raw != null ? (typeof ctx.raw==='number'? ctx.raw : (ctx.raw.y||0)) : 0);
      const health = (ctx && ctx.chart && ctx.chart.data && ctx.chart.data.__health && ctx.chart.data.__health[index]) || null;
      if(health){
        return [
          `Overall: ${value}%`,
          `High: ${health.high}%`,
          `Medium: ${health.medium}%`,
          `Low: ${health.low}%`
        ];
      }
      return `Overall: ${value}%`;
    }catch(_e){ return ''; }
  }
  // Maximize chart modal
  document.addEventListener('click', (e)=>{
    const btn = e.target.closest && e.target.closest('.chart-max');
    if(!btn) return;
    const id = btn.getAttribute('data-chart');
    const canvas = document.getElementById(id);
    if(!canvas) return;
    const cfg = charts[id] ? charts[id].config : null;
    const modal = document.getElementById('chartModal');
    const modalTitle = document.getElementById('chartModalTitle');
    const modalCanvas = document.getElementById('chartModalCanvas');
    const close = document.getElementById('chartModalClose');
    if(!modal || !modalCanvas) return;
    if(charts['_modal']){ try{ charts['_modal'].destroy(); }catch(_){} charts['_modal']=null; }
    const titleEl = btn.parentElement && btn.parentElement.querySelector('h3');
    if(modalTitle && titleEl){ modalTitle.textContent = titleEl.textContent || 'Chart'; }
    modal.hidden = false; modal.setAttribute('aria-hidden','false');
    const newData = cfg ? JSON.parse(JSON.stringify(cfg.data)) : { labels:[], datasets:[] };
    const newOpts = cfg ? JSON.parse(JSON.stringify(cfg.options||{})) : {};
    // Reattach tooltip callback for per-criticality breakdown in modal
    if(newData && (newData.__crit || newData.__health)){
      newOpts.plugins = newOpts.plugins || {};
      newOpts.plugins.tooltip = newOpts.plugins.tooltip || {};
      newOpts.plugins.tooltip.callbacks = newOpts.plugins.tooltip.callbacks || {};
      newOpts.plugins.tooltip.callbacks.label = newData.__health ? tooltipHealthPercent : tooltipLabelOnlyCount;
    }
    charts['_modal'] = new Chart(modalCanvas, { type: cfg? cfg.type: 'bar', data: newData, options: { ...newOpts, responsive:true, maintainAspectRatio:false } });
    const onClose = ()=>{ modal.hidden = true; modal.setAttribute('aria-hidden','true'); if(charts['_modal']){ try{ charts['_modal'].destroy(); }catch(_){} charts['_modal']=null; } };
    if(close){ close.onclick = onClose; }
    modal.addEventListener('click', (ev)=>{ if(ev.target === modal) onClose(); });
    document.addEventListener('keydown', function esc(ev){ if(ev.key === 'Escape'){ onClose(); document.removeEventListener('keydown', esc); } });
  });

  // kick off
  document.addEventListener('DOMContentLoaded', init);

  
})();



