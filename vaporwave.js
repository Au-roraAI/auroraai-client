/* AuroraAI Vaporwave Helpers
   Save as: vaporwave.js
   Usage (in your HTML, after body content):
     <script src="vaporwave.js"></script>
   Exposes global: window.Aurora
*/
(function(){
  const LS_PREFIX = "aurora_";
  const DEVKEY_URL = "/secrets/devkey.json"; // optional local dev key (gitignored)

  const state = {
    devKey: null,
    toastContainer: null,
  };

  function qs(sel, root=document){ return root.querySelector(sel); }
  function qsa(sel, root=document){ return Array.from(root.querySelectorAll(sel)); }

  // ==== THEME / BACKGROUND ====
  function ensureScanlines(){
    if (!document.body.classList.contains('vw-scanlines')){
      document.body.classList.add('vw-scanlines');
    }
  }
  function ensureGrid(){
    if (!qs('.vw-grid')){
      const grid = document.createElement('div');
      grid.className = 'vw-grid';
      document.body.appendChild(grid);
    }
  }
  function initTheme({scanlines=true, grid=true, bg=true}={}){
    if(bg) document.body.classList.add('vw-bg');
    if(scanlines) ensureScanlines();
    if(grid) ensureGrid();
  }
  function toggleVibes(){
    document.body.classList.toggle('extra-vibes');
  }

  // ==== TOASTS ====
  function getToastContainer(){
    if(!state.toastContainer){
      const div = document.createElement('div');
      div.className = 'vw-toast-container';
      document.body.appendChild(div);
      state.toastContainer = div;
    }
    return state.toastContainer;
  }
  function toast(msg, type="info", timeout=2400){
    const cont = getToastContainer();
    const t = document.createElement('div');
    t.className = `vw-toast ${type}`;
    t.textContent = msg;
    cont.appendChild(t);
    setTimeout(()=>{ t.style.opacity='0'; setTimeout(()=>t.remove(), 250); }, timeout);
  }

  // ==== STORAGE HELPERS ====
  function setLS(key, value){ localStorage.setItem(LS_PREFIX+key, JSON.stringify(value)); }
  function getLS(key, fallback=null){
    try{
      const v = localStorage.getItem(LS_PREFIX+key);
      return v ? JSON.parse(v) : fallback;
    }catch{ return fallback; }
  }
  function delLS(key){ localStorage.removeItem(LS_PREFIX+key); }

  // ==== OPENROUTER KEY MANAGEMENT ====
  async function fetchDevKey(){
    try{
      const res = await fetch(DEVKEY_URL, {cache:'no-store'});
      if(!res.ok) return null;
      const j = await res.json();
      return j.OPENROUTER_KEY || null;
    }catch{ return null; }
  }
  async function getOpenRouterKey(){
    const user = getLS('openrouter_key', null);
    if (user) return user;
    if (state.devKey !== undefined) return state.devKey; // cached (could be null)
    state.devKey = await fetchDevKey();
    return state.devKey;
  }
  function setOpenRouterKey(key){
    if(!key || typeof key !== 'string'){ toast('Invalid key', 'error'); return; }
    setLS('openrouter_key', key.trim());
    toast('OpenRouter key saved', 'success');
  }
  function clearOpenRouterKey(){
    delLS('openrouter_key');
    toast('OpenRouter key cleared', 'success');
  }

  // ==== MODEL SLUGS ====
  function isLikelyModelSlug(s){
    // very light heuristic: vendor/model-name, optional :suffix (e.g., :online)
    return typeof s === 'string' && /.+\/.+/.test(s);
  }

  // ==== PROJECT PERSISTENCE (local, for MVP) ====
  function projectKey(id){ return `project_${id}`; }
  function saveProject(id, data){
    if(!id) throw new Error('project id required');
    setLS(projectKey(id), data);
    return data;
  }
  function loadProject(id, fallback=null){
    return getLS(projectKey(id), fallback);
  }
  function listProjects(){
    return Object.keys(localStorage)
      .filter(k => k.startsWith(LS_PREFIX + 'project_'))
      .map(k => JSON.parse(localStorage.getItem(k)));
  }

  // ==== SIMPLE BINDERS ====
  function bindKeyModal({openBtn, input, saveBtn, clearBtn, closeBtn}){
    const $open = qs(openBtn), $input = qs(input), $save = qs(saveBtn), $clear = qs(clearBtn), $close = qs(closeBtn);
    if($open){ $open.addEventListener('click', async ()=>{
      const key = await getOpenRouterKey();
      if($input) $input.value = key ? '******** (saved)' : '';
      document.documentElement.classList.add('aurora-modal-open');
      qs('#aurora-key-modal')?.classList.remove('d-none');
    });}
    if($save){ $save.addEventListener('click', ()=>{
      const v = $input?.value?.trim();
      if(v && !v.startsWith('********')) setOpenRouterKey(v);
      qs('#aurora-key-modal')?.classList.add('d-none');
      document.documentElement.classList.remove('aurora-modal-open');
    });}
    if($clear){ $clear.addEventListener('click', ()=>{
      clearOpenRouterKey();
      if($input) $input.value='';
    });}
    if($close){ $close.addEventListener('click', ()=>{
      qs('#aurora-key-modal')?.classList.add('d-none');
      document.documentElement.classList.remove('aurora-modal-open');
    });}
  }

  // Export
  window.Aurora = {
    initTheme, toggleVibes,
    toast,
    getOpenRouterKey, setOpenRouterKey, clearOpenRouterKey,
    isLikelyModelSlug,
    saveProject, loadProject, listProjects,
    bindKeyModal,
    _internals:{ fetchDevKey }
  };
})();