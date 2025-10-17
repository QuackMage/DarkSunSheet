
// ========== Utilities ==========
const $ = (s) => document.querySelector(s);
const log = (...a) => console.log("[DarkSunSheet]", ...a);

// Try both global OBR and ESM import as fallback
let OBRref = typeof window !== "undefined" ? window.OBR : undefined;
async function ensureOBR() {
  if (OBRref) return;
  try {
    const mod = await import("https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm");
    OBRref = mod?.default || mod;
    log("OBR imported via ESM");
  } catch (e) {
    log("ESM import failed; using global OBR if present.", e);
  }
}

// One-time readiness latch
let _readyResolve;
const _ready = new Promise((res) => (_readyResolve = res));
async function ready() { await _ready; }

const toast = async (msg) => {
  try { await OBRref.notification.show(msg); } catch { console.log(msg); }
};
const uuid = () => (crypto?.randomUUID?.() || Math.random().toString(36).slice(2));

// ========== DOM refs ==========
const btns = {
  new: $("#btn-new"),
  import: $("#btn-import"),
  save: $("#btn-save"),
  export: $("#btn-export"),
  del:  $("#btn-delete"),
  refresh: $("#gm-refresh"),
  file: /** @type {HTMLInputElement} */ ($("#import-file")),
  tabsPlayer: $("#player-tabs"),
  tabsGM: $("#gm-tabs"),
  gmBar: $("#gm-bar"),
  playerBar: $("#player-bar"),
};
const form = /** @type {HTMLFormElement} */ ($("#sheet"));

// quick enable/disable for top buttons
const setButtonsDisabled = (disabled) => {
  [btns.new, btns.import, btns.save, btns.export, btns.del, btns.refresh]
    .forEach(b => { if (b) b.disabled = !!disabled; });
};

// ========== Data model ==========
const NS = "com.quackmage.darksun";
const LOCAL = `${NS}:sheets`;          // player-private
const ROOM_KEY = `${NS}:index`;        // tiny shared index

// Broadcast channels
const CH = {
  REQ: `${NS}:req-sheet`,
  PUSH: `${NS}:push-sheet`,
  SAVED: `${NS}:saved-sheet`,
};

// Which sheet the GM is currently viewing (not editing)
let gmViewing = /** @type {null | {sheetId:string, ownerId:string}} */ (null);

// Track which local sheet is active
let currentId = null;
const getActiveId = () => currentId || lastLocalId();

// Field list
const FIELDS = [
  "name","race","class","level","sp",
  "str","str_mod","dex","dex_mod","con","con_mod","int","int_mod","wis","wis_mod","cha","cha_mod",
  "hp_max","hp_cur","ac","speed","init","psionic",
  "attacks","inventory","notes",
  "save_fort","save_ref","save_will","save_death",
  "str_chk","dex_chk","con_chk","int_chk","wis_chk","cha_chk"
];

function getSheetFromDOM() {
  const o = {};
  for (const k of FIELDS) {
    const el = document.querySelector(`[data-key="${k}"]`);
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") o[k] = el.checked;
    else o[k] = /** @type {HTMLInputElement|HTMLTextAreaElement} */(el).value ?? "";
  }
  return o;
}
function setSheetToDOM(data = {}) {
  for (const k of FIELDS) {
    const el = document.querySelector(`[data-key="${k}"]`);
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!data[k];
    else /** @type {HTMLInputElement|HTMLTextAreaElement} */(el).value = data[k] ?? "";
  }
}
function setFormDisabled(disabled) {
  Array.from(form.elements).forEach(el => {
    if (el instanceof HTMLButtonElement) return; // keep top buttons active
    el.disabled = !!disabled;
  });
}

// Local storage helpers
const readLocal = () => JSON.parse(localStorage.getItem(LOCAL) || "{}");
const writeLocal = (obj) => localStorage.setItem(LOCAL, JSON.stringify(obj));
const lastLocalId = () => Object.keys(readLocal()).slice(-1)[0];

// Room index helpers
async function upsertRoomIndex(sheetId, metaPatch) {
  await ready();
  const cur = await OBRref.room.getMetadata();
  const idx = cur[ROOM_KEY] || {};
  idx[sheetId] = { ...(idx[sheetId] || {}), ...metaPatch };
  await OBRref.room.setMetadata({ [ROOM_KEY]: idx });
}
async function removeFromRoomIndex(sheetId){
  try {
    await ready();
    const cur = await OBRref.room.getMetadata();
    const idx = cur[ROOM_KEY] || {};
    if (sheetId in idx) {
      delete idx[sheetId];
      await OBRref.room.setMetadata({ [ROOM_KEY]: idx });
    }
  } catch {}
}

// ========== Tabs rendering ==========
async function renderTabs() {
  // Player tabs: local
  btns.tabsPlayer.innerHTML = "";
  const local = readLocal();
  for (const [id, sheet] of Object.entries(local)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = sheet.name || "Untitled";
    b.className = (id === currentId ? "active" : "");
    b.onclick = () => {
      currentId = id;
      gmViewing = null;
      setFormDisabled(false);
      setSheetToDOM(sheet);
      renderTabs(); // refresh active class
    };
    btns.tabsPlayer.appendChild(b);
  }

  // GM list: requires OBR
  try {
    await ready();
    const role = await OBRref.player.getRole(); // "GM" | "PLAYER"
    btns.gmBar.hidden = role !== "GM";
    if (role === "GM") {
      btns.tabsGM.innerHTML = "";
      const idx = (await OBRref.room.getMetadata())[ROOM_KEY] || {};
      const me = await OBRref.player.getId();

      for (const [sheetId, meta] of Object.entries(idx)) {
        const wrap = document.createElement("div");
        wrap.className = "tabwrap";

        const b = document.createElement("button");
        b.type = "button";
        const owner = meta.ownerId === me ? "You" : (meta.ownerName || meta.ownerId);
        b.textContent = `${meta.name || "Untitled"} (${owner})`;
        b.onclick = async () => {
          await ready();
          gmViewing = { sheetId, ownerId: meta.ownerId };
          setSheetToDOM({});
          setFormDisabled(true); // GM view is read-only
          await toast(`Requesting "${meta.name || sheetId}" from ${owner}…`);
          await OBRref.broadcast.sendMessage(CH.REQ, { sheetId, ownerId: meta.ownerId });
        };

        const x = document.createElement("button");
        x.type = "button";
        x.className = "x";
        x.textContent = "×";
        x.title = "Remove from GM list";
        x.onclick = async (e) => {
          e.stopPropagation();
          if (!confirm(`Remove "${meta.name || sheetId}" from the GM list?`)) return;
          await removeFromRoomIndex(sheetId);
          await toast("Removed from list.");
          renderTabs();
        };

        wrap.appendChild(b);
        wrap.appendChild(x);
        btns.tabsGM.appendChild(wrap);
      }
    }
  } catch {
    /* not in OBR context yet */
  }
}

// ========== Button handlers ==========
async function onNew() {
  // local first
  const id = uuid();
  const local = readLocal();

  // try to fetch real owner (if ready)
  let ownerId = "local";
  let ownerName = "Local Player";
  try {
    await ready();
    ownerId = await OBRref.player.getId();
    ownerName = await OBRref.player.getName();
  } catch {}

  local[id] = { id, name: "New Character", ownerId, ownerName, createdAt: Date.now(), ...getSheetFromDOM() };
  writeLocal(local);
  currentId = id;
  setSheetToDOM(local[id]);

  try { await upsertRoomIndex(id, { name: local[id].name, ownerId, ownerName }); } catch {}
  await toast("New character created.");
  renderTabs();
}

async function onSave(pushToGM = true) {
  const local = readLocal();
  const id = getActiveId();
  if (!id || !local[id]) return toast("No local character to save.");

  local[id] = { ...local[id], ...getSheetFromDOM() };
  writeLocal(local);

  try {
    await ready();
    await upsertRoomIndex(id, { name: local[id].name });
    if (pushToGM && OBRref?.broadcast) {
      await OBRref.broadcast.sendMessage(CH.SAVED, { sheetId: id, ownerId: local[id].ownerId, data: local[id] });
    }
  } catch {}

  await toast("Saved.");
  renderTabs();
}

async function onExport() {
  const local = readLocal();
  const id = getActiveId();
  if (!id || !local[id]) return toast("Nothing to export.");
  const blob = new Blob([JSON.stringify(local[id], null, 2)], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (local[id].name || "character") + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 800);
}

async function onImport() {
  btns.file.onchange = async () => {
    const f = btns.file.files?.[0];
    if (!f) return;
    try {
      const obj = JSON.parse(await f.text());
      const id = obj.id || uuid();

      // default owner
      let ownerId = "local";
      let ownerName = "Local Player";
      try {
        await ready();
        ownerId = await OBRref.player.getId();
        ownerName = await OBRref.player.getName();
      } catch {}

      const local = readLocal();
      local[id] = { id, ownerId, ownerName, ...obj };
      writeLocal(local);
      currentId = id;
      setSheetToDOM(local[id]);
      try { await upsertRoomIndex(id, { name: local[id].name, ownerId, ownerName }); } catch {}
      await toast("Imported.");
      renderTabs();
    } catch (e) {
      console.error(e); toast("Import failed (bad JSON?).");
    } finally { btns.file.value = ""; }
  };
  btns.file.click();
}

async function onDelete() {
  const local = readLocal();
  const id = getActiveId();
  if (!id || !local[id]) return toast("No sheet selected.");
  const name = local[id].name || "Untitled";
  if (!confirm(`Delete "${name}" from your device?`)) return;

  // remove local
  delete local[id];
  writeLocal(local);

  // best-effort remove from GM list
  await removeFromRoomIndex(id);

  // clear UI or switch to last sheet
  currentId = null;
  setSheetToDOM({});
  setFormDisabled(false);
  await toast(`Deleted "${name}".`);
  renderTabs();
}

async function onRefresh() {
  try { await ready(); } catch {}
  await toast("Refreshed.");
  renderTabs();
}

// ========== Broadcast wiring (GM <-> Player) ==========
function wireBroadcast() {
  if (!OBRref?.broadcast) return;

  // GM requests: only the owner responds with full data
  OBRref.broadcast.onMessage(CH.REQ, async (msg) => {
    try {
      await ready();
      const { sheetId, ownerId } = msg.data || {};
      const myId = await OBRref.player.getId();
      if (!sheetId || ownerId !== myId) return; // not mine
      const local = readLocal();
      const data = local[sheetId];
      if (!data) return;
      await OBRref.broadcast.sendMessage(CH.PUSH, { sheetId, ownerId: myId, data });
    } catch {}
  });

  // GM receives a pushed sheet
  OBRref.broadcast.onMessage(CH.PUSH, async (msg) => {
    try {
      await ready();
      const { sheetId, ownerId, data } = msg.data || {};
      if (!gmViewing) return;
      if (gmViewing.sheetId === sheetId && gmViewing.ownerId === ownerId) {
        setSheetToDOM(data || {});
        setFormDisabled(true);
        await toast(`Viewing live sheet from ${ownerId}.`);
      }
    } catch {}
  });

  // Player saved; update GM view if it matches
  OBRref.broadcast.onMessage(CH.SAVED, async (msg) => {
    try {
      await ready();
      const { sheetId, ownerId, data } = msg.data || {};
      if (!gmViewing) return;
      if (gmViewing.sheetId === sheetId && gmViewing.ownerId === ownerId) {
        setSheetToDOM(data || {});
        setFormDisabled(true);
        await toast("GM view updated (player saved).");
      }
    } catch {}
  });
}

// ========== Boot ==========
(async function boot() {
  await ensureOBR();
  setButtonsDisabled(true); // disable briefly during init

  // Attach handlers immediately
  btns.new?.addEventListener("click", onNew);
  btns.save?.addEventListener("click", () => onSave(true));
  btns.export?.addEventListener("click", onExport);
  btns.import?.addEventListener("click", onImport);
  btns.del?.addEventListener("click", onDelete);
  btns.refresh?.addEventListener("click", onRefresh);

  // Fallback: if onReady is slow/missed, re-enable UI after 2s anyway
  const enableFallback = setTimeout(() => {
    setButtonsDisabled(false);
    log("Enabled UI via fallback");
  }, 2000);

  if (OBRref?.onReady) {
    OBRref.onReady(async () => {
      log("OBR ready");
      clearTimeout(enableFallback);
      _readyResolve();           // flip readiness latch for OBR calls
      setButtonsDisabled(false); // enable UI for all roles
      wireBroadcast();
      try {
        OBRref.room.onMetadataChange(renderTabs);
        OBRref.player.onChange(renderTabs);
      } catch {}
      renderTabs();
    });
  } else {
    // Standalone preview (not inside Owlbear)
    clearTimeout(enableFallback);
    _readyResolve();
    setButtonsDisabled(false);
    renderTabs();
  }

  log("bootstrap complete");
})();
