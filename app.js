// MapShoppingMemo — 公開版（Google Maps + PWA通知対応）
// Google Maps + Places で店舗を検索してピン。データは端末内(localStorage)に保存。

const STORAGE_KEY = "mapShoppingMemo.places.v1";

// ---- データ ----
let places = load();      // [{ id, name, lat, lng, chain?, items:[{id, text, checked}] }]
let activeId = null;      // パネルで開いている場所のid
const markers = {};       // id -> google.maps.Marker
let map = null;

function load() {
  try {
    return JSON.parse(localStorage.getItem(STORAGE_KEY)) || [];
  } catch {
    return [];
  }
}
function save() {
  localStorage.setItem(STORAGE_KEY, JSON.stringify(places));
}
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 6);
}
function findPlace(id) {
  return places.find((p) => p.id === id);
}
function remaining(place) {
  return place.items.filter((it) => !it.checked).length;
}

// ---- Google Maps 読み込み完了後に呼ばれる ----
function initApp() {
  map = new google.maps.Map(document.getElementById("map"), {
    center: { lat: 35.681236, lng: 139.767125 }, // 東京駅
    zoom: 14,
    disableDefaultUI: true,      // アプリらしく地図のボタン類を隠す
    zoomControl: true,
    clickableIcons: false,       // 地図上の既存スポットの誤タップを防ぐ
    gestureHandling: "greedy",   // スマホで1本指スクロールを地図操作に
  });

  // 地図クリックで新しいピンを作る（シートが開いているときは閉じるだけ）
  map.addListener("click", (e) => {
    const sheet = document.getElementById("sheet");
    if (!sheet.classList.contains("hidden") || !panel.classList.contains("hidden")) {
      sheet.classList.add("hidden");
      closePanel();
      return;
    }
    const place = {
      id: uid(),
      name: "",
      lat: e.latLng.lat(),
      lng: e.latLng.lng(),
      items: [],
    };
    places.push(place);
    save();
    addMarker(place);
    openPanel(place.id);
    document.getElementById("place-name").focus();
  });

  // 既存データのピンを復元
  places.forEach(addMarker);

  // 検索（Places Autocomplete）
  setupSearch();

  // 近接通知（見守り）
  setupWatch();

  // ボトムシートの開閉
  setupUI();

  renderList();

  // 見守りを自動開始（許可済み＆前回OFFにしていないときだけ）
  autoStartWatch();
}

// ---- ボトムシートの開閉 ----
function setupUI() {
  const sheet = document.getElementById("sheet");
  document.getElementById("list-toggle").addEventListener("click", () => {
    panel.classList.add("hidden");
    sheet.classList.toggle("hidden");
  });
  // チェーンメモの追加
  document.getElementById("add-chain").addEventListener("click", () => {
    const place = { id: uid(), name: "", chain: true, items: [] };
    places.push(place);
    save();
    renderList();
    openPanel(place.id);
    placeNameInput.focus();
  });
  // カテゴリメモの追加（スーパー等・業種で通知）
  const addCatRow = document.getElementById("add-cat-row");
  document.getElementById("add-category").addEventListener("click", () => {
    addCatRow.classList.toggle("hidden");
  });
  addCatRow.querySelectorAll("button").forEach((b) => {
    b.addEventListener("click", () => {
      const cat = b.dataset.cat;
      let name;
      if (cat === "custom") {
        name = (prompt("カテゴリ名を入力（例：パン屋、本屋、カフェ）") || "").trim();
        if (!name) return;
      } else {
        name = CATEGORY_LABELS[cat] || "カテゴリ";
      }
      const place = { id: uid(), name, category: cat, items: [] };
      places.push(place);
      save();
      addCatRow.classList.add("hidden");
      renderList();
      openPanel(place.id);
      itemInput.focus();
    });
  });
  // 通知距離の設定
  const pinSel = document.getElementById("pin-dist");
  const chainSel = document.getElementById("chain-dist");
  pinSel.value = String(settings.pinDist);
  chainSel.value = String(settings.chainDist);
  pinSel.addEventListener("change", () => {
    settings.pinDist = Number(pinSel.value);
    saveSettings();
    updateWatchStatus();
  });
  chainSel.addEventListener("change", () => {
    settings.chainDist = Number(chainSel.value);
    saveSettings();
    updateWatchStatus();
  });
}
// Google のコールバックから呼べるようにグローバル公開
window.initApp = initApp;

function addMarker(place) {
  if (place.chain || place.category) return; // チェーン・カテゴリメモは地図に固定ピンを持たない
  const marker = new google.maps.Marker({
    position: { lat: place.lat, lng: place.lng },
    map,
  });
  marker.addListener("click", () => openPanel(place.id));
  markers[place.id] = marker;
  refreshMarker(place.id);
}

function refreshMarker(id) {
  const place = findPlace(id);
  const marker = markers[id];
  if (!place || !marker) return;
  const rest = remaining(place);
  const label = place.name || "（名前なし）";
  marker.setTitle(rest > 0 ? `${label}・残り${rest}` : label);
  marker.setOpacity(rest === 0 && place.items.length > 0 ? 0.5 : 1);
  // 残数をピンにバッジ表示
  marker.setLabel(
    rest > 0
      ? { text: String(rest), color: "#ffffff", fontSize: "12px", fontWeight: "700" }
      : null
  );
}

// ---- 検索 ----
function setupSearch() {
  const searchForm = document.getElementById("search-form");
  const searchInput = document.getElementById("search-input");

  // フォーム送信ではページ遷移させない（候補はGoogleが下に表示）
  searchForm.addEventListener("submit", (e) => e.preventDefault());

  const ac = new google.maps.places.Autocomplete(searchInput, {
    fields: ["name", "geometry", "formatted_address"],
    componentRestrictions: { country: "jp" },
  });
  ac.bindTo("bounds", map); // 今見ている範囲を優先

  ac.addListener("place_changed", () => {
    const p = ac.getPlace();
    if (!p.geometry || !p.geometry.location) return;
    const loc = p.geometry.location;
    addPinFromSearch(p.name || searchInput.value, loc.lat(), loc.lng());
    searchInput.value = "";
  });
}

function addPinFromSearch(name, lat, lng) {
  const place = { id: uid(), name, lat, lng, items: [] };
  places.push(place);
  save();
  addMarker(place);
  map.setCenter({ lat, lng });
  map.setZoom(Math.max(map.getZoom(), 16));
  renderList();
  openPanel(place.id);
  document.getElementById("item-input").focus();
}

// ---- 場所リスト ----
const placeListEl = document.getElementById("place-list");

function renderList() {
  placeListEl.innerHTML = "";
  if (places.length === 0) {
    placeListEl.innerHTML = '<p class="empty">まだピンがありません。検索するか地図をクリックして追加しましょう。</p>';
    return;
  }
  const sorted = [...places].sort((a, b) => remaining(b) - remaining(a));
  for (const place of sorted) {
    const rest = remaining(place);
    const card = document.createElement("div");
    card.className = "place-card" + (rest === 0 && place.items.length > 0 ? " done" : "") + (place.chain || place.category ? " chain" : "");
    const name = (place.chain ? "🏪 " : place.category ? categoryEmoji(place) + " " : "") + (place.name || "（名前なし）");
    const count =
      place.items.length === 0
        ? "メモなし"
        : rest > 0
        ? `買うもの ${rest}件` + (place.chain ? "・どこの店舗でも通知" : place.category ? "・近くの店ならどこでも通知" : "")
        : "ぜんぶ買えた ✓";
    card.innerHTML = `<div class="name">${escapeHtml(name)}</div><div class="count">${count}</div>`;
    card.addEventListener("click", () => {
      if (!place.chain && !place.category) {
        map.setCenter({ lat: place.lat, lng: place.lng });
        map.setZoom(Math.max(map.getZoom(), 15));
      }
      openPanel(place.id);
    });
    placeListEl.appendChild(card);
  }
}

// ---- 詳細パネル ----
const panel = document.getElementById("panel");
const placeNameInput = document.getElementById("place-name");
const itemForm = document.getElementById("item-form");
const itemInput = document.getElementById("item-input");
const itemListEl = document.getElementById("item-list");

function openPanel(id) {
  activeId = id;
  const place = findPlace(id);
  if (!place) return;
  placeNameInput.value = place.name;
  placeNameInput.placeholder = place.chain ? "チェーン名（例：ダイソー）" : "場所の名前（例：とらや）";
  renderItems();
  document.getElementById("sheet").classList.add("hidden"); // 一覧シートと同時表示しない
  panel.classList.remove("hidden");
}

function closePanel() {
  const place = findPlace(activeId);
  if (place && !place.name && place.items.length === 0) {
    removePlace(activeId);
  }
  activeId = null;
  panel.classList.add("hidden");
}

placeNameInput.addEventListener("input", () => {
  const place = findPlace(activeId);
  if (!place) return;
  place.name = placeNameInput.value;
  save();
  refreshMarker(place.id);
  renderList();
});

itemForm.addEventListener("submit", (e) => {
  e.preventDefault();
  const text = itemInput.value.trim();
  if (!text) return;
  const place = findPlace(activeId);
  if (!place) return;
  place.items.push({ id: uid(), text, checked: false });
  itemInput.value = "";
  save();
  renderItems();
  refreshMarker(place.id);
  renderList();
});

function renderItems() {
  const place = findPlace(activeId);
  itemListEl.innerHTML = "";
  if (!place) return;
  for (const item of place.items) {
    const li = document.createElement("li");
    li.className = item.checked ? "checked" : "";
    const cb = document.createElement("input");
    cb.type = "checkbox";
    cb.checked = item.checked;
    cb.addEventListener("change", () => {
      item.checked = cb.checked;
      save();
      renderItems();
      refreshMarker(place.id);
      renderList();
    });
    const label = document.createElement("label");
    label.textContent = item.text;
    label.addEventListener("click", () => cb.click());
    const rm = document.createElement("button");
    rm.className = "remove";
    rm.textContent = "🗑";
    rm.title = "削除";
    rm.addEventListener("click", () => {
      place.items = place.items.filter((it) => it.id !== item.id);
      save();
      renderItems();
      refreshMarker(place.id);
      renderList();
    });
    li.append(cb, label, rm);
    itemListEl.appendChild(li);
  }
}

document.getElementById("panel-close").addEventListener("click", closePanel);
document.getElementById("delete-place").addEventListener("click", () => {
  if (activeId && confirm("この場所を削除しますか？")) {
    const id = activeId;
    activeId = null;
    panel.classList.add("hidden");
    removePlace(id);
  }
});

function removePlace(id) {
  places = places.filter((p) => p.id !== id);
  if (markers[id]) {
    markers[id].setMap(null);
    delete markers[id];
  }
  save();
  renderList();
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}

// ---- 近接通知（見守り） ----
const RENOTIFY_MIN = 60;    // 同じ場所への再通知を抑える時間（分）

// 通知距離の設定（アプリ内で変更可能・端末に保存）
const SETTINGS_KEY = "mapShoppingMemo.settings.v1";
const settings = Object.assign(
  { pinDist: 500, chainDist: 100 }, // デフォルト：場所ピン500m・チェーン100m
  loadSettings()
);
function loadSettings() {
  try {
    return JSON.parse(localStorage.getItem(SETTINGS_KEY)) || {};
  } catch {
    return {};
  }
}
function saveSettings() {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
}

let watchId = null;         // watchPosition のID（null = 見守りOFF）
let myMarker = null;        // 現在地の青丸マーカー
const lastNotified = {};    // placeId -> 最後に通知した時刻（ms）

function setupWatch() {
  document.getElementById("watch-toggle").addEventListener("click", toggleWatch);
  document.getElementById("notify-test").addEventListener("click", async () => {
    if (!(await ensureNotifyPermission())) return;
    notify("🛒 テスト通知", "近くに来たらこんなふうにお知らせします");
  });
}

async function ensureNotifyPermission() {
  if (!("Notification" in window)) {
    alert(
      "この環境では通知が使えません。\n" +
      "iPhoneの場合：共有ボタン →「ホーム画面に追加」してから、追加されたアイコンで開いてください。"
    );
    return false;
  }
  let perm = Notification.permission;
  if (perm === "default") perm = await Notification.requestPermission();
  if (perm !== "granted") {
    alert("通知が許可されていません。ブラウザ（またはOS）の設定で通知を「許可」にしてください。");
    return false;
  }
  return true;
}

async function notify(title, body) {
  try {
    // スマホ（Android / iPhoneのホーム画面アプリ）は Service Worker 経由でしか通知を出せない
    if ("serviceWorker" in navigator) {
      const reg = await navigator.serviceWorker.getRegistration();
      if (reg && Notification.permission === "granted") {
        reg.showNotification(title, { body, icon: "icon-192.png", badge: "icon-192.png" });
        return;
      }
    }
    new Notification(title, { body });
  } catch {
    alert(title + "\n" + body); // 通知が出せない環境への保険
  }
}

async function toggleWatch() {
  const btn = document.getElementById("watch-toggle");
  const status = document.getElementById("watch-status");

  // ON → OFF
  if (watchId !== null) {
    navigator.geolocation.clearWatch(watchId);
    watchId = null;
    if (myMarker) { myMarker.setMap(null); myMarker = null; }
    clearCategoryMarkers();
    btn.textContent = "🔔 見守り OFF";
    btn.classList.remove("on");
    status.textContent = "";
    localStorage.setItem("watchPref", "off"); // 手動OFFを記憶 → 次回は自動ONしない
    return;
  }

  // OFF → ON
  if (!navigator.geolocation) {
    alert("この環境では位置情報を取得できません");
    return;
  }
  if (!(await ensureNotifyPermission())) return;
  watchId = navigator.geolocation.watchPosition(
    onPosition,
    (err) => { status.textContent = "位置情報エラー：" + err.message; },
    { enableHighAccuracy: true, maximumAge: 30000, timeout: 20000 }
  );
  btn.textContent = "🔔 見守り ON";
  btn.classList.add("on");
  updateWatchStatus();
  localStorage.setItem("watchPref", "on");
}

function updateWatchStatus() {
  if (watchId === null) return;
  document.getElementById("watch-status").textContent =
    `買い物が残っている場所の近く（📍${settings.pinDist}m／🏪${settings.chainDist}m）で通知します`;
}

// 開いたときに見守りを自動開始する。
// ・手動でOFFにした人には押し付けない（watchPref === "off" なら何もしない）
// ・位置情報・通知が未許可なら何もしない（勝手に許可ダイアログを出さない）
async function autoStartWatch() {
  if (localStorage.getItem("watchPref") === "off") return;
  if (!("Notification" in window) || Notification.permission !== "granted") return;
  try {
    const st = await navigator.permissions.query({ name: "geolocation" });
    if (st.state !== "granted") return;
  } catch {
    return; // permissions API が使えない環境では自動ONを諦める（手動でONにできる）
  }
  if (watchId === null) toggleWatch();
}

function onPosition(pos) {
  const { latitude, longitude } = pos.coords;

  // 現在地マーカー（青丸）
  if (!myMarker) {
    myMarker = new google.maps.Marker({
      position: { lat: latitude, lng: longitude },
      map,
      icon: {
        path: google.maps.SymbolPath.CIRCLE,
        scale: 8,
        fillColor: "#4285F4",
        fillOpacity: 1,
        strokeColor: "#fff",
        strokeWeight: 2,
      },
      title: "現在地",
      zIndex: 9999,
    });
  } else {
    myMarker.setPosition({ lat: latitude, lng: longitude });
  }

  // 買い物が残っている場所との距離をチェック
  for (const place of places) {
    if (remaining(place) === 0) continue;
    const d = distanceM(latitude, longitude, place.lat, place.lng);
    const last = lastNotified[place.id] || 0;
    if (d <= settings.pinDist && Date.now() - last > RENOTIFY_MIN * 60 * 1000) {
      lastNotified[place.id] = Date.now();
      const items = place.items.filter((it) => !it.checked).map((it) => it.text).join("、");
      notify(
        `🛒 「${place.name || "ピンした場所"}」の近くです（約${Math.round(d)}m）`,
        "買うもの：" + items
      );
    }
  }

  // チェーンメモのチェック（API節約のため移動したときだけ）
  checkChains(latitude, longitude);
}

// カテゴリメモの定義（Google Placesの業種タイプ → 表示名）
const CATEGORY_LABELS = {
  supermarket: "スーパー",
  convenience_store: "コンビニ",
  drugstore: "ドラッグストア",
};

// カテゴリ名から絵文字を自動判定
const EMOJI_TABLE = [
  ["パン", "🥐"], ["ベーカリー", "🥐"], ["本", "📚"], ["書店", "📚"], ["カフェ", "☕"], ["喫茶", "☕"], ["コーヒー", "☕"],
  ["花", "💐"], ["酒", "🍶"], ["ワイン", "🍷"], ["肉", "🥩"], ["魚", "🐟"], ["鮮魚", "🐟"], ["ケーキ", "🍰"], ["菓子", "🍬"], ["スイーツ", "🍰"],
  ["薬", "💊"], ["ドラッグ", "💊"], ["家電", "🔌"], ["電気", "🔌"], ["100", "🪙"], ["百均", "🪙"], ["ホームセンター", "🛠️"], ["工具", "🛠️"],
  ["服", "👕"], ["衣料", "👕"], ["靴", "👟"], ["メガネ", "👓"], ["眼鏡", "👓"], ["文房具", "✏️"], ["文具", "✏️"],
  ["パソコン", "💻"], ["ゲーム", "🎮"], ["おもちゃ", "🧸"], ["雑貨", "🧺"], ["コスメ", "💄"], ["化粧", "💄"],
  ["八百屋", "🥬"], ["野菜", "🥬"], ["果物", "🍎"], ["米", "🍚"], ["弁当", "🍱"], ["寿司", "🍣"], ["ラーメン", "🍜"],
  ["スーパー", "🛒"], ["コンビニ", "🏪"],
];
function categoryEmoji(place) {
  if (place.category === "supermarket") return "🛒";
  if (place.category === "convenience_store") return "🏪";
  if (place.category === "drugstore") return "💊";
  const n = place.name || "";
  for (const [k, e] of EMOJI_TABLE) {
    if (n.includes(k)) return e;
  }
  return "🏬";
}
let categoryMarkers = []; // 近くの該当店舗を示す緑丸マーカー

function clearCategoryMarkers() {
  categoryMarkers.forEach((m) => m.setMap(null));
  categoryMarkers = [];
}

// 近くの該当店舗を地図に緑丸で表示（通知チェックの検索結果を流用＝追加API消費なし）
function showCategoryMarkers(results, lat, lng) {
  for (const r of results.slice(0, 10)) {
    if (!r.geometry || !r.geometry.location) continue;
    if (distanceM(lat, lng, r.geometry.location.lat(), r.geometry.location.lng()) > 1200) continue;
    categoryMarkers.push(
      new google.maps.Marker({
        position: r.geometry.location,
        map,
        title: r.name,
        icon: {
          path: google.maps.SymbolPath.CIRCLE,
          scale: 6,
          fillColor: "#16a34a",
          fillOpacity: 0.9,
          strokeColor: "#fff",
          strokeWeight: 2,
        },
      })
    );
  }
}

// ---- チェーン・カテゴリメモの近接チェック ----
// Places API の周辺検索で「近くに該当チェーンの店舗があるか」を調べる。
// API消費を抑えるため、前回の問い合わせ地点から一定距離動いたときだけ実行する。
const CHAIN_QUERY_MIN_INTERVAL_MS = 60 * 1000;      // 問い合わせは最短でも1分空ける
// 再問い合わせに必要な移動距離：通知距離が短いほど細かくチェック（最低40m）
function chainQueryMinMove() {
  return Math.max(40, Math.round(settings.chainDist * 0.8));
}

let placesService = null;
let lastChainQueryAt = 0;
let lastChainQueryPos = null;

function checkChains(lat, lng) {
  // 対象：名前ありのチェーン／業種カテゴリ／名前ありのカスタムカテゴリ
  const chains = places.filter(
    (p) =>
      remaining(p) > 0 &&
      ((p.chain && p.name) || (p.category === "custom" ? !!p.name : !!p.category))
  );
  if (chains.length === 0) {
    clearCategoryMarkers();
    return;
  }

  const now = Date.now();
  if (lastChainQueryPos) {
    const moved = distanceM(lat, lng, lastChainQueryPos.lat, lastChainQueryPos.lng);
    if (moved < chainQueryMinMove() || now - lastChainQueryAt < CHAIN_QUERY_MIN_INTERVAL_MS) return;
  }
  lastChainQueryAt = now;
  lastChainQueryPos = { lat, lng };

  if (!placesService) placesService = new google.maps.places.PlacesService(map);
  clearCategoryMarkers(); // 前回の緑丸を消して今回の結果で描き直す

  for (const chain of chains) {
    // 検索条件：チェーンは店名キーワード、カテゴリは業種タイプで最寄り順に探す
    const req = { location: { lat, lng }, rankBy: google.maps.places.RankBy.DISTANCE };
    if (chain.category && chain.category !== "custom") req.type = chain.category; // 業種タイプで検索
    else req.keyword = chain.name; // チェーン・カスタムカテゴリは名前で検索

    placesService.nearbySearch(req, (results, status) => {
      if (status !== google.maps.places.PlacesServiceStatus.OK || !results || results.length === 0) return;

      // カテゴリメモは近くの店舗を地図に表示（通知とは独立して毎回更新）
      if (chain.category) showCategoryMarkers(results, lat, lng);

      // 通知（クールダウン中はスキップ）
      const last = lastNotified[chain.id] || 0;
      if (Date.now() - last <= RENOTIFY_MIN * 60 * 1000) return;
      const branch = results[0]; // 最寄りの店舗
      if (!branch.geometry || !branch.geometry.location) return;
      const d = Math.round(distanceM(lat, lng, branch.geometry.location.lat(), branch.geometry.location.lng()));
      if (d > settings.chainDist) return; // 設定距離より遠ければ通知しない
      lastNotified[chain.id] = Date.now();
      const items = chain.items.filter((it) => !it.checked).map((it) => it.text).join("、");
      const icon = chain.category ? categoryEmoji(chain) : "🏪";
      notify(`${icon} 「${branch.name}」の近くです（約${d}m）`, "買うもの：" + items);
    });
  }
}

// 2地点間の距離をメートルで返す（ハーバサイン公式）
function distanceM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const r = Math.PI / 180;
  const a =
    Math.sin(((lat2 - lat1) * r) / 2) ** 2 +
    Math.cos(lat1 * r) * Math.cos(lat2 * r) * Math.sin(((lng2 - lng1) * r) / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(a));
}

// ---- Service Worker 登録（スマホの通知・ホーム画面追加用） ----
if ("serviceWorker" in navigator) {
  navigator.serviceWorker.register("./sw.js").catch(() => {});
}
