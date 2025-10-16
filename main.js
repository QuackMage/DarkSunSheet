// No bundler? Import the SDK as ESM from a CDN:
import OBR from "https://cdn.jsdelivr.net/npm/@owlbear-rodeo/sdk/+esm";

/**
 * Minimal data model
 * - Full sheet data lives in localStorage (private to the player)
 * - A tiny shared index (id -> {name, ownerId}) lives in Room.metadata under our namespace
 *   so the GM can list all sheets without seeing contents.
 */
const NS = "com.quackmage.darksun";
const ROOM_KEY = `${NS}:index`;
const LOCAL_KEY = `${NS}:sheets`; // map<sheetId, sheetObject>

// Helpers
const $ = (sel) => /** @type {HTMLElement} */ (document.querySelector(sel));
const uuid = () => crypto.randomUUID();
const readLocal = () => JSON.parse(localStorage.getItem(LOCAL_KEY) || "{}");
const writeLocal = (obj) => localStorage.setItem(LOCAL_KEY, JSON.stringify(obj));
const notify = async (msg) => {
  try { await OBR.notification.show(msg); } catch { /* non-OBR context */ alert(msg); }
};

// UI refs
const btnNew = $("#btn-new");
const btnImport = $("#btn-import");
const fileImport = /** @type {HTMLInputElement} */ ($("#import-file"));
const btnSave = $("#btn-save");
const btnExport = $("#btn-export");
const btnRefresh = $("#gm-refresh");
const playerTabs = $("#player-tabs");
const gmTabs = $("#gm-tabs");
const gmBar = $("#gm-bar");
const playerBar = $("#player-bar");

// Sheet fields map (data-key attributes in your HTML)
const FIELD_KEYS = [
  "name","race","class","level","sp",
  "str","str_mod","dex","dex_mod","con","con_mod","int","int_mod","wis","wis_mod","cha","cha_mod",
  "hp_max","hp_cur","ac","speed","init","psionic",
  "attacks","inventory","notes",
  "save_fort","save_ref","save_will","save_death",
  "str_chk","dex_chk","con_chk","int_chk","wis_chk","cha_chk"
];

const readSheetFromDOM = () => {
  const out = {};
  for (const k of FIELD_KEYS) {
    const el = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (document.querySelector(`[data-key="${k}"]`));
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") out[k] = el.checked;
    else out[k] = el.value;
  }
  return out;
};

const writeSheetToDOM = (data = {}) => {
  for (const k of FIELD_KEYS) {
    const el = /** @type {HTMLInputElement|HTMLTextAreaElement} */ (document.querySelector(`[data-key="${k}"]`));
    if (!el) continue;
    if (el instanceof HTMLInputElement && el.type === "checkbox") el.checked = !!data[k];
    else el.value = data[k] ?? "";
  }
};

const renderTabs = async () => {
  const role = await OBR.player.getRole(); // "GM" | "PLAYER"  :contentReference[oaicite:2]{index=2}
  const me = OBR.player.id;
  const local = readLocal();
  const index = (await OBR.room.getMetadata())[ROOM_KEY] || {}; // shared tiny index  :contentReference[oaicite:3]{index=3}

  // Player tabs: only show my sheets
  playerTabs.innerHTML = "";
  for (const [id, sheet] of Object.entries(local)) {
    const b = document.createElement("button");
    b.textContent = sheet.name || "Untitled";
    b.className = "active";
    b.type = "button";
    b.onclick = () => writeSheetToDOM(sheet);
    playerTabs.appendChild(b);
  }

  // GM view: show everyone’s sheet names
  if (role === "GM") {
    gmBar.hidden = false;
    gmTabs.innerHTML = "";
    for (const [id, meta] of Object.entries(index)) {
      const b = document.createElement("button");
      b.textContent = `${meta.name || "Untitled"} (${meta.ownerId === me ? "You" : meta.ownerName || meta.ownerId})`;
      b.type = "button";
      b.onclick = () => {
        // GM can’t read contents (private), but clicking can highlight whose sheet it is
        notify(`Sheet ${meta.name || id} belongs to ${meta.ownerName || meta.ownerId}.`);
      };
      gmTabs.appendChild(b);
    }
  } else {
    gmBar.hidden = true;
  }

  // Player CTA buttons when no local sheets exist
  const hasLocal = Object.keys(local).length > 0;
  $("#btn-new").style.display = "";
  $("#btn-import").style.display = "";
  playerBar.style.display = ""; // keep visible for tabs
};

const upsertRoomIndex = async (sheetId, meta) => {
  const current = await OBR.room.getMetadata();               // read current  :contentReference[oaicite:4]{index=4}
  const index = current[ROOM_KEY] || {};
  index[sheetId] = { ...index[sheetId], ...meta };
  await OBR.room.setMetadata({ [ROOM_KEY]: index });          // partial update  :contentReference[oaicite:5]{index=5}
};

// Button handlers
const handleNew = async () => {
  try {
    const ownerId = OBR.player.id;
    const ownerName = await OBR.player.getName();
    const id = uuid();
    const blank = { id, name: "New Character", ownerId, ownerName, createdAt: Date.now() };
    const local = readLocal();
    local[id] = { ...blank }; // full sheet data locally
    writeLocal(local);
    await upsertRoomIndex(id, { name: blank.name, ownerId, ownerName });
    writeSheetToDOM(local[id]);
    await notify("Created new character.");
    renderTabs();
  } catch (e) {
    console.error(e); await notify("Failed to create character.");
  }
};

const handleSave = async () => {
  const local = readLocal();
  // Save into the currently visible sheet if we can infer it; fallback to last created
  const ids = Object.keys(local);
  if (ids.length === 0) return notify("No local character to save.");
  const activeId = ids[ids.length - 1];
  local[activeId] = { ...local[activeId], ...readSheetFromDOM() };
  writeLocal(local);
  // keep the shared index name updated
  await upsertRoomIndex(activeId, { name: local[activeId].name });
  await notify("Saved.");
  renderTabs();
};

const handleExport = async () => {
  const local = readLocal();
  const ids = Object.keys(local);
  if (!ids.length) return notify("Nothing to export.");
  const activeId = ids[ids.length - 1];
  const data = JSON.stringify(local[activeId], null, 2);
  const blob = new Blob([data], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = (local[activeId].name || "character") + ".json";
  a.click();
  setTimeout(() => URL.revokeObjectURL(a.href), 1000);
};

const handleImport = async () => {
  fileImport.onchange = async () => {
    const f = fileImport.files?.[0];
    if (!f) return;
    try {
      const text = await f.text();
      const obj = JSON.parse(text);
      const id = obj.id || uuid();
      const ownerId = OBR.player.id;
      const ownerName = await OBR.player.getName();
      const local = readLocal();
      local[id] = { ...obj, id, ownerId, ownerName };
      writeLocal(local);
      await upsertRoomIndex(id, { name: local[id].name, ownerId, ownerName });
      writeSheetToDOM(local[id]);
      await notify("Imported character.");
      renderTabs();
    } catch (e) {
      console.error(e); await notify("Import failed (bad JSON?).");
    } finally {
      fileImport.value = "";
    }
  };
  fileImport.click();
};

const handleRefresh = async () => {
  try {
    await notify("Refreshing…");
    renderTabs();
  } catch (e) {
    console.error(e);
  }
};

// Wire up once the SDK is ready
OBR.onReady(async () => {                                      // onReady is a callback, not a Promise  :contentReference[oaicite:6]{index=6}
  // Basic visibility: show player bar always; GM bar toggled in renderTabs()
  playerBar.style.display = "";

  // Attach handlers
  btnNew?.addEventListener("click", handleNew);
  btnSave?.addEventListener("click", handleSave);
  btnExport?.addEventListener("click", handleExport);
  btnImport?.addEventListener("click", handleImport);
  btnRefresh?.addEventListener("click", handleRefresh);

  // Re-render tabs if player/room state changes
  OBR.player.onChange(renderTabs);                             // reactive to role/name changes  :contentReference[oaicite:7]{index=7}
  OBR.room.onMetadataChange(renderTabs);                       // keep GM list in sync         :contentReference[oaicite:8]{index=8}

  renderTabs();
});
