// ============================================================================
// STEAM API BOOTSTRAP — Configurable API sources with fallback chain
// To swap APIs when one goes down, just edit PROVIDERS below.
// Python backend checks this JS cache first via /api/appinfo/cache
// ============================================================================
const SteamAPI = (() => {

  // ======================== EDIT THIS TO SWAP APIS ========================
  const PROVIDERS = [
    {
      name: "steam_store",
      enabled: true,
      buildUrl: (appid) => `https://store.steampowered.com/api/appdetails?appids=${appid}`,
      parse: (data, appid) => {
        const entry = data[String(appid)];
        if (!entry || !entry.success || !entry.data) return null;
        const d = entry.data;
        return {
          name:           d.name || "",
          installdir:     "",
          exe_candidates: [],
          type:           d.type || "",
          is_free:        !!d.is_free,
          publishers:     d.publishers || [],
          release_date:   d.release_date || null,
        };
      }
    },
    {
      name: "steamui_vdf",
      enabled: true,
      buildUrl: (appid) => `https://steamui.com/api/get_appinfo.php?appid=${appid}`,
      responseType: "text",
      parse: (text, appid) => {
        if (!text || text.includes("<!DOCTYPE")) return null;
        const result = { name:"", installdir:"", exe_candidates:[], type:"", is_free:false, publishers:[], release_date:null };
        const nameMatch = text.match(/"name"\s+"([^"]+)"/);
        if (nameMatch) result.name = nameMatch[1];
        const typeMatch = text.match(/"type"\s+"([^"]+)"/);
        if (typeMatch) result.type = typeMatch[1];
        const installMatch = text.match(/"installdir"\s+"([^"]+)"/);
        if (installMatch) result.installdir = installMatch[1];
        const exeRegex = /"executable"\s+"([^"]+)"/g;
        let m;
        while ((m = exeRegex.exec(text)) !== null) {
          const exe = m[1].replace(/\//g, "\\");
          if (!result.exe_candidates.includes(exe)) result.exe_candidates.push(exe);
        }
        const pubMatch = text.match(/"publisher"\s+"([^"]+)"/);
        if (pubMatch) result.publishers = [pubMatch[1]];
        return (result.name || result.installdir) ? result : null;
      }
    },
    // ---- ADD MORE PROVIDERS HERE ----
    // { name: "my_api", enabled: false, buildUrl: (appid) => `https://...`, parse: (data, appid) => ({...}) },
  ];
  // ======================== END CONFIG ========================

  const PROXY_URL = "/api/proxy/fetch";
  const CACHE_PUSH_URL = "/api/appinfo/cache";
  const LOCAL_TTL = 5 * 60 * 1000;
  const _cache = {};

  async function proxyFetch(url, responseType = "json") {
    try {
      const resp = await fetch(`${PROXY_URL}?url=${encodeURIComponent(url)}&type=${responseType}`);
      if (!resp.ok) return null;
      return responseType === "text" ? await resp.text() : await resp.json();
    } catch (e) { console.warn(`[SteamAPI] proxy error:`, e); return null; }
  }

  async function pushToBackend(appid, info) {
    try {
      await fetch(CACHE_PUSH_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ appid, ...info })
      });
    } catch (e) { console.warn(`[SteamAPI] cache push failed:`, e); }
  }

  function mergeInfo(base, extra) {
    if (!extra) return base;
    const m = { ...base };
    if (!m.name && extra.name) m.name = extra.name;
    if (!m.installdir && extra.installdir) m.installdir = extra.installdir;
    if (!m.type && extra.type) m.type = extra.type;
    if (extra.is_free) m.is_free = extra.is_free;
    if (!m.publishers?.length && extra.publishers?.length) m.publishers = extra.publishers;
    if (!m.release_date && extra.release_date) m.release_date = extra.release_date;
    if (!m.exe_candidates?.length && extra.exe_candidates?.length) m.exe_candidates = extra.exe_candidates;
    return m;
  }

  async function getAppInfo(appid) {
    appid = String(appid);
    const cached = _cache[appid];
    if (cached && (Date.now() - cached.ts) < LOCAL_TTL) return cached.data;

    let merged = { name:"", installdir:"", exe_candidates:[], type:"", is_free:false, publishers:[], release_date:null, _sources:[] };
    const enabled = PROVIDERS.filter(p => p.enabled);

    const results = await Promise.allSettled(
      enabled.map(async (prov) => {
        const raw = await proxyFetch(prov.buildUrl(appid), prov.responseType || "json");
        if (!raw) return null;
        try { const p = prov.parse(raw, appid); if (p) { p._source = prov.name; return p; } } catch (e) { console.warn(`[SteamAPI] ${prov.name} parse error:`, e); }
        return null;
      })
    );

    for (const r of results) {
      if (r.status === "fulfilled" && r.value) {
        merged = mergeInfo(merged, r.value);
        merged._sources.push(r.value._source);
      }
    }

    if (merged.name || merged.installdir) _cache[appid] = { data: merged, ts: Date.now() };
    if (merged.name || merged.installdir || merged.exe_candidates.length) pushToBackend(appid, merged);

    console.log(`[SteamAPI] ${appid}: name="${merged.name}" installdir="${merged.installdir}" exe=${merged.exe_candidates.length} sources=[${merged._sources}]`);
    return merged;
  }

  function setProviderEnabled(name, enabled) { const p = PROVIDERS.find(x => x.name === name); if (p) p.enabled = !!enabled; }
  function addProvider(provider) { PROVIDERS.push(provider); }
  function listProviders() { return PROVIDERS.map(p => ({ name: p.name, enabled: p.enabled })); }
  function clearCache() { Object.keys(_cache).forEach(k => delete _cache[k]); }

  console.log("[SteamAPI] Bootstrap loaded. Providers:", PROVIDERS.filter(p => p.enabled).map(p => p.name).join(", "));

  return { getAppInfo, setProviderEnabled, addProvider, listProviders, clearCache, PROVIDERS };
})();

// Prevent closing the activation modal via ESC or backdrop while locked
document.addEventListener('keydown', function(e){
  if (window.forceActivationModal && (e.key === 'Escape' || e.key === 'Esc')) {
    e.preventDefault();
    e.stopPropagation();
    return false;
  }
});

async function getLauncherStatusMapForPage(gamesOnPage) {
  const appids = gamesOnPage.map(g => g.appid);
  try {
    const res = await fetch('/api/launcher_status_bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appids })
    });
    const j = await res.json();
    if (!res.ok || !j.success) return {};
    return j.data || {};
  } catch {
    return {};
  }
}

// --- Installed Only: state + helpers ---
const INSTALLED_KEY = 'oneb:installedOnly';

function getInstalledOnly() {
  const v = localStorage.getItem(INSTALLED_KEY);
  return v === 'true';
}

function setInstalledOnly(enabled) {
  localStorage.setItem(INSTALLED_KEY, enabled ? 'true' : 'false');
  window.showInstalledOnly = !!enabled;
  const btn = document.getElementById('show-installed-btn');
  if (btn) {
    btn.classList.toggle('active', enabled);
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    btn.textContent = enabled ? "Show All Games" : "Show Added Games Only";
  }
}

document.addEventListener('DOMContentLoaded', () => {
  setInstalledOnly(getInstalledOnly());
  const btn = document.getElementById('show-installed-btn');
  if (btn) {
    btn.addEventListener('click', async () => {
      const next = !getInstalledOnly();
      console.log('🎮 Show Installed Only clicked! New state:', next);
      setInstalledOnly(next);
      if (next) {
        console.log('🎮 Refreshing installed set...');
        await refreshInstalledSet();
        console.log('🎮 Installed set size:', window.__installedSet?.size || 0);
      }
      console.log('🎮 Fetching and rendering games...');
      await fetchGamesFreshAndRender({ resetPage: true });
      console.log('🎮 Render complete!');
    });
  }
});

/* ===== Persist "Show Installed Only" + Page, and restore after remove ===== */
(function(){
  const KEY = 'oneb:view_state:v1';

  // TODO: set your exact ID if known (fallback: auto-detect by text)
  const INSTALLED_BTN_ID = 'show-installed-btn';

  const prevBtn  = document.getElementById('prev');
  const nextBtn  = document.getElementById('next');
  const pageLbl  = document.getElementById('page-label');
  const gridEl   = document.getElementById('game-grid');

  if(!prevBtn || !nextBtn || !pageLbl || !gridEl) return;

  // Find the "Show Installed Only" control
  let installedBtn = document.getElementById(INSTALLED_BTN_ID);
  if(!installedBtn){
    // fallback: any .sidebar-btn / .chip whose text contains 'installed'
    installedBtn = Array.from(document.querySelectorAll('.sidebar-btn, .chip, button'))
      .find(b => /installed/i.test(b.textContent || ''));
  }

  function loadState(){
    try {
      const s = JSON.parse(localStorage.getItem(KEY) || '{}');
      return {
        installedOnly: !!s.installedOnly,
        page: Math.max(1, parseInt(s.page || '1', 10))
      };
    } catch(e){
      return { installedOnly:false, page:1 };
    }
  }
  function saveState(s){
    localStorage.setItem(KEY, JSON.stringify(s));
  }
  function getCurrentPage(){
    // "Page 1" -> 1
    const n = parseInt((pageLbl.textContent || '').replace(/\D+/g, ''), 10);
    return isNaN(n) ? 1 : n;
  }
  function goToPage(target){
    // Use existing prev/next behavior to avoid touching your render code
    let safety = 200;
    const cur = () => getCurrentPage();
    while(cur() < target && !nextBtn.disabled && safety--) nextBtn.click();
    while(cur() > target && !prevBtn.disabled && safety--) prevBtn.click();
  }

  function getStateFromUI(){
    return {
      installedOnly: installedBtn ? installedBtn.classList.contains('active') ||
                    installedBtn.ariaPressed === 'true' : false,
      page: getCurrentPage()
    };
  }


function restoreState() {
  const s = loadState();
  setInstalledOnlyUI(s.installedOnly);
  setTimeout(() => goToPage(s.page), 0);
}

  // Save state when user interacts
  if(installedBtn){
    installedBtn.addEventListener('click', () => {
      const s = loadState();
      const ui = getStateFromUI();
      s.installedOnly = ui.installedOnly;
      s.page = ui.page; // keep current page too
      saveState(s);
    });
  }

  prevBtn.addEventListener('click', () => {
    const s = loadState();
    s.page = Math.max(1, getCurrentPage() - 1);
    saveState(s);
  });
  nextBtn.addEventListener('click', () => {
    const s = loadState();
    s.page = getCurrentPage() + 1; // capped by your own logic
    saveState(s);
  });

  // After a remove finishes, many apps re-render and jump to page 1.
  // Hook the moment your "Remove complete" modal closes OR the grid updates.
  // If you have a custom event after removal, dispatch 'game:removed' and this will catch it.
  document.addEventListener('game:removed', () => {
    restoreState();
  });

  // Fallbacks to detect close of your remove modal (if present)
  const removeModal = document.getElementById('remove-complete-modal');
  if(removeModal){
    const observer = new MutationObserver(() => {
      const visible = removeModal.style.display !== 'none';
      if(!visible){ // modal just hid => removal flow ended
        restoreState();
      }
    });
    observer.observe(removeModal, { attributes: true, attributeFilter: ['style'] });
  }

  // Initial restore on load
  document.addEventListener('DOMContentLoaded', restoreState);
  if(document.readyState === 'interactive' || document.readyState === 'complete'){
    restoreState();
  }
})();

/* === Installed-Only toggle (single source of truth) === */
(function(){
  // --- helpers (idempotent) ---
  if (!window.refreshInstalledSet) {
    // expects your getInstalledLuaAppids(); if not present, no-op
    window.refreshInstalledSet = async function(){
      if (typeof getInstalledLuaAppids !== 'function') return;
      const ids = await getInstalledLuaAppids();
      window.__installedSet = new Set((ids || []).map(String));
    };
  }
  window.__installedSet = window.__installedSet || new Set();

  const LS_KEY = 'oneb:installedOnly';
  function getInstalledOnly(){ return localStorage.getItem(LS_KEY) === 'true'; }
  function setInstalledOnly(v){
    localStorage.setItem(LS_KEY, v ? 'true' : 'false');
    window.showInstalledOnly = !!v; // keep any legacy code aligned
    const btn = document.getElementById('show-installed-btn');
    if (btn) {
      btn.classList.toggle('active', v);
      btn.setAttribute('aria-pressed', v ? 'true' : 'false');
      btn.textContent = v ? 'Show All Games' : 'Show Added Games Only';
    }
  }

  document.addEventListener('DOMContentLoaded', async () => {
    setInstalledOnly(getInstalledOnly()); // hydrate UI + global
  });
  if (document.readyState === 'interactive' || document.readyState === 'complete') {
    setInstalledOnly(getInstalledOnly());
  }
})();
const _backdrop = document.getElementById('modal-backdrop');
if (_backdrop) {
  _backdrop.addEventListener('click', function(e){
    if (window.forceActivationModal) {
      e.preventDefault(); e.stopPropagation(); return false;
    }
  });
}

document.addEventListener("DOMContentLoaded", () => {
  { var rb0=document.getElementById('modal-reset'); if (rb0) rb0.style.display='none'; }

  checkActivationStatus();
  ensureGamesCacheAndRender();
});

// Adult detector (uses API-provided content_descriptors)
const ADULT_DESCRIPTOR_CODES = new Set(['3', '4']); // sexual / adult-only
function isAdultGame(game) {
  try {
    // 1) API content_descriptors (prefer this)
    var cds = (game && game.content_descriptors && game.content_descriptors.length)
      ? game.content_descriptors : [];
    for (var i = 0; i < cds.length; i++) {
      var c = String(cds[i]);
      if (c === '3' || c === '4') return true; // adult/sexual
    }

    // 2) Legacy primary_genre fallback (some devs mislabel)
    var pg = Number(game && game.primary_genre);
    if (pg === 71 || pg === 72) return true;

    // 3) Keyword heuristics (catch mislabeled or missing descriptors)
    var name = String((game && game.name) || '').toLowerCase();
    // note: \b prevents matching words like "Sussex"
    var ADULT_KEYWORD_RE =
      /\bpornocrates\b|\bpornstar\b|\bsuccubus\b|\bsexdivers\b|\bsextet\b|\bsexy\b|\bpleasure\b|\bhentai\b|\bsex2\b|\bsex\b|\bsexual\b|\becchi\b|\bnsfw\b|\beroge\b|\bxxx\b|\br18\b|18\+|\bnude\b|\bnudity\b|\buncensored\b/;
    if (ADULT_KEYWORD_RE.test(name)) return true;

    return false;
  } catch (e) {
    return false;
  }
}


// ---------- Config ----------
const IMAGE_MAP_URL = '/image_cache_map.json';   // adjust if yours is served elsewhere

// ---------- Map cache ----------
let _imageMap = null;
let _imageMapPromise = null;
let _imageMapVer = 0; // used to bust browser cache on mapped URLs

async function getImageCacheMap({ force = false } = {}) {
  if (_imageMap && !force) return _imageMap;
  if (_imageMapPromise && !force) return _imageMapPromise;

  _imageMapPromise = (async () => {
    const url = `${IMAGE_MAP_URL}?v=${Date.now()}`;
    const r = await fetch(url, { cache: 'no-store' });
    if (!r.ok) throw new Error(`map fetch failed: ${r.status}`);
    const json = await r.json();
    _imageMapVer = Date.now();
    _imageMap = json;
    return _imageMap;
  })().catch(err => { _imageMapPromise = null; throw err; });

  return _imageMapPromise;
}

function _mapUrlFor(appid) {
  const rec = _imageMap && (_imageMap[appid] || _imageMap[String(appid)]);
  if (!rec) return null;

  // Support either a plain string or an object with common keys
  let u = typeof rec === 'string'
    ? rec
    : (rec.url || rec.path || rec.local || rec.cache || rec.file || null);

  if (!u) return null;

  // Absolute http(s) or already-rooted path
  if (/^https?:\/\//i.test(u) || u.startsWith('/')) {
    return `${u}${u.includes('?') ? '&' : '?'}v=${_imageMapVer}`;
  }
  // Relative path (serve from site root)
  return `/${u}${u.includes('?') ? '&' : '?'}v=${_imageMapVer}`;
}

// ---------- Cover loader (use this) ----------
let _coverReqCounter = 0;

function loadGameCover(imgEl, appid) {
  appid = String(appid);
  imgEl.classList.add('cover');
  imgEl.dataset.appid = appid;

  // unique request id to avoid race conditions when paging fast
  const reqId = String(++_coverReqCounter);
  imgEl.dataset.reqId = reqId;

  const guardSetSrc = (url) => {
    if (imgEl.dataset.reqId === reqId) imgEl.src = url;
  };

  const onLoaded = () => {
    if (imgEl.dataset.reqId !== reqId) return;
    imgEl.classList.add('loaded');
    imgEl.removeEventListener('load', onLoaded);
  };
  imgEl.addEventListener('load', onLoaded, { once: true });

  // Fallback chain for error: map → cached endpoint → placeholder
  imgEl.onerror = async () => {
    if (imgEl.dataset.reqId !== reqId) return;

    // 1) try image_cache_map.json
    try {
      if (!_imageMap) await getImageCacheMap();
      const mapped = _mapUrlFor(appid);
      if (mapped) {
        imgEl.onerror = () => { guardSetSrc(`/cached_image/${appid}.jpg?v=${Date.now()}`); };
        return guardSetSrc(mapped);
      }
    } catch (_) { /* ignore */ }

    // 2) fallback to cached endpoint (server will pull from GitHub if needed)
    imgEl.onerror = () => { guardSetSrc('/static/placeholder.jpg'); };
    guardSetSrc(`/cached_image/${appid}.jpg?v=${Date.now()}`);
  };

  // Start with Steam CDN (fastest path) with cache-bust
  guardSetSrc(`https://steamcdn-a.akamaihd.net/steam/apps/${appid}/library_600x900.jpg?v=${Date.now()}`);

  // Also race in the map: if CDN is slow and map has a URL, swap once
  getImageCacheMap().then(() => {
    if (imgEl.dataset.reqId !== reqId) return;
    const notLoaded = !imgEl.complete || imgEl.naturalWidth === 0;
    if (notLoaded) {
      const mapped = _mapUrlFor(appid);
      if (mapped) guardSetSrc(mapped);
    }
  }).catch(() => {});
}

// ---------- Soft refresh: reapply mapped URLs to visible covers (no other UI changes) ----------
async function refreshCoversFromMap({ forceMapReload = true } = {}) {
  try { await getImageCacheMap({ force: !!forceMapReload }); } catch { /* keep going */ }
  const imgs = document.querySelectorAll('#game-grid img.cover');
  imgs.forEach(img => {
    const appid = img.dataset.appid;
    if (!appid) return;
    const mapped = _mapUrlFor(appid);
    if (mapped) {
      // assign a new reqId to cancel any older handlers for this element
      const reqId = String(++_coverReqCounter);
      img.dataset.reqId = reqId;
      img.onerror = () => { if (img.dataset.reqId === reqId) img.src = `/cached_image/${appid}.jpg?v=${Date.now()}`; };
      img.src = mapped; // mapped URL already carries ?v=mapVersion for busting
    }
  });
}

// --- Primary-genre mapping (extend as needed) ---
const GENRE_MAP = {
  0: "Unknown Genre",
  1: "Action",
  2: "Strategy",
  3: "RPG",
  4: "Casual",
  5: "Strategy",
  28: "Simulation",
  18: "Sports",
  9: "Racing",
  10: "MMO",
  11: "FPS",
  12: "Puzzle",
  23: "Indie",
  25: "Adventure",
  29: "Massively Multiplayer",
  33: "Indie",
  34: "Indie",
  37: "Free To Play",
  50: "Indie",
  51: "Animation & Modeling",
  52: "Music",
  53: "Software & Tools",
  54: "Education",
  55: "Software & Tools",
  57: "Software & Tools",
  58: "Software & Tools",
  59: "Software & Tools",
  70: "Early Access",
  71: "Sexual Content",
  72: "Sexual Content",
  73: "Adventure",
  74: "Gore",
  60: "Software & Tools"
};

function getGenreName(code) {
  const n = Number(code);
  return GENRE_MAP[n] || `Genre ${n}`;
}


function resetAllModals() {
  document.querySelectorAll('.modal').forEach(modal => {
    modal.classList.remove('show');
    modal.style.display = 'none';
  });
  document.body.classList.remove('modal-open');
}

setInterval(() => {
  const anyVisibleModal = [...document.querySelectorAll('.modal')].some(m => m.classList.contains('show'));
  if (!anyVisibleModal) document.body.classList.remove('modal-open');
}, 1000);


function ensureStandaloneUiFixes() {
  if (document.getElementById('standalone-ui-fixes')) return;

  const style = document.createElement('style');
  style.id = 'standalone-ui-fixes';
  style.textContent = `
    /* Center and constrain custom confirm popup above detail panel */
    #custom-confirm-modal {
      position: fixed !important;
      inset: 0 !important;
      display: none;
      align-items: center !important;
      justify-content: center !important;
      padding: 24px !important;
      z-index: 30000 !important;
      background: rgba(4, 10, 22, 0.58) !important;
      backdrop-filter: blur(6px);
    }
    #custom-confirm-modal.show {
      display: flex !important;
    }
    #custom-confirm-modal .notification-content {
      width: min(92vw, 560px) !important;
      min-width: 0 !important;
      max-width: 560px !important;
      margin: 0 auto !important;
      background: linear-gradient(145deg,#0f1524,#101828 58%,#0d1320) !important;
      border: 1px solid rgba(102,192,244,0.18) !important;
      border-radius: 16px !important;
      box-shadow: 0 24px 80px rgba(0,0,0,0.55) !important;
      padding: 20px 20px 16px !important;
      text-align: center !important;
      color: #eef7ff !important;
    }
    #custom-confirm-msg {
      margin-bottom: 18px !important;
      font-size: 14px !important;
      line-height: 1.6 !important;
      white-space: normal !important;
      word-break: break-word !important;
    }
    #custom-confirm-ok,
    #custom-confirm-cancel {
      min-width: 110px !important;
      height: 40px !important;
      padding: 0 16px !important;
      border-radius: 10px !important;
      font-size: 14px !important;
      font-weight: 700 !important;
    }

    /* Restore normal section layout */
    #ugm-actions .game-actions-section {
      display: grid !important;
      grid-template-columns: repeat(2, max-content) !important;
      justify-content: start !important;
      gap: 8px !important;
      align-items: start !important;
    }

    #ugm-actions .game-actions-section-title {
      grid-column: 1 / -1 !important;
      width: auto !important;
      margin-bottom: 2px !important;
    }

    /* Only customize the Standalone Unsteam row */
    #ugm-actions .game-actions-section.standalone-section {
      display: flex !important;
      flex-direction: row !important;
      flex-wrap: wrap !important;
      gap: 8px !important;
      align-items: center !important;
    }

    /* Action row (Play + Remove) always breaks to its own line */
    #ugm-actions .standalone-action-row {
      flex-basis: 100% !important;
      display: flex !important;
      flex-wrap: wrap !important;
      gap: 8px !important;
      align-items: center !important;
    }

    #ugm-actions .game-actions-section.standalone-section .game-action-btn.standalone,
    #ugm-actions .game-actions-section.standalone-section .game-action-btn.patch {
      min-width: 200px !important;
      white-space: nowrap !important;
      padding: 4px 16px !important;
      font-size: 14px !important;
    }

    /* Force notification/loading modals above detail window (z-index 10001) */
    .notification-modal,
    #loading-modal,
    #download-complete-modal,
    #remove-complete-modal,
    #details-loading-modal {
      z-index: 20000 !important;
    }

    /* Antivirus warning glow pulse */
    @keyframes avWarningPulse {
      0%, 100% {
        color: #ff4444;
        text-shadow: 0 0 8px rgba(255,0,0,0.5), 0 0 18px rgba(255,0,0,0.3);
        border-color: rgba(255,60,60,0.32);
        background: rgba(220,20,20,0.10);
      }
      50% {
        color: #ff6a6a;
        text-shadow: 0 0 14px rgba(255,0,0,0.95), 0 0 30px rgba(255,60,60,0.65), 0 0 55px rgba(255,0,0,0.28);
        border-color: rgba(255,80,80,0.65);
        background: rgba(220,20,20,0.18);
      }
    }
    .av-warning {
      flex-basis: 100% !important;
      display: flex !important;
      align-items: flex-start !important;
      gap: 9px !important;
      padding: 11px 15px !important;
      border-radius: 8px !important;
      background: rgba(220,20,20,0.10) !important;
      border: 1px solid rgba(255,60,60,0.32) !important;
      margin: 4px 0 10px !important;
      color: #ff4444 !important;
      font-size: 12.5px !important;
      font-weight: 700 !important;
      letter-spacing: 0.25px !important;
      line-height: 1.5 !important;
      text-shadow: 0 0 8px rgba(255,0,0,0.5), 0 0 18px rgba(255,0,0,0.3) !important;
      animation: avWarningPulse 2.2s ease-in-out infinite !important;
    }
    .av-warning-icon {
      font-size: 16px !important;
      flex-shrink: 0 !important;
      margin-top: 1px !important;
    }
  `;
  document.head.appendChild(style);
}
ensureStandaloneUiFixes();

function showOneshotInstallModal() {
  // Show blur and modal
  ensureStandaloneUiFixes();
  document.body.classList.add('modal-open');
  const modal = document.getElementById('oneshot-install-modal');
  modal.style.display = 'flex';
  modal.classList.add('show');
  modal.style.zIndex = '30000';
  document.getElementById('oneshot-install-progress').value = 0;
  document.getElementById('oneshot-install-label').textContent = 'Preparing…';
}

function hideOneshotInstallModal() {
  const modal = document.getElementById('oneshot-install-modal');
  modal.style.display = 'none';
  modal.classList.remove('show');
  document.body.classList.remove('modal-open');
  document.getElementById('oneshot-install-progress').value = 0;
  document.getElementById('oneshot-install-label').textContent = '';
}


function customConfirm(message) {
  return new Promise((resolve) => {
    const modal = document.getElementById('custom-confirm-modal');
    const msg = document.getElementById('custom-confirm-msg');
    const okBtn = document.getElementById('custom-confirm-ok');
    const cancelBtn = document.getElementById('custom-confirm-cancel');

    msg.innerHTML = message;
    modal.classList.add('show');
    modal.style.display = 'flex';
    document.body.classList.add('modal-open');

    function cleanup(result) {
      modal.classList.remove('show');
      modal.style.display = 'none';
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      resolve(result);
    }

    okBtn.onclick = () => cleanup(true);
    cancelBtn.onclick = () => cleanup(false);
    modal.onclick = (e) => {
      if (e.target === modal) cleanup(false);
    };
  });
}

// Cache DOM elements globally for reuse
const modal = document.getElementById('activation-modal');
const backdrop = document.getElementById('modal-backdrop');
const confirmBtn = document.getElementById('modal-confirm');
const cancelBtn = document.getElementById('modal-cancel');
const cdInput = document.getElementById('modal-cdkey');
const feedback = document.getElementById('modal-feedback');
const activateBtn = document.getElementById('activate-btn');
const sidebar = document.getElementById('sidebar');
const openBtn = document.getElementById('sidebar-open-btn');
const closeBtn = document.getElementById('sidebar-toggle');
const mainContent = document.getElementById('main-content');




function showModal(modalId = 'activation-modal') {
  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.style.display = 'flex'; // or 'block' depending on your CSS
  modal.classList.add('show');

  document.body.classList.add('modal-open');

  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) backdrop.style.display = 'block';
}


function hideModal(modalId = 'activation-modal') {
  if (window.forceActivationModal && modalId === 'activation-modal') { return; }
  const modal = document.getElementById(modalId);
  if (!modal) return;

  modal.style.display = 'none';
  modal.classList.remove('show');

  // Delay to let transition finish (if any)
  setTimeout(() => {
    const anyVisible = !!document.querySelector('.modal.show, .notification-modal.show');
    if (!anyVisible) {
      document.body.classList.remove('modal-open');

      const backdrop = document.getElementById('modal-backdrop');
      if (backdrop) backdrop.style.display = 'none';
    }
  }, 10);
}

function toggleAppActivationUI(isActivated) {
  const allButtons = document.querySelectorAll('button');
  const cdField    = document.getElementById('modal-cdkey');
  const confirmBtn = document.getElementById('modal-confirm');
  const cancelBtn  = document.getElementById('modal-cancel');

  if (!isActivated) {
    if (mainContent) mainContent.classList.add('blur');

    allButtons.forEach(btn => {
      // Keep Activate (main), sidebar open, and modal-confirm enabled
      if (btn === activateBtn || btn === openBtn || btn === confirmBtn) {
        btn.disabled = false;
      } else {
        btn.disabled = true;
      }
    });
    // Keep input editable
    if (cdField) cdField.disabled = false;
    // Explicitly disable cancel
    if (cancelBtn) cancelBtn.disabled = true;
  } else {
    if (mainContent) mainContent.classList.remove('blur');
    allButtons.forEach(btn => btn.disabled = false);
  }
}

let activationModalManuallyOpened = false;

let lastShouldEnable = null;   // true when activated for *current* SteamID
let lastWasMismatch  = null;
let lastRestartTs    = 0;
let _didFirstPoll    = false;
const steamRestartCooldownMs = 30000;


// --- Persistent edge-state & suppression ---
const PERSIST_KEY = 'astate_v1';
const SUPPRESS_KEY = 'suppressRestart';
const SUPPRESS_UNTIL_KEY = 'suppressUntil';

let _persist = {};
try { _persist = JSON.parse(sessionStorage.getItem(PERSIST_KEY) || '{}'); } catch {}


// hydrate from persisted state if available
if (_persist && typeof _persist === 'object') {
  if (_persist.lastShouldEnable !== undefined) lastShouldEnable = _persist.lastShouldEnable;
  if (_persist.lastWasMismatch  !== undefined) lastWasMismatch  = _persist.lastWasMismatch;
  if (_persist.lastRestartTs    !== undefined) lastRestartTs    = _persist.lastRestartTs;
}

function savePersist() {
  sessionStorage.setItem(PERSIST_KEY, JSON.stringify({
    lastShouldEnable, lastWasMismatch, lastRestartTs
  }));
}
function isRestartSuppressed() {
  const until = Number(sessionStorage.getItem(SUPPRESS_UNTIL_KEY) || 0);
  const active = sessionStorage.getItem(SUPPRESS_KEY) === '1' && Date.now() < until;
  if (!active) {
    sessionStorage.removeItem(SUPPRESS_KEY);
    sessionStorage.removeItem(SUPPRESS_UNTIL_KEY);
  }
  return active;
}
function computeShouldEnable(data) {
  const info = data.activation_info || {};
  const storedSteamid  = info.steamid;
  const currentSteamid = data.steamid;
  const status = String(info.status || "").trim().toLowerCase();
  const okStatus = status === "activated" || status === "success" || status === "true" || status === "ok";
  return Boolean(storedSteamid && currentSteamid && storedSteamid === currentSteamid && okStatus);
}
let lastSteamIdState = null;
function isMismatch(data) {
  const info = data.activation_info || {};
  const storedSteamid  = info.steamid;
  const currentSteamid = data.steamid;
  // Mismatch only when both IDs exist and differ
  return Boolean(storedSteamid && currentSteamid && storedSteamid !== currentSteamid);
}

function getSteamIdState(data) {
  const info = data.activation_info || {};
  const storedSteamid  = info.steamid;
  const currentSteamid = data.steamid;
  if (!storedSteamid || !currentSteamid) return 'unknown';
  return storedSteamid === currentSteamid ? 'match' : 'mismatch';
}

// Restarts once when state flips into 'match' or 'mismatch'
async function maybeAutoRestartOnState(data) {
  // Optional: skip during your "Refresh Game List" window, if you implemented this helper
  if (typeof isRestartSuppressed === 'function' && isRestartSuppressed()) return;

  const state = getSteamIdState(data);

  // Edge detection: only when state changes
  const flipped = state !== lastSteamIdState;
  const wantsRestart = (state === 'match' || state === 'mismatch') && flipped;
  const cooldownOk = (Date.now() - lastRestartTs) > (typeof steamRestartCooldownMs !== 'undefined' ? steamRestartCooldownMs : 500);

  if (wantsRestart && cooldownOk) {
    lastRestartTs = Date.now();
    try {
      await fetch('/api/restart_steam', { method: 'POST' });
      console.log(`[AutoRestart] Restart due to SteamID state change → ${state}.`);
    } catch (e) {
      console.warn('[AutoRestart] Restart request failed:', e);
    }
  }

  lastSteamIdState = state;
}


async function maybeAutoRestartOnMismatch(data) {
  // First poll after load? Just record and bail (prevents false fire on page reload)
  const mismatchNow = isMismatch(data);
  if (!didFirstPoll) {
    lastWasMismatch = mismatchNow;
    didFirstPoll = true;
    return;
  }

  // Flip detection: non-mismatch -> mismatch
  const flippedToMismatch = (lastWasMismatch !== true) && mismatchNow;
  const cooldownOk = (Date.now() - lastRestartTs) > (typeof steamRestartCooldownMs !== 'undefined' ? steamRestartCooldownMs : 30000);

  if (flippedToMismatch && cooldownOk) {
    lastRestartTs = Date.now();
    try {
      await fetch('/api/restart_steam', { method: 'POST' });
      console.log('[AutoRestart] Restart due to SteamID mismatch transition.');
    } catch (e) {
      console.warn('[AutoRestart] Restart request failed:', e);
    }
  }

  // Track for next poll
  lastWasMismatch   = mismatchNow;
  lastShouldEnable  = false; // definitely not enabled for *this* SteamID now

  // Trackers for next poll
  lastShouldEnable = false;
  lastWasMismatch  = mismatchNow;
  try { savePersist && savePersist(); } catch(_){}
}

async function maybeAutoRestartOnMatch(data) {
  const shouldEnable = computeShouldEnable(data); // activated for THIS SteamID
  const flippedToEnabled = (lastShouldEnable !== true) && shouldEnable;
  const needRestart = Boolean(data.restart_required || flippedToEnabled);
  const cooldownOk = (Date.now() - lastRestartTs) > steamRestartCooldownMs;

  if (needRestart && cooldownOk) {
    lastRestartTs = Date.now();
    try {
      await fetch('/api/restart_steam', { method: 'POST' });
      console.log('[AutoRestart] Restart triggered due to activation match transition.');
    } catch (e) {
      console.warn('[AutoRestart] Restart request failed:', e);
    }
  }

  lastShouldEnable = shouldEnable; // track for next poll
}

// optional global flag if you have a manual "Activate" button
window.activationModalManuallyOpened = window.activationModalManuallyOpened || false;

function setImgOrHide(imgEl, url) {
  if (!imgEl) return;
  const u = (url || '').trim();
  if (!u) { imgEl.style.display = 'none'; return; }
  imgEl.style.display = '';
  imgEl.src = u;
}

async function checkActivationStatus(opts = {}) {
  try {
    const modalVisible = document.getElementById('activation-modal')?.classList.contains('show');

    // Only request persona/avatar when it matters
    const wantProfile =
      !!opts.profile ||
      modalVisible ||
      window.activationModalManuallyOpened ||
      window.forceActivationModal;

    const url = wantProfile ? '/activation-status?profile=1' : '/activation-status';
    const res = await fetch(url, { cache: 'no-store' });
    if (!res.ok) throw new Error("Failed to get activation status");
    const data = await res.json();
    updateActivatedMiniProfile(data);


    // --- steamid mismatch check (simple + robust) ---
    const info = data.activation_info || {};
    const storedSteamid  = info.steamid;
    const currentSteamid = data.steamid;

    const isMismatch = Boolean(storedSteamid && currentSteamid && storedSteamid !== currentSteamid);

    if (isMismatch) {
      // Fill IDs
      const el1 = document.getElementById('activated-steamid');
      if (el1) el1.textContent = storedSteamid || 'UNKNOWN';
      const el2 = document.getElementById('current-steamid');
      if (el2) el2.textContent = currentSteamid || 'UNKNOWN';

      // Ensure we have profile data (avatars) for mismatch modal
      // If we didn't request profile this call, fetch once with profile=1.
      if (!data.avatar_url && !wantProfile) {
        try {
          const res2 = await fetch('/activation-status?profile=1', { cache: 'no-store' });
          if (res2.ok) {
            const data2 = await res2.json();
            Object.assign(data, data2);
          }
        } catch (_) {}
      }

      // Current account persona + avatar
      const curPersonaEl = document.getElementById('mismatch-current-persona');
      if (curPersonaEl) curPersonaEl.textContent = data.persona_name || 'Unknown Steam User';
      setImgOrHide(document.getElementById('mismatch-current-avatar'), data.avatar_url);

      // Activated account persona + avatar
      // Best case: backend includes activated_persona_name / activated_avatar_url
      // Fallback: show SteamID only if backend doesn't provide these fields.
      const actPersonaEl = document.getElementById('mismatch-activated-persona');
      if (actPersonaEl) actPersonaEl.textContent = data.activated_persona_name || 'Unknown Steam User';
      setImgOrHide(document.getElementById('mismatch-activated-avatar'), data.activated_avatar_url);

      hideModal('activation-modal');
      showModal('steamid-mismatch-modal');
      return;
    } else {
      hideModal('steamid-mismatch-modal');
    }

    // --- normalize status label ---
    if (info && String(info.status || '').toLowerCase() === 'success') {
      info.status = 'Activated';
    }

    // --- derive type with better defaults ---
    const expiredFlag = (info && info.expired === true);
    const expiryStr   = info.expiry_date || null;
    let actType       = (data.activation_type || info.activation_type || info.key_type || '').toUpperCase();
    if (!actType) {
      actType = (expiryStr || expiredFlag) ? 'MONTHLY' : (data.activated ? 'LIFETIME' : '');
    }
    const actTypeDisplay = actType || '—';

    // Set global activation type for use in renderPage and other functions
    window.activationType = actType;

    // --- compute expired by date if backend didn't send it ---
    let isExpired = expiredFlag;
    if (!isExpired && expiryStr) {
      const exp = new Date(`${expiryStr}T23:59:59`);
      if (!isNaN(exp)) isExpired = (Date.now() > exp.getTime());
    }

    const modalSteamID      = document.getElementById('modal-steamid');
    const activationInfoDiv = document.getElementById('modal-activation-info') || document.getElementById('activation-info');
    const cdKeyLabel        = document.getElementById('modal-cdkey-label');
    const cdKeyInput        = document.getElementById('modal-cdkey');
    const modalConfirmBtn   = document.getElementById('modal-confirm');
    const cancelBtnLocal    = document.getElementById('modal-cancel');

    // ====== NEW: fill persona + avatar in activation modal ======
    if (modalSteamID) modalSteamID.textContent = data.steamid || "UNKNOWN";

    const personaEl = document.getElementById('modal-persona');
    if (personaEl) personaEl.textContent = data.persona_name || 'Unknown Steam User';

    const avatarEl = document.getElementById('modal-avatar');
    if (avatarEl) {
      const url = (data.avatar_url || '').trim();
      if (avatarEl.tagName === 'IMG') {
        // if you're using <img id="modal-avatar" ...>
        if (url) avatarEl.src = url;
      } else {
        // if you're using <div id="modal-avatar" ...>
        avatarEl.style.backgroundImage = url ? `url("${url}")` : '';
        avatarEl.classList.toggle('has-img', !!url);
        const initial = ((data.persona_name || 'S').trim()[0] || 'S').toUpperCase();
        avatarEl.setAttribute('data-initial', initial);
      }
    }
    // ====== END NEW ======

    // helper to disable cancel fully
    function lockCancel(btn, title) {
      if (!btn) return;
      btn.disabled = true;
      btn.title = title || 'Activation required';
      try { btn.onclick = function(e){ e.preventDefault(); e.stopPropagation(); return false; }; } catch(e) {}
    }

    // ===== expired handling: force modal, no notification, no reset button =====
    if (isExpired) {
      const cdKeyTxt = info.cd_key || info.cdkey || info.key || "N/A";
      if (activationInfoDiv) {
        activationInfoDiv.innerHTML = `
          <p><strong>Status:</strong> Expired</p>
          <p><strong>CD Key:</strong> ${cdKeyTxt}</p>
          <p><strong>Activation Date:</strong> ${info.activation_date || "N/A"}</p>
          <p><strong>Expiry Date:</strong> ${expiryStr || "N/A"}</p>
          <p><strong>Activation Type:</strong> ${actTypeDisplay}</p>
          <p style="color:#f44336;font-weight:bold;">Your monthly key has expired. Please enter a new key.</p>
        `;
      }

      if (cdKeyLabel) cdKeyLabel.style.display = 'block';
      if (cdKeyInput) { cdKeyInput.style.display = 'block'; cdKeyInput.disabled = false; if (!cdKeyInput.value) cdKeyInput.focus(); }
      if (modalConfirmBtn) { modalConfirmBtn.style.display = 'inline-block'; modalConfirmBtn.disabled = false; }

      const rb = document.getElementById('modal-reset'); if (rb) rb.style.display = 'none';

      lockCancel(cancelBtnLocal, "Expired – please enter a new CD Key");

      window.forceActivationModal = true;
      toggleAppActivationUI(false);
      showModal('activation-modal');
      return;
    }

    // ===== normal flow =====
    if (data.activated) {
      if (activationInfoDiv) {
        activationInfoDiv.innerHTML = `
          <p><strong>Status:</strong> ${info.status || "Activated"}</p>
          <p><strong>CD Key:</strong> ${info.cd_key || "N/A"}</p>
          <p><strong>Activation Date:</strong> ${info.activation_date || "N/A"}</p>
          <p><strong>Expiry Date:</strong> ${expiryStr || "N/A"}</p>
          <p><strong>Activation Type:</strong> ${actTypeDisplay}</p>
          <p style="color:#4CAF50;font-weight:bold;">Your app is activated for this SteamID.</p>
        `;
      }
      if (cdKeyLabel) cdKeyLabel.style.display = 'none';
      if (cdKeyInput) cdKeyInput.style.display = 'none';
      if (modalConfirmBtn) modalConfirmBtn.style.display = 'none';
      const rb = document.getElementById('modal-reset'); if (rb) rb.style.display = 'none';
      window.forceActivationModal = false;
    } else {
      if (activationInfoDiv) {
        activationInfoDiv.innerHTML = `
          <p><strong>Status:</strong> Not Activated</p>
          <p><strong>CD Key:</strong> ${info.cd_key || "N/A"}</p>
          <p><strong>Activation Date:</strong> ${info.activation_date || "N/A"}</p>
          <p><strong>Expiry Date:</strong> ${expiryStr || "N/A"}</p>
          <p><strong>Activation Type:</strong> ${actTypeDisplay}</p>
          <p style="color:#f44336;font-weight:bold;">App not activated or SteamID mismatch.</p>
        `;
      }
      if (cdKeyLabel) cdKeyLabel.style.display = 'block';
      if (cdKeyInput)  cdKeyInput.style.display  = 'block';
      if (modalConfirmBtn) { modalConfirmBtn.style.display = 'inline-block'; modalConfirmBtn.disabled = false; }

      const rb = document.getElementById('modal-reset'); if (rb) rb.style.display = 'none';

      lockCancel(cancelBtnLocal, "Activation required");
      window.forceActivationModal = true;
      showModal('activation-modal');
    }

    toggleAppActivationUI(Boolean(data.activated));


    // ✅ only prompt restart when backend says it's required
    if (data.restart_required) {
      maybePromptRestartOnce();
    }

  } catch (err) {
    console.error("Activation status check error:", err);
  }
}

document.addEventListener("DOMContentLoaded", async () => {
  await checkActivationStatus();

  // Get activation status from backend
  try {
    const res = await fetch('/activation-status');
    const data = await res.json();
    if (data.activated) {
    }
  } catch (err) {
    console.error("Could not check activation status for update check:", err);
  }
  await checkUnlockAllPermission();
  setInterval(checkActivationStatus, 5000);
});


function forceRefreshPywebview() {
  if (window.pywebview && window.pywebview.api && window.pywebview.api.reload_window) {
    window.pywebview.api.reload_window();
  } else {
    // window.location.reload(); // disabled to avoid unnecessary restarts during refresh
}
}

activateBtn.addEventListener('click', () => {
  feedback.textContent = '';
  cdInput.value = '';
  confirmBtn.disabled = false;
  activationModalManuallyOpened = true;   // <--- set flag
  hideModal();
  showModal('activation-modal');
  checkActivationStatus({ profile: true });
});
// Confirm button -> perform activation
if (confirmBtn) {
  confirmBtn.addEventListener('click', async () => {
    try {
      if (!cdInput) return;
      const key = (cdInput.value || '').trim().toUpperCase();
      if (!key) {
        if (feedback) feedback.textContent = 'Please enter a CD Key.';
        return;
      }
      confirmBtn.disabled = true;
      if (feedback) feedback.textContent = 'Activating...';

      const steamidEl = document.getElementById('modal-steamid');
      const sid = steamidEl ? (steamidEl.textContent || '').trim() : '';

      const resp = await fetch('/validate-onennabe-cdkey', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ cd_key: key, steamid: sid })
      });

      let json = {};
      try { json = await resp.json(); } catch(e) {}

      if (resp.ok && json && json.status === 'success') {
        if (feedback) feedback.textContent = 'Activated!';
        window.forceActivationModal = false;
        await checkActivationStatus(); // refresh UI
        hideModal('activation-modal');
      } else {
        const msg = (json && json.message) ? json.message : 'Validating..';
        if (feedback) feedback.textContent = msg;
        confirmBtn.disabled = false;
      }
    } catch (e) {
      if (feedback) feedback.textContent = 'Activation error.';
      confirmBtn.disabled = false;
      console.error('Activation error:', e);
    }
  });
}

let _activatedMiniHydrated = false;
let _activatedMiniLastSid = null;

function updateActivatedMiniProfile(data) {
  const box = document.getElementById('activated-mini-profile');
  if (!box) return;

  const sid = (data.activated_steamid || (data.activation_info || {}).steamid || '').trim();
  if (!sid) {
    box.style.display = 'none';
    return;
  }
  box.style.display = 'flex';

  const persona = (data.activated_persona_name || 'Unknown Steam User').trim();
  const avatar = (data.activated_avatar_url || '').trim();

  const personaEl = document.getElementById('activated-mini-persona');
  const sidEl = document.getElementById('activated-mini-steamid');
  const imgEl = document.getElementById('activated-mini-avatar');

  if (personaEl) personaEl.textContent = persona || 'Unknown Steam User';
  if (sidEl) sidEl.textContent = sid;

  // IMPORTANT: Only overwrite avatar if we actually got a URL (prevents "appears then disappears")
  if (imgEl && avatar) imgEl.src = avatar;

  // One-time hydrate (or if activated SteamID changed) to fetch avatar via profile=1
  if ((!_activatedMiniHydrated || _activatedMiniLastSid !== sid) && !avatar) {
    _activatedMiniHydrated = true;
    _activatedMiniLastSid = sid;

    fetch('/activation-status?profile=1', { cache: 'no-store' })
      .then(r => r.ok ? r.json() : null)
      .then(d2 => { if (d2) updateActivatedMiniProfile(d2); })
      .catch(() => {});
  }
}


cancelBtn.addEventListener('click', (e) => {
  if (window.forceActivationModal) { e.preventDefault(); e.stopPropagation(); return false; }
  hideModal('activation-modal');
});

confirmBtn.addEventListener('click', async () => {
  const cd = cdInput.value.trim();
  if (!cd) {
    feedback.style.color = '#f66';
    feedback.textContent = 'Please enter a CD Key.';
    return;
  }

  confirmBtn.disabled = cancelBtn.disabled = true;
  feedback.style.color = 'white';
  feedback.textContent = 'Activating…';

  try {
    const res = await fetch('/activate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ cd_key: cd }),
    });

    const data = await res.json();

    if (res.ok) {
      feedback.style.color = '#2e8b57';
      feedback.textContent = '✅ ' + data.message;
      activateBtn.disabled = true;
      activateBtn.textContent = "Activated";

      await checkActivationStatus();
      await fetchGames();

      await checkUnlockAllPermission();

      // NEW: Apply monthly license UI restrictions
      if (typeof applyLicenseUI === 'function') {
        await applyLicenseUI();
      }

      if (mainContent) mainContent.classList.remove('blur');
      document.querySelectorAll('button').forEach(btn => btn.disabled = false);

      hideModal();
    } else {
      feedback.style.color = '#f66';
      feedback.textContent = '❌ ' + data.message;
    }
  } catch (err) {
    feedback.style.color = '#f66';
    feedback.textContent = 'Error: ' + err.message;
  } finally {
    confirmBtn.disabled = cancelBtn.disabled = false;
  }
});

let allGames = [];
let filteredGames = [];
let currentPage = 1;
const perPage = 30;

async function fetchGames() {
  try {
    const res = await fetch('/api/games');
    allGames = await res.json();
    console.log("Fetched games count:", allGames.length);

    applyFiltersAndRender({ resetPage: true, installedOnly: getInstalledOnly() });

    // NEW: build chips from what’s present
    buildGenreChipsFromData(allGames);

    preloadImagesForPage(1);
    applyFiltersAndRender({ resetPage: true });
  } catch (err) {
    console.error("Error fetching games:", err);
  }
}

async function ensureGamesCacheAndRender() {
  try {
    let res = await fetch('/api/games', { cache: 'no-store' });
    if (!res.ok) throw new Error('no-cache');
    let data = await res.json();
    if (!Array.isArray(data) || data.length === 0) throw new Error('empty');

    allGames = data;
  } catch (_) {
    // First load failed or empty? Ask server to (re)build the cache, then retry.
    try {
      await fetch('/api/fetch_games', { method: 'POST' });
      const res2 = await fetch('/api/games', { cache: 'no-store' });
      allGames = await res2.json();
    } catch (e) {
      console.error('Failed to bootstrap game cache:', e);
      return; // bail quietly; avoids breaking the rest of the UI
    }
  }

  // Keep your existing flow
  const __installedOnlyNow = getInstalledOnly();
if (__installedOnlyNow) { await refreshInstalledSet(); }
filteredGames = __installedOnlyNow
  ? allGames.filter(g => (window.__installedSet || new Set()).has(String(g.appid)))
  : allGames;
preloadImagesForPage(1);
  currentPage = 1;
  applyFiltersAndRender({ resetPage: true });
}


function scrollToTop() {
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

function getLocalCachedImageUrl(appid) {
  return `/cache_images/${appid}.jpg`;
}

// Fallback loading: Steam CDN -> local cached -> placeholder
function loadGameCover(imgElement, appid) {
  imgElement.src = `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/library_600x900.jpg`;

  imgElement.onload = () => {
    imgElement.classList.add('loaded');  // mark loaded to remove blur/filter if any
  };

  imgElement.onerror = () => {
    imgElement.onerror = () => {
      imgElement.src = '/static/placeholder.jpg';
    };
    imgElement.src = `/cache_images/${appid}.jpg`;  // fallback to local cached image
  };
}

function preloadImagesForPage(page) {
  const start = (page - 1) * perPage;
  const end = start + perPage;
  const pageData = filteredGames.slice(start, end);
  pageData.forEach(game => {
    const img = new Image();
    img.src = getLocalCachedImageUrl(game.appid);
  });
}

// Helper to get SteamID from backend
async function getSteamID() {
  try {
    const res = await fetch('/activation-status');
    if (!res.ok) throw new Error('Failed to fetch activation status');
    const data = await res.json();
    return data.steamid || "UNKNOWN";
  } catch (err) {
    console.error("Error fetching SteamID:", err);
    return "UNKNOWN";
  }
}

async function registerGameDownload(appid) {
  try {
    const res = await fetch(`/api/track_download/${appid}`, { method: 'POST' });
    if (!res.ok) {
      console.warn(`Failed to track download for ${appid}`);
    }
  } catch(e) {
    console.error(`Error tracking download for ${appid}:`, e);
  }
}

// Call this function after successful download to register game to server
async function registerGameToServer(appid) {
  const steamid = await getSteamID();
  if (!steamid || steamid === "UNKNOWN") {
    console.warn("SteamID unavailable; skipping game registration.");
    return;
  }

  try {
    const res = await fetch('/api/user/add-game', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ steamid: steamid, appids: [String(appid)] }),
    });

    const data = await res.json();
    if (!res.ok) {
      console.warn(`Failed to register game ${appid}:`, data.message);
    } else {
      console.log(`Game ${appid} registered successfully.`);
    }
  } catch (err) {
    console.error(`Error registering game ${appid}:`, err);
  }
}

async function downloadGame(appid) {
  const game = findGameByAppId(appid);

  if (game && needsMembership(game.requires_membership)) {  // ← CHANGED
    showDenuvoWarning(game, () => actuallyDownloadGame(appid));
  } else {
    await actuallyDownloadGame(appid);
  }
}

// Bulk download handler with progress polling and cancel option
async function startBulkDownload(appids) {
  document.body.classList.add('modal-open');
  hideModal();
  showModal('bulk-appid-modal');

  const progressText  = document.getElementById('bulk-progress-text');
  const progressBar   = document.getElementById('bulk-progress-bar');
  const cancelBtnBulk = document.getElementById('bulk-appidcancel-btn');
  const completedClose= document.getElementById('completed-close-btn');

  progressText.textContent = 'Starting download...';
  progressBar.value        = 0;
  cancelBtnBulk.disabled   = false;

cancelBtnBulk.onclick = async () => {
  cancelBtnBulk.disabled = true;
  try {
    await fetch('/api/bulk_download/cancel', {method:'POST'});
    progressText.textContent = 'Cancelling...';
  } catch (err) {
    showNotification('Cancel failed: ' + err.message, {
      buttonText: "Close",
      onClose: () => { cancelBtnBulk.disabled = false; }
    });
  }
};

  let polling = setInterval(async () => {
    try {
      const res = await fetch('/api/bulk_download/status');
      if (!res.ok) throw new Error(res.statusText);
      const s  = await res.json();
      if (s.status === 'running') {
        progressBar.value     = Math.floor((s.current_index/s.total)*100);
        progressText.textContent = `Downloading ${s.current_index} of ${s.total} (AppID: ${s.current_appid})`;
      } else {
        clearInterval(polling);
        hideModal('bulk-appid-modal');
        if (s.status === 'finished') {
          setTimeout(() => {
            promptRestartSteam();           // <— add this
          }, 1200);
          await fetchGames();
        } else {
          //showNotification("Bulk download cancelled.", { title: "Bulk Download", buttonText: "OK" });
        }
      }
    } catch (e) {
      clearInterval(polling);
      document.body.classList.remove('modal-open');
      hideModal('bulk-appid-modal');
      alert('Error checking status: ' + e.message);
    }
  }, 1000);

}


function showRefreshListModal() {
  const modal = document.getElementById('refresh-list-modal');
  modal.classList.add('show');
  document.getElementById('modal-backdrop').style.display = 'block';
  document.body.classList.add('modal-open');
  document.getElementById('refresh-progress-bar').value = 0;
  document.getElementById('refresh-progress-label').textContent = 'Starting...';
}

function hideRefreshListModal() {
  const modal = document.getElementById('refresh-list-modal');
  modal.classList.remove('show');
  document.getElementById('modal-backdrop').style.display = 'none';
  document.body.classList.remove('modal-open');
  document.getElementById('refresh-progress-bar').value = 0;
  document.getElementById('refresh-progress-label').textContent = '';
}

// ---- helper: fetch fresh (no-cache) and render once ----
async function fetchGamesFreshAndRender({ resetPage = false } = {}) {
  console.log('🔄 fetchGamesFreshAndRender called, setting rendering lock');
  isRendering = true; // Prevent search handler from interfering

  try {
    const res = await fetch('/api/games', {
      cache: 'no-store',
      headers: { 'Cache-Control': 'no-store', 'Pragma': 'no-cache' }
    });
    if (!res.ok) throw new Error('Failed to load /api/games');

    allGames = await res.json();
    console.log('🔄 Loaded', allGames.length, 'games');

    const installedOnly = getInstalledOnly();
    if (installedOnly) await refreshInstalledSet();

    applyFiltersAndRender({ resetPage, installedOnly }); // pass the flag through
    console.log('🔄 Rendered, clearing lock in 100ms');
  } finally {
    // Clear the flag after a small delay to ensure rendering is complete
    setTimeout(() => {
      isRendering = false;
      console.log('🔄 Rendering lock cleared');
    }, 100);
  }
}

// ---- unified modal flow (used by startup + Refresh button) ----
async function buildCacheAndReloadUI_viaModal() {
  // Suppress any auto-restart for ~15s while we refresh the list
  sessionStorage.setItem('suppressRestart', '1');
  sessionStorage.setItem('suppressUntil', String(Date.now() + 15000));
  showRefreshListModal();

  const btn = document.getElementById('refresh-games-btn');
  const progressBar = document.getElementById('refresh-progress-bar');
  const label = document.getElementById('refresh-progress-label');
  const fakeStages = ['Contacting server','Checking for new games','Downloading list','Updating UI','Finalizing'];

  // prevent double-clicks while running
  btn?.setAttribute('disabled', 'true');

  let progress = 0, dots = 0, stageIdx = 0;
  const interval = setInterval(() => {
    if (progress < 90) {
      progress += Math.random() * 10 + 2;
      progressBar.value = Math.min(progress, 95);
      if (progress > (stageIdx + 1) * 18 && stageIdx < fakeStages.length - 1) stageIdx++;
      dots = (dots + 1) % 4;
      label.textContent = fakeStages[stageIdx] + '.'.repeat(dots);
    }
  }, 200);

  try {
    // ALWAYS rebuild cache on demand (after app start)
    const res = await fetch('/api/fetch_games', { method: 'POST' });
    if (!res.ok && res.status !== 202) throw new Error('fetch_games failed');

    // Now reload fresh and paint once
    await fetchGamesFreshAndRender();

    progressBar.value = 100;
    label.textContent = "Done!";
  } catch (e) {
    label.textContent = "Failed!";
    progressBar.value = 0;
    setTimeout(() => alert("Failed to fetch latest games: " + e.message), 50);
  } finally {
    clearInterval(interval);
    setTimeout(() => {
      hideRefreshListModal();
      btn?.removeAttribute('disabled');
      sessionStorage.removeItem('suppressRestart');
      sessionStorage.removeItem('suppressUntil');
    }, 700);
  }
}

// ---- wire the Refresh button to the same flow ----
document.getElementById('refresh-games-btn')
  .addEventListener('click', buildCacheAndReloadUI_viaModal);

// ---- FORCE rebuild & modal on FIRST LOAD, every time ----
document.addEventListener('DOMContentLoaded', async () => {
  // Always show modal and rebuild on startup
  await buildCacheAndReloadUI_viaModal();
});

// ---- helpers (drop near your other utilities) ----
function isInstalledOnlyActive(){
  // prefer your real UI id if you have one; adjust if different
  const btn = document.getElementById('show-installed-btn');
  if (btn) return btn.classList.contains('active') || btn.ariaPressed === 'true';
  return !!window.showInstalledOnly; // fallback
}

function getCurrentPage() {
  const lbl = document.getElementById('page-label');
  const n = parseInt((lbl?.textContent || '').replace(/\D+/g, ''), 10);
  return isNaN(n) ? 1 : n;
}

async function filterGamesByInstalled(allGames) {
  // Always recompute installed appids from disk so it's accurate after removal
  const installedAppids = await getInstalledLuaAppids(); // <-- your existing function
  const set = new Set(installedAppids.map(String));
  return allGames.filter(g => set.has(String(g.appid)));
}

function goToPage(target) {
  const prevBtn = document.getElementById('prev');
  const nextBtn = document.getElementById('next');
  const cur = () => getCurrentPage();
  let guard = 200;
  while (cur() < target && nextBtn && !nextBtn.disabled && guard--) nextBtn.click();
  while (cur() > target && prevBtn && !prevBtn.disabled && guard--) prevBtn.click();
}


// ---- your remove flow (updated to use the fresh helper) ----
async function removeGame(appid) {
  try {
    console.log('=== REMOVE GAME ===');
    console.log('AppID:', appid);
    console.log('URL:', `/remove/${appid}`);

    const keepPage = (() => {
      const t = document.getElementById('page-label')?.textContent || '';
      const n = parseInt(t.replace(/\D+/g,''),10);
      return isNaN(n) ? currentPage : n;
    })();

    showModal('loading-modal');
    const res = await fetch(`/remove/${appid}`);

    console.log('Response status:', res.status);
    const responseText = await res.text();
    console.log('Response text:', responseText);

    hideModal('loading-modal');

    if (!res.ok) {
      alert(`Failed to remove game: ${responseText}`);
      return;
    }

    // Reload cart from server (Flask will have already removed it)
    await loadCartFromServer();
    console.log('🛒 Reloaded cart after game removal');

    showModal('remove-complete-modal');
    setTimeout(() => hideModal('remove-complete-modal'), 2000);

    await fetchGamesFreshAndRender({ resetPage: false });

    // If renderer doesn’t keep page, navigate back
    setTimeout(() => {
      const prevBtn = document.getElementById('prev');
      const nextBtn = document.getElementById('next');
      const getP = () => {
        const t = document.getElementById('page-label')?.textContent || '';
        const n = parseInt(t.replace(/\D+/g,''),10);
        return isNaN(n) ? currentPage : n;
      };
      let guard = 200;
      while (getP() < keepPage && nextBtn && !nextBtn.disabled && guard--) nextBtn.click();
      while (getP() > keepPage && prevBtn && !prevBtn.disabled && guard--) prevBtn.click();
    }, 0);

  } catch (e) {
    hideModal('loading-modal');
    alert("Remove error: " + e.message);
  }
}


// --- helper: force the Installed Only state in BOTH globals + UI (no fetch, no click) ---
function forceInstalledOnly(enabled){
  window.showInstalledOnly = !!enabled;                         // <-- the global your code uses
  const btn = document.getElementById('show-installed-btn');    // adjust ID if different
  if (btn){
    btn.classList.toggle('active', enabled);
    btn.setAttribute('aria-pressed', enabled ? 'true' : 'false');
    // If you also toggle a data attribute or other class in your code, set it here too.
  }
}


async function renderPage() {
  // Prevent multiple simultaneous renders
  if (renderPage.rendering) {
    console.log("⚠️ Render already in progress, skipping duplicate call");
    return;
  }

  renderPage.rendering = true;
  console.log("Rendering page", currentPage, "with", filteredGames.length, "games");

  try {
    const grid = document.getElementById('game-grid');
    grid.innerHTML = '';
  const start = (currentPage - 1) * perPage;
  const end = start + perPage;
  const pageData = filteredGames.slice(start, end);
  const launcherStatusMap = await getLauncherStatusMapForPage(pageData);
  const adultCodes = new Set(["3", "4"]);

  // Check if user is monthly (for hiding bypass features)
  const isMonthly =
    document.body.getAttribute('data-license') === 'monthly' ||
    ((window.activationType || '').toUpperCase() === 'MONTHLY');

  pageData.forEach(game => {
    if (window.__parentalEnabled && isAdultGame(game)) { return; }
    const card = document.createElement('div');
    card.className = 'card';
    card.setAttribute('data-appid', game.appid);
    card.setAttribute('data-name', game.name || '');

    // Game Cover - Make it clickable to open modal
    const img = document.createElement('img');
    img.classList.add('cover');
    img.alt = 'Game Cover';

    // Use fallback loader
    loadGameCover(img, game.appid);

    // Make cover clickable to open modal
    img.style.cursor = 'pointer';
    img.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      const launcherStatus = launcherStatusMap[String(game.appid)];
      if (window.openUnifiedGamePanel) {
        window.openUnifiedGamePanel(game, launcherStatus);
      } else {
        openGameActionsModal(game, launcherStatus, e);
      }
    });

    // Size Label (top-left)
    const sizeLabel = document.createElement('div');
    sizeLabel.className = 'size-tag';
    sizeLabel.textContent = (game.size_gb && String(game.size_gb).trim()) ? String(game.size_gb).trim() : 'N/A';
    sizeLabel.style.top = '10px';
    sizeLabel.style.left = '10px';

    card.appendChild(img);
    card.appendChild(sizeLabel);

    // DRIVE BADGE - Show which drive game is installed on (BELOW size label)
    const launcherInfo = launcherStatusMap[String(game.appid)];
    if (launcherInfo && launcherInfo.game_folder) {
      // Extract drive letter from game folder path
      const driveLetter = launcherInfo.game_folder.split(':')[0] + ':';

      const driveBadge = document.createElement('div');
      driveBadge.className = 'install-drive-badge';
      driveBadge.style.cssText = `
        position: absolute;
        top: 215px;
        left: 10px;
        z-index: 11;
        padding: 4px 10px;
        background: linear-gradient(135deg, rgba(76, 175, 80, 0.5) 0%, rgba(56, 142, 60, 0.5) 100%);
        backdrop-filter: blur(5px);
        color: #fff;
        font-size: 11px;
        font-weight: 700;
        border-radius: 8px;
        box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
        display: flex;
        align-items: center;
        gap: 4px;
        letter-spacing: 0.3px;
        backdrop-filter: blur(4px);
      `;

      driveBadge.innerHTML = `<span>💾</span><span>${driveLetter}</span>`;
      driveBadge.title = `Installed on ${launcherInfo.game_folder}`;

      card.appendChild(driveBadge);
    }

    // Online Supported or Bypass Available tag (top-right)
    let hasTopRightTag = false;
    if (game.online_supported === "Yes") {
      const onlineLabel = document.createElement('div');
      onlineLabel.className = 'online-label';
      onlineLabel.innerHTML = `Online Supported</span>`;
      card.appendChild(onlineLabel);
      hasTopRightTag = true;
    } else if (game.bypass_supported === "Yes" && !isMonthly) {
      // NEW: Only show bypass pill if NOT monthly user
      const bypassLabel = document.createElement('div');
      bypassLabel.className = 'online-label bypass-label';  // Add bypass-label class
      bypassLabel.innerHTML = `Bypass<br><span style="font-size:12px;">Available</span>`;
      card.appendChild(bypassLabel);
      hasTopRightTag = true;
    }

    // Info/Details icon button (top-right, below online/bypass label or in its place)
const infoIcon = document.createElement('button');
infoIcon.className = 'info-icon-btn';
infoIcon.innerHTML = '<span>i</span>';
infoIcon.title = 'View Details';

infoIcon.style.cssText = `
  position: absolute;
  top: ${hasTopRightTag ? '70px' : '10px'};
  right: 10px;

  background: rgba(0, 123, 255, 0.85);
  border: 1px solid rgba(255, 255, 255, 0.25);
  border-radius: 50%;

  width: 22px;
  height: 22px;

  display: flex;
  align-items: center;
  justify-content: center;

  cursor: pointer;

  color: #fff;
  font-size: 13px;
  font-weight: 600;
  font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;

  box-shadow: 0 2px 6px rgba(0, 0, 0, 0.35);
  transition: background 0.2s ease, transform 0.15s ease, box-shadow 0.2s ease;
  z-index: 10;
`;

infoIcon.addEventListener('click', (e) => {
  e.preventDefault();
  e.stopPropagation();
  const launcherStatus = launcherStatusMap[String(game.appid)];
  if (window.openUnifiedGamePanel) {
    window.openUnifiedGamePanel(game, launcherStatus);
  } else {
    showGameDetails(game.appid);
  }
});

infoIcon.addEventListener('mouseenter', () => {
  infoIcon.style.background = 'rgba(0, 140, 255, 0.95)';
  infoIcon.style.transform = 'scale(1.08)';
  infoIcon.style.boxShadow = '0 4px 10px rgba(0, 0, 0, 0.45)';
});

infoIcon.addEventListener('mouseleave', () => {
  infoIcon.style.background = 'rgba(0, 123, 255, 0.85)';
  infoIcon.style.transform = 'scale(1)';
  infoIcon.style.boxShadow = '0 2px 6px rgba(0, 0, 0, 0.35)';
});

card.appendChild(infoIcon);


    // Primary Genre pill
    const genreTag = document.createElement('button');
    genreTag.className = 'genre-tag';
    const __mappedGenre = getGenreName(game.primary_genre);
    if (__mappedGenre && __mappedGenre.toLowerCase() !== 'unknown genre') {
      genreTag.textContent = __mappedGenre;
      // Make genre tag also clickable to open modal
      genreTag.addEventListener('click', (e) => {
        const launcherStatus = launcherStatusMap[String(game.appid)];
        if (window.openUnifiedGamePanel) {
          window.openUnifiedGamePanel(game, launcherStatus);
        } else {
          openGameActionsModal(game, launcherStatus, e);
        }
      });
      card.appendChild(genreTag);
    } else {
      genreTag.style.display = 'none';
    }

    // Installed badge
    if (game.installed) {
      const installedTag = document.createElement('div');
      installedTag.className = 'installed-tag';
      installedTag.textContent = 'Added';
      card.appendChild(installedTag);
    }

    // Game Info at bottom
    const info = document.createElement('div');
    info.className = 'info';
    info.innerHTML = `
      <div><span class="highlight">AppID:</span> ${game.appid}</div>
      <div><span class="highlight">Name:</span> ${game.name}</div>
      <div><span class="highlight">Added:</span> ${new Date(game.added_on).toLocaleString()}</div>
      <div><span class="highlight">Downloads:</span> ${game.downloads}</div>
      ${game.requires_membership ? '<div style="color:yellow">⭐Denuvo Protected | Borrow Account⭐</div>' : ''}
    `;

    card.appendChild(info);

    // Dynamic button: "Play on Steam" if installed on Steam, otherwise "Add to Cart"
    const actionBtn = document.createElement('button');
    actionBtn.className = 'card-cart-btn';
    actionBtn.textContent = 'Loading...';
    actionBtn.disabled = true;

    // Check Steam installation status asynchronously
    (async () => {
      try {
        const acfStatus = await fetch(`/api/acf_status/${game.appid}?t=${Date.now()}`, { cache: 'no-store' })
          .then(r => r.ok ? r.json() : null)
          .catch(() => null);

        if (acfStatus && acfStatus.status === 'installed') {
          // Game is installed on Steam - show Play button
          actionBtn.className = 'card-cart-btn play-steam';
          actionBtn.textContent = '▶ PLAY';
          actionBtn.disabled = false;
          actionBtn.onclick = async (e) => {
            e.stopPropagation();
            try {
              if (window.pywebview?.api?.launch_steam) {
                await window.pywebview.api.launch_steam(String(game.appid));
              } else {
                window.location.href = `steam://rungameid/${game.appid}`;
              }
            } catch (err) {
              console.error('Failed to launch Steam:', err);
              alert('Failed to launch game on Steam');
            }
          };
        } else {
          // Game not installed on Steam - show Add to Cart button
          const inCart = cart.includes(game.appid);
          actionBtn.className = 'card-cart-btn';
          actionBtn.textContent = inCart ? 'In Cart' : 'Add to Cart';
          actionBtn.disabled = inCart;
          actionBtn.onclick = async (e) => {
            e.stopPropagation();
            if (!cart.includes(game.appid)) {
              if (needsMembership(game.requires_membership)) {
                showDenuvoWarning(game, async () => {
                  const success = await addToCart(game.appid);
                  if (success) { actionBtn.textContent = 'In Cart'; actionBtn.disabled = true; }
                });
              } else {
                console.log('🛒 Adding to cart:', game.appid);
                const success = await addToCart(game.appid);
                if (success) { actionBtn.textContent = 'In Cart'; actionBtn.disabled = true; }
              }
            } else {
              console.log('🛒 Already in cart:', game.appid);
            }
          };
        }
      } catch (err) {
        // Fallback to Add to Cart on error
        console.error('Error checking Steam status:', err);
        const inCart = cart.includes(game.appid);
        actionBtn.className = 'card-cart-btn';
        actionBtn.textContent = inCart ? 'In Cart' : 'Add to Cart';
        actionBtn.disabled = inCart;
        actionBtn.onclick = async (e) => {
          e.stopPropagation();
          if (!cart.includes(game.appid)) {
            if (needsMembership(game.requires_membership)) {
              showDenuvoWarning(game, async () => {
                const success = await addToCart(game.appid);
                if (success) { actionBtn.textContent = 'In Cart'; actionBtn.disabled = true; }
              });
            } else {
              console.log('🛒 Adding to cart (fallback):', game.appid);
              const success = await addToCart(game.appid);
              if (success) { actionBtn.textContent = 'In Cart'; actionBtn.disabled = true; }
            }
          } else {
            console.log('🛒 Already in cart:', game.appid);
          }
        };
      }
    })();

    // Append the button AFTER the info div
    card.appendChild(actionBtn);
    // Adult content badge
    if (isAdultGame(game)) {
        const adultTag = document.createElement('div');
        adultTag.className = 'adult-tag';
        adultTag.textContent = '18+ Only';
        card.appendChild(adultTag);

        // blur cover if you like
        img?.classList?.add('blurred-cover');

        // if PC is ON, never let it flash
        if (window.__parentalEnabled) {
            card.style.display = 'none';
        }
    }

    grid.appendChild(card);
  });

  document.getElementById('page-label').textContent = `Page ${currentPage}`;
  document.getElementById('prev').disabled = currentPage === 1;
  document.getElementById('next').disabled = end >= filteredGames.length;

  // Calculate and update total pages
  const totalPages = Math.ceil(filteredGames.length / perPage);
  updatePaginationInfo(currentPage, totalPages);

  scrollToTop();
  } finally {
    renderPage.rendering = false;
  }
}

// Update pagination info display
function updatePaginationInfo(current, total) {
  const pageLabel = document.getElementById('page-label');
  if (pageLabel) {
    pageLabel.textContent = `Page ${current} of ${total}`;
  }

  // Update jump to page input max value
  const jumpInput = document.getElementById('jump-to-page-input');
  if (jumpInput) {
    jumpInput.max = total;
    jumpInput.placeholder = `1-${total}`;
  }
}

// Initialize jump to page functionality
function initJumpToPage() {
  const jumpInput = document.getElementById('jump-to-page-input');
  const jumpButton = document.getElementById('jump-to-page-btn');

  if (!jumpInput || !jumpButton) {
    console.log('Jump to page elements not found, will retry on DOM load');
    return;
  }

  // Handle jump button click
  jumpButton.addEventListener('click', () => {
    const pageNum = parseInt(jumpInput.value);
    const totalPages = Math.ceil(filteredGames.length / perPage);

    if (isNaN(pageNum) || pageNum < 1 || pageNum > totalPages) {
      showToast(`Please enter a page number between 1 and ${totalPages}`, {
        title: 'Invalid Page',
        type: 'error',
        duration: 3000
      });
      return;
    }

    if (pageNum === currentPage) {
      showToast(`Already on page ${pageNum}`, {
        title: 'Jump to Page',
        type: 'info',
        duration: 2000
      });
      return;
    }

    currentPage = pageNum;
    renderPage();
    jumpInput.value = ''; // Clear input after jump

    showToast(`Jumped to page ${pageNum}`, {
      title: 'Jump to Page',
      type: 'success',
      duration: 2000
    });
  });

  // Handle Enter key in input
  jumpInput.addEventListener('keypress', (e) => {
    if (e.key === 'Enter') {
      jumpButton.click();
    }
  });

  console.log('✅ Jump to page initialized');
}

function formatBytes(bytes) {
  if (bytes >= 1e9) return (bytes / 1e9).toFixed(2) + ' GB';
  if (bytes >= 1e6) return (bytes / 1e6).toFixed(2) + ' MB';
  if (bytes >= 1e3) return (bytes / 1e3).toFixed(2) + ' KB';
  return bytes + ' B';
}

async function openSteamStore(appid) {
  try {
    if (window.pywebview && window.pywebview.api && window.pywebview.api.open_steam_store) {
      const result = await window.pywebview.api.open_steam_store(Number(appid));
      if (!result || result.success !== true) {
        console.error('open_steam_store failed:', result);
      }
      return;
    }

    console.error('pywebview API open_steam_store is missing');
  } catch (e) {
    console.error('Failed to open Steam store:', e);
  }
}

async function showGameDetails(appid) {
  showModal('details-loading-modal');
  try {
    // Use existing backend proxy (avoids CORS) → hits store.steampowered.com/api/appdetails
    const res = await fetch(`/api/steamstore/${appid}?cc=my&l=en`);
    if (!res.ok) throw new Error("Failed to fetch details");
    const data = await res.json();

    const key = String(appid);
    if (!data?.[key]?.success || !data[key]?.data) {
      hideModal('details-loading-modal');
      alert("No details found");
      return;
    }

    const game = data[key].data;

    // Parse fields from Steam Store API response
    const name = game.name || "N/A";
    const developer = (game.developers || []).join(", ") || "N/A";
    const publisher = (game.publishers || []).join(", ") || "N/A";

    // Languages: Store API returns HTML string like "English<strong>*</strong>, Japanese, ..."
    let languages = "N/A";
    if (game.supported_languages) {
      // Strip HTML tags, clean up
      languages = game.supported_languages
        .replace(/<[^>]*>/g, '')
        .replace(/\s+/g, ' ')
        .trim() || "N/A";
    }

    // Reviews: not in appdetails, try recommendations count or show N/A
    const review = game.metacritic?.score
      ? `${game.metacritic.score} (Metacritic)`
      : "N/A";

    // Size: parse from pc_requirements minimum text (look for "Storage:" or "Hard Drive:")
    let formattedSize = "N/A";
    try {
      const minReqs = game.pc_requirements?.minimum || "";
      const sizeMatch = minReqs.match(/(?:Storage|Hard Drive|Disk Space)[^<]*?<\/strong>\s*([^<]+)/i);
      if (sizeMatch) formattedSize = sizeMatch[1].trim();
    } catch { /* ignore */ }

    // Release date
    const releaseDate = game.release_date?.date || "N/A";

    // Price
    let priceText = "";
    if (game.is_free) {
      priceText = "Free to Play";
    } else if (game.price_overview) {
      const p = game.price_overview;
      if (p.discount_percent > 0) {
        priceText = `<s style="opacity:.5">${p.initial_formatted}</s> ${p.final_formatted} (-${p.discount_percent}%)`;
      } else {
        priceText = p.final_formatted || "N/A";
      }
    }

    // ----- IMAGE: CDN-first, then cache, then placeholder -----
    const v = Date.now();
    const cdnGeneric = `https://steamcdn-a.akamaihd.net/steam/apps/${appid}/library_600x900.jpg?v=${v}`;
    const headerImg = game.header_image ? `${game.header_image}` : null;
    const cacheUrl = `${getLocalCachedImageUrl(appid)}?v=${v}`;
    const placeholderUrl = "/static/placeholder.jpg";

    const candidates = [cdnGeneric, headerImg, cacheUrl, placeholderUrl].filter(Boolean);

    const img = document.getElementById('details-modal-img');
    if (img) {
      img.onload = null;
      img.onerror = null;

      img.onload = () => {
        img.classList.add('loaded');
        const ratio = img.naturalWidth / img.naturalHeight;
        img.style.objectFit = (ratio > 1.6 || ratio < 0.7) ? 'contain' : 'cover';
      };

      let idx = 0;
      const tryNext = () => {
        if (idx >= candidates.length) return;
        img.onerror = () => { idx += 1; tryNext(); };
        img.src = candidates[idx];
      };
      tryNext();
    }

    // ----- DESCRIPTION (already in same response) -----
    const shortDescription = game.short_description || "";

    // ----- RENDER -----
    const modalBody = document.getElementById('details-modal-body');
    if (modalBody) {
      modalBody.innerHTML = `
        <table>
          <tr><th>Name</th><td>${name}</td></tr>
          <tr><th>Developer</th><td>${developer}</td></tr>
          <tr><th>Publisher</th><td>${publisher}</td></tr>
          <tr><th>Languages</th><td>${languages}</td></tr>
          <tr><th>Review</th><td>${review}</td></tr>
          <tr><th>Size</th><td>${formattedSize}</td></tr>
          <tr><th>Release Date</th><td>${releaseDate}</td></tr>
          ${priceText ? `<tr><th>Price</th><td>${priceText}</td></tr>` : ""}
        </table>
        ${shortDescription ? `
          <div class="short-description" style="margin:18px 0 0 0;padding:0 2px 12px 2px;color:#c9eaff;font-size:15px;">
            <b>Description:</b> ${shortDescription}
          </div>
        ` : ""}
        <div style="text-align:center; margin-top:30px;">
          <a href="#" class="steam-store-btn" onclick="openSteamStore(${game.appid}); return false;">
            View on Steam Store
          </a>
        </div>
      `;
    }

    hideModal('details-loading-modal');
    showModal('details-modal');
  } catch (e) {
    hideModal('details-loading-modal');
    alert("Error loading game details: " + e.message);
  }
}



document.getElementById('prev').onclick = () => {
  if (currentPage > 1) {
    preloadImagesForPage(currentPage - 1);
    currentPage--;
    renderPage();
  }
};

document.getElementById('next').onclick = () => {
  if (currentPage * perPage < filteredGames.length) {
    preloadImagesForPage(currentPage + 1);
    currentPage++;
    renderPage();
  }
};

// Prevent double-rendering when updating games
let isRendering = false;

document.getElementById('search').oninput = (e) => {
  // Don't trigger if we're already rendering from fetchGamesFreshAndRender
  if (isRendering) {
    console.log('🔍 Search handler blocked - rendering in progress');
    return;
  }

  console.log('🔍 Search handler triggered:', e.target.value);
  // Use the unified filter function instead of directly modifying filteredGames
  applyFiltersAndRender({ resetPage: true });
};

document.getElementById('details-modal-close').addEventListener('click', () => {
  hideModal('details-modal');
});

const img = document.getElementById('details-modal-img');
img.onload = function() {
  // You can choose the ratio threshold as you like (e.g. tall or wide images)
  const ratio = img.naturalWidth / img.naturalHeight;
  // E.g. treat “very wide or very tall” as special
  if (ratio > 1.6 || ratio < 0.7) {
    img.style.objectFit = 'contain';
  } else {
    img.style.objectFit = 'cover';
  }
};

function showNotification(message, options = {}) {
  const modal = document.getElementById('notification-modal');
  const content = document.getElementById('notification-content');

  const isConfirm = !!options.confirm;
  const yesText = options.yesText || "Yes";
  const noText  = options.noText  || "No";
  const okText  = options.buttonText || "OK";

  content.innerHTML = `
    <div style="font-size:1.13rem;font-weight:700;color:#1976d2;margin-bottom:12px;">
      ${options.title || "Notice"}
    </div>
    <div>${message}</div>
    <div style="margin-top:14px;">
      ${
        isConfirm
        ? `<button class="notification-btn secondary" id="notification-no-btn">${noText}</button>
           <button class="notification-btn primary" id="notification-yes-btn">${yesText}</button>`
        : `<button class="notification-btn primary" id="notification-ok-btn">${okText}</button>`
      }
    </div>
  `;

  modal.style.display = "flex";
  modal.style.zIndex = 99999;
  document.body.classList.remove('modal-open');

  if (isConfirm) {
    document.getElementById('notification-no-btn').onclick = () => {
      modal.style.display = "none";
      if (typeof options.onCancel === 'function') options.onCancel();
      if (typeof options.onClose === 'function') options.onClose();
    };
    document.getElementById('notification-yes-btn').onclick = async () => {
      modal.style.display = "none";
      if (typeof options.onConfirm === 'function') await options.onConfirm();
      if (typeof options.onClose === 'function') options.onClose();
    };
  } else {
    document.getElementById('notification-ok-btn').onclick = () => {
      modal.style.display = "none";
      const openModal = document.querySelector('.modal.show, .notification-modal.show');
      if (openModal) document.body.classList.add('modal-open');
      if (typeof options.onClose === 'function') options.onClose();
    };
  }
}

function maybePromptRestartOnce() {
  const KEY = "restart_prompted_v1";
  if (sessionStorage.getItem(KEY) === "1") return;
  sessionStorage.setItem(KEY, "1");
  promptRestartSteam(); // shows confirm modal, doesn't force restart
}


function promptRestartSteam() {
  showNotification("Restart Steam now to apply changes and unlock the game?", {
    title: "Restart Steam?",
    confirm: true,
    yesText: "Restart now",
    noText: "Later",
    onConfirm: async () => {
      try {
        await fetch('/api/restart_steam', { method: 'POST' });
        showNotification("Restarting Steam…", { title: "Please wait", buttonText: "OK" });
      } catch (e) {
        showNotification("Failed to restart Steam: " + (e?.message || e), { title: "Error" });
      }
    }
  });
}

async function restartSteamNow(btn) {
  try {
    if (btn) { btn.disabled = true; btn.textContent = "Restarting..."; }
    const res  = await fetch('/api/restart_steam', { method: 'POST' });
    const data = await res.json().catch(() => ({}));
    const msg  = data?.message || (res.ok ? "Steam restarted." : `Restart failed (${res.status})`);
    if (typeof showNotification === 'function') {
      showNotification(msg, { title: "Steam Restart" });
    } else {
      alert(msg);
    }
  } catch {
    if (typeof showNotification === 'function') {
      showNotification("Failed to restart Steam.", { title: "Error" });
    } else {
      alert("Failed to restart Steam.");
    }
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = "Restart Steam and switch account now"; }
  }
}

document.addEventListener("DOMContentLoaded", () => {
  const modalRestartBtn = document.getElementById('restart-steam-btn-modal');
  if (modalRestartBtn && !modalRestartBtn.dataset.bound) {
    modalRestartBtn.dataset.bound = "1";
    modalRestartBtn.addEventListener('click', () => restartSteamNow(modalRestartBtn));
  }
});

// Add to your sidebar HTML:
const restartBtn = document.createElement('button');
restartBtn.id = "restart-steam-btn";
restartBtn.className = "sidebar-btn";
restartBtn.textContent = "Restart Steam";
restartBtn.onclick = async () => {
  restartBtn.disabled = true;
  restartBtn.textContent = "Restarting...";
  try {
    const res = await fetch('/api/restart_steam', {method: 'POST'});
    const data = await res.json();
    showNotification(data.message, {title: "Steam Restart"});
  } catch (e) {
    showNotification("Failed to restart Steam.", {title: "Error"});
  }
  restartBtn.disabled = false;
  restartBtn.textContent = "Restart Steam";
};
// Add to sidebar DOM in your sidebar render logic.
sidebar.appendChild(restartBtn);

/* === Installed-Only helpers === */
window.__installedSet = window.__installedSet || new Set();
const __LS_INSTALLED_ONLY = 'oneb:installedOnly';

function getInstalledOnly(){ try { return localStorage.getItem(__LS_INSTALLED_ONLY) === 'true'; } catch(_) { return !!window.showInstalledOnly; } }
function setInstalledOnly(v){
  try { localStorage.setItem(__LS_INSTALLED_ONLY, v ? 'true' : 'false'); } catch(_){}
  window.showInstalledOnly = !!v;
  const btn = document.getElementById('show-installed-btn');
  if (btn){
    btn.classList.toggle('active', !!v);
    btn.setAttribute('aria-pressed', v ? 'true' : 'false');
    btn.textContent = v ? 'Show All Games' : 'Show Added Games Only';
  }
}
async function refreshInstalledSet(){
  try {
    if (typeof getInstalledLuaAppids === 'function'){
      const ids = await getInstalledLuaAppids();
      window.__installedSet = new Set((ids || []).map(String));
    } else {
      window.__installedSet = window.__installedSet || new Set();
    }
  } catch(_) { window.__installedSet = window.__installedSet || new Set(); }
}

async function getInstalledLuaAppids() {
  try {
    const res = await fetch('/api/installed_lua');
    if (!res.ok) return [];
    return await res.json();  // List of appids as strings
  } catch {
    return [];
  }
}


const removeAllBtn = document.createElement('button');
removeAllBtn.id = "remove-all-btn";
removeAllBtn.className = "sidebar-btn";
removeAllBtn.textContent = "Remove All Games";
removeAllBtn.onclick = async () => {
  const confirmed = await customConfirm(
    `⚠️ This will delete all unlocked games from your steam library.\n\nAre you sure you want to proceed?`
  );
  if (!confirmed) return;

  removeAllBtn.disabled = true;
  removeAllBtn.textContent = "Removing...";

  try {
    const res = await fetch('/api/remove_all_games', { method: 'POST' });
    const data = await res.json();
    if (data.success) {
      showNotification(data.message, { title: "Remove All Games" });
      await fetchGames(); // Refresh the grid/UI
    } else {
      showNotification(data.message || "Failed to remove games.", { title: "Remove All Games" });
    }
  } catch (e) {
    showNotification("Failed to remove games.", { title: "Remove All Games" });
  }
  removeAllBtn.disabled = false;
  removeAllBtn.textContent = "Remove All Games";
};
sidebar.appendChild(removeAllBtn);

const addAllBtn = document.createElement('button');
addAllBtn.id = "add-all-btn";
addAllBtn.className = "sidebar-btn";
addAllBtn.innerHTML = `Unlock<br><span style="font-size:15px;">[5k Top Games]</span>`;
addAllBtn.onclick = async () => {
  // Use your customConfirm, or window.confirm if you prefer
let proceed = await customConfirm(
  "⚠️ This is an experimental feature!\n\n" +
  "Unlocking games this way will enable the auto-update feature.\n" +
  "Sometimes this may lead to a download Steam error. Which will be auto resolve within 24hours:\n" +
  "\"Content Configuration Unavailable\".\n\n" +
  "If that happens:\n" +
  "  1. Request for game update in the correct discord channel.\n" +
  "  2. Click 'Update' for the affected game from the app.\n" +
  "  3. Then restart Steam.\n\n" +
  "Are you sure you want to proceed?"
);

  if (!proceed) return;

  showOneshotInstallModal();

  const prog = document.getElementById('oneshot-install-progress');
  const label = document.getElementById('oneshot-install-label');
  let fakeProgress = 0;
  let steps = [
    { value: 25, text: "Downloading package…" },
    { value: 55, text: "Extracting files…" },
    { value: 85, text: "Finalizing install…" },
    { value: 95, text: "Almost done…" }
  ];
  let stage = 0;
  prog.value = 0;

  let interval = setInterval(() => {
    if (fakeProgress < 95) {
      fakeProgress += Math.random() * 4 + 2;
      if (fakeProgress > steps[stage].value && stage < steps.length - 1) stage++;
      label.textContent = steps[stage].text;
      prog.value = Math.min(fakeProgress, 95);
    }
  }, 150);

  try {
    const res = await fetch('/api/oneshot_install', {method:'POST'});
    const data = await res.json();

    clearInterval(interval);
    prog.value = 100;
    label.textContent = data.message || "Completed!";
    setTimeout(() => {
      hideOneshotInstallModal();
      showNotification(data.message || "Unlock all complete!", {title: "Oneshot Install"});
      fetchGames();
    }, 1200);
  } catch (e) {
    clearInterval(interval);
    prog.value = 100;
    label.textContent = "Failed!";
    setTimeout(() => {
      hideOneshotInstallModal();
      showNotification("Failed to start install.", {title: "Oneshot Install"});
    }, 1400);
  }
};

sidebar.appendChild(addAllBtn);

async function checkUnlockAllPermission() {
    try {
        const response = await fetch('/api/can_unlock_all');
        const data = await response.json();

        // Find the unlock all button
        const unlockAllBtn = document.getElementById('add-all-btn');

        if (unlockAllBtn) {
            if (data.can_unlock_all) {
                // Lifetime users: Show and enable button
                unlockAllBtn.style.display = '';
                unlockAllBtn.disabled = false;
                unlockAllBtn.style.opacity = '1';
                unlockAllBtn.style.cursor = 'pointer';
                unlockAllBtn.title = '';
                console.log('✅ Unlock All: Enabled for lifetime user');
            } else {
                if (data.reason === 'monthly_subscription') {
                    // Monthly users: Hide button completely
                    unlockAllBtn.style.display = 'none';
                    console.log('🚫 Unlock All: Hidden for monthly subscription');

                    // ALTERNATIVE: Show but disable (uncomment if you prefer this)
                    // unlockAllBtn.style.display = '';
                    // unlockAllBtn.disabled = true;
                    // unlockAllBtn.title = data.message;
                    // unlockAllBtn.style.opacity = '0.5';
                    // unlockAllBtn.style.cursor = 'not-allowed';
                    // console.log('🚫 Unlock All: Disabled for monthly subscription');
                } else {
                    // Not activated or expired: Disable button
                    unlockAllBtn.style.display = '';
                    unlockAllBtn.disabled = true;
                    unlockAllBtn.title = data.message || 'Activation required';
                    unlockAllBtn.style.opacity = '0.5';
                    unlockAllBtn.style.cursor = 'not-allowed';
                    console.log('⚠️ Unlock All: Disabled -', data.reason);
                }
            }
        }
    } catch (error) {
        console.error('❌ Failed to check unlock all permission:', error);
    }
}

// Call this function when page loads
document.addEventListener('DOMContentLoaded', () => {
    console.log('🔍 Checking Unlock All permission...');
    checkUnlockAllPermission();
});

// Also call when activation status changes
// (You can trigger this event whenever activation status updates)
window.addEventListener('activationStatusChanged', () => {
    console.log('🔄 Activation status changed, rechecking Unlock All permission...');
    checkUnlockAllPermission();
});

// Initialize cart array
let cart = [];

// Load cart from server
async function loadCartFromServer() {
  try {
    const res = await fetch('/api/cart');
    if (res.ok) {
      const data = await res.json();
      cart = data.cart || [];
      console.log('📦 Loaded cart from server:', cart.length, 'items');
      return cart;
    } else {
      console.error('❌ Failed to load cart from server');
      return [];
    }
  } catch (e) {
    console.error('❌ Error loading cart:', e);
    return [];
  }
}

// Add item to cart on server
async function addToCart(appid) {
  try {
    const res = await fetch(`/api/cart/add/${appid}`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      if (data.success) {
        cart = data.cart || [];
        console.log('✅ Added', appid, 'to cart. Cart now has', cart.length, 'items');
        updateCartUI();
        return true;
      } else {
        // Check if cart limit reached
        if (data.limit_reached) {
          showNotification(data.message || 'Cart is full! Maximum 10 items allowed.', {
            title: 'Cart Full',
            type: 'warning'
          });
        } else {
          console.log('ℹ️', data.message || 'Already in cart');
        }
        return false;
      }
    }
  } catch (e) {
    console.error('❌ Error adding to cart:', e);
    return false;
  }
}

// Remove item from cart on server
async function removeFromCart(appid) {
  try {
    const res = await fetch(`/api/cart/remove/${appid}`, { method: 'POST' });
    if (res.ok) {
      const data = await res.json();
      cart = data.cart || [];
      console.log('🗑️ Removed', appid, 'from cart. Cart now has', cart.length, 'items');
      updateCartUI();
      return true;
    }
  } catch (e) {
    console.error('❌ Error removing from cart:', e);
    return false;
  }
}

// Clear entire cart
async function clearCart() {
  try {
    const res = await fetch('/api/cart/clear', { method: 'POST' });
    if (res.ok) {
      cart = [];
      console.log('🧹 Cart cleared');
      updateCartUI();
      return true;
    }
  } catch (e) {
    console.error('❌ Error clearing cart:', e);
    return false;
  }
}

// Initialize cart UI after DOM is ready
document.addEventListener('DOMContentLoaded', async () => {
  console.log('🎯 DOM ready, loading cart from server');
  await loadCartFromServer();
  updateCartUI();

  // Initialize jump to page functionality
  initJumpToPage();
});


function updateCartUI() {
  // No need to save - server handles storage
  const CART_LIMIT = 10;

  const badge = document.getElementById('cart-count');
  if (badge) {
    badge.textContent = String(cart.length);

    // Add visual indicator when cart is full
    if (cart.length >= CART_LIMIT) {
      badge.style.background = '#f44336'; // Red when full
      badge.title = `Cart full (${cart.length}/${CART_LIMIT})`;
    } else {
      badge.style.background = ''; // Reset to default
      badge.title = `${cart.length}/${CART_LIMIT} items in cart`;
    }
  } else {
    console.warn('⚠️ cart-count element not found');
  }

  // Update floating cart badge
  const floatingBadge = document.getElementById('floating-cart-badge');
  if (floatingBadge) {
    floatingBadge.textContent = String(cart.length);
    floatingBadge.setAttribute('data-count', String(cart.length));

    // Add visual indicator when cart is full
    if (cart.length >= CART_LIMIT) {
      floatingBadge.style.background = '#f44336'; // Red when full
      floatingBadge.title = `Cart full (${cart.length}/${CART_LIMIT})`;
    } else {
      floatingBadge.style.background = ''; // Reset to default
      floatingBadge.title = `${cart.length}/${CART_LIMIT} items in cart`;
    }
  } else {
    console.warn('⚠️ floating-cart-badge element not found');
  }

  updateCartDownloadCta();     // 🔁 keep modal CTA in sync
}

// Show the review modal (list games, allow remove)
function showCartReviewModal() {
  // 1) Make sure modal exists before we query inside it
  showModal('cart-review-modal');

  // 2) Query elements (some UIs build modal on open)
  const cartList     = document.getElementById('cart-list');
  const cartEmptyMsg = document.getElementById('cart-empty-msg');
  const modalCount   = document.getElementById('cart-modal-count'); // may be null

  // 3) Only require the list & empty-message containers
  if (!cartList || !cartEmptyMsg) {
    console.warn('[cart] Modal elements missing', {
      hasList: !!cartList, hasEmpty: !!cartEmptyMsg, hasCount: !!modalCount
    });
    return;
  }

  // 4) Fresh render every time
  cartList.innerHTML = '';
  const CART_LIMIT = 10;

  if (cart.length === 0) {
    cartList.style.display = 'none';
    cartEmptyMsg.style.display = 'block';
    if (modalCount) modalCount.textContent = '0';
  } else {
    cartList.style.display = 'block';
    cartEmptyMsg.style.display = 'none';
    if (modalCount) {
      modalCount.textContent = `${cart.length}/${CART_LIMIT}`;
      // Change color when full
      if (cart.length >= CART_LIMIT) {
        modalCount.style.color = '#f44336';
        modalCount.style.fontWeight = 'bold';
      } else {
        modalCount.style.color = '';
        modalCount.style.fontWeight = '';
      }
    }

    cart.forEach(appid => {
      const game = allGames.find(g => String(g.appid) === String(appid));
      const li = document.createElement('li');
      li.style.display = 'flex';
      li.style.alignItems = 'center';
      li.style.justifyContent = 'space-between';
      li.style.marginBottom = '8px';
      li.innerHTML = `
        <span>
          ${game ? `<b>${game.name}</b> (<span style="color:#1976d2;">${appid}</span>)` : appid}
        </span>
        <button type="button" class="btn-cancel cart-remove-btn" data-appid="${appid}">Remove</button>
      `;
      cartList.appendChild(li);
    });

    cartList.querySelectorAll('.cart-remove-btn').forEach(btn => {
      btn.onclick = () => removeFromCartUI(btn.getAttribute('data-appid'));
    });
  }
  updateCartDownloadCta();
}

// Remove an appid from cart and update UI/modal (called from cart review modal)
async function removeFromCartUI(appid) {
  await removeFromCart(appid);  // Call the API version
  showCartReviewModal();  // Refresh the modal
}


// Handle floating cart button click (top-right)
const floatingCartBtn = document.getElementById('floating-cart-btn');
if (floatingCartBtn) {
  floatingCartBtn.onclick = function() {
    if (cart.length === 0) {
      showNotification("Cart is empty!", { title: "Cart" });
      return;
    }
    showCartReviewModal();
  };
}


// Handle "Cancel" in cart modal
document.getElementById('cart-cancel-btn').onclick = function() {
  hideModal('cart-review-modal');
};

// Keep the modal CTA in sync with the cart
function updateCartDownloadCta() {
  const cta = document.getElementById('cart-download-btn'); // inside the modal
  if (!cta) return;
  cta.textContent = `Download Cart (${cart.length})`;
  // Optional: disable when empty
  cta.disabled = cart.length === 0;
}

// Handle "Download Cart" inside modal
// Inside cart modal "Download Cart" handler:
document.getElementById('cart-download-btn').onclick = async function() {
  if (cart.length === 0) return;
  const btn = this;
  btn.disabled = true;
  btn.textContent = 'Starting Download...';
  try {
    const cartCopy = cart.slice();
    const res = await fetch('/api/bulk_download', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appids: cartCopy })
    });
    if (!res.ok) throw new Error('Failed to start download.');
    startBulkDownload(cartCopy);

    // if you re-enable “Add to cart” buttons:
    // cartCopy.forEach(appid => enableAddButton(appid));

    await clearCart();
    hideModal('cart-review-modal'); // optional
  } catch (e) {
    showNotification('Failed to start cart download.', { title: 'Error' });
  } finally {
    btn.disabled = false;
    updateCartDownloadCta();        // 🔁 ensure label reads “(0)” if cart cleared
  }
};

function ensureMarkedLoaded(cb) {
  if (typeof marked !== "undefined") return cb();
  const script = document.createElement('script');
  script.src = "https://cdn.jsdelivr.net/npm/marked/marked.min.js";
  script.onload = cb;
  document.head.appendChild(script);
}

const luaPatchToolsBtn = document.createElement('button');
luaPatchToolsBtn.id = "lua-patch-tools-btn";
luaPatchToolsBtn.className = "sidebar-btn";
luaPatchToolsBtn.innerHTML = `Auto Update Game<br><span style="font-size:13px;">🔒[Experimental]🔓</span>`;
luaPatchToolsBtn.onclick = showLuaPatchToolsModal;
sidebar.appendChild(luaPatchToolsBtn);

function ensureLuaPatchModal() {
  if (document.getElementById("lua-patch-modal")) return; // Already added

  const modal = document.createElement('div');
  modal.id = "lua-patch-modal";
  modal.className = "modal";
  modal.tabIndex = -1;
  modal.innerHTML = `
    <div class="modal-content" style="min-width:340px;max-width:440px;text-align:center;">
      <h2 style="margin-bottom:8px;">Auto Update Game</h2>
      <div style="margin-bottom:14px;font-size:1rem;">
        This tool lets you convert your game lock version to auto-update <br>
        <span style="color:#f90;font-size:13px;">
          Use this if you need to autoupdate all your game and also reverting the game version to lock version if needed.<br>
          <b>Enable Auto Update</b> disables lock version. <b>Disable Auto Update</b> restores game to lock version.
        </span>
      </div>
      <div style="display:flex;gap:16px;justify-content:center;margin-bottom:12px;">
        <button id="lua-comment-btn" class="btn-confirm" style="min-width:120px;">Enable Auto Update</button>
        <button id="lua-uncomment-btn" class="btn-cancel" style="min-width:120px;">Disable Auto Update</button>
      </div>
      <button id="lua-patch-close-btn" class="btn-cancel" style="margin-top:6px;">Close</button>
    </div>
  `;
  document.body.appendChild(modal);
}

function showLuaPatchToolsModal() {
  ensureLuaPatchModal();

  const modal = document.getElementById("lua-patch-modal");
  modal.style.display = "flex";
  modal.classList.add("show");
  document.body.classList.add('modal-open');

  // Close logic
  document.getElementById("lua-patch-close-btn").onclick = () => {
    modal.style.display = "none";
    modal.classList.remove("show");
    document.body.classList.remove('modal-open');
  };

  // Comment setManifestid
  document.getElementById("lua-comment-btn").onclick = async function() {
    this.disabled = true;
    try {
      const res = await fetch('/api/comment_setmanifestid', {method:'POST'});
      const data = await res.json();
      showNotification(data.message, {title:"Auto Update Patch"});
    } catch(e) {
      showNotification("Failed: " + e.message, {title:"Auto Update Patch"});
    }
    this.disabled = false;
  };

  // Uncomment setManifestid
  document.getElementById("lua-uncomment-btn").onclick = async function() {
    this.disabled = true;
    try {
      const res = await fetch('/api/uncomment_setmanifestid', {method:'POST'});
      const data = await res.json();
      showNotification(data.message, {title:"Auto Update Patch"});
    } catch(e) {
      showNotification("Failed: " + e.message, {title:"Auto Update Patch"});
    }
    this.disabled = false;
  };
}

openBtn.addEventListener('click', () => {
  sidebar.classList.add('expanded');
  document.body.classList.add('sidebar-expanded');
  openBtn.style.display = 'none';
});

closeBtn.addEventListener('click', () => {
  sidebar.classList.remove('expanded');
  document.body.classList.remove('sidebar-expanded');
  openBtn.style.display = 'block';
});


async function installPatch(appid, btn) {
  const original = btn.textContent;
  btn.disabled = true;
  btn.textContent = 'Installing…';

  // Start progress bar and show a “working” toast
  startTopProgress();
  const working = showToast("Installing patch…", {
    title: "Patching",
    type: "info",
    duration: 0
  });

  try {
    const res = await fetch(`/api/download_patch/${appid}`, { method: 'POST' });
    const data = await res.json().catch(() => ({}));

    finishTopProgress();
    working.close();

    if (!res.ok || !data.success) {
      showToast(data.message || 'Patch install failed', {
        title: "Patch Failed",
        type: "error",
        duration: 9000
      });
    } else {
      // Extract game directory from response
      const gameDir = data.game_dir;

      showToast(data.message || 'Patch installed', {
        title: "Patch Installed",
        type: "success",
        duration: 10000,
        buttons: [
          {
            text: '📁 Open Folder',
            onClick: async () => {
              try {
                // Send the actual game path from patch response
                await fetch(`/api/open_folder`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ path: gameDir })
                });
              } catch (e) {
                console.error('Failed to open folder:', e);
              }
            }
          }
        ]
      });
    }
  } catch (e) {
    finishTopProgress();
    working.close();
    showToast('Network error while installing patch: ' + e.message, {
      title: "Error",
      type: "error",
      duration: 9000
    });
  } finally {
    btn.disabled = false;
    btn.textContent = original;
  }
}


// ---------- Toasts ----------
function ensureToaster() {
  if (!document.getElementById('toaster')) {
    const el = document.createElement('div');
    el.id = 'toaster';
    document.body.appendChild(el);
  }
}

function showToast(message, opts = {}) {
  ensureToaster();
  const {
    title = '',
    type = 'info',         // 'success' | 'error' | 'info'
    duration = 5000,       // ms
    icon = type === 'success' ? '✅' : type === 'error' ? '⚠️' : 'ℹ️',
    buttons = []           // Array of {text, onClick} objects
  } = opts;

  const toast = document.createElement('div');
  toast.className = `toast ${type}`;

  // Build buttons HTML
  const buttonsHtml = buttons.length > 0
    ? `<div class="toast-buttons">${buttons.map((btn, i) =>
        `<button class="toast-action-btn" data-btn-index="${i}">${btn.text}</button>`
      ).join('')}</div>`
    : '';

  toast.innerHTML = `
    <div class="icon">${icon}</div>
    <div class="toast-content">
      ${title ? `<div class="title">${title}</div>` : ''}
      <div class="msg">${message}</div>
      ${buttonsHtml}
    </div>
    <button class="close" aria-label="Close">×</button>
  `;

  const close = () => {
    toast.classList.remove('show');
    setTimeout(() => toast.remove(), 250);
  };
  toast.querySelector('.close').onclick = close;

  // Attach button event handlers
  buttons.forEach((btn, i) => {
    const btnEl = toast.querySelector(`[data-btn-index="${i}"]`);
    if (btnEl && btn.onClick) {
      btnEl.onclick = () => {
        btn.onClick();
        if (btn.closeAfter !== false) close();
      };
    }
  });

  document.getElementById('toaster').appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('show'));

  if (duration > 0) setTimeout(close, duration);
  return { close };
}

// ---------- Top progress bar ----------
function ensureTopProgress() {
  if (!document.getElementById('top-progress')) {
    const wrap = document.createElement('div');
    wrap.id = 'top-progress';
    wrap.innerHTML = '<div class="bar"></div>';
    document.body.appendChild(wrap);
  }
}

let _progressTimer = null;

function setTopProgress(pct) {
  ensureTopProgress(); // <— make sure it exists
  const bar = document.querySelector('#top-progress .bar');
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function startTopProgress() {
  ensureTopProgress(); // <— make sure it exists
  clearInterval(_progressTimer);
  setTopProgress(8);
  _progressTimer = setInterval(() => {
    const bar = document.querySelector('#top-progress .bar');
    if (!bar) return;
    const current = parseFloat(bar.style.width) || 0;
    if (current < 90) setTopProgress(current + Math.random() * 5 + 2);
  }, 300);
}

function finishTopProgress() {
  clearInterval(_progressTimer);
  setTopProgress(100);
  setTimeout(() => setTopProgress(0), 350);
}

const filterState = {
  membershipOnly: false,
  onlineSupported: false,    // online_supported === "Yes"
  bypassAvailable: false,    // bypass_supported === "Yes"
  primaryGenres: new Set(), // <--- NEW
  adultsOnly: false,
};

function ensureGenreRow() {
  let row = document.getElementById('genre-row');
  if (row) return row;
  row = document.createElement('div');
  row.id = 'genre-row';
  row.className = 'genre-row';
  document.querySelector('.filters')?.appendChild(row);
  return row;
}
// NEW: group present genres by label (e.g., "Indie" -> Set{33,34})
function groupGenresByLabel(games) {
  const groups = new Map(); // label -> Set<number>
  for (const g of games) {
    const code = Number(g.primary_genre);
    if (Number.isNaN(code)) continue;
    const label = getGenreName(code);
    if (!groups.has(label)) groups.set(label, new Set());
    groups.get(label).add(code);
  }
  return groups;
}

// Adjust if your adult genre ids differ
const ADULT_GENRE_CODES = new Set([71, 72]);

function buildGenreChipsFromData(games) {
  const row = document.getElementById('genre-row') || ensureGenreRow();

  // remove old chips (keep label if you have one outside this container)
  [...row.querySelectorAll('.genre-chip')].forEach(el => el.remove());

  const groups = groupGenresByLabel(games);
  const labels = [...groups.keys()].sort((a, b) => a.localeCompare(b));

  const frag = document.createDocumentFragment();

  for (const label of labels) {
    const codes = [...groups.get(label)];   // e.g., [33, 34] or [71]
    const isAdultChip = codes.some(c => ADULT_GENRE_CODES.has(Number(c)));

    // If PC is ON → do not render adult-genre chips; also clear any active selection for them
    if (window.__parentalEnabled && isAdultChip) {
      for (const c of codes) filterState.primaryGenres.delete(Number(c));
      continue;
    }

    const chip = document.createElement('button');
    chip.className = 'chip genre-chip';
    chip.dataset.codes = codes.join(',');
    chip.textContent = label;

    chip.addEventListener('click', () => {
      const codesArr = chip.dataset.codes.split(',').map(Number);
      const isActive = chip.classList.contains('active');

      if (isActive) {
        for (const c of codesArr) filterState.primaryGenres.delete(c);
        chip.classList.remove('active');
      } else {
        for (const c of codesArr) filterState.primaryGenres.add(c);
        chip.classList.add('active');
        filterState.adultsOnly = false;
        const adultChip = document.getElementById('genre-chip-18plus');
        if (adultChip) adultChip.classList.remove('active');
      }
      applyFiltersAndRender({ resetPage: true });
    });

    frag.appendChild(chip);
  }

  // Dedicated 18+ chip (suppressed when parental control is on)
  if (window.__parentalEnabled) {
    filterState.adultsOnly = false;
  } else {
    const adultChip = document.createElement('button');
    adultChip.className = 'chip genre-chip genre-chip-18plus';
    adultChip.id = 'genre-chip-18plus';
    adultChip.textContent = '18+';
    adultChip.classList.toggle('active', !!filterState.adultsOnly);
    adultChip.addEventListener('click', () => {
      filterState.adultsOnly = !filterState.adultsOnly;
      adultChip.classList.toggle('active', filterState.adultsOnly);
      if (filterState.adultsOnly) {
        row.querySelectorAll('.genre-chip:not(.genre-chip-18plus)').forEach(c => {
          c.classList.remove('active');
          c.dataset.codes.split(',').map(Number).forEach(n => filterState.primaryGenres.delete(n));
        });
      }
      applyFiltersAndRender({ resetPage: true });
    });
    frag.appendChild(adultChip);
  }

  row.appendChild(frag);

  // Recalc panel height once, after all chips are in the DOM
  if (window.__recalcGenrePanelHeight) {
    requestAnimationFrame(() => window.__recalcGenrePanelHeight());
  }
}

(function bindPcChipRebuild(){
  try {
    const t = document.getElementById('pc-toggle');
    if (!t || t.__pcChipBound) return;
    t.__pcChipBound = true;
    t.addEventListener('change', () => {
      buildGenreChipsFromData(typeof allGames !== 'undefined' ? allGames : []);
      if (typeof applyFiltersAndRender === 'function') applyFiltersAndRender({ resetPage: true });
      else if (typeof renderPage === 'function') renderPage();
    });
  } catch (e) {}
})();


window.__installedSet = window.__installedSet || new Set();

function fuzzyMatch(needle, haystack) {
  /**
   * Returns a match score (0-1, higher is better) or null if no match
   * Algorithm:
   * - Checks if all characters in needle appear in haystack in order
   * - Rewards consecutive character matches
   * - Penalizes gaps between matches
   */
  if (!needle || !haystack) return null;

  needle = needle.toLowerCase();
  haystack = haystack.toLowerCase();

  // Quick exact match check (highest score)
  if (haystack.includes(needle)) {
    const exactMatchBonus = 1.0 - (haystack.indexOf(needle) / haystack.length) * 0.1;
    return Math.min(exactMatchBonus, 1.0);
  }

  let needleIdx = 0;
  let haystackIdx = 0;
  let consecutiveMatches = 0;
  let totalMatches = 0;
  let lastMatchIdx = -1;
  let gapPenalty = 0;

  while (needleIdx < needle.length && haystackIdx < haystack.length) {
    if (needle[needleIdx] === haystack[haystackIdx]) {
      totalMatches++;

      // Bonus for consecutive matches
      if (lastMatchIdx === haystackIdx - 1) {
        consecutiveMatches++;
      } else {
        consecutiveMatches = 1;
        // Penalty for gaps
        gapPenalty += (haystackIdx - lastMatchIdx - 1) * 0.01;
      }

      lastMatchIdx = haystackIdx;
      needleIdx++;
    }
    haystackIdx++;
  }

  // All characters must be found
  if (needleIdx < needle.length) {
    return null;
  }

  // Calculate score
  const matchRatio = totalMatches / needle.length;
  const positionBonus = 1.0 - (lastMatchIdx / haystack.length) * 0.2;
  const consecutiveBonus = (consecutiveMatches / needle.length) * 0.3;

  let score = matchRatio * positionBonus + consecutiveBonus - gapPenalty;
  score = Math.max(0, Math.min(1, score)); // Clamp between 0 and 1

  return score;
}

// ============================================================================
// Levenshtein Distance (for typo tolerance)
// ============================================================================
function levenshteinDistance(str1, str2) {
  /**
   * Calculate edit distance between two strings
   * Lower distance = more similar strings
   */
  const m = str1.length;
  const n = str2.length;
  const dp = Array(m + 1).fill(null).map(() => Array(n + 1).fill(0));

  for (let i = 0; i <= m; i++) dp[i][0] = i;
  for (let j = 0; j <= n; j++) dp[0][j] = j;

  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (str1[i - 1] === str2[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1];
      } else {
        dp[i][j] = 1 + Math.min(
          dp[i - 1][j],     // deletion
          dp[i][j - 1],     // insertion
          dp[i - 1][j - 1]  // substitution
        );
      }
    }
  }

  return dp[m][n];
}

// ============================================================================
// Smart Fuzzy Search with Multiple Strategies
// ============================================================================
function smartFuzzySearch(query, games, options = {}) {
  /**
   * Comprehensive fuzzy search using multiple matching strategies
   * Returns sorted array of matching games
   */
  const {
    threshold = 0.3,           // Minimum score to be considered a match
    maxTypoDistance = 2,       // Maximum edit distance for typo tolerance
    limit = null                // Maximum results (null = unlimited)
  } = options;

  if (!query || query.length < 2) {
    return games; // Return all games if query too short
  }

  const queryLower = query.toLowerCase();
  const queryWords = queryLower.split(/\s+/).filter(w => w.length > 0);

  const scoredGames = games.map(game => {
    const name = (game.name || '').toLowerCase();
    const appid = String(game.appid || '');

    // Strategy 1: Exact substring match (highest priority)
    if (name.includes(queryLower) || appid.includes(query)) {
      return { game, score: 1.0 };
    }

    // Strategy 2: Fuzzy subsequence matching on full query
    const nameScore = fuzzyMatch(queryLower, name);
    const appidScore = appid.includes(query) ? 1.0 : null;

    let bestScore = Math.max(nameScore || 0, appidScore || 0);

    // Strategy 3: Word-by-word matching (for multi-word queries)
    if (queryWords.length > 1) {
      const wordScores = queryWords.map(word => {
        const wordScore = fuzzyMatch(word, name);
        return wordScore || 0;
      });
      const avgWordScore = wordScores.reduce((a, b) => a + b, 0) / wordScores.length;
      bestScore = Math.max(bestScore, avgWordScore * 0.85); // Slight penalty for word-by-word
    }

    // Strategy 4: Typo tolerance using Levenshtein distance
    if (queryLower.length >= 4) {
      const nameWords = name.split(/\s+/);
      for (const word of nameWords) {
        if (word.length >= queryLower.length - 1) {
          const distance = levenshteinDistance(queryLower, word);
          if (distance <= maxTypoDistance) {
            const typoScore = 1.0 - (distance / queryLower.length);
            bestScore = Math.max(bestScore, typoScore * 0.9);
          }
        }
      }
    }

    // Strategy 5: Acronym matching (e.g., "gtav" matches "Grand Theft Auto V")
    if (queryLower.length >= 3) {
      const nameWords = name.split(/\s+/);
      if (nameWords.length >= queryLower.length) {
        const acronym = nameWords.map(w => w[0]).join('');
        if (acronym.includes(queryLower)) {
          bestScore = Math.max(bestScore, 0.75);
        }
      }
    }

    return { game, score: bestScore };
  })
  .filter(item => item.score >= threshold)
  .sort((a, b) => b.score - a.score); // Sort by score descending

  const results = limit ? scoredGames.slice(0, limit) : scoredGames;

  console.log(`🔍 Fuzzy search for "${query}": ${results.length}/${games.length} matches`);
  if (results.length > 0 && results.length <= 5) {
    console.log('Top results:', results.slice(0, 5).map(r =>
      `${r.game.name} (score: ${r.score.toFixed(2)})`
    ));
  }

  return results.map(item => item.game);
}

// ============================================================================
// REPLACE YOUR EXISTING applyFiltersAndRender FUNCTION WITH THIS:
// ============================================================================
function applyFiltersAndRender({ resetPage = true, installedOnly = false } = {}) {
  const q = (document.getElementById('search')?.value
            ?? document.getElementById('search-input')?.value
            ?? "").trim();

  const parentalOn = Boolean(window.__parentalEnabled);

  let base = allGames;

  // installed filter FIRST
  if (installedOnly) {
    const set = window.__installedSet || new Set();
    base = set.size ? base.filter(g => set.has(String(g.appid))) : base;
  }

  // ======= FUZZY SEARCH IMPLEMENTATION =======
  let searchResults = base;

  if (q && q.length >= 2) {
    searchResults = smartFuzzySearch(q, base, {
      threshold: 0.3,        // Adjust for more/less fuzzy matching
      maxTypoDistance: 2,    // Allow up to 2 character typos
      limit: null            // No limit on results
    });
  }

  // Apply other filters on search results
  filteredGames = searchResults.filter(g => {
    const requiresMembership = !!g.requires_membership;
    const matchesMembership  = !filterState.membershipOnly || requiresMembership;

    const online = String(g.online_supported || "").trim().toLowerCase() === "yes";
    const bypass = String(g.bypass_supported || "").trim().toLowerCase() === "yes";

    const matchesOnline = !filterState.onlineSupported || online;
    const matchesBypass = !filterState.bypassAvailable || bypass;

    const code = Number(g.primary_genre);
    const isAdult = isAdultGame(g);

    if (window.__parentalEnabled && isAdult) return false;

    if (filterState.adultsOnly) {
      return isAdult && matchesMembership && matchesOnline && matchesBypass;
    }

    const hasGenreFilter = filterState.primaryGenres.size > 0;
    const matchesGenre = !hasGenreFilter || (filterState.primaryGenres.has(code) && !isAdult);

    const matchesParental = !parentalOn || !(code === 71 || code === 72);

    return matchesMembership && matchesOnline && matchesBypass && matchesGenre && matchesParental;
  });

  if (resetPage) currentPage = 1;
  if (typeof renderPage === 'function') renderPage();
  else if (typeof renderGames === 'function') renderGames(filteredGames);
}


async function refreshInstalledSet() {
  const ids = await getInstalledLuaAppids(); // you already have this
  window.__installedSet = new Set((ids || []).map(String));
}

// Buttons
const btnMembership = document.getElementById('filter-membership');
const btnOnline     = document.getElementById('filter-online');
const btnBypass     = document.getElementById('filter-bypass');
const btnClear      = document.getElementById('filter-clear');

btnMembership?.addEventListener('click', () => {
  filterState.membershipOnly = !filterState.membershipOnly;
  btnMembership.classList.toggle('active', filterState.membershipOnly);
  applyFiltersAndRender({ resetPage: true });
});

btnOnline?.addEventListener('click', () => {
  filterState.onlineSupported = !filterState.onlineSupported;
  btnOnline.classList.toggle('active', filterState.onlineSupported);
  applyFiltersAndRender({ resetPage: true });
});

btnBypass?.addEventListener('click', () => {
  filterState.bypassAvailable = !filterState.bypassAvailable;
  btnBypass.classList.toggle('active', filterState.bypassAvailable);
  applyFiltersAndRender({ resetPage: true });
});

btnClear?.addEventListener('click', () => {
  filterState.membershipOnly = false;
  filterState.onlineSupported = false;
  filterState.bypassAvailable = false;
  filterState.primaryGenres.clear();                   // NEW
  filterState.adultsOnly = false;

  btnMembership.classList.remove('active');
  btnOnline.classList.remove('active');
  btnBypass.classList.remove('active');
  document.querySelectorAll('.genre-chip.active').forEach(el => el.classList.remove('active')); // NEW

  // Also clear search
  const searchInput = document.getElementById('search') || document.getElementById('search-input');
  if (searchInput) searchInput.value = '';

  applyFiltersAndRender({ resetPage: true });
});
// NEW: call this at the end of checkActivationStatus()
async function maybeAutoRestartSteam(data) {
  // If you showed the mismatch modal you already returned earlier, so we’re safe here.

  const shouldEnable = computeShouldEnable(data); // "activated for THIS steamid"
  const flippedToEnabled = (lastShouldEnable !== true) && shouldEnable;
  const needRestart = Boolean(data.restart_required || flippedToEnabled);

  const cooldownOk = (Date.now() - lastRestartTs) > steamRestartCooldownMs;

  if (needRestart && cooldownOk) {
    lastRestartTs = Date.now();
    try {
      await fetch('/api/restart_steam', { method: 'POST' });
      console.log('[AutoRestart] Steam restart requested.');
    } catch (e) {
      console.warn('[AutoRestart] Restart request failed:', e);
    }
  }

  lastShouldEnable = shouldEnable;
}


// Search (debounced is nicer for 31k items)
// Replace the old search handler with this debounced one:
const searchBox = document.getElementById('search-input'); // (HTML uses #search)
let _searchTimer;
searchBox?.addEventListener('input', () => {
  clearTimeout(_searchTimer);
  _searchTimer = setTimeout(() => applyFiltersAndRender({ resetPage: true }), 150);
});


// Toggle "Show Genre Filter" button
(function setupGenreToggle(){
  const toggleBtn = document.getElementById('toggle-genre');
  const panel = document.getElementById('genre-row');
  if (!toggleBtn || !panel) return;

  function openPanel() {
    // set to the content height for a smooth transition
    panel.style.maxHeight = panel.scrollHeight + 'px';
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.textContent = 'Hide Genre Filter';
  }
  function closePanel() {
    panel.style.maxHeight = '0px';
    toggleBtn.setAttribute('aria-expanded', 'false');
    toggleBtn.textContent = 'Show Genre Filter';
  }

  toggleBtn.addEventListener('click', () => {
    const expanded = toggleBtn.getAttribute('aria-expanded') === 'true';
    if (expanded) closePanel(); else openPanel();
  });

  // If chips are built/changed while open, recalc height
  const recalc = () => {
    if (toggleBtn.getAttribute('aria-expanded') === 'true') {
      // briefly set to 'auto' via measurement trick
      panel.style.maxHeight = '0px';
      requestAnimationFrame(() => {
        panel.style.maxHeight = panel.scrollHeight + 'px';
      });
    }
  };

  // Expose hook so your chip builder can call it after injecting chips
  window.__recalcGenrePanelHeight = recalc;
})();

(function () {
  // find your sidebar container (adjust selectors if your app uses a different one)
  const sidebar =
    document.querySelector("#sidebar") ||
    document.querySelector(".sidebar") ||
    document.querySelector("nav.sidebar");

  if (!sidebar) return;

  // ensure we have a single button
  let injectBtn = document.getElementById("inject-workshop-btn");
  if (!injectBtn) {
    injectBtn = document.createElement("button");
    injectBtn.id = "inject-workshop-btn";
    injectBtn.className = "sidebar-btn";
    injectBtn.innerHTML = `Enable Workshop<br><span style="font-size:13px;">🔥[Experimental]🔥</span>`;
    sidebar.appendChild(injectBtn);
  }

  if (injectBtn.dataset.bound === "1") return; // avoid double-binding

  injectBtn.addEventListener("click", async () => {
    const oldHTML = injectBtn.innerHTML; // keep HTML label
    injectBtn.disabled = true;
    injectBtn.innerHTML = "Enabling Workshop…";

    try {
      const res = await fetch("/api/workshop_inject", { method: "POST" });
      const data = await res.json();
      if (!res.ok || !data.success) {
        throw new Error(data.message || `HTTP ${res.status}`);
      }

      const msg = `Enabled workshop for ${data.keys_applied_count} game(s) in Steam.`;
      showToast(msg);
    } catch (err) {
      showToast(`Injection failed: ${err.message}`, true);
    } finally {
      injectBtn.disabled = false;
      injectBtn.innerHTML = oldHTML;
    }
  });

  injectBtn.dataset.bound = "1";

  // bigger toast + blurred background
  function showToast(message, isError = false, duration = 2500) {
    const overlay = document.createElement("div");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.background = "rgba(0,0,0,.25)";
    overlay.style.backdropFilter = "blur(6px)";
    overlay.style.webkitBackdropFilter = "blur(6px)";
    overlay.style.zIndex = "9998";

    const card = document.createElement("div");
    card.textContent = message;
    card.style.position = "fixed";
    card.style.left = "50%";
    card.style.top = "50%";
    card.style.transform = "translate(-50%, -50%)";
    card.style.padding = "22px 26px";
    card.style.borderRadius = "14px";
    card.style.fontSize = "16px";
    card.style.lineHeight = "1.45";
    card.style.textAlign = "center";
    card.style.maxWidth = "560px";
    card.style.width = "calc(100% - 48px)";
    card.style.boxShadow = "0 14px 48px rgba(0,0,0,.45)";
    card.style.background = isError ? "#b71c1c" : "#2e7d32";
    card.style.color = "#fff";
    card.style.zIndex = "9999";

    function cleanup() {
      document.removeEventListener("keydown", onKey);
      overlay.remove();
      card.remove();
    }
    function onKey(e) {
      if (e.key === "Escape") cleanup();
    }

    overlay.addEventListener("click", cleanup);
    document.addEventListener("keydown", onKey);

    document.body.appendChild(overlay);
    document.body.appendChild(card);
    setTimeout(cleanup, duration);
  }
})();

// --- state
let topDownloadsOnly = false;

// --- util: sort & take top 10 by downloads
function pickTopDownloads(list, limit = 20) {
  return [...list]
    .sort((a, b) => (b.downloads || 0) - (a.downloads || 0))
    .slice(0, limit);
}

// If you already have an applyFilters() that sets filteredGames, just
// insert the "Top Downloads" step at the END (so it applies on top of other filters).
function applyFilters() {
  // 1) start from all games
  let out = Array.isArray(allGames) ? [...allGames] : [];

  // 2) existing filters you already use (examples — keep your versions)
  if (window.showInstalledOnly) out = out.filter(g => g.installed);
  if (window.membershipOnly || filterState.membershipOnly) {
    out = out.filter(g => g.requires_membership === true);
  }

  // Split online and bypass filters
  if (filterState.onlineSupported) {
    out = out.filter(g =>
      String(g.online_supported || "").trim().toLowerCase() === "yes"
    );
  }

  if (filterState.bypassAvailable) {
    out = out.filter(g =>
      String(g.bypass_supported || "").trim().toLowerCase() === "yes"
    );
  }

  // 3) search filter (if you have a search box)
  const q = (document.getElementById('search')?.value || '').trim().toLowerCase();
  if (q) {
    out = out.filter(g => {
      const name = (g.name || '').toLowerCase();
      const appid = String(g.appid || '');
      return name.includes(q) || appid.includes(q);
    });
  }

  // 4) finally apply "Top 10" cut if enabled
  if (topDownloadsOnly) {
    out = pickTopDownloads(out, 20);
  }

  filteredGames = out;
  // reset to first page if you paginate
  if (typeof currentPage !== 'undefined') currentPage = 1;
  renderPage();
}

// --- wire the chip
const topDlBtn = document.getElementById('filter-top-downloads');
if (topDlBtn) {
  topDlBtn.addEventListener('click', () => {
    topDownloadsOnly = !topDownloadsOnly;
    topDlBtn.classList.toggle('active', topDownloadsOnly); // rely on your existing .chip.active styling
    applyFilters();
  });
}

const clearBtn = document.getElementById('filter-clear');
if (clearBtn) {
  clearBtn.addEventListener('click', () => {
    topDownloadsOnly = false;
    topDlBtn?.classList.remove('active');

    // Also clear search
    const searchInput = document.getElementById('search') || document.getElementById('search-input');
    if (searchInput) searchInput.value = '';

    // also reset your other flags/search as you already do...
    applyFilters();
  });
}

/* ===============================
   Parental Control (FULL DROP-IN)
   =============================== */
(function () {
  // --- Elements (must exist in your HTML) ---
  const pcToggle          = document.getElementById('pc-toggle');
  const pcModal           = document.getElementById('pc-pin-modal');
  const pcTitle           = document.getElementById('pc-pin-title');
  const pcDesc            = document.getElementById('pc-pin-desc');
  const pcError           = document.getElementById('pc-pin-error');
  const pcSetupFields     = document.getElementById('pc-pin-setup-fields');
  const pcInput           = document.getElementById('pc-pin-input');
  const pcConfirm         = document.getElementById('pc-pin-confirm');
  const pcUnlockFields    = document.getElementById('pc-pin-unlock-fields');
  const pcUnlockInput     = document.getElementById('pc-pin-unlock');
  const pcOK              = document.getElementById('pc-pin-ok');
  const pcCancel          = document.getElementById('pc-pin-cancel');

  if (!pcToggle || !pcModal) {
    console.warn('[PC] Parental UI not found; skipping init.');
    return;
  }

  // --- Global flag read by your filter pipeline ---
  // Your applyFiltersAndRender() should check this and exclude adult genres (71/72)
  window.__parentalEnabled = false;

  // --- Local state ---
  let parentalEnabled = false;
  const LS_HAS_PIN = 'pc_has_pin_v1'; // remember if a PIN was set before

  // --- Modal helpers ---
  function openPcModal(mode) {
    // mode: 'setup' | 'enable' | 'disable'
    pcError.textContent = '';
    if (mode === 'setup') {
      pcTitle.textContent = 'Set Parental PIN';
      pcDesc.textContent  = 'Create a 4–8 digit PIN.';
      pcSetupFields.style.display  = '';
      pcUnlockFields.style.display = 'none';
      pcInput.value = '';
      pcConfirm.value = '';
    } else if (mode === 'enable') {
      pcTitle.textContent = 'Enter PIN';
      pcDesc.textContent  = 'Enter your PIN to turn on Parental Control.';
      pcSetupFields.style.display  = 'none';
      pcUnlockFields.style.display = '';
      pcUnlockInput.value = '';
    } else {
      pcTitle.textContent = 'Turn Off Parental Control';
      pcDesc.textContent  = 'Enter your PIN to turn it off.';
      pcSetupFields.style.display  = 'none';
      pcUnlockFields.style.display = '';
      pcUnlockInput.value = '';
    }
    pcModal.style.display = 'flex';
    pcModal.classList.add('show');
    document.body.classList.add('modal-open');
  }
  function closePcModal() {
    pcModal.classList.remove('show');
    pcModal.style.display = 'none';
    document.body.classList.remove('modal-open');
  }

  // --- Validation ---
  function validPin(p) { return /^\d{4,8}$/.test(String(p || '').trim()); }

  // --- API calls ---
  async function getStatus() {
    const r = await fetch('/api/parental/status', { cache: 'no-store' });
    if (!r.ok) throw new Error(r.statusText);
    const j = await r.json();
    return !!j.enabled;
  }
  async function apiEnable(pin) {
    const r = await fetch('/api/parental/enable', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ pin: String(pin) })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.message || 'Enable failed');
  }
  async function apiDisable(pin) {
    const r = await fetch('/api/parental/disable', {
      method: 'POST',
      headers: {'Content-Type': 'application/json'},
      body: JSON.stringify({ pin: String(pin) })
    });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.ok === false) throw new Error(j.message || 'Disable failed');
  }

  // --- Ask your UI to re-run filters/render (non-invasive) ---
  function rerunFilters() {
    // Preferred: your central filter function
    if (typeof window.applyFiltersAndRender === 'function') {
      window.applyFiltersAndRender({ resetPage: true });
      return;
    }
    // Fallbacks (call what you already have)
    if (typeof window.renderPage === 'function') {
      window.renderPage();
      return;
    }
    // Last resort: emit a custom event your app can listen for
    window.dispatchEvent(new CustomEvent('filters-request-rerun'));
  }

  // --- Toggle wiring ---
  pcToggle.addEventListener('change', () => {
    // We only flip after server confirmation, so revert visual flip for now
    pcToggle.checked = parentalEnabled;

    // Turning ON
    if (!parentalEnabled) {
      const hasPin = localStorage.getItem(LS_HAS_PIN) === '1';
      openPcModal(hasPin ? 'enable' : 'setup');

      pcOK.onclick = async () => {
        try {
          pcOK.disabled = pcCancel.disabled = true;
          pcError.textContent = '';
          let pin;

          if (!hasPin) {
            const p1 = (pcInput.value || '').trim();
            const p2 = (pcConfirm.value || '').trim();
            if (!validPin(p1) || !validPin(p2)) {
              pcError.textContent = 'PIN must be 4–8 digits.'; return;
            }
            if (p1 !== p2) {
              pcError.textContent = 'PINs do not match.'; return;
            }
            pin = p1;
          } else {
            const p = (pcUnlockInput.value || '').trim();
            if (!validPin(p)) { pcError.textContent = 'PIN must be 4–8 digits.'; return; }
            pin = p;
          }

          await apiEnable(pin);
          localStorage.setItem(LS_HAS_PIN, '1');
          parentalEnabled = true;
          window.__parentalEnabled = true;
          pcToggle.checked = true;
          closePcModal();
          rerunFilters();
        } catch (err) {
          pcError.textContent = String(err.message || err);
        } finally {
          pcOK.disabled = pcCancel.disabled = false;
        }
      };

      pcCancel.onclick = () => { closePcModal(); /* keep OFF */ };
      return;
    }

    // Turning OFF
    openPcModal('disable');
    pcOK.onclick = async () => {
      try {
        pcOK.disabled = pcCancel.disabled = true;
        pcError.textContent = '';
        const pin = (pcUnlockInput.value || '').trim();
        if (!validPin(pin)) { pcError.textContent = 'PIN must be 4–8 digits.'; return; }

        await apiDisable(pin);
        parentalEnabled = false;
        window.__parentalEnabled = false;
        pcToggle.checked = false;
        closePcModal();
        rerunFilters();
      } catch (err) {
        pcError.textContent = String(err.message || err);
      } finally {
        pcOK.disabled = pcCancel.disabled = false;
      }
    };

    pcCancel.onclick = () => { closePcModal(); /* keep ON */ };
  });

  // --- Boot: get status, set flag, hydrate toggle, and re-run filters once ---
  (async function initParental() {
    try {
      parentalEnabled = await getStatus();
    } catch (_) {
      parentalEnabled = false;
    }
    window.__parentalEnabled = parentalEnabled;
    pcToggle.checked = parentalEnabled;
    rerunFilters();
  })();

})();


fetchGames();
renderPage();

// === Parental Control: boot hydration (auto-injected) ===
(function parentalHydrateInit(){try{
  const toggle = document.getElementById('pc-toggle');
  async function __pc_getStatus(){
    try{
      const r = await fetch('/api/parental/status',{cache:'no-store'});
      if(!r.ok) throw 0;
      const j = await r.json();
      return !!j.enabled;
    }catch(e){return false;}
  }
  (async()=>{
    const on = await __pc_getStatus();
    window.__parentalEnabled = on;
    if(toggle) toggle.checked = on;
    if(typeof applyFiltersAndRender==='function') applyFiltersAndRender({resetPage:true});
    else if(typeof renderPage==='function') renderPage();
  })();
  // mirror UI instantly; backend PIN flow should still confirm server-side elsewhere
  toggle && toggle.addEventListener('change', ()=>{
    window.__parentalEnabled = !!toggle.checked;
    if(typeof applyFiltersAndRender==='function') applyFiltersAndRender({resetPage:true});
    else if(typeof renderPage==='function') renderPage();
  });
}catch(_){}})();


// Debounced search listener (auto-injected) [SearchDebounce_PC]
(function(){
  const box = document.getElementById('search') || document.getElementById('search-input');
  if(!box) return;
  let t; box.addEventListener('input', ()=>{
    clearTimeout(t); t = setTimeout(()=>{
      if (typeof applyFiltersAndRender==='function') applyFiltersAndRender({resetPage:true});
    }, 150);
  });
})();
(function(){
  if (window.__fullUiZoomAddonLoaded) return; // avoid double init
  window.__fullUiZoomAddonLoaded = true;

  const ZOOM_MIN = 0.5;   // 50%
  const ZOOM_MAX = 2.0;   // 200%
  const STEP     = 0.1;
  const STORAGE_KEY = "onennabe_ui_zoom";

  function getStoredZoom(){
    const v = parseFloat(localStorage.getItem(STORAGE_KEY));
    return isNaN(v) ? 1.0 : Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, v));
  }

  let zoomLevel = getStoredZoom();

  function applyZoom(){
    // Chromium supports CSS zoom, which scales the entire document
    document.body.style.zoom = (zoomLevel * 100).toFixed(0) + "%";
    localStorage.setItem(STORAGE_KEY, String(zoomLevel));
  }

  function hookZoomButtons(){
    const zoomInBtn  = document.getElementById('zoom-in');
    const zoomOutBtn = document.getElementById('zoom-out');

    if(!zoomInBtn || !zoomOutBtn){
      // Retry later in case sidebar renders after script
      setTimeout(hookZoomButtons, 300);
      return;
    }

    zoomInBtn.addEventListener('click', () => {
      zoomLevel = Math.min(ZOOM_MAX, +(zoomLevel + STEP).toFixed(2));
      applyZoom();
    });

    zoomOutBtn.addEventListener('click', () => {
      zoomLevel = Math.max(ZOOM_MIN, +(zoomLevel - STEP).toFixed(2));
      applyZoom();
    });
  }

  // Initialize
  document.addEventListener('DOMContentLoaded', () => {
    applyZoom();
    hookZoomButtons();
  });
  if(document.readyState === 'interactive' || document.readyState === 'complete'){
    applyZoom();
    hookZoomButtons();
  }
})();
// Persist accordion state in localStorage
(function(){
  const ACCORDION_ID = 'sidebar-tools';
  const KEY = 'accordion:' + ACCORDION_ID;
  const el = document.getElementById(ACCORDION_ID);
  if(!el) return;

  // restore
  const saved = localStorage.getItem(KEY);
  if(saved === 'open') el.setAttribute('open', '');
  if(saved === 'closed') el.removeAttribute('open');

  // save on toggle
  el.addEventListener('toggle', () => {
    localStorage.setItem(KEY, el.open ? 'open' : 'closed');
  });
})();

// Replace your current verifyCdKeyOnStartupSimple with this:
async function verifyCdKeyOnStartupSimple() {
  try {
    const r = await fetch('/startup-verify', { method: 'POST', cache: 'no-store' });
    const j = await r.json().catch(() => ({}));

    if (j && j.status === 'REVOKED') {
      // Tell backend to delete the local SUINABE.dat
      try {
        await fetch('/api/delete-activation', { method: 'POST' });
      } catch (_) {
        console.warn("Failed to delete SUINABE.dat");
      }

      // Force Activation modal open
      window.forceActivationModal = true;
      if (typeof checkActivationStatus === 'function') {
        await checkActivationStatus();
      }
      if (typeof showModal === 'function') {
        showModal('activation-modal');
      }
      return;
    }

    if (!j || j.status === 'NETWORK_ERROR' || j.status === 'UNKNOWN') {
      ensureStartupWarnModal();
      showStartupWarnModal();
      return;
    }

    // ACTIVE or NO_LOCAL_KEY -> nothing at startup
  } catch (e) {
    ensureStartupWarnModal();
    showStartupWarnModal();
  }
}

(function initModalKit(){
  if (window.__modalKit) return;

  // Inject styles once
  const css = `
  .mk-backdrop{position:fixed;inset:0;display:none;align-items:center;justify-content:center;z-index:30000;
    background:rgba(0,0,0,.45);backdrop-filter:blur(10px) saturate(1.1);-webkit-backdrop-filter:blur(10px) saturate(1.1)}
  .mk-backdrop.show{display:flex;animation:mk-fade .16s ease-out}
  @keyframes mk-fade{from{opacity:0}to{opacity:1}}
  .mk-modal{width:min(92vw,560px);border-radius:16px;background:#0f1624;color:#e6eef8;
    box-shadow:0 20px 60px rgba(0,0,0,.55);border:1px solid rgba(255,255,255,.06);transform:translateY(10px);opacity:.98}
  .mk-head{display:flex;align-items:center;gap:10px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.06)}
  .mk-title{font-size:18px;font-weight:700}
  .mk-body{padding:18px;line-height:1.6}
  .mk-actions{display:flex;justify-content:flex-end;gap:10px;padding:12px 18px;border-top:1px solid rgba(255,255,255,.06)}
  .mk-btn{border:none;border-radius:10px;padding:10px 14px;font-weight:700;cursor:pointer}
  .mk-btn:focus{outline:2px solid #5aa3ff;outline-offset:2px}
  .mk-primary{background:#2a75ff;color:#fff}
  .mk-ghost{background:transparent;color:#e6eef8;border:1px solid rgba(255,255,255,.14)}
  .mk-danger{background:#e5484d;color:#fff}
  .mk-icon{display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:10px}
  .mk-icon.warn{background:rgba(239,68,68,.12);border:1px solid rgba(239,68,68,.35)}
  .mk-icon.info{background:rgba(59,130,246,.12);border:1px solid rgba(59,130,246,.35)}
  .mk-subtle{opacity:.85}
  `;
  const style = document.createElement('style');
  style.id = 'modal-kit-styles';
  style.textContent = css;
  document.head.appendChild(style);

  // Create backdrop container once
  const backdrop = document.createElement('div');
  backdrop.className = 'mk-backdrop';
  backdrop.setAttribute('aria-hidden', 'true');
  document.body.appendChild(backdrop);

  // Focus trap helpers
  function trapFocus(container){
    const focusables = container.querySelectorAll('button,[href],input,select,textarea,[tabindex]:not([tabindex="-1"])');
    const first = focusables[0], last = focusables[focusables.length - 1];
    function loop(e){
      if (e.key !== 'Tab') return;
      if (e.shiftKey && document.activeElement === first){ e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last){ e.preventDefault(); first.focus(); }
    }
    container.addEventListener('keydown', loop);
    return ()=>container.removeEventListener('keydown', loop);
  }

  function openModal({title, html, mode='confirm', okText='Delete', cancelText='Cancel', okVariant='danger'}){
    return new Promise(resolve=>{
      backdrop.innerHTML = '';
      const modal = document.createElement('div');
      modal.className = 'mk-modal';
      modal.setAttribute('role','dialog');
      modal.setAttribute('aria-modal','true');

      modal.innerHTML = `
        <div class="mk-head">
          <div class="mk-icon ${mode==='confirm' ? 'warn' : 'info'}" aria-hidden="true">
            ${mode==='confirm'
              ? '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path><line x1="12" y1="9" x2="12" y2="13"></line><line x1="12" y1="17" x2="12.01" y2="17"></line></svg>'
              : '<svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#3b82f6" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"></circle><line x1="12" y1="16" x2="12" y2="12"></line><line x1="12" y1="8" x2="12" y2="8"></line></svg>'
            }
          </div>
          <div class="mk-title">${title}</div>
        </div>
        <div class="mk-body">${html}</div>
        <div class="mk-actions">
          ${mode==='confirm' ? `<button class="mk-btn mk-ghost" id="mk-cancel">${cancelText}</button>` : ''}
          <button class="mk-btn ${okVariant==='danger' ? 'mk-danger' : 'mk-primary'}" id="mk-ok">${mode==='confirm' ? okText : 'OK'}</button>
        </div>
      `;

      backdrop.appendChild(modal);
      backdrop.classList.add('show');
      backdrop.setAttribute('aria-hidden','false');

      const untrap = trapFocus(modal);
      const btnOk = modal.querySelector('#mk-ok');
      const btnCancel = modal.querySelector('#mk-cancel');

      function close(val){
        untrap();
        backdrop.classList.remove('show');
        backdrop.setAttribute('aria-hidden','true');
        backdrop.innerHTML = '';
        resolve(val);
      }

      // Wire buttons
      btnOk.addEventListener('click', ()=>close(true));
      if (btnCancel) btnCancel.addEventListener('click', ()=>close(false));
      // Close on overlay click (but not when clicking inside modal)
      backdrop.addEventListener('click', (e)=>{ if (e.target === backdrop) close(false); });
      // ESC closes confirm/info like typical modal
      document.addEventListener('keydown', function esc(e){
        if (e.key === 'Escape'){ document.removeEventListener('keydown', esc); close(false); }
      });

      // Initial focus
      (btnCancel || btnOk).focus();
    });
  }

  async function confirmModal(options={}){
    const { title='Reset Activation?', message='This will remove the local CD-Key (SUINABE.dat) and require re-activation.', okText='Delete', cancelText='Cancel' } = options;
    return openModal({
      title, html:`<div class="mk-subtle">${message}</div>`,
      mode:'confirm', okText, cancelText, okVariant:'danger'
    });
  }

  async function infoModal({title='Done', message='Operation completed.'}={}){
    await openModal({ title, html:`<div class="mk-subtle">${message}</div>`, mode:'info', okVariant:'primary' });
  }

  window.__modalKit = { confirmModal, infoModal };
})();

// ---------- Your delete button wiring (using the modal) ----------
document.addEventListener('DOMContentLoaded', () => {
  const delBtn = document.getElementById('btn-delete-cdkey');
  if (!delBtn) return;

  delBtn.addEventListener('click', async (ev) => {
    ev.preventDefault();

    const ok = await __modalKit.confirmModal({
      title: 'Reset Activation?',
      message: 'This will reset your activation. You will need to activate again.',
      okText: 'Reset',
      cancelText: 'Cancel'
    });
    if (!ok) return;

    delBtn.disabled = true;
    const oldLabel = delBtn.textContent;
    delBtn.textContent = 'Deleting…';

    try {
      const res = await fetch('/api/delete-activation', { method: 'POST' });
      const data = await res.json().catch(()=> ({}));

      if (res.ok && data && data.ok !== false) {
        await __modalKit.infoModal({
          title: 'Activation Reset',
          message: (data.message || 'Local activation deleted.') + ' Please activate again.'
        });
        if (typeof checkActivationStatus === 'function') {
          await checkActivationStatus();
        } else if (typeof showModal === 'function') {
          showModal('activation-modal');
        } else {
          location.reload();
        }
      } else {
        await __modalKit.infoModal({
          title: 'Delete Failed',
          message: (data && data.message) ? data.message : 'Could not delete the activation file.'
        });
      }
    } catch (err) {
      console.error('Delete activation error:', err);
      await __modalKit.infoModal({
        title: 'Network Error',
        message: 'Network error while deleting activation. Please try again.'
      });
    } finally {
      delBtn.disabled = false;
      delBtn.textContent = oldLabel || 'Delete CD-Key';
    }
  });
});

function setInstalledOnlyUI(enabled) {
  // 1. Update the toggle button state
  const btn = document.getElementById("installed-toggle-btn");
  if (btn) {
    btn.textContent = enabled ? "Show All Games" : "Show Added Games Only";
    btn.dataset.active = enabled ? "1" : "0";
  }

  // 2. Update global flag
  window.installedOnly = !!enabled;

  // 3. Reapply filters (if you already have a rerender function)
  if (typeof applyFilters === "function") {
    applyFilters();
  }
}

function ensureStartupWarnModal() {
  if (document.getElementById('startup-license-warn')) return;

  // Non-blocking container (does NOT intercept page interactions)
  const bar = document.createElement('div');
  bar.id = 'startup-license-warn';
  bar.style.position = 'fixed';
  bar.style.top = '0';
  bar.style.left = '0';
  bar.style.right = '0';
  bar.style.zIndex = '9999';
  bar.style.display = 'none';            // keep same show/hide behavior as before
  bar.style.pointerEvents = 'none';      // <- crucial: do NOT block the app
  bar.style.background = 'transparent';  // no overlay, just a bar

  // Inner banner (clickable, but only inside itself)
  const inner = document.createElement('div');
  inner.style.pointerEvents = 'auto';
  inner.style.margin = '8px auto';
  inner.style.maxWidth = '720px';
  inner.style.borderRadius = '12px';
  inner.style.background = '#111827'; // slate-900
  inner.style.color = '#fff';
  inner.style.border = '1px solid rgba(255,255,255,0.1)';
  inner.style.boxShadow = '0 10px 30px rgba(0,0,0,0.35)';
  inner.style.display = 'flex';
  inner.style.alignItems = 'flex-start';
  inner.style.gap = '12px';
  inner.style.padding = '14px 16px';

  // Icon
  const iconWrap = document.createElement('div');
  iconWrap.style.cssText = 'display:inline-flex;align-items:center;justify-content:center;width:36px;height:36px;border-radius:8px;background:rgba(239,68,68,0.15);border:1px solid rgba(239,68,68,0.4);flex:0 0 36px;';
  iconWrap.innerHTML = `
    <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden="true"
         fill="none" stroke="#ef4444" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
      <path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"></path>
      <line x1="12" y1="9" x2="12" y2="13"></line>
      <line x1="12" y1="17" x2="12.01" y2="17"></line>
    </svg>
  `;

  // Text
  const text = document.createElement('div');
  text.style.flex = '1 1 auto';
  text.innerHTML = `
    <div style="font-size:16px;font-weight:700;color:#fca5a5;margin-bottom:4px;">
      CDKEY NOT VALID OR NO INTERNET CONNECTION
    </div>
    <div style="opacity:.9;line-height:1.45;">
      We couldn’t reach the activation service. You can continue using the app; features may be limited.
      <b>API IS OFFLINE, NO LATEST GAME LOADED, SERVER MAYBE DOWN.</b>
    </div>
  `;

  // Close button (optional)
  const closeBtn = document.createElement('button');
  closeBtn.type = 'button';
  closeBtn.textContent = '×';
  closeBtn.setAttribute('aria-label', 'Close');
  closeBtn.style.cssText = 'flex:0 0 auto;background:transparent;border:none;color:#fff;opacity:.7;font-size:20px;line-height:1;cursor:pointer;padding:0 4px;';
  closeBtn.addEventListener('click', (e) => {
    e.preventDefault();
    // just hide the bar; app remains fully usable
    bar.style.display = 'none';
  });

  inner.appendChild(iconWrap);
  inner.appendChild(text);
  inner.appendChild(closeBtn);
  bar.appendChild(inner);
  document.body.appendChild(bar);
}

function showStartupWarnModal(){
  const el = document.getElementById('startup-license-warn');
  if (el){ el.style.display = 'block'; }
}

// Kick off early on load
document.addEventListener('DOMContentLoaded', () => {
  verifyCdKeyOnStartupSimple();
});

function ensureUpdateModal(){
  if (document.getElementById('update-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'update-overlay';
  overlay.style.position = 'fixed';
  overlay.style.inset = '0';
  overlay.style.zIndex = '9998';
  overlay.style.display = 'none';
  overlay.style.background = 'rgba(0,0,0,.5)';
  overlay.innerHTML = `
    <div id="update-modal" role="dialog" aria-modal="true"
         style="width:min(90vw,640px);margin:10vh auto;background:#111827;color:#fff;
                border:1px solid rgba(255,255,255,.08);border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.6);
                font-family:system-ui, -apple-system, Segoe UI, Roboto, Inter, sans-serif;">
      <div style="padding:18px 22px;border-bottom:1px solid rgba(255,255,255,.06);display:flex;gap:12px;align-items:center">
        <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#60a5fa" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">
          <path d="M21 12a9 9 0 1 1-6.219-8.56"/><path d="M12 7v5l3 3"/>
        </svg>
        <div style="font-weight:800;font-size:18px">Updating…</div>
      </div>
      <div style="padding:18px 22px">
        <div style="margin-bottom:10px;opacity:.9" id="upd-msg">Downloading the latest version. Please keep the app open.</div>
        <div style="height:12px;background:#1f2937;border-radius:9999px;overflow:hidden;box-shadow: inset 0 0 0 1px rgba(255,255,255,.06)">
          <div id="upd-bar" style="height:100%;width:0%;background:linear-gradient(90deg,#60a5fa,#34d399);transition:width .2s ease"></div>
        </div>
        <div id="upd-foot" style="margin-top:10px;font-size:12px;opacity:.8">0%</div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}
function showUpdateModal(){ const o = document.getElementById('update-overlay'); if (o) o.style.display = 'block'; }
function hideUpdateModal(){ const o = document.getElementById('update-overlay'); if (o) o.style.display = 'none'; }

// ── Legacy version warning — shown when running < v1.3.6 (broken OTA) ────────
function showLegacyUpdateWarning() {
  if (document.getElementById('legacy-update-overlay')) return;
  const overlay = document.createElement('div');
  overlay.id = 'legacy-update-overlay';
  overlay.style.cssText = 'position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.75);display:flex;align-items:center;justify-content:center;';
  overlay.innerHTML = `
    <div style="width:min(92vw,520px);background:#111827;border:1px solid rgba(239,68,68,.4);
                border-radius:14px;box-shadow:0 20px 60px rgba(0,0,0,.8);
                font-family:system-ui,-apple-system,Segoe UI,Roboto,sans-serif;overflow:hidden;">
      <div style="padding:18px 22px;background:rgba(239,68,68,.12);border-bottom:1px solid rgba(239,68,68,.25);
                  display:flex;align-items:center;gap:12px;">
        <span style="font-size:22px;">⚠️</span>
        <div>
          <div style="font-weight:800;font-size:17px;color:#fff;">Manual Update Required</div>
          <div style="font-size:12px;color:#9ca3af;margin-top:2px;">Your version does not support automatic updates</div>
        </div>
      </div>
      <div style="padding:20px 22px;">
        <p style="color:#d1d5db;font-size:14px;line-height:1.6;margin:0 0 14px;">
          You are running <b style="color:#f87171;">v1.3.5</b> which has a known issue with the auto-updater.
          Please download and install <b style="color:#34d399;">v1.3.6</b> manually — this is a one-time step.
          Future updates will work automatically after this.
        </p>
        <div style="background:#1f2937;border-radius:8px;padding:12px 14px;margin-bottom:18px;font-size:13px;color:#9ca3af;line-height:1.7;">
          <b style="color:#fff;">Steps:</b><br>
          1. Click <b style="color:#60a5fa;">Download Installer</b> below<br>
          2. Run the installer — it will upgrade your existing install<br>
          3. Relaunch the app — auto-updates will work from now on
        </div>
        <div style="display:flex;gap:10px;justify-content:flex-end;">
          <button onclick="document.getElementById('legacy-update-overlay').style.display='none'"
                  style="padding:9px 18px;border-radius:7px;border:1px solid rgba(255,255,255,.15);
                         background:transparent;color:#9ca3af;cursor:pointer;font-size:13px;">
            Remind me later
          </button>
          <a href="https://github.com/3circledesign/OnennabeBruhHub/releases/latest"
             target="_blank"
             style="padding:9px 20px;border-radius:7px;border:none;
                    background:linear-gradient(135deg,#3b82f6,#2563eb);
                    color:#fff;font-weight:700;font-size:13px;text-decoration:none;
                    display:inline-flex;align-items:center;gap:6px;">
            ⬇ Download Installer
          </a>
        </div>
      </div>
    </div>`;
  document.body.appendChild(overlay);
}

function _jsVercmp(a, b) {
  const pa = String(a).replace(/^v/i,'').split('.').map(Number);
  const pb = String(b).replace(/^v/i,'').split('.').map(Number);
  const len = Math.max(pa.length, pb.length);
  for (let i = 0; i < len; i++) {
    const x = pa[i] || 0, y = pb[i] || 0;
    if (x !== y) return x > y ? 1 : -1;
  }
  return 0;
}

// Minimum version required for OTA to work correctly
const MIN_OTA_VERSION = '1.3.6';

async function beginAutoUpdate(){
  try {
    const kick = await fetch('/auto-update/begin', { method: 'POST', cache: 'no-store' });
    const jd = await kick.json();
    if (!jd.ok) {
      console.warn('[update] begin failed', jd);
      return;
    }

    // jd.version on up_to_date = current installed version (works on v1.3.5+)
    // jd.current_version = only on v1.3.6+ (new field we added)
    // Fall back to jd.version when up_to_date since that IS the current version
    const currentVer = jd.current_version || (jd.up_to_date ? jd.version : '');

    if (currentVer && _jsVercmp(currentVer, MIN_OTA_VERSION) < 0) {
      console.warn('[update] Legacy version detected:', currentVer, '— OTA not safe, showing manual warning');
      showLegacyUpdateWarning();
      return;
    }

    if (jd.up_to_date) {
      console.log('[update] already up to date', jd.version);
      return;
    }

    // OTA is safe — proceed with auto-update
    ensureUpdateModal();
    showUpdateModal();
    document.getElementById('upd-msg').textContent = 'Downloading the latest version…';
    pollUpdateProgress();
  } catch (e) {
    console.warn('[update] begin error', e);
  }
}

async function pollUpdateProgress(){
  try {
    const bar = document.getElementById('upd-bar');
    const foot = document.getElementById('upd-foot');
    const t = setInterval(async () => {
      try {
        const r = await fetch('/auto-update/progress', { cache: 'no-store' });
        const j = await r.json();
        if (!j.ok) return;
        if (j.phase === 'downloading') {
          const pct = Math.max(0, Math.min(100, Number(j.pct || 0)));
          if (bar) bar.style.width = pct + '%';
          if (foot) foot.textContent = pct.toFixed(0) + '%';
        } else if (j.phase === 'ready') {
          if (bar) bar.style.width = '100%';
          if (foot) foot.textContent = '100%';
          clearInterval(t);
          // Trigger OTA swap — bat script will relaunch after this process exits
          const launchResp = await fetch('/auto-update/launch', { method: 'POST' }).then(r => r.json()).catch(() => ({}));
          if (launchResp.restart) {
            document.getElementById('upd-msg').textContent = 'Update downloaded! Restarting app…';
            // Give the response time to return, then exit so bat can swap the exe
            setTimeout(async () => {
              await fetch('/auto-update/quit', { method: 'POST' }).catch(() => {});
            }, 800);
          } else {
            document.getElementById('upd-msg').textContent = 'Launching installer… Follow the steps in the installer window.';
          }
        } else if (j.phase === 'error') {
          clearInterval(t);
          document.getElementById('upd-msg').textContent = 'Update failed: ' + (j.error || 'unknown error');
        }
      } catch (_){}
    }, 600);
  } catch (e) {
    console.warn('[update] poll error', e);
  }
}

// Auto-trigger on boot (no prompts)
document.addEventListener('DOMContentLoaded', () => {
  beginAutoUpdate();
});

// --- Ensure Installed toggle sits below the Download Cart button ---
document.addEventListener('DOMContentLoaded', () => {
  const btn = document.getElementById('show-installed-btn');
  if (btn && cartBtn && cartBtn.nextSibling !== btn) {
    cartBtn.insertAdjacentElement('afterend', btn);
  }
});

(function () {

  function wrapRenderHooks() {
    if (window.__monthlyWrapDone) return;
    window.__monthlyWrapDone = true;

    // Wrap renderPage to strip membership-only games for MONTHLY license
    if (typeof window.renderPage === 'function') {
      const _origRender = window.renderPage;
      window.renderPage = function(...args) {
        try {
          const isMonthly = document.body.getAttribute('data-license') === 'monthly';
          if (isMonthly && Array.isArray(window.filteredGames)) {
            window.filteredGames = window.filteredGames.filter(g => !(g && g.requires_membership === true));
          }
        } catch (_) {}
        return _origRender.apply(this, args);
      };
    }

    // Also wrap applyFilters (if present) to pre-strip before pagination
    if (typeof window.applyFilters === 'function') {
      const _origApply = window.applyFilters;
      window.applyFilters = function(...args) {
        const ret = _origApply.apply(this, args);
        try {
          const isMonthly = document.body.getAttribute('data-license') === 'monthly';
          if (isMonthly && Array.isArray(window.filteredGames)) {
            window.filteredGames = window.filteredGames.filter(g => !(g && g.requires_membership === true));
          }
        } catch (_) {}
        return ret;
      };
    }
  }

  const SEL = {
    filterMembership: "#filter-membership",
    filterOnline: "#filter-online",
    filterBypass: "#filter-bypass",
    gameGrid: "#game-grid",
    modalConfirm: "#modal-confirm",
  };

  function injectMonthlyStyles() {
    if (document.getElementById("monthly-style-rules")) return;
    const style = document.createElement("style");
    style.id = "monthly-style-rules";
    style.textContent = `
      body[data-license="monthly"] ${SEL.filterMembership},
      body[data-license="monthly"] ${SEL.filterOnline},
      body[data-license="monthly"] ${SEL.filterBypass}{
        display: none !important;
      }
      body[data-license="monthly"] .bypass-label,
      body[data-license="monthly"] .online-badge,
      body[data-license="monthly"] .patch-btn,
      body[data-license="monthly"] [data-role="patch-btn"],
      body[data-license="monthly"] [data-action="patch"],
      body[data-license="monthly"] a[href*="patch"],
      body[data-license="monthly"] button[data-patch],
      body[data-license="monthly"] .bypass-patch {
        display: none !important;
        visibility: hidden !important;
        pointer-events: none !important;
      }
    `;
    document.head.appendChild(style);
  }

  function stripPatchElements(root) {
    const selectors = [
      ".bypass-label",
      ".online-badge",
      ".patch-btn",
      "[data-role='patch-btn']",
      "[data-action='patch']",
      "a[href*='patch']",
      "button[data-patch]",
      ".bypass-patch",
    ];
    selectors.forEach(sel => {
      root.querySelectorAll(sel).forEach(el => {
        el.remove();
      });
    });
  }

  function watchGridForPatches() {
    const grid = document.querySelector(SEL.gameGrid);
    if (!grid) return;
    stripPatchElements(grid);
    const mo = new MutationObserver((muts) => {
      for (const m of muts) {
        m.addedNodes.forEach(node => {
          if (node.nodeType === 1) stripPatchElements(node);
        });
      }
    });
    mo.observe(grid, { childList: true, subtree: true });
  }

  async function fetchActivationType() {
    try {
      const r = await fetch("/activation-status", { cache: "no-store" });
      const j = await r.json();
      const typ = (j && j.activation_type || "").toLowerCase();
      return typ;
    } catch (e) {
      return "";
    }
  }

  async function applyLicenseUI() {
    const activationType = await fetchActivationType();
    if (activationType !== "monthly") {
      document.body.removeAttribute("data-license");
      return;
    }
    document.body.setAttribute("data-license", "monthly");
    injectMonthlyStyles();
    stripPatchElements(document);
    watchGridForPatches();
  }

  function hookActivationButton() {
    const btn = document.querySelector(SEL.modalConfirm);
    if (!btn) return;
    btn.addEventListener("click", () => {
      setTimeout(applyLicenseUI, 1200);
    });
  }

  document.addEventListener("DOMContentLoaded", () => {
    wrapRenderHooks();
    applyLicenseUI();
    hookActivationButton();
    window.addEventListener("focus", applyLicenseUI, { passive: true });
  });
})();
(() => {
  const grid = document.getElementById('game-grid');
  const notifModal = document.getElementById('notification-modal');
  const notifContent = document.getElementById('notification-content');

  function showNotice(html) {
    notifContent.innerHTML = html;
    notifModal.style.display = 'flex';
  }
  function hideNotice() {
    notifModal.style.display = 'none';
    notifContent.innerHTML = '';
  }
  // Click outside to close
  notifModal?.addEventListener('click', (e) => {
    if (e.target === notifModal) hideNotice();
  });

  async function installLauncher(appid, btn) {
    try {
      btn.disabled = true;

      // Pre-fetch app info via JS APIs and push to backend cache
      SteamAPI.getAppInfo(appid).catch(() => {}); // fire-and-forget, don't block UI

      showNotice(`
        <div style="display:flex;flex-direction:column;gap:8px;align-items:center">
          <div>Installing Universal Online Patch for <b>${appid}</b>…</div>
          <div class="spinner" aria-hidden="true"></div>
        </div>
      `);

      const res = await fetch(`/api/install_launcher/${appid}`, { method: 'POST' });
      const data = await res.json();

      if (!res.ok || !data.success) {
        showNotice(`
          <div style="display:flex;flex-direction:column;gap:10px;align-items:center;max-width:420px;">
            <div style="font-weight:700;color:#ff6b6b;">Failed</div>
            <div style="opacity:.9">${(data && data.message) ? data.message : 'Unknown error.'}</div>
            <button class="btn-pill" style="background:#455a64" id="notice-close">Close</button>
          </div>
        `);
        document.getElementById('notice-close')?.addEventListener('click', hideNotice);
        return;
      }

      // Success UI with optional Restart Steam
      showNotice(`
        <div style="display:flex;flex-direction:column;gap:12px;align-items:center;max-width:520px;">
          <div style="font-weight:700;color:#7cf;">Universal Online Patch Installed</div>
          <div style="opacity:.9;text-align:center">
            Installed to:<br><code style="font-size:.95em">${data.game_folder || '(unknown)'}</code><br>
            EXE: <code>${data.exe}</code><br>
            INI: <code>${data.ini}</code>
          </div>
          <div style="display:flex;gap:8px;flex-wrap:wrap;justify-content:center;">
            <button class="btn-pill" id="notice-close" style="background:#37474f">Close</button>
            <button class="btn-pill" id="restart-steam" title="Restart Steam to pick up changes">↻ Restart Steam</button>
          </div>
        </div>
      `);

      document.getElementById('notice-close')?.addEventListener('click', hideNotice);
      document.getElementById('restart-steam')?.addEventListener('click', async () => {
        try {
          const r = await fetch('/api/restart_steam', { method: 'POST' });
          const j = await r.json().catch(() => ({}));
          showNotice(`
            <div style="display:flex;flex-direction:column;gap:10px;align-items:center;">
              <div style="font-weight:700;">${r.ok ? 'Steam Restarted' : 'Restart Failed'}</div>
              <div style="opacity:.9">${(j && j.message) ? j.message : ''}</div>
              <button class="btn-pill" id="notice-close" style="background:#37474f">Close</button>
            </div>
          `);
          document.getElementById('notice-close')?.addEventListener('click', hideNotice);
        } catch (e) {
          showNotice(`
            <div style="display:flex;flex-direction:column;gap:10px;align-items:center;">
              <div style="font-weight:700;color:#ff6b6b;">Restart Error</div>
              <div style="opacity:.9">${String(e)}</div>
              <button class="btn-pill" id="notice-close" style="background:#37474f">Close</button>
            </div>
          `);
          document.getElementById('notice-close')?.addEventListener('click', hideNotice);
        }
      });
    } catch (e) {
      showNotice(`
        <div style="display:flex;flex-direction:column;gap:10px;align-items:center;">
          <div style="font-weight:700;color:#ff6b6b;">Unexpected Error</div>
          <div style="opacity:.9;max-width:460px;">${String(e)}</div>
          <button class="btn-pill" id="notice-close" style="background:#37474f">Close</button>
        </div>
      `);
      document.getElementById('notice-close')?.addEventListener('click', hideNotice);
    } finally {
      btn.disabled = false;
    }
  }

  // Event delegation for all Install Unsteam buttons in the grid
  grid?.addEventListener('click', (e) => {
    const btn = e.target.closest('.install-launcher');
    if (!btn) return;
    const appid = btn.getAttribute('data-appid');
    if (!appid) return;
    installLauncher(appid, btn);
  });
})();
// === Steamless - Direct function (for fanout menu) ===
async function runSteamless(appid, buttonElement = null) {
  if (!appid) return;

  // Helper function to show the summary modal
  async function showSteamlessSummary({ appid, folder, summary }) {
    return new Promise((resolve) => {
      if (!document.getElementById('steamless-inline-styles')) {
        const css = `
          .slm__overlay{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.55);backdrop-filter:blur(8px);animation:slmFade .12s ease}
          .slm__wrap{box-sizing:border-box;width:min(92vw,820px);margin:8vh auto;border-radius:18px;background:#0b1220;color:#e5e7eb;border:1px solid rgba(255,255,255,.08);box-shadow:0 30px 90px rgba(0,0,0,.6);font-family:system-ui,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial;overflow:hidden}
          .slm__head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.06);
            background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 50%, #22d3ee 100%);}
          .slm__ttl{display:flex;align-items:center;gap:12px;color:#fff}
          .slm__badge{font-size:12px;font-weight:800;padding:6px 10px;border-radius:999px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.25);color:#fff}
          .slm__body{padding:18px 20px}
          .slm__pill{background:#0f172a;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px 12px;margin:0 0 10px 0}
          .slm__pill code{color:#93c5fd}
          .slm__grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0 2px}
          .slm__card{border-radius:14px;padding:14px;text-align:center;background:#0f172a;border:1px solid rgba(255,255,255,.12)}
          .slm__num{font-size:22px;font-weight:900;line-height:1}
          .slm__ok .slm__num{color:#34d399} .slm__warn .slm__num{color:#fbbf24} .slm__err .slm__num{color:#f87171}
          .slm__lbl{opacity:.85;font-size:12px;letter-spacing:.3px;text-transform:uppercase}
          .slm__note{opacity:.9;margin:8px 0 10px}
          .slm__sec{border:1px solid rgba(255,255,255,.08);border-radius:12px;background:#0f172a;margin:10px 0;overflow:hidden}
          .slm__sec summary{cursor:pointer;padding:12px 14px;font-weight:900;letter-spacing:.2px;display:flex;justify-content:space-between;align-items:center;list-style:none}
          .slm__sec summary::-webkit-details-marker{display:none}
          .slm__sec .slm__content{max-height:260px;overflow:auto;padding:4px 14px 12px}
          .slm__actions{display:flex;gap:10px;justify-content:flex-end;padding:0 20px 16px}
          .slm__btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:#111827;color:#fff;border-radius:12px;padding:10px 14px;font-weight:800;cursor:pointer}
          .slm__btn:hover{filter:brightness(1.05)}
          .slm__btn--primary{background:#2563eb;border-color:rgba(255,255,255,.18)}
          @media (prefers-color-scheme: light){
            .slm__wrap{background:#fff;color:#0f172a;border-color:rgba(0,0,0,.08)}
            .slm__pill,.slm__card,.slm__sec{background:#fff;border-color:rgba(0,0,0,.08)}
            .slm__btn{background:#f1f5f9;color:#0f172a;border-color:rgba(0,0,0,.1)}
            .slm__btn--primary{background:#2563eb;color:#fff}
          }
          @keyframes slmFade{from{opacity:0}to{opacity:1}}
        `;
        const st = document.createElement('style');
        st.id = 'steamless-inline-styles';
        st.appendChild(document.createTextNode(css));
        document.head.appendChild(st);
      }

      const rep = summary?.replaced || [];
      const ski = summary?.skipped  || [];
      const err = summary?.errors   || [];
      const processed = summary?.processed || [];
      const repCount = rep.length, skiCount = ski.length, errCount = err.length;

      const mkList = (arr) =>
        (arr && arr.length)
          ? arr.map(x => `<div style="padding:8px 0;border-bottom:1px dashed rgba(255,255,255,.08)">${x}</div>`).join('')
          : `<div style="opacity:.7">—</div>`;

      const overlayEl = document.createElement('div'); overlayEl.className = 'slm__overlay';
      const wrap    = document.createElement('div'); wrap.className = 'slm__wrap';

      const head = document.createElement('div'); head.className = 'slm__head';
      head.innerHTML = `
        <div class="slm__ttl">
          <div style="width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:rgba(0,0,0,.15);backdrop-filter: blur(2px);">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>
          </div>
          <div>
            <div style="font-size:16px;font-weight:900;letter-spacing:.2px">Steamless Completed</div>
            <div style="opacity:.95;font-size:12px;margin-top:2px;color:#fff">Files unpacked and swapped where available</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div class="slm__badge">AppID ${String(appid)}</div>
          <div class="slm__badge">Processed ${processed.length}</div>
          <button class="slm__btn" data-close>✕</button>
        </div>
      `;

      const body = document.createElement('div'); body.className = 'slm__body';

      const folderPill = document.createElement('div'); folderPill.className = 'slm__pill';
      folderPill.innerHTML = `<div style="font-weight:800;margin-bottom:4px;opacity:.95">Folder</div><code>${folder || '—'}</code>`;

      const grid = document.createElement('div'); grid.className = 'slm__grid';
      grid.innerHTML = `
        <div class="slm__card slm__ok"><div class="slm__num">${repCount}</div><div class="slm__lbl">Replaced</div></div>
        <div class="slm__card slm__warn"><div class="slm__num">${skiCount}</div><div class="slm__lbl">Skipped</div></div>
        <div class="slm__card slm__err"><div class="slm__num">${errCount}</div><div class="slm__lbl">Errors</div></div>
      `;

      const note = document.createElement('div'); note.className = 'slm__note';
      note.innerHTML = `Replaced files are backed up as <code>.BAK</code>. "Skipped" usually means no <code>.unpacked.exe</code> was produced (file not packed).`;

      function makeDetails(title, html, open=false, accent='') {
        const details = document.createElement('details'); details.className = 'slm__sec'; if (open) details.setAttribute('open', '');
        const sum = document.createElement('summary');
        sum.innerHTML = `<span ${accent ? `style="color:${accent}"` : ''}>${title}</span><span style="opacity:.7">▼</span>`;
        const content = document.createElement('div'); content.className = 'slm__content'; content.innerHTML = html;
        details.appendChild(sum); details.appendChild(content);
        return details;
      }

      const secReplaced = makeDetails(`Replaced (${repCount})`, mkList(rep), true);
      const secSkipped  = makeDetails(`Skipped (${skiCount})`,  mkList(ski), false);
      const secErrors   = errCount ? makeDetails(`Errors (${errCount})`, mkList(err), false, '#fca5a5') : null;

      const actions = document.createElement('div'); actions.className = 'slm__actions';
      const copyBtn = document.createElement('button'); copyBtn.className = 'slm__btn'; copyBtn.textContent = 'Copy JSON';
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify({ appid: String(appid), folder, summary }, null, 2));
          const old = copyBtn.textContent; copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = old, 900);
        } catch {}
      };
      const openBtn = document.createElement('button'); openBtn.className = 'slm__btn'; openBtn.textContent = 'Open Folder';
      if (window.pywebview?.api?.open_folder && folder) {
        openBtn.onclick = async () => { try { await window.pywebview.api.open_folder(folder); } catch {} };
      } else {
        openBtn.style.display = 'none';
      }
      const doneBtn = document.createElement('button'); doneBtn.className = 'slm__btn slm__btn--primary'; doneBtn.textContent = 'Done';
      doneBtn.onclick = () => { try { document.body.removeChild(overlayEl); } catch {} ; resolve(); };

      actions.appendChild(copyBtn); actions.appendChild(openBtn); actions.appendChild(doneBtn);

      overlayEl.appendChild(wrap);
      wrap.appendChild(head);
      wrap.appendChild(body);
      body.appendChild(folderPill);
      body.appendChild(grid);
      body.appendChild(note);
      body.appendChild(secReplaced);
      body.appendChild(secSkipped);
      if (secErrors) body.appendChild(secErrors);
      wrap.appendChild(actions);
      document.body.appendChild(overlayEl);

      const closeBtn = head.querySelector('[data-close]');
      const close = () => { try{ document.body.removeChild(overlayEl);} catch{}; resolve(); };
      closeBtn.addEventListener('click', close);
      overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) close(); });
      const esc = (e)=>{ if (e.key === 'Escape') { e.preventDefault(); document.removeEventListener('keydown', esc, true); close(); } };
      document.addEventListener('keydown', esc, true);
    });
  }

  try {
    if (buttonElement) {
      buttonElement.disabled = true;
      buttonElement.textContent = 'Running…';
    }

    const r = await fetch('/api/steamless', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appid: String(appid).trim() })
    });
    const j = await r.json().catch(() => ({}));

    if (buttonElement) {
      buttonElement.disabled = false;
      buttonElement.textContent = 'Steamless [Remove DRM]';
    }

    if (!r.ok || !j.success) {
      const dump = j && j.summary ? `
      <details style="margin-top:8px;opacity:.85">
        <summary>Show debug</summary>
        <pre style="white-space:pre-wrap;max-height:220px;overflow:auto;">${JSON.stringify(j.summary, null, 2)}</pre>
      </details>` : '';

      await showSteamlessSummary({
        appid,
        folder: j.game_folder || '',
        summary: {
          replaced: [],
          skipped: [],
          errors: [(j && j.message) || r.statusText || 'Unknown error.'],
          processed: []
        }
      });
      return;
    }

    const sum = j.summary || {};
    await showSteamlessSummary({ appid: j.appid, folder: j.game_folder, summary: sum });

  } catch (e) {
    if (buttonElement) {
      buttonElement.disabled = false;
      buttonElement.textContent = 'Steamless [Remove DRM]';
    }

    await showSteamlessSummary({
      appid: appid,
      folder: '',
      summary: {
        replaced: [],
        skipped: [],
        errors: [String(e && e.message || e)],
        processed: []
      }
    });
  }
}

// === Steamless in Sidebar (reuses promptModal + niceModal if you have them) ===
function ensureSteamlessSidebarButton() {
  const BTN_ID = 'steamless-sidebar-btn';

  // If already present, bail
  if (document.getElementById(BTN_ID)) return;

  // Where to try first
  const selectorList = [
    '#sidebar .actions',
    '#sidebar',
    '.sidebar .actions',
    '.sidebar',
    '[data-role="sidebar"]',
  ];

function makeButton() {
  const btn = document.createElement('button');
  btn.id = BTN_ID;
  btn.type = 'button';
  btn.setAttribute('data-allow-locked', '1');
  btn.title = 'Run Steamless on all EXEs in a game folder';
  btn.innerHTML = `Steamless<br><span style="font-size:13px;">[Remove Steam DRM]</span>`;
  btn.addEventListener('mouseenter', () => btn.style.filter = 'brightness(1.05)');
  btn.addEventListener('mouseleave', () => btn.style.filter = '');

  // --- Pretty modal (standalone, no niceModal) ------------------------------
  async function showSteamlessSummary({ appid, folder, summary }) {
    return new Promise((resolve) => {
      if (!document.getElementById('steamless-inline-styles')) {
        const css = `
          .slm__overlay{position:fixed;inset:0;z-index:99999;background:rgba(15,23,42,.55);backdrop-filter:blur(8px);animation:slmFade .12s ease}
          .slm__wrap{box-sizing:border-box;width:min(92vw,820px);margin:8vh auto;border-radius:18px;background:#0b1220;color:#e5e7eb;border:1px solid rgba(255,255,255,.08);box-shadow:0 30px 90px rgba(0,0,0,.6);font-family:system-ui,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial;overflow:hidden}
          .slm__head{display:flex;align-items:center;justify-content:space-between;padding:18px 20px;border-bottom:1px solid rgba(255,255,255,.06);
            background: linear-gradient(135deg, #0ea5e9 0%, #6366f1 50%, #22d3ee 100%);}
          .slm__ttl{display:flex;align-items:center;gap:12px;color:#fff}
          .slm__badge{font-size:12px;font-weight:800;padding:6px 10px;border-radius:999px;background:rgba(0,0,0,.18);border:1px solid rgba(255,255,255,.25);color:#fff}
          .slm__body{padding:18px 20px}
          .slm__pill{background:#0f172a;border:1px solid rgba(255,255,255,.08);border-radius:12px;padding:10px 12px;margin:0 0 10px 0}
          .slm__pill code{color:#93c5fd}
          .slm__grid{display:grid;grid-template-columns:repeat(3,minmax(0,1fr));gap:10px;margin:12px 0 2px}
          .slm__card{border-radius:14px;padding:14px;text-align:center;background:#0f172a;border:1px solid rgba(255,255,255,.12)}
          .slm__num{font-size:22px;font-weight:900;line-height:1}
          .slm__ok .slm__num{color:#34d399} .slm__warn .slm__num{color:#fbbf24} .slm__err .slm__num{color:#f87171}
          .slm__lbl{opacity:.85;font-size:12px;letter-spacing:.3px;text-transform:uppercase}
          .slm__note{opacity:.9;margin:8px 0 10px}
          .slm__sec{border:1px solid rgba(255,255,255,.08);border-radius:12px;background:#0f172a;margin:10px 0;overflow:hidden}
          .slm__sec summary{cursor:pointer;padding:12px 14px;font-weight:900;letter-spacing:.2px;display:flex;justify-content:space-between;align-items:center;list-style:none}
          .slm__sec summary::-webkit-details-marker{display:none}
          .slm__sec .slm__content{max-height:260px;overflow:auto;padding:4px 14px 12px}
          .slm__actions{display:flex;gap:10px;justify-content:flex-end;padding:0 20px 16px}
          .slm__btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:#111827;color:#fff;border-radius:12px;padding:10px 14px;font-weight:800;cursor:pointer}
          .slm__btn:hover{filter:brightness(1.05)}
          .slm__btn--primary{background:#2563eb;border-color:rgba(255,255,255,.18)}
          @media (prefers-color-scheme: light){
            .slm__wrap{background:#fff;color:#0f172a;border-color:rgba(0,0,0,.08)}
            .slm__pill,.slm__card,.slm__sec{background:#fff;border-color:rgba(0,0,0,.08)}
            .slm__btn{background:#f1f5f9;color:#0f172a;border-color:rgba(0,0,0,.1)}
            .slm__btn--primary{background:#2563eb;color:#fff}
          }
          @keyframes slmFade{from{opacity:0}to{opacity:1}}
        `;
        const st = document.createElement('style');
        st.id = 'steamless-inline-styles';
        st.appendChild(document.createTextNode(css));
        document.head.appendChild(st);
      }

      const rep = summary?.replaced || [];
      const ski = summary?.skipped  || [];
      const err = summary?.errors   || [];
      const processed = summary?.processed || [];
      const repCount = rep.length, skiCount = ski.length, errCount = err.length;

      const mkList = (arr) =>
        (arr && arr.length)
          ? arr.map(x => `<div style="padding:8px 0;border-bottom:1px dashed rgba(255,255,255,.08)">${x}</div>`).join('')
          : `<div style="opacity:.7">—</div>`;

      const overlayEl = document.createElement('div'); overlayEl.className = 'slm__overlay';
      const wrap    = document.createElement('div'); wrap.className = 'slm__wrap';

      const head = document.createElement('div'); head.className = 'slm__head';
      head.innerHTML = `
        <div class="slm__ttl">
          <div style="width:42px;height:42px;border-radius:12px;display:grid;place-items:center;background:rgba(0,0,0,.15);backdrop-filter: blur(2px);">
            <svg width="22" height="22" viewBox="0 0 24 24" fill="none" stroke="#ffffff" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6L9 17l-5-5"></path></svg>
          </div>
          <div>
            <div style="font-size:16px;font-weight:900;letter-spacing:.2px">Steamless Completed</div>
            <div style="opacity:.95;font-size:12px;margin-top:2px;color:#fff">Files unpacked and swapped where available</div>
          </div>
        </div>
        <div style="display:flex;gap:8px;align-items:center;flex-wrap:wrap">
          <div class="slm__badge">AppID ${String(appid)}</div>
          <div class="slm__badge">Processed ${processed.length}</div>
          <button class="slm__btn" data-close>✕</button>
        </div>
      `;

      const body = document.createElement('div'); body.className = 'slm__body';

      const folderPill = document.createElement('div'); folderPill.className = 'slm__pill';
      folderPill.innerHTML = `<div style="font-weight:800;margin-bottom:4px;opacity:.95">Folder</div><code>${folder || '—'}</code>`;

      const grid = document.createElement('div'); grid.className = 'slm__grid';
      grid.innerHTML = `
        <div class="slm__card slm__ok"><div class="slm__num">${repCount}</div><div class="slm__lbl">Replaced</div></div>
        <div class="slm__card slm__warn"><div class="slm__num">${skiCount}</div><div class="slm__lbl">Skipped</div></div>
        <div class="slm__card slm__err"><div class="slm__num">${errCount}</div><div class="slm__lbl">Errors</div></div>
      `;

      const note = document.createElement('div'); note.className = 'slm__note';
      note.innerHTML = `Replaced files are backed up as <code>.BAK</code>. “Skipped” usually means no <code>.unpacked.exe</code> was produced (file not packed).`;

      function makeDetails(title, html, open=false, accent='') {
        const details = document.createElement('details'); details.className = 'slm__sec'; if (open) details.setAttribute('open', '');
        const sum = document.createElement('summary');
        sum.innerHTML = `<span ${accent ? `style="color:${accent}"` : ''}>${title}</span><span style="opacity:.7">▼</span>`;
        const content = document.createElement('div'); content.className = 'slm__content'; content.innerHTML = html;
        details.appendChild(sum); details.appendChild(content);
        return details;
      }

      const secReplaced = makeDetails(`Replaced (${repCount})`, mkList(rep), true);
      const secSkipped  = makeDetails(`Skipped (${skiCount})`,  mkList(ski), false);
      const secErrors   = errCount ? makeDetails(`Errors (${errCount})`, mkList(err), false, '#fca5a5') : null;

      const actions = document.createElement('div'); actions.className = 'slm__actions';
      const copyBtn = document.createElement('button'); copyBtn.className = 'slm__btn'; copyBtn.textContent = 'Copy JSON';
      copyBtn.onclick = async () => {
        try {
          await navigator.clipboard.writeText(JSON.stringify({ appid: String(appid), folder, summary }, null, 2));
          const old = copyBtn.textContent; copyBtn.textContent = 'Copied'; setTimeout(() => copyBtn.textContent = old, 900);
        } catch {}
      };
      const openBtn = document.createElement('button'); openBtn.className = 'slm__btn'; openBtn.textContent = 'Open Folder';
      if (window.pywebview?.api?.open_folder && folder) {
        openBtn.onclick = async () => { try { await window.pywebview.api.open_folder(folder); } catch {} };
      } else {
        openBtn.style.display = 'none';
      }
      const doneBtn = document.createElement('button'); doneBtn.className = 'slm__btn slm__btn--primary'; doneBtn.textContent = 'Done';
      doneBtn.onclick = () => { try { document.body.removeChild(overlayEl); } catch {} ; resolve(); };

      actions.appendChild(copyBtn); actions.appendChild(openBtn); actions.appendChild(doneBtn);

      overlayEl.appendChild(wrap);
      wrap.appendChild(head);
      wrap.appendChild(body);
      body.appendChild(folderPill);
      body.appendChild(grid);
      body.appendChild(note);
      body.appendChild(secReplaced);
      body.appendChild(secSkipped);
      if (secErrors) body.appendChild(secErrors);
      wrap.appendChild(actions);
      document.body.appendChild(overlayEl);

      const closeBtn = head.querySelector('[data-close]');
      const close = () => { try{ document.body.removeChild(overlayEl);} catch{}; resolve(); };
      closeBtn.addEventListener('click', close);
      overlayEl.addEventListener('click', (e) => { if (e.target === overlayEl) close(); });
      const esc = (e)=>{ if (e.key === 'Escape') { e.preventDefault(); document.removeEventListener('keydown', esc, true); close(); } };
      document.addEventListener('keydown', esc, true);
    });
  }
  // ---------------------------------------------------------------------------

  // Click handler
  btn.addEventListener('click', async () => {
    const initial = localStorage.getItem('lastSteamlessAppId') || '';
    const appid = (typeof promptAppIdModal === 'function')
      ? await promptAppIdModal({ title:'Steamless Unpack', label:'Enter Steam AppID', initialValue: initial, okText:'Run', cancelText:'Cancel' })
      : (window.prompt('Enter Steam AppID') || '').trim();

    if (!appid) return;
    localStorage.setItem('lastSteamlessAppId', appid);

    try {
      btn.disabled = true;
      const oldHTML = btn.innerHTML;
      btn.innerHTML = 'Running…';

      const r = await fetch('/api/steamless', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ appid: String(appid).trim() })
      });
      const j = await r.json().catch(() => ({}));

      btn.innerHTML = oldHTML;
      btn.disabled = false;

      if (!r.ok || !j.success) {
        const dump = j && j.summary ? `
        <details style="margin-top:8px;opacity:.85">
          <summary>Show debug</summary>
          <pre style="white-space:pre-wrap;max-height:220px;overflow:auto;">${JSON.stringify(j.summary, null, 2)}</pre>
        </details>` : '';
        if (typeof niceModal === 'function') {
          await niceModal({
            title: 'Steamless Failed',
            message: `
              <div style="margin-bottom:8px;">${(j && j.message) || r.statusText || 'Unknown error.'}</div>
              <div style="opacity:.85">Ensure the game is installed and <code>appmanifest_${appid}.acf</code> exists.</div>
              ${dump}
            `,
            variant: 'error',
            okText: 'OK'
          });
        } else {
          // inline fallback error modal
          await showSteamlessSummary({
            appid,
            folder: j.game_folder || '',
            summary: { replaced: [], skipped: [], errors: [(j && j.message) || r.statusText || 'Unknown error.'], processed: [] }
          });
        }
        return;
      }

      const sum = j.summary || {};
      // SUCCESS — always show pretty standalone modal (so you never fall back to alert)
      await showSteamlessSummary({ appid: j.appid, folder: j.game_folder, summary: sum });

    } catch (e) {
      btn.disabled = false;
      if (typeof niceModal === 'function') {
        await niceModal({ title: 'Unexpected Error', message: `<div>${e.message || e}</div>`, variant: 'error', okText: 'OK' });
      } else {
        await showSteamlessSummary({
          appid: appid,
          folder: '',
          summary: { replaced: [], skipped: [], errors: [String(e && e.message || e)], processed: [] }
        });
      }
    }
  });

  return btn;
}

  function findHost() {
    for (const sel of selectorList) {
      const el = document.querySelector(sel);
      if (el) return el;
    }
    return null;
  }

  // If host exists now, append immediately
  let host = findHost();
  if (host) {
    host.appendChild(makeButton());
    return;
  }

  // Otherwise, wait for sidebar to appear
  const mo = new MutationObserver(() => {
    const h = findHost();
    if (h) {
      if (!document.getElementById(BTN_ID)) h.appendChild(makeButton());
      mo.disconnect();
    }
  });
  mo.observe(document.documentElement, { childList: true, subtree: true });

  // Safety: also append a floating fallback if sidebar never appears in 2s
  setTimeout(() => {
    if (!document.getElementById(BTN_ID)) {
      const float = document.createElement('div');
      float.style.cssText = `
        position: fixed; right: 18px; bottom: 18px; z-index: 9999;
        max-width: 240px;
      `;
      float.appendChild(makeButton());
      document.body.appendChild(float);
    }
  }, 2000);
}

// init - DISABLED: Steamless moved to game card menus only
// document.addEventListener('DOMContentLoaded', ensureSteamlessSidebarButton);
// if (document.readyState === 'interactive' || document.readyState === 'complete') {
//   ensureSteamlessSidebarButton();
// }

async function promptAppIdModal({
  title = 'Steamless (Remove Steam DRM)',
  label = 'Enter Steam AppID',
  initialValue = '',
  okText = 'Run',
  cancelText = 'Cancel'
} = {}) {
  // Ensure niceModal CSS exists (we rely on .nm-* classes)
  if (!document.getElementById('nice-modal-styles')) {
    // If you haven’t added niceModal yet, paste that helper first.
    // Otherwise we add a minimal subset so the prompt still looks good.
    const s = document.createElement('style');
    s.id = 'nice-modal-styles';
    s.textContent = `
      .nm-overlay{position:fixed;inset:0;z-index:99999;background:rgba(0,0,0,.45);backdrop-filter:blur(6px)}
      .nm-wrap{box-sizing:border-box;width:min(92vw,480px);margin:12vh auto;border-radius:16px;background:#0f172a;color:#e5e7eb;border:1px solid rgba(255,255,255,.08);box-shadow:0 25px 80px rgba(0,0,0,.55);font-family:system-ui,Segoe UI,Roboto,Ubuntu,"Helvetica Neue",Arial}
      .nm-head{display:flex;align-items:center;gap:12px;padding:16px 18px;border-bottom:1px solid rgba(255,255,255,.06);font-weight:700;font-size:16px}
      .nm-body{padding:16px 18px;line-height:1.55}
      .nm-actions{display:flex;justify-content:flex-end;gap:10px;padding:0 18px 16px}
      .nm-btn{appearance:none;border:1px solid rgba(255,255,255,.14);background:#1f2937;color:#fff;border-radius:10px;padding:9px 14px;font-weight:600;cursor:pointer}
      .nm-btn:hover{filter:brightness(1.05)}
      .nm-btn-primary{background:#2563eb;border-color:rgba(255,255,255,.18)}
      .nm-field{display:flex;align-items:center;gap:10px}
      .nm-input{flex:1 1 auto;width:100%;padding:10px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.14);background:#0b1220;color:#fff;outline:none}
      .nm-help{margin-top:8px;opacity:.8;font-size:12px}
      @media (prefers-color-scheme: light){
        .nm-wrap{background:#ffffff;color:#0f172a;border-color:rgba(0,0,0,.08)}
        .nm-body{color:#334155}
        .nm-input{background:#fff;color:#0f172a;border-color:rgba(0,0,0,.14)}
        .nm-btn{background:#f1f5f9;color:#0f172a;border-color:rgba(0,0,0,.1)}
        .nm-btn-primary{background:#2563eb;color:#fff}
      }
    `;
    document.head.appendChild(s);
  }

  return new Promise((resolve) => {
    const overlay = document.createElement('div'); overlay.className = 'nm-overlay';

    const wrap = document.createElement('div'); wrap.className = 'nm-wrap';
    const head = document.createElement('div'); head.className = 'nm-head'; head.textContent = title;

    const body = document.createElement('div'); body.className = 'nm-body';
    const field = document.createElement('div'); field.className = 'nm-field';

    const prefix = document.createElement('div');
    prefix.style.cssText = 'padding:0 10px;border:1px solid rgba(255,255,255,.14);border-radius:10px;background:#111827;color:#9ca3af;font-weight:700';
    prefix.textContent = 'AppID';

    const input = document.createElement('input');
    input.className = 'nm-input';
    input.placeholder = label;
    input.value = initialValue || '';
    input.inputMode = 'numeric';
    input.autocomplete = 'off';
    input.spellcheck = false;

    // numeric filter
    input.addEventListener('input', () => {
      input.value = input.value.replace(/[^\d]/g, '').slice(0, 10);
    });

    field.appendChild(prefix);
    field.appendChild(input);

    const help = document.createElement('div');
    help.className = 'nm-help';
    help.innerHTML = `Example: <code>570</code> (Dota 2), <code>892970</code> (Valheim).`;

    body.appendChild(field);
    body.appendChild(help);

    const actions = document.createElement('div'); actions.className = 'nm-actions';
    const cancel = document.createElement('button'); cancel.className = 'nm-btn'; cancel.textContent = cancelText;
    const ok = document.createElement('button'); ok.className = 'nm-btn nm-btn-primary'; ok.textContent = okText;

    actions.appendChild(cancel);
    actions.appendChild(ok);

    wrap.appendChild(head);
    wrap.appendChild(body);
    wrap.appendChild(actions);
    overlay.appendChild(wrap);
    document.body.appendChild(overlay);

    function close(ret) {
      try { document.body.removeChild(overlay); } catch {}
      resolve(ret);
    }

    cancel.addEventListener('click', () => close(null));
    ok.addEventListener('click', () => {
      const val = (input.value || '').trim();
      if (!/^\d+$/.test(val)) {
        input.focus();
        input.select();
        return;
      }
      close(val);
    });

    input.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') ok.click();
      if (e.key === 'Escape') cancel.click();
    });

    setTimeout(() => input.select(), 0);
    overlay.addEventListener('click', (e) => { if (e.target === overlay) close(null); });
  });
}
// Simple solid modal — no transparency, no blur
(function () {
  if (window.niceModal) return;

  const backdrop = document.createElement('div');
  backdrop.id = 'nm-solid-backdrop';
  Object.assign(backdrop.style, {
    position: 'fixed', inset: '0', zIndex: '9998',
    background: '#0b1220',  // solid dark
    display: 'none'
  });

  const box = document.createElement('div');
  box.id = 'nm-solid-box';
  Object.assign(box.style, {
    position: 'fixed', zIndex: '9999',
    left: '50%', top: '50%', transform: 'translate(-50%, -50%)',
    width: 'min(92vw, 640px)',
    background: '#111827', color: '#e5e7eb',
    border: '1px solid rgba(255,255,255,.08)',
    borderRadius: '12px',
    boxShadow: '0 20px 60px rgba(0,0,0,.6)',
    display: 'none', overflow: 'hidden', fontFamily: 'system-ui, Segoe UI, Roboto, Arial'
  });

  box.innerHTML = `
    <div id="nm-solid-head" style="padding:14px 16px;border-bottom:1px solid rgba(255,255,255,.08);font-weight:800;">
      <span id="nm-solid-title">Notice</span>
    </div>
    <div id="nm-solid-body" style="padding:16px;line-height:1.55;"></div>
    <div id="nm-solid-foot" style="padding:12px 16px;border-top:1px solid rgba(255,255,255,.08);display:flex;justify-content:flex-end;gap:10px;">
      <button id="nm-solid-ok" type="button" style="padding:9px 12px;border-radius:10px;border:1px solid rgba(255,255,255,.12);background:#1f2937;color:#fff;font-weight:700;cursor:pointer;">OK</button>
    </div>
  `;

  document.body.appendChild(backdrop);
  document.body.appendChild(box);

  function open() { backdrop.style.display = 'block'; box.style.display = 'block'; }
  function close() { box.style.display = 'none'; backdrop.style.display = 'none'; }

  window.niceModal = function ({ title = 'Notice', message = '', okText = 'OK' } = {}) {
    return new Promise((resolve) => {
      box.querySelector('#nm-solid-title').textContent = title;
      box.querySelector('#nm-solid-body').innerHTML = message;
      box.querySelector('#nm-solid-ok').textContent = okText;

      const onOk = () => { okBtn.removeEventListener('click', onOk); close(); resolve(true); };
      const okBtn = box.querySelector('#nm-solid-ok');
      okBtn.addEventListener('click', onOk, { once: true });

      // Close on ESC
      const onEsc = (e) => { if (e.key === 'Escape') { e.preventDefault(); cleanup(); resolve(true); } };
      const cleanup = () => { document.removeEventListener('keydown', onEsc, true); close(); };
      document.addEventListener('keydown', onEsc, true);

      open();
    });
  };
})();
/* =======================
   COMPLETE STEAM-THEMED Depot Download UI
   Includes professional library selector with disk space visualization
   ======================= */

/* Ensure a Steam-styled progress modal exists */
(function ensureDepotModal(){
  if (document.getElementById('depot-modal')) return;

  const css = document.createElement('style');
  css.textContent = `
  /* Steam Theme Colors */
  :root {
    --steam-dark: #1B2838;
    --steam-darker: #16202D;
    --steam-light: #2A475E;
    --steam-accent: #66C0F4;
    --steam-text: #C7D5E0;
    --steam-muted: #8F98A0;
  }

  .depot-modal-backdrop {
    position: fixed;
    inset: 0;
    background: linear-gradient(135deg,
      rgba(22, 32, 45, 0.95) 0%,
      rgba(27, 40, 56, 0.98) 100%
    );
    backdrop-filter: blur(10px);
    display: none;
    z-index: 9998;
    animation: steamFadeIn 0.3s ease;
  }

  .depot-modal {
    position: fixed;
    inset: 0;
    display: none;
    z-index: 9999;
    align-items: center;
    justify-content: center;
  }

  .depot-card {
    width: min(720px, 96vw);
    background: linear-gradient(165deg, var(--steam-dark) 0%, var(--steam-darker) 100%);
    color: var(--steam-text);
    border: 1px solid rgba(102, 192, 244, 0.2);
    border-radius: 12px;
    padding: 0;
    box-shadow:
      0 20px 60px rgba(0, 0, 0, 0.6),
      0 0 1px rgba(102, 192, 244, 0.3),
      inset 0 1px 0 rgba(102, 192, 244, 0.1);
    font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
    overflow: hidden;
    animation: steamSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
  }

  /* Header */
  .depot-card h3 {
    margin: 0;
    padding: 20px 24px 16px;
    font-size: 20px;
    font-weight: 600;
    background: linear-gradient(180deg, rgba(102, 192, 244, 0.08) 0%, transparent 100%);
    border-bottom: 1px solid rgba(102, 192, 244, 0.15);
    display: flex;
    align-items: center;
    gap: 12px;
  }

  .depot-card h3::before {
    content: '';
    width: 40px;
    height: 40px;
    background: linear-gradient(135deg, rgba(102, 192, 244, 0.15) 0%, rgba(102, 192, 244, 0.05) 100%);
    border: 2px solid rgba(102, 192, 244, 0.3);
    border-radius: 8px;
    display: flex;
    align-items: center;
    justify-content: center;
    flex-shrink: 0;
    background-image: url("data:image/svg+xml,%3Csvg width='24' height='24' viewBox='0 0 24 24' fill='none' xmlns='http://www.w3.org/2000/svg'%3E%3Cpath d='M19 9h-4V3H9v6H5l7 7 7-7zM5 18v2h14v-2H5z' fill='%2366C0F4'/%3E%3C/svg%3E");
    background-repeat: no-repeat;
    background-position: center;
  }

  /* Metadata Grid */
  .depot-kv {
    padding: 16px 24px;
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(200px, 1fr));
    gap: 12px;
    font-size: 13px;
  }

  .depot-kv > div {
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .depot-kv b {
    font-size: 11px;
    color: var(--steam-muted);
    text-transform: uppercase;
    letter-spacing: 0.5px;
    font-weight: 600;
  }

  .depot-kv code {
    background: rgba(0, 0, 0, 0.3);
    padding: 4px 8px;
    border-radius: 4px;
    font-family: ui-monospace, Consolas, monospace;
    font-size: 12px;
    color: var(--steam-accent);
    border: 1px solid rgba(102, 192, 244, 0.2);
    display: inline-block;
    margin-top: 2px;
  }

  /* Progress Section */
  .depot-row {
    padding: 0 24px 16px 24px;
    display: flex;
    flex-direction: column;
    gap: 10px;
  }

  .depot-progress-wrapper {
    display: flex;
    justify-content: space-between;
    align-items: center;
    margin-bottom: 8px;
  }

  .depot-progress-label {
    font-size: 14px;
    color: var(--steam-text);
    font-weight: 500;
  }

  .depot-percent {
    font-size: 16px;
    color: var(--steam-accent);
    font-weight: 600;
    font-family: 'Courier New', monospace;
  }

  .depot-progress {
    width: 100%;
    height: 8px;
    position: relative;
    background: rgba(0, 0, 0, 0.4);
    border-radius: 4px;
    overflow: hidden;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.3);
    appearance: none;
  }

  .depot-progress::-webkit-progress-bar {
    background: rgba(0, 0, 0, 0.4);
    border-radius: 4px;
  }

  .depot-progress::-webkit-progress-value {
    background: linear-gradient(90deg, #4A9ED8 0%, var(--steam-accent) 50%, #7DD4FF 100%);
    border-radius: 4px;
    box-shadow: 0 0 10px rgba(102, 192, 244, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.3);
    position: relative;
  }

  .depot-progress::-moz-progress-bar {
    background: linear-gradient(90deg, #4A9ED8 0%, var(--steam-accent) 50%, #7DD4FF 100%);
    border-radius: 4px;
    box-shadow: 0 0 10px rgba(102, 192, 244, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.3);
  }

  /* Log Console */
  .depot-log {
    margin: 0 24px 20px 24px;
    background: rgba(0, 0, 0, 0.3);
    border: 1px solid rgba(102, 192, 244, 0.2);
    border-radius: 8px;
    max-height: 220px;
    overflow: auto;
    padding: 12px;
    font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
    font-size: 12px;
    line-height: 1.6;
    color: var(--steam-muted);
    white-space: pre-wrap;
    box-shadow: inset 0 2px 4px rgba(0, 0, 0, 0.2);
  }

  .depot-log::-webkit-scrollbar {
    width: 8px;
  }

  .depot-log::-webkit-scrollbar-track {
    background: rgba(0, 0, 0, 0.2);
    border-radius: 4px;
  }

  .depot-log::-webkit-scrollbar-thumb {
    background: rgba(102, 192, 244, 0.3);
    border-radius: 4px;
  }

  .depot-log::-webkit-scrollbar-thumb:hover {
    background: rgba(102, 192, 244, 0.5);
  }

  /* Actions Footer */
  .depot-actions {
    padding: 16px 24px 20px;
    background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.2) 100%);
    border-top: 1px solid rgba(102, 192, 244, 0.1);
    display: flex;
    justify-content: flex-end;
    gap: 12px;
  }

  /* Buttons */
  .btn {
    padding: 10px 20px;
    border: none;
    border-radius: 6px;
    font-size: 14px;
    font-weight: 600;
    cursor: pointer;
    transition: all 0.2s ease;
    display: inline-flex;
    align-items: center;
    gap: 8px;
    position: relative;
    overflow: hidden;
  }

  .btn::before {
    content: '';
    position: absolute;
    top: 50%;
    left: 50%;
    width: 0;
    height: 0;
    background: rgba(255, 255, 255, 0.2);
    border-radius: 50%;
    transform: translate(-50%, -50%);
    transition: width 0.6s, height 0.6s;
  }

  .btn:active::before {
    width: 300px;
    height: 300px;
  }

  .btn-primary {
    background: linear-gradient(135deg, #5C9BC6 0%, var(--steam-accent) 50%, #76D0FF 100%);
    color: #fff;
    box-shadow: 0 4px 12px rgba(102, 192, 244, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3);
  }

  .btn-primary:hover {
    background: linear-gradient(135deg, #6CACCD 0%, #76D0FF 50%, #86E0FF 100%);
    transform: translateY(-1px);
    box-shadow: 0 6px 16px rgba(102, 192, 244, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.4);
  }

  .btn-primary:active {
    transform: translateY(0);
  }

  .btn-ghost {
    background: linear-gradient(135deg, rgba(42, 71, 94, 0.8) 0%, rgba(42, 71, 94, 0.6) 100%);
    color: var(--steam-text);
    border: 1px solid rgba(102, 192, 244, 0.3);
  }

  .btn-ghost:hover {
    background: linear-gradient(135deg, rgba(42, 71, 94, 1) 0%, rgba(42, 71, 94, 0.8) 100%);
    border-color: rgba(102, 192, 244, 0.5);
    color: #fff;
    transform: translateY(-1px);
  }

  .btn-ghost:active {
    transform: translateY(0);
  }

  /* Animations */
  @keyframes steamFadeIn {
    from { opacity: 0; }
    to { opacity: 1; }
  }

  @keyframes steamSlideIn {
    from {
      opacity: 0;
      transform: translateY(-40px) scale(0.95);
    }
    to {
      opacity: 1;
      transform: translateY(0) scale(1);
    }
  }

  /* Responsive */
  @media (max-width: 768px) {
    .depot-card {
      width: 95vw;
    }

    .depot-kv {
      grid-template-columns: 1fr;
    }

    .depot-actions {
      flex-direction: column;
    }

    .btn {
      width: 100%;
      justify-content: center;
    }
  }
  `;
  document.head.appendChild(css);

  const backdrop = document.createElement('div');
  backdrop.id = 'depot-modal-backdrop';
  backdrop.className = 'depot-modal-backdrop';

  const modal = document.createElement('div');
  modal.id = 'depot-modal';
  modal.className = 'depot-modal';
  modal.innerHTML = `
    <div class="depot-card">
      <h3 id="depot-title">Standalone Game Downloader</h3>
      <div class="depot-kv" id="depot-meta"></div>
      <div class="depot-row">
        <div class="depot-progress-wrapper">
          <span class="depot-progress-label">Preparing...</span>
          <span id="depot-percent" class="depot-percent">0%</span>
        </div>
        <progress id="depot-progress" class="depot-progress" value="0" max="100"></progress>
      </div>
      <div id="depot-log" class="depot-log"></div>
      <div class="depot-actions">
        <button id="depot-cancel" class="btn btn-ghost">Close</button>
        <button id="depot-open-folder" class="btn btn-primary" style="display:none;">
          <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
            <path d="M20 6h-8l-2-2H4c-1.1 0-1.99.9-1.99 2L2 18c0 1.1.9 2 2 2h16c1.1 0 2-.9 2-2V8c0-1.1-.9-2-2-2z" fill="currentColor"/>
          </svg>
          Open Folder
        </button>
      </div>
    </div>
  `;
  document.body.appendChild(backdrop);
  document.body.appendChild(modal);

  const hide = () => {
    backdrop.style.display = 'none';
    modal.style.display = 'none';
    document.body.classList.remove('modal-open');
  };
  document.getElementById('depot-cancel').onclick = hide;
  backdrop.onclick = hide;

  window.__showDepotModal = function(title, htmlMeta){
    document.getElementById('depot-title').textContent = title || 'Game Downloader (Standalone)';

    // Convert htmlMeta to Steam-styled grid
    const metaContainer = document.getElementById('depot-meta');
    metaContainer.innerHTML = '';

    if (htmlMeta) {
      const parser = new DOMParser();
      const doc = parser.parseFromString(htmlMeta, 'text/html');
      const items = doc.querySelectorAll('div');

      items.forEach(item => {
        const html = item.innerHTML;
        const match = html.match(/<b>([^<]+):<\/b>\s*(.+)/);

        if (match) {
          const wrapper = document.createElement('div');

          const label = document.createElement('b');
          label.textContent = match[1];

          const valueDiv = document.createElement('div');
          valueDiv.innerHTML = match[2];

          wrapper.appendChild(label);
          wrapper.appendChild(valueDiv);
          metaContainer.appendChild(wrapper);
        }
      });
    }

    document.getElementById('depot-progress').value = 0;
    document.getElementById('depot-percent').textContent = '0%';
    document.getElementById('depot-log').textContent = '';
    document.getElementById('depot-open-folder').style.display = 'none';
    document.body.classList.add('modal-open');
    backdrop.style.display = 'block';
    modal.style.display = 'flex';
  };

  window.__updateDepotModal = function(pct, lines){
    const p = Math.max(0, Math.min(100, parseInt(pct || 0, 10)));
    document.getElementById('depot-progress').value = p;
    document.getElementById('depot-percent').textContent = p + '%';
    if (Array.isArray(lines)) {
      document.getElementById('depot-log').textContent = lines.join('\n');
      const el = document.getElementById('depot-log');
      el.scrollTop = el.scrollHeight;
    }
  };

  window.__finishDepotModal = function(showOpen, folderPath){
    const btn = document.getElementById('depot-open-folder');
    if (showOpen) {
      btn.style.display = 'inline-flex';
      btn.onclick = async () => {
        try {
          if (window.pywebview?.api?.open_folder) {
            await window.pywebview.api.open_folder(folderPath || '');
          }
        } catch(_){}
      };
    } else {
      btn.style.display = 'none';
    }
  };

  // NEW: Show Play (Bypass Steam) button after successful installation
  window.__showDepotPlayButton = function(appid, gameName){
    const btn = document.getElementById('depot-open-folder');
    btn.textContent = '🎮 Play (Bypass Steam)';
    btn.style.display = 'inline-flex';
    btn.style.background = 'linear-gradient(135deg, #5C9BC6 0%, #66C0F4 50%, #76D0FF 100%)';
    btn.style.color = '#fff';
    btn.style.fontWeight = '700';
    btn.style.padding = '12px 24px';
    btn.style.borderRadius = '6px';
    btn.style.border = 'none';
    btn.style.cursor = 'pointer';
    btn.style.boxShadow = '0 4px 12px rgba(102, 192, 244, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.3)';
    btn.style.transition = 'all 0.2s ease';

    // Refresh installation badges after download completes
    setTimeout(() => {
      if (window.updateGameInstallationBadges) {
        window.updateGameInstallationBadges();
      }
    }, 1000);

    btn.onclick = async () => {
      try {
        // Launch game via ONENNABE launcher
        const launchRes = await fetch(`/api/launch_onennabe/${appid}`, {
          method: 'POST'
        });

        const launchData = await launchRes.json();

        if (launchRes.ok && launchData.success) {
          // Show success message
          const logDiv = document.getElementById('depot-log');
          logDiv.textContent += '\n\n🚀 Launching ' + gameName + '...';
          logDiv.scrollTop = logDiv.scrollHeight;

          // Close modal after a moment
          setTimeout(() => {
            backdrop.style.display = 'none';
            modal.style.display = 'none';
            document.body.classList.remove('modal-open');
          }, 1500);
        } else {
          // Show error
          const logDiv = document.getElementById('depot-log');
          logDiv.textContent += '\n\n❌ Launch failed: ' + (launchData.message || 'Unknown error');
          logDiv.scrollTop = logDiv.scrollHeight;
        }
      } catch (error) {
        console.error('Launch error:', error);
        const logDiv = document.getElementById('depot-log');
        logDiv.textContent += '\n\n❌ Launch error: ' + error.message;
        logDiv.scrollTop = logDiv.scrollHeight;
      }
    };

    // Hover effects
    btn.addEventListener('mouseenter', () => {
      btn.style.transform = 'translateY(-2px)';
      btn.style.boxShadow = '0 6px 16px rgba(102, 192, 244, 0.5), inset 0 1px 0 rgba(255, 255, 255, 0.4)';
    });

    btn.addEventListener('mouseleave', () => {
      btn.style.transform = 'translateY(0)';
      btn.style.boxShadow = '0 4px 12px rgba(102, 192, 244, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.3)';
    });
  };
})();

// PROFESSIONAL STEAM LIBRARY SELECTOR with Disk Space Visualization
async function appendDepotControls(game, card){
  const row = card.querySelector('.play-bypass-row') || card.querySelector('.actions-acf') || card;

  let container = card.querySelector('.depot-actions-row');
  if (!container) {
    container = document.createElement('div');
    container.className = 'depot-actions-row';
    container.style.cssText = 'margin-top:8px; display:flex; gap:8px; width:100%;';
    row.insertAdjacentElement('afterend', container);
  } else {
    container.replaceChildren();
  }

  // ==== PROFESSIONAL STEAM LIBRARY SELECTOR with Disk Space Visualization ====
  function selectSteamLibraryModal(libraries, suggestedInstalldir) {
    return new Promise((resolve) => {
      const overlayId = 'select-steam-lib-overlay';
      const existing = document.getElementById(overlayId);
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = overlayId;
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 99999;
        background: linear-gradient(135deg, rgba(22, 32, 45, 0.95) 0%, rgba(27, 40, 56, 0.98) 100%);
        backdrop-filter: blur(10px);
        display: flex; align-items: center; justify-content: center;
        animation: steamFadeIn 0.3s ease;
      `;

      const box = document.createElement('div');
      box.style.cssText = `
        width: min(680px, 92vw);
        background: linear-gradient(165deg, #1B2838 0%, #16202D 100%);
        color: #C7D5E0; border: 1px solid rgba(102, 192, 244, 0.2);
        border-radius: 14px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 1px rgba(102, 192, 244, 0.3);
        overflow: hidden; animation: steamSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      `;

      box.innerHTML = `
        <div style="padding: 24px 28px 20px; background: linear-gradient(180deg, rgba(102, 192, 244, 0.08) 0%, transparent 100%); border-bottom: 1px solid rgba(102, 192, 244, 0.15);">
          <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 12px;">
            <div style="width: 56px; height: 56px; background: linear-gradient(135deg, rgba(102, 192, 244, 0.15) 0%, rgba(102, 192, 244, 0.05) 100%); border: 2px solid rgba(102, 192, 244, 0.3); border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" fill="#66C0F4" opacity="0.3"/>
                <rect x="2" y="4" width="20" height="16" rx="2" stroke="#66C0F4" stroke-width="2" fill="none"/>
                <circle cx="6" cy="8" r="1" fill="#66C0F4"/><circle cx="6" cy="12" r="1" fill="#66C0F4"/><circle cx="6" cy="16" r="1" fill="#66C0F4"/>
              </svg>
            </div>
            <div>
              <h2 style="margin: 0 0 6px 0; font-size: 24px; font-weight: 700; color: #fff; letter-spacing: 0.3px;">Choose Installation Drive</h2>
              <p style="margin: 0; font-size: 14px; color: #8F98A0; line-height: 1.5;">Select where to install <strong style="color: #66C0F4;">${suggestedInstalldir || 'your game'}</strong></p>
            </div>
          </div>
        </div>

        <div style="padding: 24px 28px;">
          <div style="margin-bottom: 20px; padding: 14px 16px; background: rgba(102, 192, 244, 0.05); border-left: 3px solid #66C0F4; border-radius: 6px;">
            <div style="font-size: 13px; color: #C7D5E0; line-height: 1.6;">
              <strong style="color: #66C0F4;">Installation Path:</strong><br/>
              <code style="background: rgba(0, 0, 0, 0.3); padding: 4px 8px; border-radius: 4px; font-family: ui-monospace, Consolas, monospace; font-size: 12px; color: #8F98A0; display: inline-block; margin-top: 4px;">{selected}\\steamapps\\common\\${suggestedInstalldir || 'GameFolder'}</code>
            </div>
          </div>

          <div style="margin-bottom: 16px; font-size: 12px; color: #8F98A0; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Available Steam Libraries</div>

          <div id="lib-list" style="display: flex; flex-direction: column; gap: 12px; max-height: 380px; overflow-y: auto; padding-right: 4px;"></div>

          <div id="installdir-row" style="margin-top: 20px; display: ${suggestedInstalldir ? 'none':'block'};">
            <label style="display: block; font-size: 13px; color: #8F98A0; margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Custom Install Folder Name</label>
            <input id="installdir-input" type="text" value="${suggestedInstalldir || 'GameFolder'}" style="width: 100%; padding: 12px 14px; border-radius: 6px; border: 1px solid rgba(102, 192, 244, 0.3); background: rgba(11, 19, 40, 0.8); color: #C7D5E0; outline: none; font-size: 14px; font-family: inherit; transition: all 0.2s ease;">
          </div>
        </div>

        <div style="padding: 16px 28px 20px; background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.2) 100%); border-top: 1px solid rgba(102, 192, 244, 0.1); display: flex; gap: 12px; justify-content: flex-end;">
          <button id="cancel-btn" style="padding: 12px 24px; border-radius: 6px; background: linear-gradient(135deg, rgba(42, 71, 94, 0.8) 0%, rgba(42, 71, 94, 0.6) 100%); color: #C7D5E0; border: 1px solid rgba(102, 192, 244, 0.3); font-weight: 600; cursor: pointer; transition: all 0.2s ease; font-size: 14px; font-family: inherit;">Cancel</button>
          <button id="continue-btn" disabled style="padding: 12px 28px; border-radius: 6px; background: linear-gradient(135deg, #5C9BC6 0%, #66C0F4 50%, #76D0FF 100%); color: #fff; border: none; font-weight: 700; cursor: pointer; opacity: 0.5; transition: all 0.2s ease; font-size: 14px; font-family: inherit; box-shadow: 0 4px 12px rgba(102, 192, 244, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3);">Continue Installation</button>
        </div>
      `;

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const list = box.querySelector('#lib-list');
      const btnCancel = box.querySelector('#cancel-btn');
      const btnOk = box.querySelector('#continue-btn');
      const installdirInput = box.querySelector('#installdir-input');
      const pathPreview = box.querySelector('code');

      let chosen = null;

      // Scrollbar styling
      const scrollStyle = document.createElement('style');
      scrollStyle.textContent = `
        #lib-list::-webkit-scrollbar { width: 8px; }
        #lib-list::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.2); border-radius: 4px; }
        #lib-list::-webkit-scrollbar-thumb { background: rgba(102, 192, 244, 0.3); border-radius: 4px; }
        #lib-list::-webkit-scrollbar-thumb:hover { background: rgba(102, 192, 244, 0.5); }
      `;
      document.head.appendChild(scrollStyle);

      // Get disk info (mock data - replace with real API)
      // Get REAL disk space from backend API
      const getDiskInfo = async (path) => {
        try {
          // Call backend API to get real disk space
          const response = await fetch(`/api/disk_space?path=${encodeURIComponent(path)}`, {
            cache: 'no-store'
          });

          if (!response.ok) {
            throw new Error(`HTTP ${response.status}`);
          }

          const data = await response.json();

          if (!data.success) {
            throw new Error(data.message || 'Failed to get disk space');
          }

          // Return in the expected format
          return {
            freeGB: data.free_gb,
            totalGB: data.total_gb,
            usedGB: data.used_gb,
            usedPercent: data.used_percent
          };

        } catch (error) {
          console.warn('Failed to fetch real disk space for', path, ':', error);

          // Fallback to mock data if API fails
          const driveLetter = path.match(/^([A-Z]):/)?.[1] || 'C';
          const mockData = {
            'C': { freeGB: 125, totalGB: 500, usedGB: 375 },
            'D': { freeGB: 850, totalGB: 2000, usedGB: 1150 },
            'E': { freeGB: 450, totalGB: 1000, usedGB: 550 },
            'F': { freeGB: 75, totalGB: 250, usedGB: 175 },
          };
          return mockData[driveLetter] || { freeGB: 100, totalGB: 500, usedGB: 400 };
        }
      };

      // Create professional library cards with disk space
      (libraries || []).forEach(async (lib, index) => {
        const diskInfo = await getDiskInfo(lib);
        const usedPercent = (diskInfo.usedGB / diskInfo.totalGB) * 100;
        const driveLetter = lib.match(/^([A-Z]):/)?.[1] || '?';

        const item = document.createElement('button');
        item.type = 'button';
        item.style.cssText = `
          text-align: left; width: 100%; border-radius: 10px; padding: 0; cursor: pointer;
          border: 2px solid rgba(102, 192, 244, 0.2); background: rgba(11, 19, 40, 0.4);
          color: #C7D5E0; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          position: relative; overflow: hidden;
        `;

        item.innerHTML = `
          <div style="padding: 18px 20px;">
            <div style="display: flex; align-items: flex-start; gap: 16px;">
              <div style="width: 64px; height: 64px; background: linear-gradient(135deg, rgba(102, 192, 244, 0.15) 0%, rgba(102, 192, 244, 0.05) 100%); border: 2px solid rgba(102, 192, 244, 0.3); border-radius: 10px; display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0;">
                <svg width="28" height="28" viewBox="0 0 24 24" fill="none" style="margin-bottom: 2px;">
                  <rect x="3" y="5" width="18" height="14" rx="2" stroke="#66C0F4" stroke-width="2" fill="none"/>
                  <path d="M3 9h18M7 5v4m10-4v4" stroke="#66C0F4" stroke-width="1.5" opacity="0.5"/>
                  <circle cx="7" cy="13" r="1.5" fill="#66C0F4"/><circle cx="12" cy="13" r="1.5" fill="#66C0F4" opacity="0.6"/><circle cx="17" cy="13" r="1.5" fill="#66C0F4" opacity="0.3"/>
                </svg>
                <div style="font-size: 11px; font-weight: 700; color: #66C0F4; letter-spacing: 0.5px;">${driveLetter}:</div>
              </div>

              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 700; font-size: 15px; color: #fff; margin-bottom: 6px; display: flex; align-items: center; gap: 8px;">
                  ${lib}
                  <span style="padding: 2px 8px; background: rgba(102, 192, 244, 0.2); border-radius: 4px; font-size: 10px; color: #66C0F4; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">Drive ${driveLetter}</span>
                </div>

                <div style="font-size: 12px; color: #8F98A0; font-family: ui-monospace, Consolas, monospace; margin-bottom: 12px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  Final path → ${lib}\\steamapps\\common\\${suggestedInstalldir || '{installdir}'}
                </div>

                <div style="margin-bottom: 8px;">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 6px; font-size: 11px; color: #8F98A0; text-transform: uppercase; letter-spacing: 0.5px; font-weight: 600;">
                    <span>Storage</span>
                    <span style="color: #66C0F4;">${diskInfo.freeGB} GB free</span>
                  </div>
                  <div style="height: 6px; background: rgba(0, 0, 0, 0.4); border-radius: 3px; overflow: hidden; position: relative; box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);">
                    <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${usedPercent}%; background: linear-gradient(90deg, ${usedPercent > 85 ? '#c9302c' : usedPercent > 70 ? '#f0ad4e' : '#5cb85c'} 0%, ${usedPercent > 85 ? '#d9534f' : usedPercent > 70 ? '#f5b85e' : '#6cc86c'} 100%); transition: width 0.3s ease;"></div>
                  </div>
                  <div style="display: flex; justify-content: space-between; margin-top: 4px; font-size: 11px; color: #8F98A0;">
                    <span>${diskInfo.usedGB} GB used</span>
                    <span>${diskInfo.totalGB} GB total</span>
                  </div>
                </div>
              </div>

              <div class="selection-indicator" style="width: 32px; height: 32px; border-radius: 50%; border: 2px solid rgba(102, 192, 244, 0.3); display: flex; align-items: center; justify-content: center; opacity: 0.3; transition: all 0.2s ease; flex-shrink: 0;">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" fill="#66C0F4" opacity="0"/>
                  <path d="M9 12l2 2 4-4" stroke="#66C0F4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0"/>
                </svg>
              </div>
            </div>
          </div>
        `;

        // Hover effects
        item.addEventListener('mouseenter', () => {
          if (!item.classList.contains('selected')) {
            item.style.background = 'rgba(102, 192, 244, 0.05)';
            item.style.borderColor = 'rgba(102, 192, 244, 0.4)';
            item.style.transform = 'translateX(4px)';
          }
        });

        item.addEventListener('mouseleave', () => {
          if (!item.classList.contains('selected')) {
            item.style.background = 'rgba(11, 19, 40, 0.4)';
            item.style.borderColor = 'rgba(102, 192, 244, 0.2)';
            item.style.transform = 'translateX(0)';
          }
        });

        // Selection
        item.addEventListener('click', () => {
          list.querySelectorAll('button').forEach(b => {
            b.classList.remove('selected');
            b.style.background = 'rgba(11, 19, 40, 0.4)';
            b.style.borderColor = 'rgba(102, 192, 244, 0.2)';
            b.style.boxShadow = 'none';
            b.style.transform = 'translateX(0)';

            const indicator = b.querySelector('.selection-indicator');
            indicator.style.opacity = '0.3';
            indicator.style.borderColor = 'rgba(102, 192, 244, 0.3)';
            indicator.style.background = 'transparent';

            const circle = indicator.querySelector('circle');
            const path = indicator.querySelector('path');
            circle.style.opacity = '0';
            path.style.opacity = '0';
          });

          item.classList.add('selected');
          item.style.background = 'rgba(102, 192, 244, 0.1)';
          item.style.borderColor = '#66C0F4';
          item.style.boxShadow = '0 0 20px rgba(102, 192, 244, 0.3), inset 0 1px 0 rgba(102, 192, 244, 0.1)';

          const indicator = item.querySelector('.selection-indicator');
          indicator.style.opacity = '1';
          indicator.style.borderColor = '#66C0F4';
          indicator.style.background = 'rgba(102, 192, 244, 0.2)';

          const circle = indicator.querySelector('circle');
          const path = indicator.querySelector('path');
          circle.style.opacity = '1';
          path.style.opacity = '1';

          chosen = lib;
          btnOk.disabled = false;
          btnOk.style.opacity = '1';
          pathPreview.textContent = `${lib}\\steamapps\\common\\${suggestedInstalldir || 'GameFolder'}`;
        });

        list.appendChild(item);
        if (index === 0) setTimeout(() => item.click(), 100);
      });

      // Button hover effects
      btnCancel.addEventListener('mouseenter', () => {
        btnCancel.style.background = 'linear-gradient(135deg, rgba(42, 71, 94, 1) 0%, rgba(42, 71, 94, 0.8) 100%)';
        btnCancel.style.borderColor = 'rgba(102, 192, 244, 0.5)';
        btnCancel.style.color = '#fff';
        btnCancel.style.transform = 'translateY(-1px)';
      });
      btnCancel.addEventListener('mouseleave', () => {
        btnCancel.style.background = 'linear-gradient(135deg, rgba(42, 71, 94, 0.8) 0%, rgba(42, 71, 94, 0.6) 100%)';
        btnCancel.style.borderColor = 'rgba(102, 192, 244, 0.3)';
        btnCancel.style.color = '#C7D5E0';
        btnCancel.style.transform = 'translateY(0)';
      });

      btnOk.addEventListener('mouseenter', () => {
        if (!btnOk.disabled) {
          btnOk.style.background = 'linear-gradient(135deg, #6CACCD 0%, #76D0FF 50%, #86E0FF 100%)';
          btnOk.style.transform = 'translateY(-1px)';
          btnOk.style.boxShadow = '0 6px 16px rgba(102, 192, 244, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.4)';
        }
      });
      btnOk.addEventListener('mouseleave', () => {
        if (!btnOk.disabled) {
          btnOk.style.background = 'linear-gradient(135deg, #5C9BC6 0%, #66C0F4 50%, #76D0FF 100%)';
          btnOk.style.transform = 'translateY(0)';
          btnOk.style.boxShadow = '0 4px 12px rgba(102, 192, 244, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3)';
        }
      });

      installdirInput?.addEventListener('focus', () => {
        installdirInput.style.borderColor = '#66C0F4';
        installdirInput.style.background = 'rgba(11, 19, 40, 1)';
        installdirInput.style.boxShadow = '0 0 0 3px rgba(102, 192, 244, 0.2)';
      });
      installdirInput?.addEventListener('blur', () => {
        installdirInput.style.borderColor = 'rgba(102, 192, 244, 0.3)';
        installdirInput.style.background = 'rgba(11, 19, 40, 0.8)';
        installdirInput.style.boxShadow = 'none';
      });

      btnCancel.onclick = () => {
        scrollStyle.remove();
        overlay.remove();
        resolve(null);
      };

      btnOk.onclick = () => {
        const finalInstalldir = suggestedInstalldir || (installdirInput ? installdirInput.value.trim() : 'GameFolder');
        scrollStyle.remove();
        overlay.remove();
        if (!chosen) return resolve(null);
        resolve({
          libraryRoot: chosen,
          installdir: finalInstalldir || 'GameFolder',
          outDir: `${chosen}\\steamapps\\common\\${finalInstalldir || 'GameFolder'}`
        });
      };

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) btnCancel.click();
      });
    });
  }

  // The Download button
  const depotBtn = document.createElement('button');
  depotBtn.className = 'btn btn-ghost';
  depotBtn.style.cssText = `
    width: 100%; text-align: center; border-radius: 10px; padding: 10px 14px;
    background: linear-gradient(135deg, rgba(42, 71, 94, 0.8) 0%, rgba(42, 71, 94, 0.6) 100%);
    color: #C7D5E0; border: 1px solid rgba(102, 192, 244, 0.3); font-weight: 700;
    cursor: pointer; transition: all 0.2s ease;
  `;
  depotBtn.textContent = 'Download Game (Standalone)';
  depotBtn.title = 'Parse Lua → write key → verify manifests → download with progress';

  depotBtn.addEventListener('mouseenter', () => {
    if (!depotBtn.disabled) {
      depotBtn.style.background = 'linear-gradient(135deg, rgba(42, 71, 94, 1) 0%, rgba(42, 71, 94, 0.8) 100%)';
      depotBtn.style.borderColor = 'rgba(102, 192, 244, 0.5)';
      depotBtn.style.color = '#fff';
      depotBtn.style.transform = 'translateY(-1px)';
    }
  });

  depotBtn.addEventListener('mouseleave', () => {
    if (!depotBtn.disabled) {
      depotBtn.style.background = 'linear-gradient(135deg, rgba(42, 71, 94, 0.8) 0%, rgba(42, 71, 94, 0.6) 100%)';
      depotBtn.style.borderColor = 'rgba(102, 192, 244, 0.3)';
      depotBtn.style.color = '#C7D5E0';
      depotBtn.style.transform = 'translateY(0)';
    }
  });

  container.appendChild(depotBtn);

  depotBtn.onclick = async () => {
    try {
      depotBtn.disabled = true;
      depotBtn.textContent = 'Preparing…';
      depotBtn.style.opacity = '0.6';

      const planRes = await fetch(`/api/depot_plan/${game.appid}`, { cache:'no-store' });
      const plan = await planRes.json();
      if (!planRes.ok || !plan.success) {
        depotBtn.disabled = false;
        depotBtn.textContent = 'Download Game (Standalone)';
        depotBtn.style.opacity = '1';
        alert(`Plan failed: ${(plan && plan.message) || planRes.statusText}`);
        return;
      }

      if (window.__showDepotModal) {
        const totalManifests = (plan.manifests || []).length;
        const available = (plan.manifests || []).filter(m => m.exists).length;
        const missing = totalManifests - available;
        const metaHtml = `
          <div><b>Game:</b> ${game.name || ''}</div>
          <div><b>AppID:</b> ${game.appid}</div>
          <div><b>Steam Root:</b> <code>${plan.steam_root}</code></div>
          <div><b>Key File:</b> <code>${plan.key_file}</code></div>
          <div><b>Depotcache:</b> <code>${plan.depotcache}</code></div>
          <div><b>InstallDir (suggested):</b> <code>${plan.installdir}</code></div>
          <div style="margin-top:6px;"><b>Manifests:</b> ${available}/${totalManifests} ready${missing>0?` (missing ${missing})`:''}</div>
        `;
        window.__showDepotModal('Game Downloader (Standalone)', metaHtml);
      }

      let libraries = [];
      try {
        const libsRes = await fetch('/api/steam_libraries', { cache:'no-store' });
        const libs = await libsRes.json().catch(() => ({}));
        if (libsRes.ok && libs && libs.success && Array.isArray(libs.libraries)) {
          libraries = libs.libraries;
        }
      } catch (_) {}

      if (!libraries.length && plan.steam_root) {
        libraries = [plan.steam_root.replace(/\\Steam$/i, '\\SteamLibrary')];
      }

      const pick = await selectSteamLibraryModal(libraries, plan.installdir);
      if (!pick || !pick.outDir) {
        depotBtn.disabled = false;
        depotBtn.textContent = 'Download Game (Standalone)';
        depotBtn.style.opacity = '1';
        if (window.__finishDepotModal) window.__finishDepotModal(false, '');
        return;
      }

      try {
        const mRes = await fetch('/api/create_appmanifest', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                appid: Number(game.appid),
                library_root: pick.libraryRoot,
                installdir: pick.installdir
            })
        });
        const m = await mRes.json().catch(() => ({}));
        if (!mRes.ok || !m.success) {
            console.warn('create_appmanifest failed:', m && m.message);
        } else {
            console.debug('appmanifest created at:', m.manifest_path);
        }
      } catch (e) {
        console.warn('create_appmanifest error:', e);
      }

      depotBtn.textContent = 'Starting…';
      const startRes = await fetch('/api/depot_download/start', {
        method: 'POST',
        headers: {'Content-Type':'application/json'},
        body: JSON.stringify({ appid: Number(game.appid), out_dir: pick.outDir })
      });
      const start = await startRes.json().catch(() => ({}));
      if (!startRes.ok || !start.success) {
        if (window.__updateDepotModal) window.__updateDepotModal(0, [`Start failed: ${(start && start.message) || startRes.statusText}`]);
        depotBtn.disabled = false;
        depotBtn.textContent = 'Download Game (Standalone)';
        depotBtn.style.opacity = '1';
        return;
      }

      depotBtn.textContent = 'Downloading…';
      const jobId = start.job_id;
      let stop = false;
      const poll = async () => {
        if (stop) return;
        try {
          const sRes = await fetch(`/api/depot_download/progress/${encodeURIComponent(jobId)}?t=${Date.now()}`, { cache:'no-store' });
          const s = await sRes.json();
          if (!sRes.ok || !s.success) throw new Error((s && s.message) || sRes.statusText);

          if (window.__updateDepotModal) window.__updateDepotModal(s.progress || 0, s.log || []);

          if (s.status === 'done') {
            stop = true;
            if (window.__finishDepotModal) window.__finishDepotModal(true, '');
            depotBtn.disabled = false;
            depotBtn.textContent = 'Download Game (Standalone)';
            depotBtn.style.opacity = '1';
            return;
          }
          if (s.status === 'error') {
            stop = true;
            if (window.__finishDepotModal) window.__finishDepotModal(false, '');
            depotBtn.disabled = false;
            depotBtn.textContent = 'Download Game (Standalone)';
            depotBtn.style.opacity = '1';
            return;
          }
        } catch (e) {
          stop = true;
          if (window.__updateDepotModal) window.__updateDepotModal(0, ['Polling error: ' + (e.message || e)]);
          if (window.__finishDepotModal) window.__finishDepotModal(false, '');
          depotBtn.disabled = false;
          depotBtn.textContent = 'Download Game (Standalone)';
          depotBtn.style.opacity = '1';
          return;
        }
        setTimeout(poll, 1000);
      };
      poll();

    } catch (e) {
      alert('Depot flow error: ' + (e.message || e));
      depotBtn.disabled = false;
      depotBtn.textContent = 'Download Game (Standalone)';
      depotBtn.style.opacity = '1';
    }
  };
}


(function () {
  let saveSizeTimer = null;

  function sendWindowSize() {
    if (!window.pywebview || !window.pywebview.api || !window.pywebview.api.save_window_state) {
      return;
    }

    const w = window.innerWidth  || document.documentElement.clientWidth  || 1280;
    const h = window.innerHeight || document.documentElement.clientHeight || 720;

    window.pywebview.api.save_window_state(w, h).catch(() => {
      // ignore errors
    });
  }

  // Debounce resize so it only saves after user stops dragging
  window.addEventListener('resize', () => {
    clearTimeout(saveSizeTimer);
    saveSizeTimer = setTimeout(sendWindowSize, 400);
  });

  // Save once on initial load too
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', sendWindowSize);
  } else {
    sendWindowSize();
  }
})();
(function ensureClearAndFixSteamButton(){
  const BUTTON_ID = 'clear-and-fix-steam-btn';

  function showCombinedModal(onConfirm){
    const old = document.getElementById('steam-combined-modal-overlay');
    if (old) old.remove();

    const overlay = document.createElement('div');
    overlay.id = 'steam-combined-modal-overlay';
    overlay.style.cssText = `
      position:fixed; inset:0; z-index:99999;
      background:rgba(0,0,0,.45); display:flex; align-items:center; justify-content:center;
    `;

    const box = document.createElement('div');
    box.style.cssText = `
      width:min(560px,92vw); background:#0f172a; color:#e6eefc;
      border:1px solid #2a3a5d; border-radius:14px; box-shadow:0 20px 60px rgba(0,0,0,.55);
      font-family:system-ui,Segoe UI,Inter,Arial; overflow:hidden;
    `;
    box.innerHTML = `
      <div style="padding:16px 18px; border-bottom:1px solid #1f2a44; font-weight:800;">
        Clear Steam Download Cache & Reinitialize Onennabe
      </div>
      <div style="padding:16px 18px; line-height:1.45;">
        <div style="margin-bottom:10px; opacity:.95">This will:</div>
        <ul style="margin:0 0 12px 18px; padding:0;">
          <li>Back up achievement files</li>
          <li>Clear Steam download cache & temp files</li>
          <li>Downloading unlocker</code></li>
          <li>Registry activation</li>
          <li>Restart Steam once at the end</li>
        </ul>
        <div id="steam-combined-modal-status" style="margin-top:6px; font-size:13px; color:#a9b8d9; min-height:18px;"></div>
      </div>
      <div style="padding:12px 18px; border-top:1px solid #1f2a44; display:flex; gap:10px; justify-content:flex-end;">
        <button id="steam-combined-cancel" class="btn" style="
          padding:10px 14px; border-radius:10px; border:1px solid #2a3a5d; background:transparent; color:#e6eefc; font-weight:700; cursor:pointer;
        ">Cancel</button>
        <button id="steam-combined-confirm" class="btn btn-primary" style="
          padding:10px 14px; border-radius:10px; border:none; background:linear-gradient(to bottom,#4aa3ff,#1e78ff); color:#fff; font-weight:800; cursor:pointer;
        ">Clear + Fix & Restart</button>
      </div>
    `;
    overlay.appendChild(box);
    document.body.appendChild(overlay);

    const statusEl = box.querySelector('#steam-combined-modal-status');
    const btnCancel = box.querySelector('#steam-combined-cancel');
    const btnConfirm = box.querySelector('#steam-combined-confirm');

    btnCancel.onclick = () => overlay.remove();

    btnConfirm.onclick = async () => {
      btnConfirm.disabled = true;
      btnCancel.disabled = true;
      btnConfirm.textContent = 'Working…';
      statusEl.textContent = 'Clearing cache and reinitializing unlocker…';
      try {
        await onConfirm((msg) => { statusEl.textContent = msg; });
        statusEl.textContent = 'Done. Steam is restarting…';
        setTimeout(() => overlay.remove(), 1500);
      } catch (e) {
        statusEl.textContent = 'Failed: ' + (e.message || e);
        btnConfirm.disabled = false;
        btnCancel.disabled = false;
        btnConfirm.textContent = 'Clear + Fix & Restart';
      }
    };
  }

  function mount(){
    // Place after the "Reinitialize Onennabe" button if it exists
    const fixBtn = document.getElementById('fix-steam-hid-reg-btn');
    const anchor = (fixBtn && (fixBtn.closest('.settings-row') || fixBtn))
                || document.getElementById('clear-steam-cache-btn')
                || document.getElementById('btn-delete-cdkey')
                || document.querySelector('#btn-delete-cdkey')
                || document.querySelector('#modal-reset');

    if (!anchor) return;
    if (document.getElementById(BUTTON_ID)) return;

    const row = document.createElement('div');
    row.className = 'settings-row';
    anchor.insertAdjacentElement('afterend', row);

    const btn = document.createElement('button');
    btn.id = BUTTON_ID;
    btn.className = 'sidebar-btn danger';
    btn.type = 'button';
    btn.title = 'Clear Steam cache AND reinitialize Onennabe unlocker in one step';
    btn.textContent = 'Clear Steam Download Cache';
    row.appendChild(btn);

    btn.addEventListener('click', () => {
      showCombinedModal(async (setProgress) => {
        setProgress('Contacting service…');
        const r = await fetch('/api/steam/clear_cache_and_fix', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ kill_steam: true, restart_steam: true })
        });
        const j = await r.json().catch(() => ({}));
        if (!r.ok || j.success !== true) {
          throw new Error(j.message || r.statusText || 'Service error');
        }
        setProgress(j.message || 'Operation completed.');
      });
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => setTimeout(mount, 0));
  } else {
    setTimeout(mount, 0);
  }
  const mo = new MutationObserver(() => mount());
  mo.observe(document.body, { childList: true, subtree: true });
})();
/* ============================================
   Game Actions Modal - Click to Open
   ============================================ */

(function() {
  let currentGameData = null;

  // Open modal with game actions
  window.openGameActionsModal = function(game, launcherStatus, clickEvent) {
    currentGameData = { game, launcherStatus };

    const modal = document.getElementById('game-actions-modal');
    const modalContent = document.querySelector('.game-actions-content');
    const cover = document.getElementById('game-actions-cover');
    const title = document.getElementById('game-actions-title');
    const appid = document.getElementById('game-actions-appid');
    const size = document.getElementById('game-actions-size');
    const downloads = document.getElementById('game-actions-downloads');
    const body = document.getElementById('game-actions-body');

    // Set header info
    loadGameCover(cover, game.appid);
    title.textContent = game.name;
    appid.textContent = `AppID: ${game.appid}`;
    size.textContent = `Size: ${(game.size_gb && String(game.size_gb).trim()) ? String(game.size_gb).trim() : 'N/A'}`;
    downloads.textContent = `Downloads: ${game.downloads || 0}`;

    // Clear previous buttons
    body.innerHTML = '';

    if (game.requires_membership) {
      const denuvoWarn = document.createElement('div');
      denuvoWarn.className = 'denuvo-warning';

      denuvoWarn.innerHTML = `
        <div class="denuvo-title">THIS GAME IS DENUVO PROTECTED</div>
        <div class="denuvo-desc">
          Please borrow the seller Steam account to play this game.
        </div>
      `;

      body.appendChild(denuvoWarn);
    }

    // Build action buttons
    buildActionButtons(game, launcherStatus, body);

    // Lock body scroll
    document.body.classList.add('modal-open');

    // Show modal
    modal.classList.remove('closing');
    modal.classList.add('show');
    modal.style.display = 'block';
  };

  // Close modal with animation
  window.closeGameActionsModal = function() {
    const modal = document.getElementById('game-actions-modal');
    modal.classList.add('closing');
    modal.classList.remove('show');

    // Unlock body scroll
    document.body.classList.remove('modal-open');

    setTimeout(() => {
      modal.style.display = 'none';
      modal.classList.remove('closing');
    }, 250);
    currentGameData = null;
  };

  // Build all action buttons
  function buildActionButtons(game, launcherStatus, container, primaryContainer) {
    const isMonthly =
      document.body.getAttribute('data-license') === 'monthly' ||
      ((window.activationType || '').toUpperCase() === 'MONTHLY') ||
      ((localStorage.getItem('key_type') || '').toUpperCase() === 'MONTHLY');

    // Primary Actions Section
    const primarySection = createSection('Primary Actions');
    (primaryContainer || container).appendChild(primarySection);

    // 1. Download or Update Button
    const downloadBtn = createActionButton(
      game.installed ? 'Update Game' : 'Unlock Game',
      game.installed ? 'update' : 'primary',
      () => {
        closeGameActionsModal();
        downloadGame(game.appid);
      }
    );

    // 2. Details Button
    const detailsBtn = createActionButton(
      'View Details',
      'details',
      () => {
        closeGameActionsModal();
        showGameDetails(game.appid);
      }
    );

    // 3. Add to Cart Button
    const inCart = cart.includes(game.appid);
    const cartBtn = createActionButton(
      inCart ? 'In Cart ✓' : 'Add to Cart',
      'cart',
      async () => {
        if (!cart.includes(game.appid)) {
            if (needsMembership(game.requires_membership)) {
              closeGameActionsModal();   // close details window
              showDenuvoWarning(game, async () => {
                const success = await addToCart(game.appid);
                if (success) {
                  cartBtn.textContent = 'In Cart ✓';
                  cartBtn.disabled = true;
                }
              });
          } else {
            console.log('🛒 Adding to cart (modal):', game.appid);
            const success = await addToCart(game.appid);
            if (success) { cartBtn.textContent = 'In Cart ✓'; cartBtn.disabled = true; }
          }
        } else {
          console.log('🛒 Already in cart:', game.appid);
        }
      }
    );
    cartBtn.disabled = inCart;

    // Append: Download, Cart first
    primarySection.appendChild(downloadBtn);
    primarySection.appendChild(cartBtn);

    // 4. Remove Game (same row as Download + Cart)
    if (game.installed) {
      const removeBtn = createActionButton(
        'Remove Game',
        'danger',
        async () => {
          const proceed = await customConfirm(
            `<b>Remove ${game.name}?</b><br><br>This will remove the game from your system.`
          );
          if (!proceed) return;
          closeGameActionsModal();
          removeGame(game.appid);
        }
      );
      primarySection.appendChild(removeBtn);

      // Force 3-column row, override square aspect-ratio
      primarySection.style.cssText += ';grid-template-columns:1fr 1fr 1fr !important;';
      [downloadBtn, cartBtn, removeBtn].forEach(function(b) {
        b.style.cssText += ';aspect-ratio:auto !important;padding:12px 8px !important;font-size:13px !important;';
      });
    }

    // Details — always last, full width
    primarySection.appendChild(detailsBtn);
    detailsBtn.style.cssText += ';grid-column:1/-1 !important;aspect-ratio:auto !important;padding:10px 8px !important;font-size:13px !important;';

      // Denuvo / seller-account warning
    if (needsMembership(game.requires_membership)) {
      const denuvoSection = createSection('THIS GAME IS DENUVO PROTECTED');
      denuvoSection.classList.add('denuvo-section');

      const denuvoDesc = document.createElement('div');
      denuvoDesc.className = 'section-description denuvo-warning-desc';
      denuvoDesc.textContent =
        'Please borrow the seller Steam account to play this game.';

      denuvoSection.appendChild(denuvoDesc);
      container.appendChild(denuvoSection);
    }
    // Standalone/Patch Section (if installed)
    if (game.installed && !game.requires_membership) {

    const standaloneSection = createSection('Universal Online Patch and Standalone Launcher');
    standaloneSection.classList.add('standalone-section');

    // description below the title
    const desc = document.createElement('div');
    desc.className = 'section-description';
    desc.style.cssText = 'flex-basis:100%;font-size:11px;color:#8ba5be;line-height:1.4;margin-bottom:2px;';
    desc.textContent =
      'This will download the game without using Steam and will create a desktop shortcut. It will also patch the game with Universal Online Patch and enable Spacewar-based online play for supported games. Also Patch Standalone is to patch game using cold client launcher which supposedly can bypass Steam. REMEMBER: THIS DOESNT WORK ON ALL GAMES';

    standaloneSection.appendChild(desc);

    // Antivirus warning
    const avWarning = document.createElement('div');
    avWarning.className = 'av-warning';
    const avIcon = document.createElement('span');
    avIcon.className = 'av-warning-icon';
    avIcon.textContent = '\u26A0';
    const avText = document.createElement('span');
    avText.textContent = 'WARNING: You must DISABLE your Antivirus / Windows Defender before using the functions below, or the patch files will be quarantined and the patching will fail.';
    avWarning.appendChild(avIcon);
    avWarning.appendChild(avText);
    standaloneSection.appendChild(avWarning);

    container.appendChild(standaloneSection);

      // Play/Remove buttons row — forces a new line via flex-basis:100%
      const standaloneActionRow = document.createElement('div');
      standaloneActionRow.className = 'standalone-action-row';
      // will be appended to standaloneSection after the patch buttons

      // Always show Download Standalone whenever the game is installed
      const downloadStandaloneBtn = createActionButton(
        'Download Standalone',
        'standalone',
        async () => {
          try {
            downloadStandaloneBtn.disabled = true;
            const previous = downloadStandaloneBtn.textContent;
            downloadStandaloneBtn.textContent = 'Preparing...';

            if (typeof triggerDepotDownload === 'function') {
              await triggerDepotDownload(game);
            } else {
              alert('Download Standalone - connect this to your depot download system');
            }

            downloadStandaloneBtn.textContent = previous;
            downloadStandaloneBtn.disabled = false;
          } catch (e) {
            alert('Standalone download error: ' + (e.message || e));
            downloadStandaloneBtn.textContent = 'Download Standalone';
            downloadStandaloneBtn.disabled = false;
          }
        }
      );
      standaloneSection.appendChild(downloadStandaloneBtn);

      const isUnsteamInstalled = !!(launcherStatus && launcherStatus.installed);
      const isColdClientInstalled = !!(launcherStatus && launcherStatus.coldclient_installed);

      if (isUnsteamInstalled) {
        // Play (Universal Online Patch) button
        const playBypassBtn = createActionButton(
          '▶ Play (Online Patch)',
          'play',
          async () => {
            try {
              playBypassBtn.disabled = true;
              playBypassBtn.textContent = 'Launching...';
              const r = await fetch(`/api/launch_onennabe/${game.appid}`, { method: 'POST' });
              const j = await r.json().catch(() => ({}));
              if (!r.ok || !j.success) {
                alert(`Failed to launch:\n${(j && j.message) || r.statusText}`);
              }
              closeGameActionsModal();
            } catch (e) {
              alert('Launch error: ' + (e.message || e));
            } finally {
              playBypassBtn.disabled = false;
              playBypassBtn.textContent = '▶ Play (Online Patch)';
            }
          }
        );
        standaloneActionRow.appendChild(playBypassBtn);

        // Remove Universal Online Patch button
        const removeStandaloneBtn = createActionButton(
          'Remove Online Patch',
          'danger',
          async () => {
            const proceed = (typeof customConfirm === 'function')
              ? await customConfirm(`<b>Remove Universal Online Patch?</b><br>This deletes Universal Online Patch files for <code>${game.name}</code> (AppID ${game.appid}).`)
              : window.confirm('Remove Universal Online Patch files for this game?');

            if (!proceed) return;

            try {
              removeStandaloneBtn.disabled = true;
              const prev = removeStandaloneBtn.textContent;
              removeStandaloneBtn.textContent = 'Removing...';
              const res = await fetch(`/api/uninstall_launcher/${game.appid}`, { method: 'POST' });
              const data = await res.json().catch(() => ({}));

              if (!res.ok || !data.success) {
                alert(`Failed to remove Universal Online Patch:\n${(data && data.message) || res.statusText || 'Unknown error.'}`);
                removeStandaloneBtn.textContent = prev;
                removeStandaloneBtn.disabled = false;
                return;
              }

              if (window.__modalKit) { await window.__modalKit.infoModal({ title: 'Success', message: 'Universal Online Patch removed successfully.' }); } else { alert('Universal Online Patch removed.'); }
              const _ugmModal = document.getElementById('unified-game-modal');
              const _ugmActions = document.getElementById('ugm-actions');
              if (_ugmModal && _ugmModal.style.display !== 'none' && _ugmActions && window.__buildGameActionButtons) {
                try {
                  const _freshRes = await fetch('/api/launcher_status/' + game.appid);
                  const _freshStatus = await _freshRes.json().catch(() => ({}));
                  _ugmActions.innerHTML = '';
                  const _ugmPrimary = document.getElementById('ugm-primary-actions');
                  if (_ugmPrimary) _ugmPrimary.innerHTML = '';
                  window.__buildGameActionButtons(game, _freshStatus, _ugmActions, _ugmPrimary || undefined);
                  _ugmActions.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                  if (_ugmPrimary) _ugmPrimary.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                } catch(e) { console.error('UGM refresh error:', e); }
              }
              closeGameActionsModal();
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              alert('Unexpected error: ' + (e.message || e));
              removeStandaloneBtn.disabled = false;
            }
          }
        );
        standaloneActionRow.appendChild(removeStandaloneBtn);

        // Patch Standalone conflict warning button
        const patchStandaloneConflictBtn = createActionButton(
          'Patch Standalone',
          'patch',
          async () => {
            if (window.__modalKit) { await window.__modalKit.infoModal({ title: 'Conflict', message: 'Please remove Universal Online Patch first before using Patch Standalone.' }); } else { alert('Please remove Universal Online Patch first before using Patch Standalone.'); }
          }
        );
        standaloneSection.appendChild(patchStandaloneConflictBtn);

      } else if (isColdClientInstalled) {
        // Play Bypass Steam button
        const playBypassSteamBtn = createActionButton(
          '▶ Play (Bypass Steam)',
          'play',
          async () => {
            try {
              playBypassSteamBtn.disabled = true;
              playBypassSteamBtn.textContent = 'Launching...';
              const r = await fetch(`/api/launch_coldclient/${game.appid}`, { method: 'POST' });
              const j = await r.json().catch(() => ({}));
              if (!r.ok || !j.success) {
                alert(`Failed to launch:\n${(j && j.message) || r.statusText}`);
              }
              closeGameActionsModal();
            } catch (e) {
              alert('Launch error: ' + (e.message || e));
            } finally {
              playBypassSteamBtn.disabled = false;
              playBypassSteamBtn.textContent = '▶ Play (Bypass Steam)';
            }
          }
        );
        standaloneActionRow.appendChild(playBypassSteamBtn);

        // Remove Patch Standalone button
        const removePatchStandaloneBtn = createActionButton(
          'Remove Patch Standalone',
          'danger',
          async () => {
            const proceed = (typeof customConfirm === 'function')
              ? await customConfirm(`<b>Remove Patch Standalone?</b><br>This deletes Patch Standalone files for <code>${game.name}</code> (AppID ${game.appid}).`)
              : window.confirm('Remove Patch Standalone files for this game?');

            if (!proceed) return;

            try {
              removePatchStandaloneBtn.disabled = true;
              const prev = removePatchStandaloneBtn.textContent;
              removePatchStandaloneBtn.textContent = 'Removing...';
              const res = await fetch(`/api/uninstall_coldclient/${game.appid}`, { method: 'POST' });
              const data = await res.json().catch(() => ({}));

              if (!res.ok || !data.success) {
                alert(`Failed to remove Patch Standalone:\n${(data && data.message) || res.statusText || 'Unknown error.'}`);
                removePatchStandaloneBtn.textContent = prev;
                removePatchStandaloneBtn.disabled = false;
                return;
              }

              if (window.__modalKit) { await window.__modalKit.infoModal({ title: 'Success', message: 'Patch Standalone removed successfully.' }); } else { alert('Patch Standalone removed.'); }
              const _ugmModal = document.getElementById('unified-game-modal');
              const _ugmActions = document.getElementById('ugm-actions');
              if (_ugmModal && _ugmModal.style.display !== 'none' && _ugmActions && window.__buildGameActionButtons) {
                try {
                  const _freshRes = await fetch('/api/launcher_status/' + game.appid);
                  const _freshStatus = await _freshRes.json().catch(() => ({}));
                  _ugmActions.innerHTML = '';
                  const _ugmPrimary = document.getElementById('ugm-primary-actions');
                  if (_ugmPrimary) _ugmPrimary.innerHTML = '';
                  window.__buildGameActionButtons(game, _freshStatus, _ugmActions, _ugmPrimary || undefined);
                  _ugmActions.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                  if (_ugmPrimary) _ugmPrimary.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                } catch(e) { console.error('UGM refresh error:', e); }
              }
              closeGameActionsModal();
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              alert('Unexpected error: ' + (e.message || e));
              removePatchStandaloneBtn.disabled = false;
            }
          }
        );
        standaloneActionRow.appendChild(removePatchStandaloneBtn);

        // Universal Online Patch conflict warning button
        const uopConflictBtn = createActionButton(
          'Universal Online Patch',
          'patch',
          async () => {
            if (window.__modalKit) { await window.__modalKit.infoModal({ title: 'Conflict', message: 'Please remove Patch Standalone first before using Universal Online Patch.' }); } else { alert('Please remove Patch Standalone first before using Universal Online Patch.'); }
          }
        );
        if (game.online_supported !== "Yes") standaloneSection.appendChild(uopConflictBtn);

      } else {
        // Attempt Standalone Patch Unsteam button
        const patchBtn = createActionButton(
          'Universal Online Patch',
          'patch',
          async () => {
            const msg = [
              'Patch with Universal Online Patch?',
              `• Verify appmanifest_${game.appid}.acf exists`,
              '• Run Steamless (best-effort) on the game folder',
              '• Copy unsteam.dll to the game folder',
              '• Update unsteam.ini (exe_file, real_app_id)',
              '• Sometimes this may not work depending on the game',
              '',
              'Proceed?'
            ].join('\n');

            const proceed = (typeof customConfirm === 'function')
              ? await customConfirm(msg.replace(/\n/g, '<br>'))
              : window.confirm(msg);

            if (!proceed) return;

            patchBtn.disabled = true;
            const previous = patchBtn.textContent;
            patchBtn.textContent = 'Patching...';

            try {
              let r = await fetch(`/api/launcher/patch/${encodeURIComponent(game.appid)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ steamless: true })
              });

              if (r.status === 404) {
                try {
                  const r1 = await fetch(`/api/steamless`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify({ appid: String(game.appid) })
                  });
                  const j1 = await r1.json().catch(()=>({}));
                  if (typeof showToast === 'function') {
                    showToast(j1.success ? 'success' : 'info',
                              'Steamless',
                              j1.success ? 'Unpack OK.' : (j1.message || 'Skipped/failed — continuing.'));
                  }
                } catch (_) { /* ignore */ }

                await SteamAPI.getAppInfo(game.appid).catch(() => {});
                r = await fetch(`/api/install_launcher/${encodeURIComponent(game.appid)}`, { method: 'POST' });
              }

              const j = await r.json().catch(()=>({}));
              if (!r.ok || j.success !== true) {
                const m = (j && (j.message || j.install?.message)) || r.statusText || 'Unknown error.';
                throw new Error(m);
              }

              if (typeof showToast === 'function') {
                if (j.steamless) {
                  showToast(j.steamless.ok ? 'success' : 'info',
                            'Steamless',
                            j.steamless.ok ? 'Unpack OK.' : 'Skipped/failed — Universal Online Patch installed.');
                }
                showToast('success', 'Universal Online Patch', (j.install && j.install.message) || 'Patched successfully.');
              } else {
                alert('Universal Online Patch installed. You can now use "PLAY (Bypass Steam)".');
              }

              const _ugmModal = document.getElementById('unified-game-modal');
              const _ugmActions = document.getElementById('ugm-actions');
              if (_ugmModal && _ugmModal.style.display !== 'none' && _ugmActions && window.__buildGameActionButtons) {
                try {
                  const _freshRes = await fetch('/api/launcher_status/' + game.appid);
                  const _freshStatus = await _freshRes.json().catch(() => ({}));
                  _ugmActions.innerHTML = '';
                  const _ugmPrimary = document.getElementById('ugm-primary-actions');
                  if (_ugmPrimary) _ugmPrimary.innerHTML = '';
                  window.__buildGameActionButtons(game, _freshStatus, _ugmActions, _ugmPrimary || undefined);
                  _ugmActions.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                  if (_ugmPrimary) _ugmPrimary.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                } catch(e) { console.error('UGM refresh error:', e); }
              }
              closeGameActionsModal();
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              if (typeof showToast === 'function') {
                showToast('error', 'Patch Failed', String(e && e.message || e));
              } else {
                alert('Failed to install Universal Online Patch:\n' + (e.message || e));
              }
              patchBtn.textContent = previous;
              patchBtn.disabled = false;
            }
          }
        );
        if (game.online_supported !== "Yes") standaloneSection.appendChild(patchBtn);

        // Patch Standalone button
        const patchStandaloneBtn = createActionButton(
          'Patch Standalone',
          'patch',
          async () => {
            const msg = [
              'Patch Standalone?',
              '• This will copy ColdClientLoader files to the game folder',
              '• Creates ColdClientLoader.ini with your game settings',
              `• AppID: ${game.appid}`,
              '• After patching, use "Play (Bypass Steam)" to launch',
              '',
              'Proceed?'
            ].join('\n');

            const proceed = (typeof customConfirm === 'function')
              ? await customConfirm(msg.replace(/\n/g, '<br>'))
              : window.confirm(msg);

            if (!proceed) return;

            patchStandaloneBtn.disabled = true;
            const previous = patchStandaloneBtn.textContent;
            patchStandaloneBtn.textContent = 'Patching...';

            try {
              const r = await fetch(`/api/install_coldclient/${encodeURIComponent(game.appid)}`, { method: 'POST' });
              const j = await r.json().catch(()=>({}));
              if (!r.ok || j.success !== true) {
                throw new Error((j && j.message) || r.statusText || 'Unknown error.');
              }

              if (typeof showToast === 'function') {
                showToast('success', 'Patch Standalone', j.message || 'Patched successfully.');
              } else {
                alert('Patch Standalone installed. You can now use "Play (Bypass Steam)".');
              }

              const _ugmModal = document.getElementById('unified-game-modal');
              const _ugmActions = document.getElementById('ugm-actions');
              if (_ugmModal && _ugmModal.style.display !== 'none' && _ugmActions && window.__buildGameActionButtons) {
                try {
                  const _freshRes = await fetch('/api/launcher_status/' + game.appid);
                  const _freshStatus = await _freshRes.json().catch(() => ({}));
                  _ugmActions.innerHTML = '';
                  const _ugmPrimary = document.getElementById('ugm-primary-actions');
                  if (_ugmPrimary) _ugmPrimary.innerHTML = '';
                  window.__buildGameActionButtons(game, _freshStatus, _ugmActions, _ugmPrimary || undefined);
                  _ugmActions.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                  if (_ugmPrimary) _ugmPrimary.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                } catch(e) { console.error('UGM refresh error:', e); }
              }
              closeGameActionsModal();
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              if (typeof showToast === 'function') {
                showToast('error', 'Patch Standalone Failed', String(e && e.message || e));
              } else {
                alert('Failed to install Patch Standalone:\n' + (e.message || e));
              }
              patchStandaloneBtn.textContent = previous;
              patchStandaloneBtn.disabled = false;
            }
          }
        );
        standaloneSection.appendChild(patchStandaloneBtn);
      }

      // Append action row (Play + Remove) after patch buttons — flex-basis:100% forces new line
      standaloneSection.appendChild(standaloneActionRow);

      // Download Standalone (if available from depot controls)
      // This would need to check if depot downloads are available
      // For now, we'll add a placeholder that can be expanded
    }

    // Steam Install/Play Section
    const steamSection = createSection('Steam Integration');
    container.appendChild(steamSection);

    // Add Steam install/play button based on ACF status
    addSteamActionButton(game, steamSection);

    // Online Patch Section (if supported)
    if (game.online_supported === "Yes" || game.bypass_supported === "Yes") {
      const onlineSection = createSection('This Game Supports Online Patch or Bypass — Please Use It!');
      onlineSection.classList.add('online-section');

      const title = onlineSection.querySelector('.game-actions-section-title');
      if (title) {
        title.classList.add('online-warning-title');
      }

      const desc = document.createElement('div');
      desc.className = 'section-description';
      desc.style.cssText = 'grid-column:1/-1;font-size:11px;color:#8ba5be;line-height:1.4;margin-bottom:2px;';
      desc.textContent =
        'This installs the online patch or bypass for supported games. Use this for games that support online features or a Steam bypass method.';

      onlineSection.appendChild(desc);
      container.appendChild(onlineSection);

      const onlinePatchBtn = createActionButton(
        game.online_supported === "Yes" ? 'Online Patch' : game.bypass_supported === "Yes" ? 'Bypass Game' : 'Online Patch/Bypass',
        'patch',
        () => {
          closeGameActionsModal();
          installPatch(game.appid, onlinePatchBtn);
        }
      );

      if (isMonthly) {
        onlinePatchBtn.disabled = true;
        onlinePatchBtn.title = 'Online Patch/Bypass is not available for Monthly licenses';
      }

      onlineSection.appendChild(onlinePatchBtn);
    }

    // Steamless Section (if installed)
    if (game.installed && !game.requires_membership) {
      const steamlessSection = createSection('Steam DRM Removal - This fix error 54 and error 60005432');
      container.appendChild(steamlessSection);

        const steamlessBtn = createActionButton(
          'Steamless [Remove DRM]',
          'patch',
          async () => {
            const proceed = await customConfirm(
              `<b>Remove Steam DRM from ${game.name}?</b><br><br>This will unpack protected EXE files.`
            );
            if (!proceed) return;

            closeGameActionsModal();
            await runSteamless(game.appid);
          }
      );
      steamlessSection.appendChild(steamlessBtn);
    }

    // Per-game Auto Update Section
    const autoUpdateSection = createSection('Auto Update');
    const autoUpdateDesc = document.createElement('div');
    autoUpdateDesc.className = 'section-description';
    autoUpdateDesc.style.cssText = 'flex-basis:100%;font-size:11px;color:#8ba5be;line-height:1.4;margin-bottom:2px;';
    autoUpdateDesc.textContent = 'Enable to allow this game to auto-update to the latest version. Disable to lock it to its current version.';
    autoUpdateSection.appendChild(autoUpdateDesc);
    container.appendChild(autoUpdateSection);

    const enableAutoUpdateBtn = createActionButton(
      'Enable Auto Update',
      'primary',
      async () => {
        enableAutoUpdateBtn.disabled = true;
        const prev = enableAutoUpdateBtn.textContent;
        enableAutoUpdateBtn.textContent = 'Applying...';
        try {
          const res = await fetch('/api/comment_setmanifestid/' + game.appid, { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (typeof showToast === 'function') {
            showToast('success', 'Auto Update', data.message || ('Auto Update enabled for ' + game.name));
          } else { alert(data.message || 'Auto Update enabled.'); }
        } catch (e) {
          if (typeof showToast === 'function') {
            showToast('error', 'Auto Update', (e && e.message) || 'Failed to enable Auto Update.');
          } else { alert('Failed: ' + ((e && e.message) || e)); }
        }
        enableAutoUpdateBtn.disabled = false;
        enableAutoUpdateBtn.textContent = prev;
      }
    );
    autoUpdateSection.appendChild(enableAutoUpdateBtn);

    const disableAutoUpdateBtn = createActionButton(
      'Disable Auto Update',
      'danger',
      async () => {
        disableAutoUpdateBtn.disabled = true;
        const prev = disableAutoUpdateBtn.textContent;
        disableAutoUpdateBtn.textContent = 'Applying...';
        try {
          const res = await fetch('/api/uncomment_setmanifestid/' + game.appid, { method: 'POST' });
          const data = await res.json().catch(() => ({}));
          if (typeof showToast === 'function') {
            showToast('success', 'Auto Update', data.message || ('Auto Update disabled for ' + game.name));
          } else { alert(data.message || 'Auto Update disabled.'); }
        } catch (e) {
          if (typeof showToast === 'function') {
            showToast('error', 'Auto Update', (e && e.message) || 'Failed to disable Auto Update.');
          } else { alert('Failed: ' + ((e && e.message) || e)); }
        }
        disableAutoUpdateBtn.disabled = false;
        disableAutoUpdateBtn.textContent = prev;
      }
    );
    autoUpdateSection.appendChild(disableAutoUpdateBtn);

  }

  // Helper: Create section with title
  function createSection(title) {
    const section = document.createElement('div');
    section.className = 'game-actions-section';

    const titleEl = document.createElement('div');
    titleEl.className = 'game-actions-section-title';
    titleEl.textContent = title;
    section.appendChild(titleEl);

    return section;
  }

  // Helper: Create action button
  function createActionButton(text, type, onClick) {
    const btn = document.createElement('button');
    btn.className = `game-action-btn ${type}`;
    btn.textContent = text;
    btn.onclick = onClick;
    return btn;
  }

  // Add Steam-specific action button
  async function addSteamActionButton(game, container) {
    const appid = String(game.appid);
    const st = await fetchAcfStatus(appid);

    if (st?.status === 'installed') {
      const playBtn = createActionButton(
        'Play on Steam',
        'play',
        async (e) => {
          e.preventDefault();
          try {
            if (window.pywebview?.api?.launch_steam) {
              const res = await window.pywebview.api.launch_steam(appid);
              if (!res?.success) console.error('Launch failed:', res?.error);
            } else {
              window.location.href = `steam://rungameid/${appid}`;
            }
            closeGameActionsModal();
          } catch (err) {
            console.error('Launch error:', err);
          }
        }
      );
      container.appendChild(playBtn);
    } else if (st?.status === 'installing') {
      const pct = Math.max(0, Math.min(100, Math.floor((st.progress || 0) * 100)));
      const installingBtn = createActionButton(
        pct > 0 ? `Installing... ${pct}%` : 'Installing...',
        'install',
        null
      );
      installingBtn.disabled = true;
      container.appendChild(installingBtn);
    } else if (game.installed === true) {
      const installBtn = createActionButton(
        'Install to Steam',
        'install',
        async (e) => {
          e.preventDefault();
          installBtn.disabled = true;
          installBtn.textContent = 'Starting...';
          try {
            if (window.pywebview?.api?.install_steam) {
              await window.pywebview.api.install_steam(appid);
            } else if (window.pywebview?.api?.launch_steam) {
              await window.pywebview.api.launch_steam(appid);
            } else {
              window.location.href = `steam://install/${appid}`;
            }
            closeGameActionsModal();
          } catch (err) {
            console.error('Install start error:', err);
            installBtn.disabled = false;
            installBtn.textContent = 'Install to Steam';
          }
        }
      );
      container.appendChild(installBtn);
    }
  }

  // Helper function for fetching ACF status (reuse from existing code)
  async function fetchAcfStatus(appid) {
    try {
      const r = await fetch(`/api/acf_status/${appid}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch {
      return null;
    }
  }

  // Expose buildActionButtons for unified game detail panel
  window.__buildGameActionButtons = buildActionButtons;
  window.__createActionButton = createActionButton;
  window.__createSection = createSection;

  // Set up event listeners
  document.addEventListener('DOMContentLoaded', () => {
    // Close button
    const closeBtn = document.getElementById('game-actions-close');
    if (closeBtn) {
      closeBtn.addEventListener('click', closeGameActionsModal);
    }

    // Click outside to close (click on backdrop, not content)
    const modal = document.getElementById('game-actions-modal');
    if (modal) {
      modal.addEventListener('click', (e) => {
        // Only close if clicking directly on the modal backdrop, not the content
        if (e.target === modal) {
          closeGameActionsModal();
        }
      });
    }

    // ESC key to close
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape' && modal && modal.classList.contains('show')) {
        closeGameActionsModal();
      }
    });
  });

})();


// ===== .NET SDK Check and Installation =====
async function checkAndInstallDotNet() {
  return new Promise(async (resolve, reject) => {
    try {
      // Step 1: Check if .NET SDK is installed
      const checkRes = await fetch('/api/check_dotnet', { cache: 'no-store' });
      const checkData = await checkRes.json();

      if (!checkData.success) {
        throw new Error('Failed to check .NET SDK installation');
      }

      // If already installed, continue
      if (checkData.installed || checkData.compatible_installed) {
        console.log('.NET SDK already installed:', checkData.installed_version);
        resolve(true);
        return;
      }

      // Step 2: .NET not installed - show installation modal
      const overlayId = 'dotnet-install-overlay';
      const existing = document.getElementById(overlayId);
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = overlayId;
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 99999;
        background: linear-gradient(135deg, rgba(22, 32, 45, 0.95) 0%, rgba(27, 40, 56, 0.98) 100%);
        backdrop-filter: blur(10px);
        display: flex; align-items: center; justify-content: center;
        animation: steamFadeIn 0.3s ease;
      `;

      const box = document.createElement('div');
      box.style.cssText = `
        width: min(580px, 92vw);
        background: linear-gradient(165deg, #1B2838 0%, #16202D 100%);
        color: #C7D5E0; border: 1px solid rgba(102, 192, 244, 0.2);
        border-radius: 14px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 1px rgba(102, 192, 244, 0.3);
        overflow: hidden; animation: steamSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
      `;

      box.innerHTML = `
        <div style="padding: 24px 28px 20px; background: linear-gradient(180deg, rgba(255, 152, 0, 0.1) 0%, transparent 100%); border-bottom: 1px solid rgba(255, 152, 0, 0.2);">
          <div style="display: flex; align-items: center; gap: 16px; margin-bottom: 12px;">
            <div style="width: 56px; height: 56px; background: linear-gradient(135deg, rgba(255, 152, 0, 0.2) 0%, rgba(255, 152, 0, 0.1) 100%); border: 2px solid rgba(255, 152, 0, 0.4); border-radius: 10px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <svg width="32" height="32" viewBox="0 0 24 24" fill="none">
                <path d="M12 2C6.48 2 2 6.48 2 12s4.48 10 10 10 10-4.48 10-10S17.52 2 12 2zm1 15h-2v-2h2v2zm0-4h-2V7h2v6z" fill="#FF9800"/>
              </svg>
            </div>
            <div>
              <h2 style="margin: 0 0 6px 0; font-size: 24px; font-weight: 700; color: #fff; letter-spacing: 0.3px;">Required Dependency Missing</h2>
              <p style="margin: 0; font-size: 14px; color: #FFB74D; line-height: 1.5;">This game requires <strong>.NET SDK 9.0.308</strong></p>
            </div>
          </div>
        </div>

        <div style="padding: 24px 28px;">
          <div style="margin-bottom: 20px; padding: 16px; background: rgba(255, 152, 0, 0.05); border-left: 3px solid #FF9800; border-radius: 6px;">
            <div style="font-size: 14px; color: #C7D5E0; line-height: 1.7;">
              <strong style="color: #FFB74D;">Why is this needed?</strong><br/>
              The depot downloader requires .NET SDK 9.0 to function properly. This is a one-time installation.
            </div>
          </div>

          <div style="margin-bottom: 16px; padding: 14px; background: rgba(102, 192, 244, 0.05); border-radius: 8px; border: 1px solid rgba(102, 192, 244, 0.2);">
            <div style="font-size: 13px; color: #8F98A0; margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.5px;">Download Information</div>
            <div style="font-size: 13px; color: #C7D5E0; line-height: 1.6;">
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span>Version:</span>
                <span style="color: #66C0F4; font-weight: 600;">.NET SDK 9.0.308</span>
              </div>
              <div style="display: flex; justify-content: space-between; margin-bottom: 4px;">
                <span>Size:</span>
                <span style="color: #66C0F4; font-weight: 600;">~200 MB</span>
              </div>
              <div style="display: flex; justify-content: space-between;">
                <span>Source:</span>
                <span style="color: #66C0F4; font-weight: 600;">Microsoft Official</span>
              </div>
            </div>
          </div>

          <div id="dotnet-status" style="margin-top: 16px; padding: 12px; background: rgba(0, 0, 0, 0.2); border-radius: 6px; font-size: 13px; color: #8F98A0; font-family: ui-monospace, Consolas, monospace; min-height: 60px; max-height: 120px; overflow-y: auto; display: none;">
            <div id="dotnet-log"></div>
          </div>
        </div>

        <div style="padding: 16px 28px 20px; background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.2) 100%); border-top: 1px solid rgba(102, 192, 244, 0.1); display: flex; gap: 12px; justify-content: flex-end;">
          <button id="dotnet-cancel" style="padding: 12px 24px; border-radius: 6px; background: linear-gradient(135deg, rgba(42, 71, 94, 0.8) 0%, rgba(42, 71, 94, 0.6) 100%); color: #C7D5E0; border: 1px solid rgba(102, 192, 244, 0.3); font-weight: 600; cursor: pointer; transition: all 0.2s ease; font-size: 14px; font-family: inherit;">Cancel</button>
          <button id="dotnet-download" style="padding: 12px 28px; border-radius: 6px; background: linear-gradient(135deg, #FF9800 0%, #F57C00 100%); color: #fff; border: none; font-weight: 700; cursor: pointer; transition: all 0.2s ease; font-size: 14px; font-family: inherit; box-shadow: 0 4px 12px rgba(255, 152, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3);">Download & Install .NET SDK</button>
        </div>
      `;

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const btnCancel = box.querySelector('#dotnet-cancel');
      const btnDownload = box.querySelector('#dotnet-download');
      const statusDiv = box.querySelector('#dotnet-status');
      const logDiv = box.querySelector('#dotnet-log');

      const log = (message) => {
        const timestamp = new Date().toLocaleTimeString();
        logDiv.innerHTML += `<div>[${timestamp}] ${message}</div>`;
        statusDiv.scrollTop = statusDiv.scrollHeight;
      };

      // Cancel button
      btnCancel.onclick = () => {
        overlay.remove();
        reject(new Error('User cancelled .NET SDK installation'));
      };

      // Download & Install button
      btnDownload.onclick = async () => {
        try {
          btnDownload.disabled = true;
          btnDownload.textContent = 'Downloading...';
          btnDownload.style.opacity = '0.6';
          btnCancel.disabled = true;

          statusDiv.style.display = 'block';
          log('Starting .NET SDK download...');

          // Open download link in new tab
          const downloadUrl = 'https://builds.dotnet.microsoft.com/dotnet/Sdk/9.0.308/dotnet-sdk-9.0.308-win-x64.exe';
          window.open(downloadUrl, '_blank');

          log('Download started in new tab');
          log('Please run the installer after download completes');
          log('The installer will open automatically');

          // Wait a bit for download to start
          await new Promise(resolve => setTimeout(resolve, 2000));

          btnDownload.textContent = 'Waiting for Installation...';
          log('Waiting for you to install .NET SDK...');
          log('After installation completes, click "Verify Installation"');

          // Change button to verify
          btnDownload.textContent = 'Verify Installation';
          btnDownload.disabled = false;
          btnDownload.style.opacity = '1';
          btnDownload.style.background = 'linear-gradient(135deg, #4CAF50 0%, #388E3C 100%)';

          btnDownload.onclick = async () => {
            try {
              btnDownload.disabled = true;
              btnDownload.textContent = 'Verifying...';

              log('Checking .NET SDK installation...');

              const verifyRes = await fetch('/api/check_dotnet', { cache: 'no-store' });
              const verifyData = await verifyRes.json();

              if (verifyData.installed || verifyData.compatible_installed) {
                log('✅ .NET SDK installed successfully!');
                log(`Version: ${verifyData.installed_version}`);

                await new Promise(resolve => setTimeout(resolve, 1000));

                overlay.remove();
                resolve(true);
              } else {
                log('❌ .NET SDK not detected yet');
                log('Please make sure installation completed successfully');
                log('You may need to restart your application');

                btnDownload.textContent = 'Verify Installation';
                btnDownload.disabled = false;
              }

            } catch (error) {
              log(`Error: ${error.message}`);
              btnDownload.textContent = 'Verify Installation';
              btnDownload.disabled = false;
            }
          };

        } catch (error) {
          log(`Error: ${error.message}`);
          btnDownload.disabled = false;
          btnDownload.textContent = 'Download & Install .NET SDK';
          btnDownload.style.opacity = '1';
          btnCancel.disabled = false;
        }
      };

      // Hover effects
      btnDownload.addEventListener('mouseenter', () => {
        if (!btnDownload.disabled) {
          btnDownload.style.transform = 'translateY(-1px)';
          btnDownload.style.boxShadow = '0 6px 16px rgba(255, 152, 0, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.4)';
        }
      });
      btnDownload.addEventListener('mouseleave', () => {
        if (!btnDownload.disabled) {
          btnDownload.style.transform = 'translateY(0)';
          btnDownload.style.boxShadow = '0 4px 12px rgba(255, 152, 0, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3)';
        }
      });

    } catch (error) {
      console.error('.NET SDK check failed:', error);
      reject(error);
    }
  });
}


// ===== Depot Download Helper =====
async function triggerDepotDownload(game) {
  // PROFESSIONAL library selector with REAL disk space visualization (COMPACT & RESPONSIVE)
  function selectSteamLibraryModal(libraries, suggestedInstalldir) {
    return new Promise((resolve) => {
      const overlayId = 'select-steam-lib-overlay';
      const existing = document.getElementById(overlayId);
      if (existing) existing.remove();

      const overlay = document.createElement('div');
      overlay.id = overlayId;
      overlay.style.cssText = `
        position: fixed; inset: 0; z-index: 99999;
        background: linear-gradient(135deg, rgba(22, 32, 45, 0.95) 0%, rgba(27, 40, 56, 0.98) 100%);
        backdrop-filter: blur(10px);
        display: flex; align-items: center; justify-content: center;
        animation: steamFadeIn 0.3s ease;
        padding: 10px;
      `;

      const box = document.createElement('div');
      box.style.cssText = `
        width: min(520px, 100%);
        max-height: min(650px, 90vh);
        background: linear-gradient(165deg, #1B2838 0%, #16202D 100%);
        color: #C7D5E0; border: 1px solid rgba(102, 192, 244, 0.2);
        border-radius: 12px;
        box-shadow: 0 20px 60px rgba(0, 0, 0, 0.6), 0 0 1px rgba(102, 192, 244, 0.3);
        overflow: hidden; animation: steamSlideIn 0.4s cubic-bezier(0.16, 1, 0.3, 1);
        font-family: system-ui, -apple-system, Segoe UI, Roboto, Arial, sans-serif;
        display: flex; flex-direction: column;
      `;

      box.innerHTML = `
        <div style="padding: 16px 20px 14px; background: linear-gradient(180deg, rgba(102, 192, 244, 0.08) 0%, transparent 100%); border-bottom: 1px solid rgba(102, 192, 244, 0.15); flex-shrink: 0;">
          <div style="display: flex; align-items: center; gap: 12px; margin-bottom: 8px;">
            <div style="width: 40px; height: 40px; background: linear-gradient(135deg, rgba(102, 192, 244, 0.15) 0%, rgba(102, 192, 244, 0.05) 100%); border: 2px solid rgba(102, 192, 244, 0.3); border-radius: 8px; display: flex; align-items: center; justify-content: center; flex-shrink: 0;">
              <svg width="24" height="24" viewBox="0 0 24 24" fill="none">
                <path d="M4 6h16v2H4zm0 5h16v2H4zm0 5h16v2H4z" fill="#66C0F4" opacity="0.3"/>
                <rect x="2" y="4" width="20" height="16" rx="2" stroke="#66C0F4" stroke-width="2" fill="none"/>
                <circle cx="6" cy="8" r="1" fill="#66C0F4"/><circle cx="6" cy="12" r="1" fill="#66C0F4"/><circle cx="6" cy="16" r="1" fill="#66C0F4"/>
              </svg>
            </div>
            <div style="flex: 1; min-width: 0;">
              <h2 style="margin: 0 0 4px 0; font-size: 18px; font-weight: 700; color: #fff; letter-spacing: 0.2px;">Choose Installation Drive</h2>
              <p style="margin: 0; font-size: 12px; color: #8F98A0; line-height: 1.4; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">Install <strong style="color: #66C0F4;">${suggestedInstalldir || 'your game'}</strong></p>
            </div>
          </div>
        </div>

        <div style="padding: 16px 20px; flex: 1; overflow-y: auto; min-height: 0;">
          <div style="margin-bottom: 14px; padding: 10px 12px; background: rgba(102, 192, 244, 0.05); border-left: 3px solid #66C0F4; border-radius: 5px;">
            <div style="font-size: 11px; color: #C7D5E0; line-height: 1.5;">
              <strong style="color: #66C0F4; font-size: 12px;">Path:</strong>
              <code style="background: rgba(0, 0, 0, 0.3); padding: 3px 6px; border-radius: 3px; font-family: ui-monospace, Consolas, monospace; font-size: 10px; color: #8F98A0; display: block; margin-top: 4px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">{selected}\\steamapps\\common\\${suggestedInstalldir || 'GameFolder'}</code>
            </div>
          </div>

          <div style="margin-bottom: 12px; font-size: 11px; color: #8F98A0; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600;">Available Libraries</div>

          <div id="lib-list" style="display: flex; flex-direction: column; gap: 10px; max-height: 280px; overflow-y: auto; padding-right: 4px;"></div>

          <div id="installdir-row" style="margin-top: 14px; display: ${suggestedInstalldir ? 'none':'block'};">
            <label style="display: block; font-size: 11px; color: #8F98A0; margin-bottom: 6px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.4px;">Custom Folder Name</label>
            <input id="installdir-input" type="text" value="${suggestedInstalldir || 'GameFolder'}" style="width: 100%; padding: 10px 12px; border-radius: 5px; border: 1px solid rgba(102, 192, 244, 0.3); background: rgba(11, 19, 40, 0.8); color: #C7D5E0; outline: none; font-size: 13px; font-family: inherit; transition: all 0.2s ease;">
          </div>
        </div>

        <div style="padding: 12px 20px 14px; background: linear-gradient(180deg, transparent 0%, rgba(0, 0, 0, 0.2) 100%); border-top: 1px solid rgba(102, 192, 244, 0.1); display: flex; gap: 10px; justify-content: flex-end; flex-shrink: 0;">
          <button id="cancel-btn" style="padding: 10px 18px; border-radius: 5px; background: linear-gradient(135deg, rgba(42, 71, 94, 0.8) 0%, rgba(42, 71, 94, 0.6) 100%); color: #C7D5E0; border: 1px solid rgba(102, 192, 244, 0.3); font-weight: 600; cursor: pointer; transition: all 0.2s ease; font-size: 13px; font-family: inherit;">Cancel</button>
          <button id="continue-btn" disabled style="padding: 10px 20px; border-radius: 5px; background: linear-gradient(135deg, #5C9BC6 0%, #66C0F4 50%, #76D0FF 100%); color: #fff; border: none; font-weight: 700; cursor: pointer; opacity: 0.5; transition: all 0.2s ease; font-size: 13px; font-family: inherit; box-shadow: 0 4px 12px rgba(102, 192, 244, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3);">Continue</button>
        </div>
      `;

      overlay.appendChild(box);
      document.body.appendChild(overlay);

      const list = box.querySelector('#lib-list');
      const btnCancel = box.querySelector('#cancel-btn');
      const btnOk = box.querySelector('#continue-btn');
      const installdirInput = box.querySelector('#installdir-input');
      const pathPreview = box.querySelector('code');

      let chosen = null;

      // Scrollbar styling
      const scrollStyle = document.createElement('style');
      scrollStyle.textContent = `
        #lib-list::-webkit-scrollbar { width: 8px; }
        #lib-list::-webkit-scrollbar-track { background: rgba(0, 0, 0, 0.2); border-radius: 4px; }
        #lib-list::-webkit-scrollbar-thumb { background: rgba(102, 192, 244, 0.3); border-radius: 4px; }
        #lib-list::-webkit-scrollbar-thumb:hover { background: rgba(102, 192, 244, 0.5); }
      `;
      document.head.appendChild(scrollStyle);

      // Get REAL disk space from backend API
      const getDiskInfo = async (path) => {
        try {
          const response = await fetch(`/api/disk_space?path=${encodeURIComponent(path)}`, {
            cache: 'no-store'
          });

          if (!response.ok) throw new Error(`HTTP ${response.status}`);

          const data = await response.json();

          if (!data.success) throw new Error(data.message || 'Failed to get disk space');

          return {
            freeGB: data.free_gb,
            totalGB: data.total_gb,
            usedGB: data.used_gb,
            usedPercent: data.used_percent
          };

        } catch (error) {
          console.warn('Failed to fetch real disk space for', path, ':', error);

          // Fallback to mock data if API fails
          const driveLetter = path.match(/^([A-Z]):/)?.[1] || 'C';
          const mockData = {
            'C': { freeGB: 125, totalGB: 500, usedGB: 375 },
            'D': { freeGB: 850, totalGB: 2000, usedGB: 1150 },
            'E': { freeGB: 450, totalGB: 1000, usedGB: 550 },
            'F': { freeGB: 75, totalGB: 250, usedGB: 175 },
          };
          return mockData[driveLetter] || { freeGB: 100, totalGB: 500, usedGB: 400 };
        }
      };

      // Create professional library cards with REAL disk space (COMPACT VERSION)
      (libraries || []).forEach(async (lib, index) => {
        const diskInfo = await getDiskInfo(lib);
        const usedPercent = (diskInfo.usedGB / diskInfo.totalGB) * 100;
        const driveLetter = lib.match(/^([A-Z]):/)?.[1] || '?';

        const item = document.createElement('button');
        item.type = 'button';
        item.style.cssText = `
          text-align: left; width: 100%; border-radius: 8px; padding: 0; cursor: pointer;
          border: 2px solid rgba(102, 192, 244, 0.2); background: rgba(11, 19, 40, 0.4);
          color: #C7D5E0; transition: all 0.25s cubic-bezier(0.4, 0, 0.2, 1);
          position: relative; overflow: hidden;
        `;

        item.innerHTML = `
          <div style="padding: 12px 14px;">
            <div style="display: flex; align-items: flex-start; gap: 12px;">
              <div style="width: 48px; height: 48px; background: linear-gradient(135deg, rgba(102, 192, 244, 0.15) 0%, rgba(102, 192, 244, 0.05) 100%); border: 2px solid rgba(102, 192, 244, 0.3); border-radius: 8px; display: flex; flex-direction: column; align-items: center; justify-content: center; flex-shrink: 0;">
                <svg width="22" height="22" viewBox="0 0 24 24" fill="none" style="margin-bottom: 1px;">
                  <rect x="3" y="5" width="18" height="14" rx="2" stroke="#66C0F4" stroke-width="2" fill="none"/>
                  <path d="M3 9h18M7 5v4m10-4v4" stroke="#66C0F4" stroke-width="1.5" opacity="0.5"/>
                  <circle cx="7" cy="13" r="1.5" fill="#66C0F4"/><circle cx="12" cy="13" r="1.5" fill="#66C0F4" opacity="0.6"/><circle cx="17" cy="13" r="1.5" fill="#66C0F4" opacity="0.3"/>
                </svg>
                <div style="font-size: 9px; font-weight: 700; color: #66C0F4; letter-spacing: 0.4px;">${driveLetter}:</div>
              </div>

              <div style="flex: 1; min-width: 0;">
                <div style="font-weight: 700; font-size: 13px; color: #fff; margin-bottom: 4px; display: flex; align-items: center; gap: 6px; flex-wrap: wrap;">
                  <span style="overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">${lib}</span>
                  <span style="padding: 1px 6px; background: rgba(102, 192, 244, 0.2); border-radius: 3px; font-size: 9px; color: #66C0F4; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600; flex-shrink: 0;">Drive ${driveLetter}</span>
                </div>

                <div style="font-size: 10px; color: #8F98A0; font-family: ui-monospace, Consolas, monospace; margin-bottom: 8px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;">
                  → ${lib}\\steamapps\\common\\${suggestedInstalldir || '{installdir}'}
                </div>

                <div style="margin-bottom: 6px;">
                  <div style="display: flex; justify-content: space-between; align-items: center; margin-bottom: 4px; font-size: 10px; color: #8F98A0; text-transform: uppercase; letter-spacing: 0.4px; font-weight: 600;">
                    <span>Storage</span>
                    <span style="color: #66C0F4;">${diskInfo.freeGB} GB free</span>
                  </div>
                  <div style="height: 5px; background: rgba(0, 0, 0, 0.4); border-radius: 2.5px; overflow: hidden; position: relative; box-shadow: inset 0 1px 2px rgba(0, 0, 0, 0.3);">
                    <div style="position: absolute; left: 0; top: 0; bottom: 0; width: ${usedPercent}%; background: linear-gradient(90deg, ${usedPercent > 85 ? '#c9302c' : usedPercent > 70 ? '#f0ad4e' : '#5cb85c'} 0%, ${usedPercent > 85 ? '#d9534f' : usedPercent > 70 ? '#f5b85e' : '#6cc86c'} 100%); transition: width 0.3s ease;"></div>
                  </div>
                  <div style="display: flex; justify-content: space-between; margin-top: 3px; font-size: 9px; color: #8F98A0;">
                    <span>${diskInfo.usedGB} GB used</span>
                    <span>${diskInfo.totalGB} GB total</span>
                  </div>
                </div>
              </div>

              <div class="selection-indicator" style="width: 28px; height: 28px; border-radius: 50%; border: 2px solid rgba(102, 192, 244, 0.3); display: flex; align-items: center; justify-content: center; opacity: 0.3; transition: all 0.2s ease; flex-shrink: 0;">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                  <circle cx="12" cy="12" r="10" fill="#66C0F4" opacity="0"/>
                  <path d="M9 12l2 2 4-4" stroke="#66C0F4" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" opacity="0"/>
                </svg>
              </div>
            </div>
          </div>
        `;

        // Hover effects
        item.addEventListener('mouseenter', () => {
          if (!item.classList.contains('selected')) {
            item.style.background = 'rgba(102, 192, 244, 0.05)';
            item.style.borderColor = 'rgba(102, 192, 244, 0.4)';
            item.style.transform = 'translateX(4px)';
          }
        });

        item.addEventListener('mouseleave', () => {
          if (!item.classList.contains('selected')) {
            item.style.background = 'rgba(11, 19, 40, 0.4)';
            item.style.borderColor = 'rgba(102, 192, 244, 0.2)';
            item.style.transform = 'translateX(0)';
          }
        });

        // Selection
        item.addEventListener('click', () => {
          list.querySelectorAll('button').forEach(b => {
            b.classList.remove('selected');
            b.style.background = 'rgba(11, 19, 40, 0.4)';
            b.style.borderColor = 'rgba(102, 192, 244, 0.2)';
            b.style.boxShadow = 'none';
            b.style.transform = 'translateX(0)';

            const indicator = b.querySelector('.selection-indicator');
            indicator.style.opacity = '0.3';
            indicator.style.borderColor = 'rgba(102, 192, 244, 0.3)';
            indicator.style.background = 'transparent';

            const circle = indicator.querySelector('circle');
            const path = indicator.querySelector('path');
            circle.style.opacity = '0';
            path.style.opacity = '0';
          });

          item.classList.add('selected');
          item.style.background = 'rgba(102, 192, 244, 0.1)';
          item.style.borderColor = '#66C0F4';
          item.style.boxShadow = '0 0 20px rgba(102, 192, 244, 0.3), inset 0 1px 0 rgba(102, 192, 244, 0.1)';

          const indicator = item.querySelector('.selection-indicator');
          indicator.style.opacity = '1';
          indicator.style.borderColor = '#66C0F4';
          indicator.style.background = 'rgba(102, 192, 244, 0.2)';

          const circle = indicator.querySelector('circle');
          const path = indicator.querySelector('path');
          circle.style.opacity = '1';
          path.style.opacity = '1';

          chosen = lib;
          btnOk.disabled = false;
          btnOk.style.opacity = '1';
          pathPreview.textContent = `${lib}\\steamapps\\common\\${suggestedInstalldir || 'GameFolder'}`;
        });

        list.appendChild(item);
        if (index === 0) setTimeout(() => item.click(), 100);
      });

      // Button hover effects
      btnCancel.addEventListener('mouseenter', () => {
        btnCancel.style.background = 'linear-gradient(135deg, rgba(42, 71, 94, 1) 0%, rgba(42, 71, 94, 0.8) 100%)';
        btnCancel.style.borderColor = 'rgba(102, 192, 244, 0.5)';
        btnCancel.style.color = '#fff';
        btnCancel.style.transform = 'translateY(-1px)';
      });
      btnCancel.addEventListener('mouseleave', () => {
        btnCancel.style.background = 'linear-gradient(135deg, rgba(42, 71, 94, 0.8) 0%, rgba(42, 71, 94, 0.6) 100%)';
        btnCancel.style.borderColor = 'rgba(102, 192, 244, 0.3)';
        btnCancel.style.color = '#C7D5E0';
        btnCancel.style.transform = 'translateY(0)';
      });

      btnOk.addEventListener('mouseenter', () => {
        if (!btnOk.disabled) {
          btnOk.style.background = 'linear-gradient(135deg, #6CACCD 0%, #76D0FF 50%, #86E0FF 100%)';
          btnOk.style.transform = 'translateY(-1px)';
          btnOk.style.boxShadow = '0 6px 16px rgba(102, 192, 244, 0.4), inset 0 1px 0 rgba(255, 255, 255, 0.4)';
        }
      });
      btnOk.addEventListener('mouseleave', () => {
        if (!btnOk.disabled) {
          btnOk.style.background = 'linear-gradient(135deg, #5C9BC6 0%, #66C0F4 50%, #76D0FF 100%)';
          btnOk.style.transform = 'translateY(0)';
          btnOk.style.boxShadow = '0 4px 12px rgba(102, 192, 244, 0.3), inset 0 1px 0 rgba(255, 255, 255, 0.3)';
        }
      });

      installdirInput?.addEventListener('focus', () => {
        installdirInput.style.borderColor = '#66C0F4';
        installdirInput.style.background = 'rgba(11, 19, 40, 1)';
        installdirInput.style.boxShadow = '0 0 0 3px rgba(102, 192, 244, 0.2)';
      });
      installdirInput?.addEventListener('blur', () => {
        installdirInput.style.borderColor = 'rgba(102, 192, 244, 0.3)';
        installdirInput.style.background = 'rgba(11, 19, 40, 0.8)';
        installdirInput.style.boxShadow = 'none';
      });

      btnCancel.onclick = () => {
        scrollStyle.remove();
        overlay.remove();
        resolve(null);
      };

      btnOk.onclick = () => {
        const finalInstalldir = suggestedInstalldir || (installdirInput ? installdirInput.value.trim() : 'GameFolder');
        scrollStyle.remove();
        overlay.remove();
        if (!chosen) return resolve(null);
        resolve({
          libraryRoot: chosen,
          installdir: finalInstalldir || 'GameFolder',
          outDir: `${chosen}\\steamapps\\common\\${finalInstalldir || 'GameFolder'}`
        });
      };

      overlay.addEventListener('click', (e) => {
        if (e.target === overlay) btnCancel.click();
      });
    });
  }

  // STEP 1: Check and install .NET SDK before proceeding
  try {
    await checkAndInstallDotNet();
  } catch (error) {
    console.warn('.NET SDK installation cancelled or failed:', error);
    return; // Exit if user cancels or installation fails
  }

  // STEP 2: Continue with depot download flow
  try {
    // Pre-fetch app info via JS APIs and push to backend cache
    const _apiInfo = await SteamAPI.getAppInfo(game.appid);
    console.log(`[depot] Pre-cached app info for ${game.appid}:`, _apiInfo?.name, _apiInfo?.installdir);

    // Build plan
    const planRes = await fetch(`/api/depot_plan/${game.appid}`, { cache:'no-store' });
    const plan = await planRes.json();
    if (!planRes.ok || !plan.success) {
      alert(`Plan failed: ${(plan && plan.message) || planRes.statusText}`);
      return;
    }

    // Show depot modal if available
    if (window.__showDepotModal) {
      const totalManifests = (plan.manifests || []).length;
      const available = (plan.manifests || []).filter(m => m.exists).length;
      const missing = totalManifests - available;
      const metaHtml = `
        <div><b>Game:</b> ${game.name || ''}</div>
        <div><b>AppID:</b> ${game.appid}</div>
        <div><b>Steam Root:</b> <code>${plan.steam_root}</code></div>
        <div><b>Key File:</b> <code>${plan.key_file}</code></div>
        <div><b>Depotcache:</b> <code>${plan.depotcache}</code></div>
        <div><b>InstallDir (suggested):</b> <code>${plan.installdir}</code></div>
        <div style="margin-top:6px;"><b>Manifests:</b> ${available}/${totalManifests} ready${missing>0?` (missing ${missing})`:''}</div>
      `;
      window.__showDepotModal('Game Downloader (Standalone)', metaHtml);
    }

    // Get Steam libraries
    let libraries = [];
    try {
      const libsRes = await fetch('/api/steam_libraries', { cache:'no-store' });
      const libs = await libsRes.json().catch(() => ({}));
      if (libsRes.ok && libs && libs.success && Array.isArray(libs.libraries)) {
        libraries = libs.libraries;
      }
    } catch (_) {}

    if (!libraries.length && plan.steam_root) {
      libraries = [plan.steam_root.replace(/\\Steam$/i, '\\SteamLibrary')];
    }

    // Show selection modal
    const pick = await selectSteamLibraryModal(libraries, plan.installdir);
    if (!pick || !pick.outDir) {
      if (window.__finishDepotModal) window.__finishDepotModal(false, '');
      return;
    }

    // Create appmanifest
    try {
      const mRes = await fetch('/api/create_appmanifest', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          appid: Number(game.appid),
          library_root: pick.libraryRoot,
          installdir: pick.installdir
        })
      });
      const m = await mRes.json().catch(() => ({}));
      if (!mRes.ok || !m.success) {
        console.warn('create_appmanifest failed:', m && m.message);
      } else {
        console.debug('appmanifest created at:', m.manifest_path);
      }
    } catch (e) {
      console.warn('create_appmanifest error:', e);
    }

    // Start download
    const startRes = await fetch('/api/depot_download/start', {
      method: 'POST',
      headers: {'Content-Type':'application/json'},
      body: JSON.stringify({ appid: Number(game.appid), out_dir: pick.outDir })
    });
    const start = await startRes.json().catch(() => ({}));
    if (!startRes.ok || !start.success) {
      if (window.__updateDepotModal) window.__updateDepotModal(0, [`Start failed: ${(start && start.message) || startRes.statusText}`]);
      return;
    }

    // Poll progress
    const jobId = start.job_id;
    let stop = false;
    const poll = async () => {
      if (stop) return;
      try {
        const sRes = await fetch(`/api/depot_download/progress/${encodeURIComponent(jobId)}?t=${Date.now()}`, { cache:'no-store' });
        const s = await sRes.json();
        if (!sRes.ok || !s.success) throw new Error((s && s.message) || sRes.statusText);

        if (window.__updateDepotModal) window.__updateDepotModal(s.progress || 0, s.log || []);

        if (s.status === 'done') {
          stop = true;

          // AUTO-PATCH: Install ONENNABE launcher after download completes
          try {
            if (window.__updateDepotModal) {
              window.__updateDepotModal(100, [...(s.log || []), '', '🔧 Installing Universal Online Patch...']);
            }

            // Call patch API (installs ONENNABE launcher)
            const patchRes = await fetch('/api/patch_game', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                appid: Number(game.appid),
                game_path: pick.outDir
              })
            });

            const patchData = await patchRes.json();

            if (patchRes.ok && patchData.success && patchData.patched) {
              // Unsteam installed successfully
              const messages = [
                ...(s.log || []),
                '',
                '✅ Universal Online Patch installed successfully!'
              ];

              // Add launcher details if available
              if (patchData.exe) {
                messages.push(`📁 Game executable: ${patchData.exe}`);
              }
              if (patchData.copy_stats) {
                messages.push(`📦 Files installed: ${patchData.copy_stats.copied || 'N/A'}`);
              }

              messages.push('🎮 Game ready to play!');

              if (window.__updateDepotModal) {
                window.__updateDepotModal(100, messages);
              }

              // Wait a moment to show success message
              await new Promise(resolve => setTimeout(resolve, 1500));

              // Show "Play (Bypass Steam)" button instead of just closing
              if (window.__showDepotPlayButton) {
                window.__showDepotPlayButton(game.appid, game.name || 'Game');
              } else {
                // Fallback if play button not available
                if (window.__finishDepotModal) window.__finishDepotModal(true, '');
              }
            } else if (patchRes.ok && patchData.success && !patchData.patched) {
              // Unsteam installation failed (not critical)
              if (window.__updateDepotModal) {
                window.__updateDepotModal(100, [
                  ...(s.log || []),
                  '',
                  '⚠️ Universal Online Patch installation skipped',
                  `📝 ${patchData.message || 'No Universal Online Patch available'}`,
                  '🎮 Game downloaded - may need manual setup'
                ]);
              }

              await new Promise(resolve => setTimeout(resolve, 2000));

              if (window.__finishDepotModal) window.__finishDepotModal(true, '');
            } else {
              // Launcher installation error
              if (window.__updateDepotModal) {
                window.__updateDepotModal(100, [
                  ...(s.log || []),
                  '',
                  `❌ Universal Online Patch installation failed: ${patchData.message || 'Unknown error'}`,
                  '🎮 Game downloaded but Universal Online Patch not installed'
                ]);
              }

              await new Promise(resolve => setTimeout(resolve, 2000));

              if (window.__finishDepotModal) window.__finishDepotModal(true, '');
            }

          } catch (patchError) {
            // Patching error (network or other)
            console.error('Patch error:', patchError);

            if (window.__updateDepotModal) {
              window.__updateDepotModal(100, [
                ...(s.log || []),
                '',
                `❌ Patching error: ${patchError.message || 'Unknown error'}`,
                '🎮 Game downloaded but not patched'
              ]);
            }

            await new Promise(resolve => setTimeout(resolve, 2000));

            if (window.__finishDepotModal) window.__finishDepotModal(true, '');
          }

          return;
        }
        if (s.status === 'failed') {
          stop = true;
          if (window.__finishDepotModal) window.__finishDepotModal(false, '');
          return;
        }
        setTimeout(poll, 1000);
      } catch (err) {
        console.error('Depot poll error:', err);
        if (window.__finishDepotModal) window.__finishDepotModal(false, '');
        stop = true;
      }
    };
    poll();

  } catch (e) {
    alert('Error: ' + (e.message || e));
    if (window.__finishDepotModal) window.__finishDepotModal(false, '');
  }
}

// ===== Right-Side Popover Menu =====
(function() {
  // Helper to fetch ACF status
  async function fetchAcfStatus(appid) {
    try {
      const r = await fetch(`/api/acf_status/${appid}?t=${Date.now()}`, { cache: 'no-store' });
      if (!r.ok) return null;
      return await r.json();
    } catch { return null; }
  }

  // Open popover menu to the right of card
  window.openGameActionsModal = function(game, launcherStatus, clickEvent) {
    const popover = document.getElementById('actions-popover');
    const backdrop = document.getElementById('popover-backdrop');
    const container = document.getElementById('popover-container');
    const arrow = document.getElementById('popover-arrow');
    const buttonsDiv = document.getElementById('popover-buttons');

    // CRITICAL: Get card rect immediately!
    let clickedCard = null;
    let cardRect = null;
    if (clickEvent && clickEvent.target) {
      clickedCard = clickEvent.target.closest('.card');
      if (clickedCard) {
        // Get rect BEFORE any style changes - THIS IS CRITICAL!
        cardRect = clickedCard.getBoundingClientRect();

        // Remove any previous active card
        document.querySelectorAll('.card.active-card').forEach(c => c.classList.remove('active-card'));
        // Mark this card as active (won't be blurred)
        clickedCard.classList.add('active-card');
      }
    }

    // Add blur to everything else
    document.body.classList.add('popover-open');

    // Clean up any existing scroll lock handlers first
    if (window.__scrollPreventHandlers) {
      console.log('⚠️ Cleaning up old handlers...');
      const { preventScroll: oldPreventScroll, preventKeyScroll: oldPreventKeyScroll } = window.__scrollPreventHandlers;
      if (oldPreventScroll) {
        window.removeEventListener('wheel', oldPreventScroll, { passive: false });
        window.removeEventListener('touchmove', oldPreventScroll, { passive: false });
      }
      if (oldPreventKeyScroll) {
        window.removeEventListener('keydown', oldPreventKeyScroll, false);
      }
      delete window.__scrollPreventHandlers;
      console.log('⚠️ Old handlers cleaned up');
    }

    // Lock scrolling using event prevention (NOT overflow:hidden!)
    console.log('🔒 Adding scroll lock...');
    const preventScroll = (e) => {
      e.preventDefault();
      e.stopPropagation();
      return false;
    };

    // Prevent scroll via mouse wheel
    window.addEventListener('wheel', preventScroll, { passive: false });
    window.addEventListener('touchmove', preventScroll, { passive: false });
    console.log('🔒 Wheel/touch listeners added');

    // Prevent scroll via keyboard
    const preventKeyScroll = (e) => {
      const keys = [32, 33, 34, 35, 36, 37, 38, 39, 40]; // Space, Page Up/Down, Home, End, Arrows
      if (keys.includes(e.keyCode)) {
        e.preventDefault();
        return false;
      }
      // Don't prevent ESC (27) so popover can close
    };
    window.addEventListener('keydown', preventKeyScroll, false);
    console.log('🔒 Keyboard listener added');

    // Store references for cleanup
    window.__scrollPreventHandlers = { preventScroll, preventKeyScroll };
    console.log('🔒 Scroll lock active!');

    // Clear previous buttons
    buttonsDiv.innerHTML = '';

    // Build buttons
    const buttons = [];

    const isMonthly =
      document.body.getAttribute('data-license') === 'monthly' ||
      ((window.activationType || '').toUpperCase() === 'MONTHLY') ||
      ((localStorage.getItem('key_type') || '').toUpperCase() === 'MONTHLY');

    // 1. Download/Update
    buttons.push(createBtn(
      game.installed ? 'Update Game' : 'Unlock Game',
      game.installed ? 'update' : 'primary',
      () => { closePopover(); downloadGame(game.appid); }
    ));

    // 2. Standalone Unsteam Actions
    if (game.installed) {
      const isUnsteamInstalled = !!(launcherStatus && launcherStatus.installed);
      const isColdClientInstalled = !!(launcherStatus && launcherStatus.coldclient_installed);

      if (isUnsteamInstalled) {
        // Play (Universal Online Patch)
        buttons.push(createBtn(
          'Play (Online Patch)',
          'play',
          async () => {
            try {
              const r = await fetch(`/api/launch_onennabe/${game.appid}`, { method: 'POST' });
              const j = await r.json().catch(() => ({}));
              if (!r.ok || !j.success) alert(`Failed to launch:\n${(j && j.message) || r.statusText}`);
              closePopover();
            } catch (e) {
              alert('Launch error: ' + (e.message || e));
            }
          }
        ));

        // Remove Universal Online Patch
        buttons.push(createBtn(
          'Remove Online Patch',
          'danger',
          async () => {
            closePopover();

            const confirmed = await window.__modalKit.confirmModal({
              title: 'Remove Online Patch?',
              message: 'This will remove the Universal Online Patch files for this game.',
              okText: 'Remove',
              cancelText: 'Cancel'
            });

            if (!confirmed) return;

            try {
              const res = await fetch(`/api/uninstall_launcher/${game.appid}`, { method: 'POST' });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.success) {
                await window.__modalKit.infoModal({
                  title: 'Error',
                  message: `Failed to remove Universal Online Patch:\n${(data && data.message) || res.statusText}`
                });
                return;
              }

              await window.__modalKit.infoModal({ title: 'Success', message: 'Universal Online Patch removed successfully.' });
              const _ugmModal = document.getElementById('unified-game-modal');
              const _ugmActions = document.getElementById('ugm-actions');
              if (_ugmModal && _ugmModal.style.display !== 'none' && _ugmActions && window.__buildGameActionButtons) {
                try {
                  const _freshRes = await fetch('/api/launcher_status/' + game.appid);
                  const _freshStatus = await _freshRes.json().catch(() => ({}));
                  _ugmActions.innerHTML = '';
                  const _ugmPrimary = document.getElementById('ugm-primary-actions');
                  if (_ugmPrimary) _ugmPrimary.innerHTML = '';
                  window.__buildGameActionButtons(game, _freshStatus, _ugmActions, _ugmPrimary || undefined);
                  _ugmActions.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                  if (_ugmPrimary) _ugmPrimary.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                } catch(e) { console.error('UGM refresh error:', e); }
              }
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              await window.__modalKit.infoModal({ title: 'Error', message: 'Error: ' + (e.message || e) });
            }
          }
        ));

        // Patch Standalone conflict warning
        buttons.push(createBtn(
          'Patch Standalone',
          'patch',
          async () => {
            closePopover();
            await window.__modalKit.infoModal({
              title: 'Conflict',
              message: 'Please remove Universal Online Patch first before using Patch Standalone.'
            });
          }
        ));

      } else if (isColdClientInstalled) {
        // Play Bypass Steam
        buttons.push(createBtn(
          '▶ Play (Bypass Steam)',
          'play',
          async () => {
            try {
              const r = await fetch(`/api/launch_coldclient/${game.appid}`, { method: 'POST' });
              const j = await r.json().catch(() => ({}));
              if (!r.ok || !j.success) alert(`Failed to launch:\n${(j && j.message) || r.statusText}`);
              closePopover();
            } catch (e) {
              alert('Launch error: ' + (e.message || e));
            }
          }
        ));

        // Remove Patch Standalone
        buttons.push(createBtn(
          'Remove Patch Standalone',
          'danger',
          async () => {
            closePopover();

            const confirmed = await window.__modalKit.confirmModal({
              title: 'Remove Patch Standalone?',
              message: 'This will remove the Patch Standalone files for this game.',
              okText: 'Remove',
              cancelText: 'Cancel'
            });

            if (!confirmed) return;

            try {
              const res = await fetch(`/api/uninstall_coldclient/${game.appid}`, { method: 'POST' });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.success) {
                await window.__modalKit.infoModal({
                  title: 'Error',
                  message: `Failed to remove Patch Standalone:\n${(data && data.message) || res.statusText}`
                });
                return;
              }

              await window.__modalKit.infoModal({ title: 'Success', message: 'Patch Standalone removed successfully.' });
              const _ugmModal = document.getElementById('unified-game-modal');
              const _ugmActions = document.getElementById('ugm-actions');
              if (_ugmModal && _ugmModal.style.display !== 'none' && _ugmActions && window.__buildGameActionButtons) {
                try {
                  const _freshRes = await fetch('/api/launcher_status/' + game.appid);
                  const _freshStatus = await _freshRes.json().catch(() => ({}));
                  _ugmActions.innerHTML = '';
                  const _ugmPrimary = document.getElementById('ugm-primary-actions');
                  if (_ugmPrimary) _ugmPrimary.innerHTML = '';
                  window.__buildGameActionButtons(game, _freshStatus, _ugmActions, _ugmPrimary || undefined);
                  _ugmActions.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                  if (_ugmPrimary) _ugmPrimary.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                } catch(e) { console.error('UGM refresh error:', e); }
              }
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              await window.__modalKit.infoModal({ title: 'Error', message: 'Error: ' + (e.message || e) });
            }
          }
        ));

        // Universal Online Patch conflict warning
        buttons.push(createBtn(
          'Universal Online Patch',
          'patch',
          async () => {
            closePopover();
            await window.__modalKit.infoModal({
              title: 'Conflict',
              message: 'Please remove Patch Standalone first before using Universal Online Patch.'
            });
          }
        ));
      }
      // Attempt Standalone Patch moved to ADVANCED section at the end
    }

    // 4. Steam Actions - Check status first
    const checkSteamStatus = async () => {
      const st = await fetchAcfStatus(String(game.appid));
      return st;
    };

    // Start the check but don't wait yet
    const steamStatusPromise = checkSteamStatus();

    // 5. Online Patch
    if ((game.online_supported === "Yes" || game.bypass_supported === "Yes") && !isMonthly) {
      buttons.push(createBtn(
        'Online Patch/Bypass',
        'patch',
        async () => {
          console.log('🎮 Online Patch clicked for appid:', game.appid);
          console.log('🎮 Calling installPatch function...');
          closePopover();

          try {
            // installPatch expects a button element, so we need to handle this differently
            // Call the API directly instead
            startTopProgress();
            const working = showToast("Installing patch…", {
              title: "Patching",
              type: "info",
              duration: 0
            });

            const res = await fetch(`/api/download_patch/${game.appid}`, { method: 'POST' });
            const data = await res.json().catch(() => ({}));

            finishTopProgress();
            working.close();

            if (!res.ok || !data.success) {
              showToast(data.message || 'Patch install failed', {
                title: "Patch Failed",
                type: "error",
                duration: 9000
              });
            } else {
              // Extract game directory from response
              const gameDir = data.game_dir;

              showToast(data.message || 'Patch installed', {
                title: "Patch Installed",
                type: "success",
                duration: 10000,
                buttons: [
                  {
                    text: '📁 Open Folder',
                    onClick: async () => {
                      try {
                        // Send the actual game path from patch response
                        await fetch(`/api/open_folder`, {
                          method: 'POST',
                          headers: { 'Content-Type': 'application/json' },
                          body: JSON.stringify({ path: gameDir })
                        });
                      } catch (e) {
                        console.error('Failed to open folder:', e);
                      }
                    }
                  }
                ]
              });
            }
          } catch (e) {
            finishTopProgress();
            if (working) working.close();
            showToast('Network error while installing patch: ' + e.message, {
              title: "Error",
              type: "error",
              duration: 9000
            });
          }
        }
      ));
    }

    // 7. Install to Steam - Add BEFORE Remove Game
    if (game.installed) {
      buttons.push(createBtn(
        'Install to Steam',
        'standalone',
        async () => {
          try {
            if (window.pywebview?.api?.install_steam) {
              await window.pywebview.api.install_steam(String(game.appid));
            } else {
              window.location.href = `steam://install/${game.appid}`;
            }
            closePopover();
          } catch (err) { console.error(err); }
        }
      ));
    }

    // 8. Remove Game
    if (game.installed) {
      buttons.push(createBtn(
        'Remove Game',
        'danger',
        async () => {
          // Close popover FIRST, then show confirmation modal
          closePopover();

          // Use custom modal instead of browser confirm
          const confirmed = await window.__modalKit.confirmModal({
            title: 'Remove Game?',
            message: `This will remove ${game.name} from your system.`,
            okText: 'Remove',
            cancelText: 'Cancel'
          });

          if (!confirmed) return;

          removeGame(game.appid);
        }
      ));
    }

    // === ADVANCED USER ONLY SECTION ===
    if (game.installed) {
      const isLauncherInstalled = !!(launcherStatus && launcherStatus.installed);
      const hasAdvancedOptions = true; // Always show Download Standalone if installed
      const isUnsteamInstalled2 = !!(launcherStatus && launcherStatus.installed);
      const isColdClientInstalled2 = !!(launcherStatus && launcherStatus.coldclient_installed);
      const neitherInstalled = !isUnsteamInstalled2 && !isColdClientInstalled2;

      if (hasAdvancedOptions || neitherInstalled) {
        // Add section header
        buttons.push(createSectionHeader('⚠️ ADVANCED USER ONLY'));

        // Download Standalone (using depot downloader)
        buttons.push(createBtn(
          'Download Standalone',
          'standalone',
          async () => {
            closePopover();
            await triggerDepotDownload(game);
          }
        ));

        // Universal Online Patch (only if neither installed; warn if coldclient present)
        if (neitherInstalled || isUnsteamInstalled2) {
          buttons.push(createBtn(
            'Universal Online Patch',
            'patch',
            async () => {
              closePopover();

              if (isColdClientInstalled2) {
                await window.__modalKit.infoModal({
                  title: 'Conflict',
                  message: 'Please remove Patch Standalone first before using Universal Online Patch.'
                });
                return;
              }

              const confirmed = await window.__modalKit.confirmModal({
                title: 'Patch with Universal Online Patch?',
                message: 'This will install Universal Online Patch to run the game standalone.',
                okText: 'Install',
                cancelText: 'Cancel'
              });

              if (!confirmed) return;

              try {
                await SteamAPI.getAppInfo(game.appid).catch(() => {});
                let r = await fetch(`/api/launcher/patch/${encodeURIComponent(game.appid)}`, {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({ steamless: true })
                });
                if (r.status === 404) {
                  r = await fetch(`/api/install_launcher/${encodeURIComponent(game.appid)}`, { method: 'POST' });
                }
                const j = await r.json().catch(()=>({}));
                if (!r.ok || j.success !== true) {
                  throw new Error((j && (j.message || j.install?.message)) || 'Unknown error.');
                }

                await window.__modalKit.infoModal({
                  title: 'Success',
                  message: 'Universal Online Patch installed successfully!'
                });

                const _ugmModal = document.getElementById('unified-game-modal');
                const _ugmActions = document.getElementById('ugm-actions');
                if (_ugmModal && _ugmModal.style.display !== 'none' && _ugmActions && window.__buildGameActionButtons) {
                  try {
                    const _freshRes = await fetch('/api/launcher_status/' + game.appid);
                    const _freshStatus = await _freshRes.json().catch(() => ({}));
                    _ugmActions.innerHTML = '';
                    const _ugmPrimary = document.getElementById('ugm-primary-actions');
                    if (_ugmPrimary) _ugmPrimary.innerHTML = '';
                    window.__buildGameActionButtons(game, _freshStatus, _ugmActions, _ugmPrimary || undefined);
                    _ugmActions.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                    if (_ugmPrimary) _ugmPrimary.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                  } catch(e) { console.error('UGM refresh error:', e); }
                }
                await fetchGamesFreshAndRender({ resetPage: false });
              } catch (e) {
                await window.__modalKit.infoModal({
                  title: 'Error',
                  message: 'Failed to install Universal Online Patch:\n' + (e.message || e)
                });
              }
            }
          ));
        }

        // Patch Standalone (only if neither installed; warn if unsteam present)
        if (neitherInstalled || isColdClientInstalled2) {
          buttons.push(createBtn(
            'Patch Standalone',
            'patch',
            async () => {
              closePopover();

              if (isUnsteamInstalled2) {
                await window.__modalKit.infoModal({
                  title: 'Conflict',
                  message: 'Please remove Universal Online Patch first before using Patch Standalone.'
                });
                return;
              }

              const confirmed = await window.__modalKit.confirmModal({
                title: 'Patch Standalone?',
                message: 'This will copy ColdClientLoader files to the game folder and create ColdClientLoader.ini.',
                okText: 'Install',
                cancelText: 'Cancel'
              });

              if (!confirmed) return;

              try {
                const r = await fetch(`/api/install_coldclient/${encodeURIComponent(game.appid)}`, { method: 'POST' });
                const j = await r.json().catch(()=>({}));
                if (!r.ok || j.success !== true) {
                  throw new Error((j && j.message) || 'Unknown error.');
                }

                await window.__modalKit.infoModal({
                  title: 'Success',
                  message: 'Patch Standalone installed successfully!'
                });

                const _ugmModal = document.getElementById('unified-game-modal');
                const _ugmActions = document.getElementById('ugm-actions');
                if (_ugmModal && _ugmModal.style.display !== 'none' && _ugmActions && window.__buildGameActionButtons) {
                  try {
                    const _freshRes = await fetch('/api/launcher_status/' + game.appid);
                    const _freshStatus = await _freshRes.json().catch(() => ({}));
                    _ugmActions.innerHTML = '';
                    const _ugmPrimary = document.getElementById('ugm-primary-actions');
                    if (_ugmPrimary) _ugmPrimary.innerHTML = '';
                    window.__buildGameActionButtons(game, _freshStatus, _ugmActions, _ugmPrimary || undefined);
                    _ugmActions.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                    if (_ugmPrimary) _ugmPrimary.querySelectorAll('.game-action-btn.details').forEach(b => b.remove());
                  } catch(e) { console.error('UGM refresh error:', e); }
                }
                await fetchGamesFreshAndRender({ resetPage: false });
              } catch (e) {
                await window.__modalKit.infoModal({
                  title: 'Error',
                  message: 'Failed to install Patch Standalone:\n' + (e.message || e)
                });
              }
            }
          ));
        }

        // Steamless [Remove Steam DRM]
        buttons.push(createBtn(
          'Steamless [Remove DRM]',
          'patch',
          async () => {
            closePopover();

            const confirmed = await window.__modalKit.confirmModal({
              title: 'Remove Steam DRM?',
              message: `This will unpack protected EXE files for ${game.name}.\n\nOriginal files will be backed up as .BAK`,
              okText: 'Run Steamless',
              cancelText: 'Cancel'
            });

            if (!confirmed) return;

            await runSteamless(game.appid);
          }
        ));
      }
    }

    function renderButtons() {
      buttonsDiv.innerHTML = '';
      buttons.forEach(btn => buttonsDiv.appendChild(btn));
    }

    renderButtons();

    // Check Steam status asynchronously and update button if needed
    (async () => {
      if (game.installed) {
        const st = await fetchAcfStatus(String(game.appid));
        if (st?.status === 'installed') {
          // Find and replace "Install to Steam" with "Play on Steam"
          const installIndex = buttons.findIndex(btn =>
            btn.textContent === 'Install to Steam'
          );

          if (installIndex !== -1) {
            // Replace with Play on Steam
            buttons[installIndex] = createBtn(
              'Play on Steam',
              'play',
              async () => {
                try {
                  if (window.pywebview?.api?.launch_steam) {
                    await window.pywebview.api.launch_steam(String(game.appid));
                  } else {
                    window.location.href = `steam://rungameid/${game.appid}`;
                  }
                  closePopover();
                } catch (err) { console.error(err); }
              }
            );
            renderButtons();
          }
        }
      }
    })();

    // Position popover to the RIGHT of card
    if (cardRect) {
      // Use the rect we captured BEFORE overflow:hidden was applied
      const rect = cardRect;
      const popoverWidth = 260;
      const popoverHeight = (buttons.length * 45) + 20; // Estimate

      // Position to the right of card
      let left = rect.right + 12; // 12px gap from card
      let top = rect.top + 10; // Near top of card

      // DEBUG: Log positioning
      console.log('🎯 Card rect:', { left: rect.left, right: rect.right, top: rect.top, bottom: rect.bottom });
      console.log('🎯 Popover will be at:', { left, top });

      // Arrow position
      let arrowTop = 30;

      // Keep in viewport
      const margin = 10;
      if (left + popoverWidth > window.innerWidth - margin) {
        // If too far right, show on left side
        left = rect.left - popoverWidth - 12;
        console.log('🎯 Flipped to left side:', left);
        // Flip arrow to point right
        arrow.style.left = 'auto';
        arrow.style.right = '-8px';
        arrow.style.borderRight = 'none';
        arrow.style.borderLeft = '8px solid #1e2330';
      } else {
        arrow.style.left = '-8px';
        arrow.style.right = 'auto';
        arrow.style.borderLeft = 'none';
        arrow.style.borderRight = '8px solid #1e2330';
      }

      if (top < margin) top = margin;
      if (top + popoverHeight > window.innerHeight - margin) {
        top = window.innerHeight - popoverHeight - margin;
      }

      console.log('🎯 Final position:', { left, top });

      // Adjust arrow based on final position
      arrowTop = Math.max(10, Math.min(rect.top + (rect.height / 2) - top, popoverHeight - 25));
      arrow.style.top = arrowTop + 'px';

      // CRITICAL: Position the POPOVER (fixed), and reset container to 0,0
      popover.style.left = left + 'px';
      popover.style.top = top + 'px';
      container.style.left = '0';
      container.style.top = '0';

      console.log('🎯 Applied styles - popover:', popover.style.left, popover.style.top);
      console.log('🎯 Applied styles - container:', container.style.left, container.style.top);
    }

    // Show popover
    popover.classList.add('show');
    popover.style.display = 'block';
  };

  function createBtn(text, type, onClick) {
    const btn = document.createElement('button');
    btn.className = `popover-btn ${type}`;
    btn.textContent = text;
    btn.onclick = onClick;
    return btn;
  }

  function createSectionHeader(text) {
    const header = document.createElement('div');
    header.style.cssText = `
      padding: 8px 4px 4px 4px;
      font-size: 11px;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.5px;
      color: #ff6b35;
      border-top: 1px solid rgba(255,255,255,0.1);
      margin-top: 4px;
    `;
    header.textContent = text;
    return header;
  }

  function closePopover() {
    const popover = document.getElementById('actions-popover');
    const container = document.getElementById('popover-container');
    container.classList.add('closing');

    // Remove blur and active card class
    document.body.classList.remove('popover-open');
    document.querySelectorAll('.card.active-card').forEach(c => c.classList.remove('active-card'));

    // Remove scroll prevention event listeners
    console.log('🔓 Removing scroll lock...');
    if (window.__scrollPreventHandlers) {
      console.log('🔓 Handlers found:', window.__scrollPreventHandlers);
      const { preventScroll, preventKeyScroll } = window.__scrollPreventHandlers;

      if (preventScroll) {
        window.removeEventListener('wheel', preventScroll, { passive: false });
        window.removeEventListener('touchmove', preventScroll, { passive: false });
        console.log('🔓 Wheel/touch listeners removed');
      }

      if (preventKeyScroll) {
        window.removeEventListener('keydown', preventKeyScroll, false);
        console.log('🔓 Keyboard listener removed');
      }

      console.log('🔓 Scroll lock removed!');
      delete window.__scrollPreventHandlers;
      console.log('🔓 Handlers deleted from window');
    } else {
      console.log('⚠️ No handlers found!');
    }

    setTimeout(() => {
      popover.classList.remove('show');
      popover.style.display = 'none';
      container.classList.remove('closing');
      console.log('🔓 Popover hidden');
    }, 200);
  }

  // Click backdrop to close
  document.getElementById('popover-backdrop')?.addEventListener('click', closePopover);

  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('actions-popover')?.classList.contains('show')) {
      closePopover();
    }
  });
})();


    // Clear previous buttons
    container.innerHTML = '';

    // Build buttons
    const buttons = [];

    const isMonthly =
      document.body.getAttribute('data-license') === 'monthly' ||
      ((window.activationType || '').toUpperCase() === 'MONTHLY') ||
      ((localStorage.getItem('key_type') || '').toUpperCase() === 'MONTHLY');

    // 1. Download/Update
    buttons.push(createBtn(
      game.installed ? 'Update Game' : 'Unlock Game',
      game.installed ? 'update' : 'primary',
      () => { closeFanout(); downloadGame(game.appid); }
    ));

    // 2. Download Standalone (if installed)
    if (game.installed) {
      buttons.push(createBtn(
        'Download Standalone',
        'standalone',
        () => {
          closeFanout();
          alert('Download Standalone - connect this to your depot download system');
        }
      ));
    }

    // 3. Standalone Unsteam Actions
    if (game.installed) {
      const isUnsteamInstalled = !!(launcherStatus && launcherStatus.installed);
      const isColdClientInstalled = !!(launcherStatus && launcherStatus.coldclient_installed);

      if (isUnsteamInstalled) {
        // Play (Universal Online Patch)
        buttons.push(createBtn(
          '▶ Play (Online Patch)',
          'play',
          async () => {
            try {
              const r = await fetch(`/api/launch_onennabe/${game.appid}`, { method: 'POST' });
              const j = await r.json().catch(() => ({}));
              if (!r.ok || !j.success) alert(`Failed to launch:\n${(j && j.message) || r.statusText}`);
              closeFanout();
            } catch (e) {
              alert('Launch error: ' + (e.message || e));
            }
          }
        ));

        // Remove Universal Online Patch
        buttons.push(createBtn(
          'Remove Online Patch',
          'danger',
          async () => {
            if (!confirm('Remove Universal Online Patch files?')) return;
            try {
              const res = await fetch(`/api/uninstall_launcher/${game.appid}`, { method: 'POST' });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.success) {
                alert(`Failed:\n${(data && data.message) || res.statusText}`);
                return;
              }
              if (window.__modalKit) { await window.__modalKit.infoModal({ title: 'Success', message: 'Universal Online Patch removed successfully.' }); } else { alert('Universal Online Patch removed.'); }
              closeFanout();
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              alert('Error: ' + (e.message || e));
            }
          }
        ));

        // Patch Standalone conflict warning
        buttons.push(createBtn(
          'Patch Standalone',
          'patch',
          async () => {
            if (window.__modalKit) { await window.__modalKit.infoModal({ title: 'Conflict', message: 'Please remove Universal Online Patch first before using Patch Standalone.' }); } else { alert('Please remove Universal Online Patch first before using Patch Standalone.'); }
          }
        ));

      } else if (isColdClientInstalled) {
        // Play Bypass Steam
        buttons.push(createBtn(
          '▶ Play (Bypass Steam)',
          'play',
          async () => {
            try {
              const r = await fetch(`/api/launch_coldclient/${game.appid}`, { method: 'POST' });
              const j = await r.json().catch(() => ({}));
              if (!r.ok || !j.success) alert(`Failed to launch:\n${(j && j.message) || r.statusText}`);
              closeFanout();
            } catch (e) {
              alert('Launch error: ' + (e.message || e));
            }
          }
        ));

        // Remove Patch Standalone
        buttons.push(createBtn(
          'Remove Patch Standalone',
          'danger',
          async () => {
            if (!confirm('Remove Patch Standalone files?')) return;
            try {
              const res = await fetch(`/api/uninstall_coldclient/${game.appid}`, { method: 'POST' });
              const data = await res.json().catch(() => ({}));
              if (!res.ok || !data.success) {
                alert(`Failed:\n${(data && data.message) || res.statusText}`);
                return;
              }
              if (window.__modalKit) { await window.__modalKit.infoModal({ title: 'Success', message: 'Patch Standalone removed successfully.' }); } else { alert('Patch Standalone removed.'); }
              closeFanout();
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              alert('Error: ' + (e.message || e));
            }
          }
        ));

        // Universal Online Patch conflict warning
        buttons.push(createBtn(
          'Universal Online Patch',
          'patch',
          async () => {
            if (window.__modalKit) { await window.__modalKit.infoModal({ title: 'Conflict', message: 'Please remove Patch Standalone first before using Universal Online Patch.' }); } else { alert('Please remove Patch Standalone first before using Universal Online Patch.'); }
          }
        ));

      } else {
        // Attempt Universal Online Patch
        buttons.push(createBtn(
          'Universal Online Patch',
          'patch',
          async () => {
            if (!confirm('Patch with Universal Online Patch?')) return;
            try {
              await SteamAPI.getAppInfo(game.appid).catch(() => {});
              let r = await fetch(`/api/launcher/patch/${encodeURIComponent(game.appid)}`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ steamless: true })
              });
              if (r.status === 404) {
                r = await fetch(`/api/install_launcher/${encodeURIComponent(game.appid)}`, { method: 'POST' });
              }
              const j = await r.json().catch(()=>({}));
              if (!r.ok || j.success !== true) {
                throw new Error((j && (j.message || j.install?.message)) || 'Unknown error.');
              }
              alert('Universal Online Patch installed successfully!');
              closeFanout();
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              alert('Failed:\n' + (e.message || e));
            }
          }
        ));

        // Patch Standalone button
        buttons.push(createBtn(
          'Patch Standalone',
          'patch',
          async () => {
            if (!confirm('Patch Standalone? This will copy ColdClientLoader files to the game folder and create ColdClientLoader.ini.')) return;
            try {
              const r = await fetch(`/api/install_coldclient/${encodeURIComponent(game.appid)}`, { method: 'POST' });
              const j = await r.json().catch(()=>({}));
              if (!r.ok || j.success !== true) {
                throw new Error((j && j.message) || 'Unknown error.');
              }
              alert('Patch Standalone installed. Use "Play (Bypass Steam)" to launch.');
              closeFanout();
              await fetchGamesFreshAndRender({ resetPage: false });
            } catch (e) {
              alert('Failed:\n' + (e.message || e));
            }
          }
        ));
      }
    }

    // 4. Steam Actions
    (async () => {
      const st = await fetchAcfStatus(String(game.appid));
      if (st?.status === 'installed') {
        buttons.push(createBtn(
          'Play on Steam',
          'play',
          async () => {
            try {
              if (window.pywebview?.api?.launch_steam) {
                await window.pywebview.api.launch_steam(String(game.appid));
              } else {
                window.location.href = `steam://rungameid/${game.appid}`;
              }
              closeFanout();
            } catch (err) { console.error(err); }
          }
        ));
      } else if (game.installed) {
        buttons.push(createBtn(
          'Install to Steam',
          'standalone',
          async () => {
            try {
              if (window.pywebview?.api?.install_steam) {
                await window.pywebview.api.install_steam(String(game.appid));
              } else {
                window.location.href = `steam://install/${game.appid}`;
              }
              closeFanout();
            } catch (err) { console.error(err); }
          }
        ));
      }
      renderButtons();
    })();

    // 5. Online Patch/Bypass
    if ((game.online_supported === "Yes" || game.bypass_supported === "Yes") && !isMonthly) {
      buttons.push(createBtn(
        'Online Patch/Bypass',
        'patch',
        () => { closeFanout(); installPatch(game.appid); }
      ));
    }

    // 6. Remove Game (renumbered)
    if (game.installed) {
      buttons.push(createBtn(
        'Remove Game',
        'danger',
        () => {
          if (!confirm(`Remove ${game.name}?`)) return;
          closeFanout();
          removeGame(game.appid);
        }
      ));
    }

    function renderButtons() {
      container.innerHTML = '';
      buttons.forEach(btn => container.appendChild(btn));
    }

    renderButtons();

    // Position menu
    if (clickEvent && clickEvent.target) {
      const card = clickEvent.target.closest('.card');
      if (card) {
        const rect = card.getBoundingClientRect();
        const menuWidth = 220;
        let left = rect.left + (rect.width / 2) - (menuWidth / 2);
        let top = rect.top - 20;

        // Keep in viewport
        if (left < 10) left = 10;
        if (left + menuWidth > window.innerWidth - 10) left = window.innerWidth - menuWidth - 10;
        if (top < 10) top = rect.bottom + 10;

        container.style.left = left + 'px';
        container.style.top = top + 'px';
      }
    }

    // Show menu
    menu.classList.add('show');
    menu.style.display = 'block';

  function createBtn(text, type, onClick) {
    const btn = document.createElement('button');
    btn.className = `fanout-btn ${type}`;
    btn.textContent = text;
    btn.onclick = onClick;
    return btn;
  }

  function closeFanout() {
    const fanout = document.querySelector('.actions-popover');
    if (fanout) fanout.remove();
  }

  function closeFanout() {
    const menu = document.getElementById('fanout-menu');
    const container = document.getElementById('fanout-container');
    container.classList.add('closing');
    setTimeout(() => {
      menu.classList.remove('show');
      menu.style.display = 'none';
      container.classList.remove('closing');
    }, 250);
  }

  // Click backdrop to close
  document.getElementById('fanout-backdrop')?.addEventListener('click', closeFanout);

  // ESC to close
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape' && document.getElementById('fanout-menu').classList.contains('show')) {
      closeFanout();
    }
  });

// ====================================================================================
// Game Installation Drive Badges
// ====================================================================================

// Function to check and display installation drive for all visible games
window.updateGameInstallationBadges = async function() {
  try {
    // Get all game cards
    const cards = document.querySelectorAll('.card[data-appid]');
    if (!cards.length) {
      console.log('No cards with data-appid found');
      return;
    }

    console.log(`Found ${cards.length} game cards`);

    // Collect all appids
    const appids = Array.from(cards).map(card => card.getAttribute('data-appid')).filter(Boolean);

    if (!appids.length) {
      console.log('No appids found');
      return;
    }

    console.log('Checking installation for appids:', appids);

    // Fetch installation status for all games in bulk
    const response = await fetch('/api/game_install_locations_bulk', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ appids: appids }),
      cache: 'no-store'
    });

    if (!response.ok) {
      console.error('API request failed:', response.status, response.statusText);
      return;
    }

    const data = await response.json();
    console.log('API response:', data);

    if (!data.success || !data.data) {
      console.error('Invalid API response:', data);
      return;
    }

    // Count installed games
    let installedCount = 0;

    // Update each card with installation badge
    cards.forEach(card => {
      const appid = card.getAttribute('data-appid');
      const info = data.data[appid];

      if (!info) return;

      // Remove existing badge if any
      const existingBadge = card.querySelector('.install-drive-badge');
      if (existingBadge) existingBadge.remove();

      if (info.installed && info.drive) {
        installedCount++;

        // Create installation drive badge
        const badge = document.createElement('div');
        badge.className = 'install-drive-badge';
        badge.style.cssText = `
          position: absolute;
          top: 8px;
          left: 8px;
          z-index: 10;
          padding: 4px 10px;
          background: linear-gradient(135deg, rgba(76, 175, 80, 0.95) 0%, rgba(56, 142, 60, 0.95) 100%);
          color: #fff;
          font-size: 11px;
          font-weight: 700;
          border-radius: 4px;
          box-shadow: 0 2px 8px rgba(0, 0, 0, 0.3);
          display: flex;
          align-items: center;
          gap: 4px;
          letter-spacing: 0.3px;
          backdrop-filter: blur(4px);
        `;

        badge.innerHTML = `<span>💾</span><span>${info.drive}</span>`;
        badge.title = `Installed on ${info.library_path || info.drive}`;

        // Try multiple selectors for badge placement
        let badgeContainer = card.querySelector('.card-image');

        if (!badgeContainer) {
          // Try alternative selectors
          badgeContainer = card.querySelector('img')?.parentElement;
        }

        if (!badgeContainer) {
          // Last resort - use the card itself
          badgeContainer = card;
        }

        // Make sure container has position: relative
        const currentPosition = window.getComputedStyle(badgeContainer).position;
        if (currentPosition === 'static' || !currentPosition) {
          badgeContainer.style.position = 'relative';
        }

        // Add badge
        badgeContainer.appendChild(badge);

        console.log(`Added badge to AppID ${appid} (${info.drive})`);
      }
    });

    console.log(`✅ Badges added: ${installedCount} out of ${appids.length} games installed`);

  } catch (error) {
    console.error('Failed to update installation badges:', error);
  }
};

// ====================================================================================
// Better initialization - with debugging
// ====================================================================================

console.log('Installation badge system initializing...');

// Call on page load
if (document.readyState === 'loading') {
  console.log('Waiting for DOM to load...');
  document.addEventListener('DOMContentLoaded', () => {
    console.log('DOM loaded, updating badges in 1 second...');
    setTimeout(() => {
      console.log('Running first badge update...');
      window.updateGameInstallationBadges();
    }, 1000);
  });
} else {
  // DOM already loaded
  console.log('DOM already loaded, updating badges in 1 second...');
  setTimeout(() => {
    console.log('Running first badge update...');
    window.updateGameInstallationBadges();
  }, 1000);
}

// Refresh badges periodically (every 30 seconds)
setInterval(() => {
  console.log('Periodic badge refresh...');
  window.updateGameInstallationBadges();
}, 30000);

// ====================================================================================
// Test function - Run this in console to debug
// ====================================================================================

window.testDriveBadges = function() {
  console.log('=== DRIVE BADGE DEBUG TEST ===');

  // 1. Check function exists
  console.log('1. Function exists:', typeof window.updateGameInstallationBadges === 'function');

  // 2. Check cards
  const cards = document.querySelectorAll('.card[data-appid]');
  console.log('2. Cards found:', cards.length);

  if (cards.length === 0) {
    console.error('❌ No cards with data-appid attribute found!');
    console.log('Check HTML structure. Cards should have: <div class="card" data-appid="123456">');
    return;
  }

  // 3. Check first card structure
  if (cards[0]) {
    console.log('3. First card structure:');
    console.log('   - Has .card-image:', !!cards[0].querySelector('.card-image'));
    console.log('   - Has img:', !!cards[0].querySelector('img'));
    console.log('   - Card HTML:', cards[0].outerHTML.substring(0, 200) + '...');
  }

  // 4. Check appids
  const appids = Array.from(cards).map(c => c.getAttribute('data-appid')).filter(Boolean);
  console.log('4. AppIDs found:', appids.slice(0, 5), '...', `(${appids.length} total)`);

  // 5. Test API
  console.log('5. Testing API...');
  fetch('/api/game_install_locations_bulk', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ appids: appids.slice(0, 3) })
  })
  .then(r => {
    console.log('   API status:', r.status, r.statusText);
    return r.json();
  })
  .then(data => {
    console.log('   API response:', data);
    if (data.success && data.data) {
      Object.entries(data.data).forEach(([appid, info]) => {
        console.log(`   - AppID ${appid}:`, info.installed ? `✅ ${info.drive} (${info.library_path})` : '❌ Not installed');
      });
    }
  })
  .catch(err => {
    console.error('   ❌ API Error:', err);
    console.log('   Make sure backend endpoints are added!');
  });

  // 6. Try to run badge update
  console.log('6. Running badge update...');
  window.updateGameInstallationBadges();

  // 7. Check if badges appeared
  setTimeout(() => {
    const badges = document.querySelectorAll('.install-drive-badge');
    console.log('7. Badges created:', badges.length);
    if (badges.length === 0) {
      console.error('❌ No badges created!');
      console.log('Possible issues:');
      console.log('   - API endpoint not returning data');
      console.log('   - No games installed');
      console.log('   - Card structure incompatible');
    } else {
      console.log('✅ Badges working!');
    }
    console.log('=== END DEBUG TEST ===');
  }, 2000);
};

// ==================== DENUVO WARNING SYSTEM ====================

// Stores the callback to run when user clicks Proceed
window.denuvoOnProceed = null;

// Find game by AppID
function findGameByAppId(appid) {
  if (typeof allGames !== 'undefined') {
    return allGames.find(g => g.appid == appid || g.appid === String(appid));
  }
  return null;
}

// Check if a game requires membership/borrowed account (Denuvo)
function needsMembership(value) {
  if (value === true || value === 1) return true;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    return v === 'true' || v === '1' || v === 'yes';
  }
  return false;
}

// Hide Denuvo modal
function hideDenuvoModal() {
  const modal = document.getElementById('denuvo-warning-modal');
  if (modal) {
    modal.style.display = 'none';
    modal.classList.remove('show');
  }
  document.body.classList.remove('modal-open');
  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) backdrop.style.display = 'none';
  window.denuvoOnProceed = null;
  console.log('🔒 Denuvo modal hidden');
}

// Show Denuvo warning modal — accepts a callback for what to do when user proceeds
function showDenuvoWarning(game, onProceed) {
  const modal = document.getElementById('denuvo-warning-modal');
  if (!modal) {
    console.warn('Denuvo warning modal not found, running action directly');
    if (onProceed) onProceed();
    return;
  }

  console.log('🎮 Showing Denuvo warning for:', game.name);

  // Update game name
  const gameNameEl = document.getElementById('denuvo-warning-game-name');
  if (gameNameEl) gameNameEl.textContent = game.name || 'Unknown Game';

  // Update cover image
  const coverImg = document.getElementById('denuvo-warning-cover');
  if (coverImg && game.cover) {
    coverImg.src = game.cover;
    coverImg.style.display = 'block';
  } else if (coverImg) {
    coverImg.style.display = 'none';
  }

  // Update tags
  const tagsContainer = document.getElementById('denuvo-warning-tags');
  if (tagsContainer) {
    tagsContainer.innerHTML =
      '<span class="tag" style="background: linear-gradient(135deg, #ff6b6b 0%, #ee5a6f 100%); color: white; padding: 8px 16px; border-radius: 20px; font-weight: bold;">⚠️ Denuvo Protected</span>';
  }

  // Store the callback — this is what runs when user clicks Proceed
  window.denuvoOnProceed = onProceed || null;

  // Setup buttons fresh every time
  setupDenuvoModalButtons();

  // Show modal with backdrop
  modal.style.display = 'flex';
  modal.style.zIndex = '20000';
  modal.classList.add('show');
  document.body.classList.add('modal-open');
  const backdrop = document.getElementById('modal-backdrop');
  if (backdrop) { backdrop.style.display = 'block'; backdrop.style.zIndex = '19999'; }

  console.log('✅ Denuvo warning modal shown for:', game.name);
}

// Setup button handlers — called every time modal shows
function setupDenuvoModalButtons() {
  const modal = document.getElementById('denuvo-warning-modal');
  if (!modal) return;

  const cancelBtn = document.getElementById('denuvo-warning-cancel');
  const proceedBtn = document.getElementById('denuvo-warning-proceed');
  if (!cancelBtn || !proceedBtn) {
    console.error('❌ Denuvo modal buttons not found!');
    return;
  }

  // Clone to remove all old listeners
  const newCancelBtn = cancelBtn.cloneNode(true);
  const newProceedBtn = proceedBtn.cloneNode(true);
  cancelBtn.parentNode.replaceChild(newCancelBtn, cancelBtn);
  proceedBtn.parentNode.replaceChild(newProceedBtn, proceedBtn);

  newCancelBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    console.log('❌ User cancelled');
    hideDenuvoModal();
  });

  newProceedBtn.addEventListener('click', function(e) {
    e.preventDefault();
    e.stopPropagation();
    console.log('✅ User proceeded');
    const callback = window.denuvoOnProceed;
    hideDenuvoModal();
    if (callback) {
      callback();
    } else {
      console.error('❌ No proceed callback stored!');
    }
  });

  console.log('🔧 Denuvo modal buttons set up');
}

// Your original download function (the actual download logic)
async function actuallyDownloadGame(appid) {
  try {
    showModal('loading-modal');
    const res = await fetch(`/download/${appid}`);
    hideModal('loading-modal');
    if (res.ok) {
      await registerGameToServer(appid);
      await registerGameDownload(appid);
      await loadCartFromServer();
      console.log('🛒 Reloaded cart after download');
      showModal('download-complete-modal');
      setTimeout(() => {
        hideModal('download-complete-modal');
        promptRestartSteam();
      }, 2000);
      await fetchGames();
    } else {
      alert("Download failed for appid " + appid);
    }
  } catch (e) {
    hideModal('loading-modal');
    alert("Download error: " + e.message);
  }
}

console.log('🎮 Denuvo warning system loaded');

// ============================================================================
// TRAILER HOVER PREVIEW (with Flask-side debug logging)
// ============================================================================

function tpLog(msg) {
  fetch('/api/tp_log?msg=' + encodeURIComponent(msg)).catch(() => {});
}

tpLog('script-start: TrailerPreview code reached');

window.TrailerPreview = (() => {
  const _cache = {};
  let _popup = null;
  let _video = null;
  let _currentAppid = null;

  function _ensurePopup() {
    if (_popup) return;
    tpLog('creating popup element');
    _popup = document.createElement('div');
    _popup.id = 'trailer-preview-popup';
    _popup.style.cssText = 'position:fixed;z-index:99998;display:none;width:420px;background:#0e1621;border:1px solid rgba(102,192,244,0.3);border-radius:10px;overflow:hidden;box-shadow:0 12px 40px rgba(0,0,0,0.7);pointer-events:none;';

    const title = document.createElement('div');
    title.id = 'tp-title';
    title.style.cssText = 'padding:8px 12px;font-size:12px;font-weight:600;color:#66C0F4;background:rgba(102,192,244,0.08);border-bottom:1px solid rgba(102,192,244,0.15);white-space:nowrap;overflow:hidden;text-overflow:ellipsis;';

    _video = document.createElement('video');
    _video.style.cssText = 'width:100%;display:block;background:#000;min-height:236px;';
    _video.muted = true;
    _video.loop = true;
    _video.playsInline = true;
    _video.setAttribute('muted', '');

    const spinner = document.createElement('div');
    spinner.id = 'tp-spinner';
    spinner.style.cssText = 'position:absolute;top:50%;left:50%;transform:translate(-50%,-50%);width:32px;height:32px;border:3px solid rgba(102,192,244,0.2);border-top-color:#66C0F4;border-radius:50%;animation:tpSpin .8s linear infinite;';
    const s = document.createElement('style');
    s.textContent = '@keyframes tpSpin{to{transform:translate(-50%,-50%) rotate(360deg)}}';
    document.head.appendChild(s);

    const wrap = document.createElement('div');
    wrap.style.cssText = 'position:relative;';
    wrap.appendChild(_video);
    wrap.appendChild(spinner);

    _video.onplaying = () => { tpLog('video playing!'); spinner.style.display = 'none'; };
    _video.onwaiting = () => { spinner.style.display = 'block'; };
    _video.onerror = () => {
      tpLog('video error for src: ' + (_video.src || 'none'));
      const cached = _currentAppid ? _cache[_currentAppid] : null;
      if (cached && cached._urls && cached._urlIdx < cached._urls.length) {
        const next = cached._urls[cached._urlIdx++];
        tpLog('trying fallback: ' + next);
        _video.src = '/api/video_proxy?url=' + encodeURIComponent(next);
        _video.play().catch(() => {});
      } else {
        spinner.style.display = 'none';
        title.textContent = '\uD83C\uDFAC Trailer unavailable';
      }
    };

    _popup.appendChild(title);
    _popup.appendChild(wrap);
    document.body.appendChild(_popup);
    tpLog('popup appended to body');
  }

  function _position(cardEl) {
    if (!_popup) return;
    const r = cardEl.getBoundingClientRect();
    const pw = 420, vw = window.innerWidth, vh = window.innerHeight;
    let left = r.right + 12, top = r.top;
    if (left + pw > vw - 10) left = r.left - pw - 12;
    if (left < 10) left = 10;
    const ph = _popup.offsetHeight || 300;
    if (top + ph > vh - 10) top = vh - ph - 10;
    if (top < 10) top = 10;
    _popup.style.left = left + 'px';
    _popup.style.top = top + 'px';
  }

  async function _getTrailer(appid) {
    if (_cache.hasOwnProperty(appid)) { tpLog('cache hit for ' + appid); return _cache[appid]; }
    tpLog('fetching /api/steamstore/' + appid);
    try {
      const res = await fetch('/api/steamstore/' + appid + '?cc=my&l=en');
      tpLog('steamstore response: ' + res.status);
      if (!res.ok) { _cache[appid] = null; return null; }
      const data = await res.json();
      const game = data[String(appid)] && data[String(appid)].data;
      if (!game || !game.movies || !game.movies.length) {
        tpLog('no movies for ' + appid);
        _cache[appid] = null;
        return null;
      }
      const m = game.movies[0];
      tpLog('movie id=' + m.id + ' keys=' + Object.keys(m).join(','));
      const urls = [];
      if (m.mp4) { if (m.mp4.max) urls.push(m.mp4.max); if (m.mp4['480']) urls.push(m.mp4['480']); }
      if (m.webm) { if (m.webm.max) urls.push(m.webm.max); if (m.webm['480']) urls.push(m.webm['480']); }
      if (m.id) {
        urls.push('https://cdn.akamai.steamstatic.com/steam/apps/' + m.id + '/movie480.mp4');
        urls.push('https://cdn.akamai.steamstatic.com/steam/apps/' + m.id + '/movie480_vp9.webm');
        urls.push('https://cdn.akamai.steamstatic.com/steam/apps/' + m.id + '/movie_max.mp4');
        urls.push('https://cdn.akamai.steamstatic.com/steam/apps/' + m.id + '/movie_max_vp9.webm');
      }
      var unique = urls.filter(function(v, i, a) { return a.indexOf(v) === i; });
      tpLog('urls: ' + JSON.stringify(unique));
      if (!unique.length) { _cache[appid] = null; return null; }
      var result = { _urls: unique, _urlIdx: 1, videoUrl: unique[0] };
      _cache[appid] = result;
      return result;
    } catch (e) {
      tpLog('fetch error: ' + e.message);
      _cache[appid] = null;
      return null;
    }
  }

  async function show(appid, name, cardEl) {
    tpLog('show() appid=' + appid + ' name=' + name);
    _ensurePopup();
    _currentAppid = appid;
    var title = document.getElementById('tp-title');
    var spinner = document.getElementById('tp-spinner');
    if (title) title.textContent = '\uD83C\uDFAC ' + (name || appid);
    if (spinner) spinner.style.display = 'block';
    _video.removeAttribute('src');
    _popup.style.display = 'block';
    _position(cardEl);
    var t = await _getTrailer(appid);
    if (_currentAppid !== appid) { tpLog('user moved away'); return; }
    if (!t || !t.videoUrl) {
      if (title) title.textContent = '\uD83C\uDFAC ' + name + ' \u2014 No trailer';
      if (spinner) spinner.style.display = 'none';
      setTimeout(function() { if (_currentAppid === appid) hide(); }, 2000);
      return;
    }
    if (_cache[appid]) _cache[appid]._urlIdx = 1;
    var proxied = '/api/video_proxy?url=' + encodeURIComponent(t.videoUrl);
    tpLog('playing: ' + proxied);
    _video.src = proxied;
    _video.play().catch(function(e) { tpLog('play() error: ' + e.message); });
    _position(cardEl);
  }

  function hide() {
    _currentAppid = null;
    if (_video) { _video.pause(); _video.removeAttribute('src'); }
    if (_popup) _popup.style.display = 'none';
  }

  tpLog('TrailerPreview module created');
  return { show: show, hide: hide };
})();

// Attach hover to cards
(function() {
  var DELAY = 600;
  var attached = new WeakSet();

  function hookCard(card) {
    if (attached.has(card)) return;
    attached.add(card);
    var t = null;
    card.addEventListener('mouseenter', function() {
      var id = card.getAttribute('data-appid');
      var nm = card.getAttribute('data-name') || id;
      if (!id || !window.TrailerPreview) return;
      tpLog('mouseenter card appid=' + id);
      t = setTimeout(function() { window.TrailerPreview.show(id, nm, card); }, DELAY);
    });
    card.addEventListener('mouseleave', function() {
      clearTimeout(t);
      if (window.TrailerPreview) window.TrailerPreview.hide();
    });
  }

  function scan() {
    var cards = document.querySelectorAll('#game-grid .card');
    var n = 0;
    cards.forEach(function(c) { if (!attached.has(c)) n++; hookCard(c); });
    if (n > 0) tpLog('hooked ' + n + ' new cards (total: ' + cards.length + ')');
  }

  function init() {
    var grid = document.getElementById('game-grid');
    if (!grid) {
      tpLog('game-grid not found, retrying in 500ms');
      setTimeout(init, 500);
      return;
    }
    tpLog('game-grid found, scanning...');
    scan();
    new MutationObserver(function() { tpLog('MutationObserver fired'); scan(); }).observe(grid, { childList: true });
    tpLog('MutationObserver attached');
  }
  init();
})();

// ============================================================================

// THEME SWITCHER
// Talks to /api/theme (GET/POST) on the Flask backend.
// On apply: swaps the <link rel="stylesheet"> href + logo <img> src,
// then forces a full reload so the server delivers the new CSS/logo.
// ============================================================================
(function initThemeSwitcher() {
  const THEMES = {
    original:  { label: '🎮 Original',       css: '/styles.css', logo: '/logo.png' },
    cny:       { label: '💜 Indigo Galaxy',   css: '/styles.css', logo: '/logo.png' },
    hariraya:  { label: '🌙 Hari Raya',      css: '/styles.css', logo: '/logo.png' },
  };

  async function loadCurrentTheme() {
    try {
      const res = await fetch('/api/theme', { cache: 'no-store' });
      if (!res.ok) return;
      const data = await res.json();
      highlightActiveBtn(data.current);
      updateActiveLabel(data.current);
    } catch (e) {
      console.warn('[theme] could not load theme preference', e);
    }
  }

  async function applyTheme(themeName) {
    const activeLabel = document.getElementById('theme-active-label');
    if (activeLabel) activeLabel.textContent = 'Applying…';

    try {
      const res = await fetch('/api/theme', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ theme: themeName })
      });

      const data = await res.json();

      if (!res.ok) {
        if (activeLabel) activeLabel.textContent = '❌ Error: ' + (data.error || 'Unknown');
        return;
      }

      // Surface any per-asset download errors in the label
      if (!data.css_ok || !data.logo_ok) {
        const errors = [];
        if (!data.css_ok)  errors.push('CSS: ' + (data.css_error || 'failed'));
        if (!data.logo_ok) errors.push('Logo: ' + (data.logo_error || 'failed'));
        if (activeLabel) activeLabel.textContent = '⚠️ ' + errors.join(' | ');
        console.warn('[theme] Download issues:', errors);
        // Still swap what we can — CSS route falls back gracefully
      }

      highlightActiveBtn(themeName);
      if (data.css_ok && data.logo_ok) {
        updateActiveLabel(themeName);
      }

      // Force browser to re-fetch CSS (bust cache with timestamp)
      const styleLink = document.querySelector('link[rel="stylesheet"]');
      if (styleLink) {
        styleLink.href = '/styles.css?t=' + Date.now();
      }

      // Force logo reload
      const logoImg = document.querySelector('.app-logo');
      if (logoImg) {
        logoImg.src = '/logo.png?t=' + Date.now();
      }

      console.log(`[theme] Applied: ${themeName}`, data);
    } catch (e) {
      console.error('[theme] apply failed', e);
      if (activeLabel) activeLabel.textContent = '❌ Network error';
    }
  }

  function highlightActiveBtn(activeName) {
    document.querySelectorAll('.theme-pick-btn').forEach(btn => {
      const isActive = btn.dataset.theme === activeName;
      btn.style.opacity = isActive ? '1' : '0.55';
      btn.style.outline = isActive ? '2px solid var(--accent, #22d3ee)' : 'none';
      btn.style.fontWeight = isActive ? '700' : '400';
    });
  }

  function updateActiveLabel(themeName) {
    const label = document.getElementById('theme-active-label');
    if (!label) return;
    const names = { original: '🎮 Original', cny: '💜 Indigo Galaxy', hariraya: '🌙 Hari Raya' };
    label.textContent = 'Active: ' + (names[themeName] || themeName);
  }

  function bindButtons() {
    document.querySelectorAll('.theme-pick-btn').forEach(btn => {
      btn.addEventListener('click', () => applyTheme(btn.dataset.theme));
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => { bindButtons(); loadCurrentTheme(); });
  } else {
    bindButtons();
    loadCurrentTheme();
  }
})();