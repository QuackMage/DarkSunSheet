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

// One-time readiness latch (resolve only after OBR.onReady fires)
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
  [btns.new, btns.import, btns.save, btns.export, btns.refresh]
    .forEach(b => { if (b) b.disabled = !!disabled; });
};

// ========== Data model ==========
const NS = "com.quackmage.darksun";
const LOCAL = `${NS}:sheets`;          // player-private: { [sheetId]: sheetData }
const ROOM_KEY = `${NS}:index`;        // tiny shared index: { [sheetId]: {name, ownerId, ownerName} }

// Broadcast channels (ephemeral sync)
const CH = {
  REQ: `${NS}:req-sheet`,
  PUSH: `${NS}:push-sheet`,
  SAVED: `${NS}:saved-sheet`, // optional ping on save
};

// Which sheet the GM is currently viewing (not editing)
let gmViewing = /** @type {null | {sheetId:string, ownerId:string}} */ (null);

// Field list matches data-key in index.html
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
    if (el instanceof HTMLButtonElement) return; // keep buttons clickable
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

// ========== Tabs rendering ==========
async function renderTabs() {
  // Player tabs: local only (no OBR needed)
  btns.tabsPlayer.innerHTML = "";
  const local = readLocal();
  for (const [id, sheet] of Object.entries(local)) {
    const b = document.createElement("button");
    b.type = "button";
    b.textContent = sheet.name || "Untitled";
    b.className = "active";
    b.onclick = () => {
      gmViewing = null;               // back to local edit
      setFormDisabled(false);
      setSheetToDOM(sheet);
    };
    btns.tabsPlayer.appendChild(b);
  }

  // GM list: requires OBR (wait for ready, then try)
  try {
    await ready();
    const role = await OBRref.player.getRole(); // "GM" | "PLAYER"
    btns.gmBar.hidden = role !== "GM";
    if (role === "GM") {
      btns.tabsGM.innerHTML = "";
      const idx = (await OBRref.room.getMetadata())[ROOM_KEY] || {};
      const me = await OBRref.player.getId();
      for (const [sheetId, meta] of Object.entries(idx)) {
        const b = document.createElement("button");
        b.type = "button";
        const owner = meta.ownerId === me ? "You" : (meta.ownerName || meta.ownerId);
        b.textContent = `${meta.name || "Untitled"} (${owner})`;
        b.onclick = async () => {
          await ready();
          // Request live data from the owner
          gmViewing = { sheetId, ownerId: meta.ownerId };
          setSheetToDOM({});          // clear while waiting
          setFormDisabled(true);      // GM view is read-only
          await toast(`Requesting "${meta.name || sheetId}" from ${owner}…`);
          await OBRref.broadcast.sendMessage(CH.REQ, { sheetId, ownerId: meta.ownerId });
        };
        btns.tabsGM.appendChild(b);
      }
    }
  } catch {
    /* not in OBR context yet; GM bar stays hidden */
  }
}

// ========== Button handlers ==========
async function onNew() {
  // local parts first (don’t need OBR)
  const id = uuid();
  const local = readLocal();

  // if OBR ready, get real owner metadata
  let ownerId = "local";
  let ownerName = "Local Player";
  try {
    await ready();
    ownerId = await OBRref.player.getId();
    ownerName = await OBRref.player.getName();
  } catch {}

  local[id] = { id, name: "New Character", ownerId, ownerName, createdAt: Date.now(), ...getSheetFromDOM() };
  writeLocal(local);
  setSheetToDOM(local[id]);

  try { await upsertRoomIndex(id, { name: local[id].name, ownerId, ownerName }); } catch {}
  await toast("New character created.");
  renderTabs();
}

async function onSave(pushToGM = true) {
  const local = readLocal();
  const id = lastLocalId();
  if (!id) return toast("No local character to save.");

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
  const id = lastLocalId();
  if (!id) return toast("Nothing to export.");
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

  // GM receives a pushed sheet: show it read-only if it matches the one they’re viewing
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

  // When a player saves, they can ping any listening GM to refresh if they’re viewing that sheet
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
  setButtonsDisabled(true); // prevent early clicks

  // Attach button handlers immediately (local features work even outside OBR)
  btns.new?.addEventListener("click", onNew);
  btns.save?.addEventListener("click", () => onSave(true));
  btns.export?.addEventListener("click", onExport);
  btns.import?.addEventListener("click", onImport);
  btns.refresh?.addEventListener("click", onRefresh);

  if (OBRref?.onReady) {
    OBRref.onReady(async () => {
      log("OBR ready");
      _readyResolve();           // flip the readiness latch
      setButtonsDisabled(false); // enable UI now that bus is ready
      wireBroadcast();
      try {
        OBRref.room.onMetadataChange(renderTabs);
        OBRref.player.onChange(renderTabs);
      } catch {}
      renderTabs();
    });
  } else {
    // Standalone preview (not inside Owlbear)
    _readyResolve();            // allow code paths that await ready()
    setButtonsDisabled(false);
    renderTabs();
  }

  log("bootstrap complete");
})();
