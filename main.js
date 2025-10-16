import OBR from "https://cdn.owlbear.rodeo/sdk@2.3.0/obr.min.js";

// ---- Constants & Namespacing
const NS = "com.your.darksun";
const ROOM_INDEX_KEY = `${NS}/index`; // { sheets: { [playerId]: { [sheetId]: {name, updatedAt} } } }
const PLAYER_SHEETS_KEY = `${NS}/sheets`; // { [sheetId]: SheetData }, also store active: sheetId

const CHANNELS = {
  REQUEST_SHEET: `${NS}/req`,
  PUSH_SHEET: `${NS}/push`,
  ANNOUNCE: `${NS}/announce`
};

// Minimal schema for a new sheet
function newSheet() {
  return {
    name: "", race: "", class: "", level: "", sp: "0 / 0",
    str:"", dex:"", con:"", int:"", wis:"", cha:"",
    str_mod:"", dex_mod:"", con_mod:"", int_mod:"", wis_mod:"", cha_mod:"",
    str_chk:false, dex_chk:false, con_chk:false, int_chk:false, wis_chk:false, cha_chk:false,
    hp_max:"", hp_cur:"", ac:"", speed:"", init:"", psionic:"",
    save_fort:"", save_ref:"", save_will:"", save_death:"",
    attacks:"", inventory:"", notes:""
  };
}

// ---- State
let ROLE = "PLAYER";
let SELF_ID = null;
let activeSheetId = null; // current local sheet id
let gmViewing = null;     // {playerId, sheetId} when GM opens a tab

// UI refs
const gmBar = document.getElementById("gm-bar");
const gmTabs = document.getElementById("gm-tabs");
const gmRefresh = document.getElementById("gm-refresh");
const playerBar = document.getElementById("player-bar");
const playerTabs = document.getElementById("player-tabs");
const btnNew = document.getElementById("btn-new");
const btnImport = document.getElementById("btn-import");
const importFile = document.getElementById("import-file");
const btnSave = document.getElementById("btn-save");
const btnExport = document.getElementById("btn-export");
const sheetForm = document.getElementById("sheet");

// Enumerate all fields (matches data-key attributes in HTML)
const FIELD_KEYS = Array.from(sheetForm.querySelectorAll("[data-key]"))
  .map(el => el.getAttribute("data-key"));

// Helpers
const uid = () => Math.random().toString(36).slice(2, 10);
const now = () => Date.now();

// Read/write local sheet form
function readSheetFromForm() {
  const data = {};
  for (const key of FIELD_KEYS) {
    const el = sheetForm.querySelector(`[data-key="${key}"]`);
    data[key] = el.type === "checkbox" ? !!el.checked : el.value;
  }
  return data;
}
function writeSheetToForm(data) {
  for (const key of FIELD_KEYS) {
    const el = sheetForm.querySelector(`[data-key="${key}"]`);
    if (!el) continue;
    if (el.type === "checkbox") el.checked = !!data[key];
    else el.value = (data[key] ?? "");
  }
}

// Player metadata store
async function getPlayerStore() {
  const meta = await OBR.player.getMetadata();
  return meta[PLAYER_SHEETS_KEY] || { sheets: {}, active: null };
}
async function setPlayerStore(store) {
  await OBR.player.setMetadata({ [PLAYER_SHEETS_KEY]: store });
}

// Room index (tiny)
async function getRoomIndex() {
  const meta = await OBR.room.getMetadata();
  return meta[ROOM_INDEX_KEY] || { sheets: {} };
}
async function setRoomIndex(idx) {
  await OBR.room.setMetadata({ [ROOM_INDEX_KEY]: idx });
}

// Draw player tabs
async function refreshPlayerTabs() {
  const store = await getPlayerStore();
  playerTabs.innerHTML = "";
  const ids = Object.keys(store.sheets);
  if (ids.length === 0) {
    btnNew.hidden = false; btnImport.hidden = false;
  } else {
    btnNew.hidden = false; btnImport.hidden = false; // keep visible for more
  }
  ids.forEach(id => {
    const name = store.sheets[id]?.name || "Untitled";
    const b = document.createElement("button");
    b.textContent = name;
    if (id === store.active) b.classList.add("active");
    b.onclick = async () => { store.active = id; await setPlayerStore(store); await loadActiveLocal(); };
    playerTabs.appendChild(b);
  });
}

// GM: rebuild tabs from room index
async function refreshGMTabs() {
  const idx = await getRoomIndex();
  gmTabs.innerHTML = "";
  for (const [playerId, byPlayer] of Object.entries(idx.sheets || {})) {
    for (const [sheetId, info] of Object.entries(byPlayer)) {
      const b = document.createElement("button");
      b.textContent = `${info.name || "Untitled"} (${playerId.slice(0,6)})`;
      b.onclick = () => openGMView(playerId, sheetId);
      gmTabs.appendChild(b);
    }
  }
}

// GM: request and display a player sheet
async function openGMView(playerId, sheetId) {
  gmViewing = { playerId, sheetId };
  // Ask owner to push the latest
  await OBR.broadcast.sendMessage(CHANNELS.REQUEST_SHEET, { playerId, sheetId });
}

// Load current active local sheet into form
async function loadActiveLocal() {
  const store = await getPlayerStore();
  activeSheetId = store.active;
  writeSheetToForm(store.sheets[activeSheetId] || newSheet());
}

// Persist local changes + announce
async function saveLocalAndAnnounce() {
  const store = await getPlayerStore();
  if (!store.active) {
    // first save creates the sheet
    const id = uid();
    store.active = id;
    store.sheets[id] = newSheet();
  }
  const data = readSheetFromForm();
  store.sheets[store.active] = data;
  await setPlayerStore(store);

  // Update room index entry for GM discovery (minimized)
  const idx = await getRoomIndex();
  if (!idx.sheets[SELF_ID]) idx.sheets[SELF_ID] = {};
  idx.sheets[SELF_ID][store.active] = { name: data.name || "Untitled", updatedAt: now() };
  await setRoomIndex(idx); // Room metadata (small bits) per docs. :contentReference[oaicite:1]{index=1}

  // Announce update + provide payload to any listening GM(s)
  await OBR.broadcast.sendMessage(CHANNELS.PUSH_SHEET, {
    from: SELF_ID, sheetId: store.active, data
  }); // Ephemeral sync channel per Broadcast API. :contentReference[oaicite:2]{index=2}

  await OBR.notification?.show?.("Saved Dark Sun sheet.");
}

// Import / Export
async function exportCurrent() {
  const data = readSheetFromForm();
  const blob = new Blob([JSON.stringify({ type:"darksun-sheet", version:1, data }, null, 2)], { type:"application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `${data.name || "darksun"}-sheet.json`;
  a.click();
}
function importJSON(obj) {
  if (!obj || obj.type !== "darksun-sheet") return;
  const data = obj.data || newSheet();
  writeSheetToForm(data);
  saveLocalAndAnnounce();
}

// Wire up UI
btnNew.onclick = async () => {
  const store = await getPlayerStore();
  const id = uid();
  store.sheets[id] = newSheet();
  store.active = id;
  await setPlayerStore(store);
  await refreshPlayerTabs();
  await loadActiveLocal();
};
btnImport.onclick = () => importFile.click();
importFile.onchange = async (e) => {
  const file = e.target.files?.[0];
  if (!file) return;
  const text = await file.text();
  importJSON(JSON.parse(text));
};
btnSave.onclick = saveLocalAndAnnounce;
btnExport.onclick = exportCurrent;

gmRefresh.onclick = () => refreshGMTabs();

// Listen for party/role changes (to show GM bar)
function setRoleUI() {
  if (ROLE === "GM") { gmBar.hidden = false; } else { gmBar.hidden = true; }
}

// Broadcast listeners
OBR.broadcast.onMessage(CHANNELS.REQUEST_SHEET, async (msg) => {
  // Only respond if we own that sheet
  const { playerId, sheetId } = msg.data || {};
  if (playerId !== SELF_ID) return;
  const store = await getPlayerStore();
  const data = store.sheets[sheetId];
  if (!data) return;
  await OBR.broadcast.sendMessage(CHANNELS.PUSH_SHEET, { from: SELF_ID, sheetId, data });
});

OBR.broadcast.onMessage(CHANNELS.PUSH_SHEET, (msg) => {
  // GM receives and displays if this is the viewed sheet
  if (ROLE !== "GM" || !gmViewing) return;
  const { from, sheetId, data } = msg.data || {};
  if (from === gmViewing.playerId && sheetId === gmViewing.sheetId) {
    writeSheetToForm(data);
    // Disable input while GM is viewing someone else’s sheet
    toggleFormDisabled(true);
  }
});

function toggleFormDisabled(disabled) {
  Array.from(sheetForm.elements).forEach(el => { if (el.tagName !== "BUTTON") el.disabled = disabled; });
}

// Init
(async function init() {
  if (!OBR.isAvailable) return;
  await OBR.onReady(() => {});

  ROLE = await OBR.player.getRole();                      // GM or PLAYER. :contentReference[oaicite:3]{index=3}
  SELF_ID = await OBR.player.getId();

  setRoleUI();

  // Build player tabs and load active
  await refreshPlayerTabs();
  await loadActiveLocal();

  // Build GM tabs if GM
  if (ROLE === "GM") {
    await refreshGMTabs();
    OBR.room.onMetadataChange(async () => { await refreshGMTabs(); }); // keep GM tabs in sync. :contentReference[oaicite:4]{index=4}
  }

  // Keep local header tabs reactive to metadata changes on this player
  OBR.player.onChange(async () => { await refreshPlayerTabs(); });

})();
