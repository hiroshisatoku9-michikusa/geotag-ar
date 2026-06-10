// ====================================================
// GEOTAG — Location-based AR App
// Persistence: localStorage
// AR: A-Frame + AR.js (gps-entity-place)
// ====================================================

const STORE_KEYS = {
  ITEMS: 'geotag_items_v1',
  CATEGORIES: 'geotag_categories_v1',
  SETTINGS: 'geotag_settings_v1'
};

// デフォルトカテゴリ
const DEFAULT_CATEGORIES = [
  { id: 'food', name: 'Food', color: '#ff8a3d' },
  { id: 'art',  name: 'Art',  color: '#ff3d8e' },
  { id: 'mark', name: 'Marker', color: '#00ffd1' },
  { id: 'memo', name: 'Memo', color: '#a78bfa' }
];

const COLOR_PALETTE = [
  '#00ffd1', '#ffb547', '#ff3d8e', '#a78bfa',
  '#ff8a3d', '#5ee7df', '#ffd166', '#ef476f',
  '#06d6a0', '#118ab2', '#f72585', '#7209b7'
];

// v0.2 の距離しきい値
const CARD_RADIUS_DEFAULT = 50; // m: ポラロイドカードが現れる半径（スライダーで可変）
const ARROW_MIN_DIST = 10;      // m: 展開中、これ以上離れると方向矢印を表示
const FIT_MAX_DIST = 10;        // m: 画角フィットを許可する距離
const SETTINGS_VERSION = 2;     // displayRadius の意味が変わったため設定を移行

// State
let state = {
  items: [],
  categories: [],
  activeCategories: new Set(),
  selectedCategoryId: null,
  imageMode: 'upload', // upload | url
  currentImage: null, // data URL or URL string
  geocodedCoords: null, // {lat, lng}
  userCoords: null,
  displayRadius: CARD_RADIUS_DEFAULT,
  selectedNewCategoryColor: COLOR_PALETTE[0],
  expandedItemId: null,  // AR内で展開中のタグ
  fitMode: false,        // 画角フィット操作中
  deviceHeading: null    // コンパス方位（北=0, 時計回り）
};

// ====================================================
// STORAGE
// ====================================================
function load() {
  try {
    state.items = JSON.parse(localStorage.getItem(STORE_KEYS.ITEMS) || '[]');
    const savedCats = JSON.parse(localStorage.getItem(STORE_KEYS.CATEGORIES) || 'null');
    state.categories = savedCats || DEFAULT_CATEGORIES;
    const settings = JSON.parse(localStorage.getItem(STORE_KEYS.SETTINGS) || '{}');
    // v2: displayRadius は「カード出現半径」に意味が変わったため旧設定値は引き継がない
    state.displayRadius = (settings.v === SETTINGS_VERSION && settings.displayRadius)
      ? settings.displayRadius
      : CARD_RADIUS_DEFAULT;
    const savedActive = settings.activeCategories;
    if (savedActive && Array.isArray(savedActive)) {
      state.activeCategories = new Set(savedActive);
    } else {
      state.activeCategories = new Set(state.categories.map(c => c.id));
    }
  } catch (e) {
    console.error('Load error:', e);
    state.categories = DEFAULT_CATEGORIES;
    state.activeCategories = new Set(state.categories.map(c => c.id));
  }
}

function save() {
  localStorage.setItem(STORE_KEYS.ITEMS, JSON.stringify(state.items));
  localStorage.setItem(STORE_KEYS.CATEGORIES, JSON.stringify(state.categories));
  localStorage.setItem(STORE_KEYS.SETTINGS, JSON.stringify({
    v: SETTINGS_VERSION,
    displayRadius: state.displayRadius,
    activeCategories: Array.from(state.activeCategories)
  }));
}

// ====================================================
// UTILS
// ====================================================
function uid() {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
}

function toast(message, isError = false) {
  const el = document.getElementById('toast');
  el.textContent = message;
  el.classList.toggle('error', isError);
  el.classList.add('visible');
  clearTimeout(toast._t);
  toast._t = setTimeout(() => el.classList.remove('visible'), 2400);
}

function formatCoord(num) {
  if (num == null || isNaN(num)) return '— · — · —';
  return num.toFixed(6);
}

function haversineDistance(lat1, lng1, lat2, lng2) {
  const R = 6371000; // earth radius m
  const toRad = d => d * Math.PI / 180;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a = Math.sin(dLat/2)**2 +
            Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) *
            Math.sin(dLng/2)**2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1-a));
}

// 地点1から地点2への方位角（北=0, 時計回り 0-360）
function bearingBetween(lat1, lng1, lat2, lng2) {
  const toRad = d => d * Math.PI / 180;
  const p1 = toRad(lat1), p2 = toRad(lat2), dL = toRad(lng2 - lng1);
  const y = Math.sin(dL) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dL);
  return (Math.atan2(y, x) * 180 / Math.PI + 360) % 360;
}

function getCategory(id) {
  return state.categories.find(c => c.id === id) || state.categories[0];
}

// ====================================================
// MODE SWITCHER
// ====================================================
function initModeSwitcher() {
  const tabs = document.querySelectorAll('.mode-tab');
  const indicator = document.getElementById('modeIndicator');
  const cameraView = document.getElementById('cameraView');
  const registerView = document.getElementById('registerView');

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const mode = tab.dataset.mode;
      tabs.forEach(t => t.classList.toggle('active', t === tab));

      if (mode === 'camera') {
        indicator.classList.remove('mode-2');
        cameraView.classList.add('active');
        registerView.classList.remove('active');
      } else {
        indicator.classList.add('mode-2');
        registerView.classList.add('active');
        cameraView.classList.remove('active');
      }
    });
  });
}

// ====================================================
// GEOLOCATION
// ====================================================
function watchUserLocation() {
  if (!navigator.geolocation) {
    toast('位置情報がサポートされていません', true);
    return;
  }
  navigator.geolocation.watchPosition(
    (pos) => {
      state.userCoords = {
        lat: pos.coords.latitude,
        lng: pos.coords.longitude
      };
      document.getElementById('userLat').textContent = 'LAT ' + formatCoord(state.userCoords.lat);
      document.getElementById('userLng').textContent = 'LNG ' + formatCoord(state.userCoords.lng);
      updateInRangeCount();
    },
    (err) => {
      console.warn('Geolocation error:', err);
    },
    { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
  );
}

// ====================================================
// GEOCODING (v0.2 再構築)
// 国土地理院(GSI)アドレス検索を第一候補に、Nominatim をフォールバックに。
// GSI は日本の住所（番地・街区レベルまで）に強く、APIキー不要・CORS可。
// それでも外れる場合は番地以降を落とした町名で再試行（approximate フラグ付き）。
// ====================================================
function normalizeAddress(s) {
  return s.trim()
    .replace(/[０-９]/g, c => String.fromCharCode(c.charCodeAt(0) - 0xFEE0)) // 全角数字→半角
    .replace(/([0-9])[ー－‐−―ｰ〜~](?=[0-9])/g, '$1-') // 数字間のダッシュ類のみ統一（地名の長音は触らない）
    .replace(/\s+/g, '');
}

async function fetchJSON(url, timeoutMs = 8000) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, { headers: { 'Accept': 'application/json' }, signal: ctrl.signal });
    if (!res.ok) return null;
    return await res.json();
  } catch (_) {
    return null;
  } finally {
    clearTimeout(t);
  }
}

// --- GSI 結果の妥当性チェック用正規化 ---
// GSI は前方一致のあいまい検索で、ランドマーク名（例: 東京タワー）には
// 無関係な候補を大量に返す。タイトルとクエリを同じ規則で正規化して
// 前方一致するものだけを採用する。
// 「一丁目１番」と「1-1」の表記揺れを吸収するため、漢数字→算用数字、
// 丁目/番地/番/号→"-" に揃える（比較専用。表示や検索クエリには使わない）。
function kanjiDigits(m) {
  const d = { '〇':'0','一':'1','二':'2','三':'3','四':'4','五':'5','六':'6','七':'7','八':'8','九':'9' };
  if (!m.includes('十')) return m.split('').map(c => d[c] || '').join('');
  const [a, b] = m.split('十');
  return (a ? d[a] : '1') + (b ? d[b] : '0');
}

function normCompare(s) {
  return normalizeAddress(s)
    .replace(/[〇一二三四五六七八九十]+(?=丁目|丁|番地|番|号)/g, kanjiDigits)
    .replace(/(丁目|丁|番地|番|号)/g, '-')
    .replace(/-+/g, '-')
    .replace(/-$/, '');
}

function gsiResultMatches(query, title) {
  const q = normCompare(query);
  const t = normCompare(title);
  if (!q || !t) return false;
  return q.startsWith(t) || t.startsWith(q);
}

async function geocodeGSI(q) {
  const data = await fetchJSON('https://msearch.gsi.go.jp/address-search/AddressSearch?q=' + encodeURIComponent(q));
  if (!Array.isArray(data) || data.length === 0) return null;
  const best = data.find(e =>
    e.geometry && e.geometry.coordinates &&
    e.properties && gsiResultMatches(q, e.properties.title || '')
  );
  if (!best) return null;
  return {
    lat: best.geometry.coordinates[1],
    lng: best.geometry.coordinates[0],
    displayName: best.properties.title
  };
}

async function geocodeNominatim(q) {
  const data = await fetchJSON('https://nominatim.openstreetmap.org/search?format=json&accept-language=ja&limit=1&q=' + encodeURIComponent(q));
  if (!Array.isArray(data) || data.length === 0) return null;
  return {
    lat: parseFloat(data[0].lat),
    lng: parseFloat(data[0].lon),
    displayName: data[0].display_name
  };
}

async function geocodeAddress(raw) {
  const addr = normalizeAddress(raw);
  const trimmed = addr.replace(/[0-9].*$/, '').trim(); // 番地以降を外した町名
  const attempts = [
    { q: addr, fn: geocodeGSI, approx: false },
    { q: addr, fn: geocodeNominatim, approx: false }
  ];
  if (trimmed && trimmed !== addr) {
    attempts.push({ q: trimmed, fn: geocodeGSI, approx: true });
    attempts.push({ q: trimmed, fn: geocodeNominatim, approx: true });
  }
  for (const a of attempts) {
    const r = await a.fn(a.q);
    if (r) return { ...r, approximate: a.approx };
  }
  throw new Error('Address not found');
}

function initGeocoding() {
  const btn = document.getElementById('geocodeBtn');
  const input = document.getElementById('addressInput');
  const resultEl = document.getElementById('coordsResult');
  const useCurrentBtn = document.getElementById('useCurrentLocation');

  btn.addEventListener('click', async () => {
    const addr = input.value.trim();
    if (!addr) { toast('住所を入力してください', true); return; }
    btn.disabled = true;
    btn.textContent = '...';
    try {
      const coords = await geocodeAddress(addr);
      state.geocodedCoords = coords;
      document.getElementById('resultLat').textContent = formatCoord(coords.lat);
      document.getElementById('resultLng').textContent = formatCoord(coords.lng);
      document.getElementById('resultAddr').textContent =
        '→ ' + coords.displayName + (coords.approximate ? '（番地まで特定できず・おおよその位置）' : '');
      resultEl.classList.add('visible');
      toast(coords.approximate ? '町名レベルのおおよその位置です' : '位置を取得しました', coords.approximate);
    } catch (e) {
      toast('住所が見つかりません。現地なら「現在地を使う」が確実です', true);
    } finally {
      btn.disabled = false;
      btn.textContent = 'Locate';
    }
  });

  useCurrentBtn.addEventListener('click', () => {
    if (!state.userCoords) {
      toast('現在地が取得できていません', true);
      return;
    }
    state.geocodedCoords = { ...state.userCoords, displayName: 'Current Location' };
    document.getElementById('resultLat').textContent = formatCoord(state.userCoords.lat);
    document.getElementById('resultLng').textContent = formatCoord(state.userCoords.lng);
    document.getElementById('resultAddr').textContent = '→ 現在地（GPS）';
    document.getElementById('addressInput').value = 'Current Location';
    resultEl.classList.add('visible');
    toast('現在地を使用します');
  });
}

// ====================================================
// IMAGE UPLOAD
// ====================================================
function initImageUploader() {
  const fileInput = document.getElementById('imageFile');
  const preview = document.getElementById('imagePreview');
  const uploader = document.getElementById('imageUploader');
  const urlInput = document.getElementById('imageUrl');

  fileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (!file) return;
    if (file.size > 4 * 1024 * 1024) {
      toast('画像は4MB以下にしてください', true);
      return;
    }
    const reader = new FileReader();
    reader.onload = (ev) => {
      // 縮小処理
      const img = new Image();
      img.onload = () => {
        const canvas = document.createElement('canvas');
        const maxDim = 512;
        let w = img.width, h = img.height;
        if (w > h && w > maxDim) { h = h * (maxDim / w); w = maxDim; }
        else if (h > maxDim) { w = w * (maxDim / h); h = maxDim; }
        canvas.width = w; canvas.height = h;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, w, h);
        const dataUrl = canvas.toDataURL('image/jpeg', 0.85);
        state.currentImage = dataUrl;
        preview.src = dataUrl;
        preview.style.display = 'block';
        uploader.classList.add('has-image');
      };
      img.src = ev.target.result;
    };
    reader.readAsDataURL(file);
  });

  urlInput.addEventListener('input', (e) => {
    state.currentImage = e.target.value.trim();
  });

  // toggle upload/url mode
  document.querySelectorAll('[data-img-mode]').forEach(btn => {
    btn.addEventListener('click', () => {
      const mode = btn.dataset.imgMode;
      state.imageMode = mode;
      document.querySelectorAll('[data-img-mode]').forEach(b => b.classList.toggle('active', b === btn));
      document.getElementById('uploadMode').style.display = mode === 'upload' ? 'block' : 'none';
      document.getElementById('urlMode').style.display = mode === 'url' ? 'block' : 'none';
      // reset
      state.currentImage = null;
      preview.style.display = 'none';
      uploader.classList.remove('has-image');
      fileInput.value = '';
      urlInput.value = '';
    });
  });
}

// ====================================================
// CATEGORIES
// ====================================================
function renderCategoryPicker() {
  const picker = document.getElementById('categoryPicker');
  picker.innerHTML = '';
  state.categories.forEach(cat => {
    const chip = document.createElement('div');
    chip.className = 'category-chip';
    if (state.selectedCategoryId === cat.id) chip.classList.add('selected');
    chip.style.setProperty('--cat-color', cat.color);
    chip.textContent = cat.name;
    chip.addEventListener('click', () => {
      state.selectedCategoryId = cat.id;
      renderCategoryPicker();
    });
    picker.appendChild(chip);
  });
}

function renderCategoryToggles() {
  // メインビュー用
  const togglesEl = document.getElementById('categoryToggles');
  togglesEl.innerHTML = '';
  state.categories.forEach(cat => {
    const chip = document.createElement('div');
    chip.className = 'category-chip';
    if (state.activeCategories.has(cat.id)) chip.classList.add('selected');
    chip.style.setProperty('--cat-color', cat.color);
    const count = state.items.filter(i => i.categoryId === cat.id).length;
    chip.innerHTML = `${cat.name} <span style="color: var(--text-dim); margin-left: 4px;">${count}</span>`;
    chip.addEventListener('click', () => {
      if (state.activeCategories.has(cat.id)) {
        state.activeCategories.delete(cat.id);
      } else {
        state.activeCategories.add(cat.id);
      }
      save();
      renderCategoryToggles();
      updateInRangeCount();
    });
    togglesEl.appendChild(chip);
  });

  // AR HUD用
  const arEl = document.getElementById('arCategoryToggles');
  arEl.innerHTML = '';
  state.categories.forEach(cat => {
    const btn = document.createElement('button');
    btn.className = 'ar-cat-toggle';
    if (state.activeCategories.has(cat.id)) btn.classList.add('active');
    btn.style.setProperty('--cat-color', cat.color);
    btn.textContent = cat.name;
    btn.addEventListener('click', () => {
      if (state.activeCategories.has(cat.id)) {
        state.activeCategories.delete(cat.id);
      } else {
        state.activeCategories.add(cat.id);
      }
      save();
      renderCategoryToggles();
      renderARScene();
    });
    arEl.appendChild(btn);
  });
}

function initCategoryModal() {
  const modal = document.getElementById('categoryModal');
  const colorPicker = document.getElementById('colorPicker');
  const addBtn = document.getElementById('addCategoryBtn');
  const cancelBtn = document.getElementById('cancelCategoryBtn');
  const confirmBtn = document.getElementById('confirmCategoryBtn');
  const nameInput = document.getElementById('newCategoryName');

  // 色パレット
  function renderColors() {
    colorPicker.innerHTML = '';
    COLOR_PALETTE.forEach(color => {
      const swatch = document.createElement('div');
      swatch.className = 'color-swatch';
      swatch.style.background = color;
      if (color === state.selectedNewCategoryColor) swatch.classList.add('selected');
      swatch.addEventListener('click', () => {
        state.selectedNewCategoryColor = color;
        renderColors();
      });
      colorPicker.appendChild(swatch);
    });
  }

  addBtn.addEventListener('click', () => {
    nameInput.value = '';
    state.selectedNewCategoryColor = COLOR_PALETTE[Math.floor(Math.random() * COLOR_PALETTE.length)];
    renderColors();
    modal.classList.add('visible');
    setTimeout(() => nameInput.focus(), 100);
  });

  cancelBtn.addEventListener('click', () => modal.classList.remove('visible'));

  confirmBtn.addEventListener('click', () => {
    const name = nameInput.value.trim();
    if (!name) { toast('カテゴリ名を入力してください', true); return; }
    if (state.categories.some(c => c.name.toLowerCase() === name.toLowerCase())) {
      toast('同じ名前のカテゴリがあります', true);
      return;
    }
    const newCat = {
      id: uid(),
      name: name,
      color: state.selectedNewCategoryColor
    };
    state.categories.push(newCat);
    state.activeCategories.add(newCat.id);
    state.selectedCategoryId = newCat.id;
    save();
    renderCategoryPicker();
    renderCategoryToggles();
    modal.classList.remove('visible');
    toast('カテゴリを追加しました');
  });

  modal.addEventListener('click', (e) => {
    if (e.target === modal) modal.classList.remove('visible');
  });
}

// ====================================================
// SAVE ITEM
// ====================================================
function initSave() {
  document.getElementById('saveBtn').addEventListener('click', () => {
    if (!state.geocodedCoords) { toast('住所を取得してください', true); return; }
    if (!state.currentImage) { toast('画像を選択してください', true); return; }
    if (!state.selectedCategoryId) { toast('カテゴリを選択してください', true); return; }

    const name = document.getElementById('itemName').value.trim() || 'Untitled';

    const item = {
      id: uid(),
      name: name,
      lat: state.geocodedCoords.lat,
      lng: state.geocodedCoords.lng,
      address: state.geocodedCoords.displayName || document.getElementById('addressInput').value,
      image: state.currentImage,
      categoryId: state.selectedCategoryId,
      heading: null, // 方位（度・北=0）。現地での「画角フィット」でのみ設定される
      createdAt: Date.now()
    };
    state.items.push(item);
    save();
    toast('登録しました ✓');
    resetForm();
    renderItemList();
    renderCategoryToggles();
    updateItemCount();
  });
}

function resetForm() {
  document.getElementById('addressInput').value = '';
  document.getElementById('itemName').value = '';
  document.getElementById('imageUrl').value = '';
  document.getElementById('imageFile').value = '';
  document.getElementById('imagePreview').style.display = 'none';
  document.getElementById('imageUploader').classList.remove('has-image');
  document.getElementById('coordsResult').classList.remove('visible');
  state.currentImage = null;
  state.geocodedCoords = null;
  state.selectedCategoryId = null;
  renderCategoryPicker();
}

// ====================================================
// ITEM LIST
// ====================================================
function renderItemList() {
  const list = document.getElementById('itemsList');
  list.innerHTML = '';
  document.getElementById('totalTagCount').textContent = state.items.length;

  if (state.items.length === 0) {
    list.innerHTML = `
      <div class="empty-state">
        <div class="empty-state-icon">◌</div>
        <div class="empty-state-text">No tags yet</div>
      </div>`;
    return;
  }

  state.items.slice().reverse().forEach(item => {
    const cat = getCategory(item.categoryId);
    const card = document.createElement('div');
    card.className = 'item-card';
    card.style.setProperty('--item-color', cat.color);
    card.innerHTML = `
      <div class="item-thumb" style="background-image: url('${item.image}')"></div>
      <div class="item-info">
        <div class="item-name">${escapeHtml(item.name)}</div>
        <div class="item-meta">${formatCoord(item.lat)}, ${formatCoord(item.lng)}${item.heading != null ? ' · 向き固定 ' + Math.round(item.heading) + '°' : ''}</div>
        <div class="item-category">● ${cat.name}</div>
      </div>
      <button class="item-delete" data-id="${item.id}" aria-label="Delete">×</button>
    `;
    list.appendChild(card);
  });

  list.querySelectorAll('.item-delete').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const id = btn.dataset.id;
      if (!confirm('このタグを削除しますか?')) return;
      state.items = state.items.filter(i => i.id !== id);
      save();
      renderItemList();
      renderCategoryToggles();
      updateItemCount();
      toast('削除しました');
    });
  });
}

function escapeHtml(str) {
  const div = document.createElement('div');
  div.textContent = str;
  return div.innerHTML;
}

function updateItemCount() {
  document.getElementById('itemCount').textContent = state.items.length;
  document.getElementById('itemCount').innerHTML = state.items.length + '<span class="ar-info-unit">tags</span>';
}

function updateInRangeCount() {
  let count = 0;
  if (state.userCoords) {
    state.items.forEach(item => {
      if (!state.activeCategories.has(item.categoryId)) return;
      const dist = haversineDistance(
        state.userCoords.lat, state.userCoords.lng,
        item.lat, item.lng
      );
      if (dist <= state.displayRadius) count++;
    });
  }
  document.getElementById('inRangeCount').innerHTML = count + '<span class="ar-info-unit">visible</span>';
  document.getElementById('arVisibleCount').textContent = count;
}

// ====================================================
// DISTANCE SLIDER
// ====================================================
function initDistanceSlider() {
  const slider = document.getElementById('distanceSlider');
  const arSlider = document.getElementById('arDistanceSlider');
  const val = document.getElementById('distanceVal');
  const arVal = document.getElementById('arDistanceVal');

  slider.value = state.displayRadius;
  arSlider.value = state.displayRadius;
  val.textContent = state.displayRadius;
  arVal.textContent = state.displayRadius;

  const onChange = (newVal) => {
    state.displayRadius = parseInt(newVal, 10);
    slider.value = state.displayRadius;
    arSlider.value = state.displayRadius;
    val.textContent = state.displayRadius;
    arVal.textContent = state.displayRadius;
    save();
    updateInRangeCount();
    renderARScene();
  };

  slider.addEventListener('input', (e) => onChange(e.target.value));
  arSlider.addEventListener('input', (e) => onChange(e.target.value));
}

// ====================================================
// AR INTERACTION (v0.2)
// 50m以内 → ポラロイドカード → タップで展開（厚み付きパネルがAR空間に出現）
// → 下スワイプで戻す。展開中に10m以上離れると方向矢印。
// 10m以内では「画角フィット」で向きを設定できる。
// ====================================================

function getNearbyItems() {
  if (!state.userCoords) return [];
  return state.items
    .filter(i => state.activeCategories.has(i.categoryId))
    .map(i => ({
      item: i,
      dist: haversineDistance(state.userCoords.lat, state.userCoords.lng, i.lat, i.lng)
    }))
    .filter(e => e.dist <= state.displayRadius)
    .sort((a, b) => a.dist - b.dist);
}

// AR.js の gps 空間: +x=東, -z=北。plane の正面は +z（=南向きが rotation 0）。
// パネル正面を方位 bearing（北=0・時計回り）へ向ける yaw 角:
function headingToYaw(bearing) {
  return ((180 - bearing) % 360 + 360) % 360;
}

let _expandedEls = null; // { group, label } 展開中のARエンティティ参照

function renderARScene() {
  renderExpandedEntity();
}

function renderExpandedEntity() {
  const container = document.getElementById('arEntities');
  if (!container) return;
  container.innerHTML = '';
  _expandedEls = null;

  const item = state.items.find(i => i.id === state.expandedItemId);
  if (!item) return;

  const cat = getCategory(item.categoryId);
  const W = 10; // パネル幅(m)。50m圏内で見やすいサイズ

  const group = document.createElement('a-entity');
  group.setAttribute('gps-entity-place', `latitude: ${item.lat}; longitude: ${item.lng};`);

  if (!state.fitMode && item.heading == null) {
    // 方向未設定 → 常にユーザー正面（ビルボード）
    group.setAttribute('look-at', '[gps-camera]');
  } else {
    // 方向固定 or フィット操作中
    const bearing = state.fitMode
      ? (((state.deviceHeading != null ? state.deviceHeading : 0) + 180) % 360)
      : item.heading;
    group.setAttribute('rotation', `0 ${headingToYaw(bearing)} 0`);
  }

  // 台座: ポラロイドの白フチ＋厚み（パネル感）
  const board = document.createElement('a-box');
  board.setAttribute('color', '#f5f2ea');
  board.setAttribute('depth', 0.5);

  const img = document.createElement('a-image');
  img.setAttribute('src', item.image);
  img.setAttribute('position', '0 0.5 0.3'); // 下フチを厚く（ポラロイド比率）

  const label = document.createElement('a-text');
  label.setAttribute('color', cat.color);
  label.setAttribute('align', 'center');
  label.setAttribute('scale', '8 8 8');
  label.setAttribute('look-at', '[gps-camera]');
  label.setAttribute('value', item.name);

  function applySize(h) {
    board.setAttribute('width', W + 1.2);
    board.setAttribute('height', h + 2.2);
    img.setAttribute('width', W);
    img.setAttribute('height', h);
    label.setAttribute('position', `0 ${-(h / 2 + 2.4)} 0`);
  }
  applySize(W * 0.75);

  // 画像の実アスペクト比に合わせて再調整
  const probe = new Image();
  probe.onload = () => {
    if (probe.naturalWidth && probe.naturalHeight) {
      applySize(W * probe.naturalHeight / probe.naturalWidth);
    }
  };
  probe.src = item.image;

  group.appendChild(board);
  group.appendChild(img);
  group.appendChild(label);
  container.appendChild(group);
  _expandedEls = { group, label };
}

// ---- 近接カード（ポラロイド） ----
let _cardsKey = '';
function renderCards(nearby) {
  const wrap = document.getElementById('arCards');
  if (!wrap) return;
  if (state.expandedItemId) {
    wrap.innerHTML = '';
    _cardsKey = '';
    return;
  }
  const key = nearby.map(e => e.item.id).join(',');
  if (key !== _cardsKey) {
    _cardsKey = key;
    wrap.innerHTML = '';
    nearby.forEach(({ item }) => {
      const card = document.createElement('div');
      card.className = 'polaroid';
      card.dataset.id = item.id;
      card.innerHTML = `
        <img class="polaroid-photo" src="${item.image}" alt="">
        <div class="polaroid-name">${escapeHtml(item.name)}</div>
        <div class="polaroid-dist" data-dist>—</div>`;
      card.addEventListener('click', () => expandItem(item.id));
      wrap.appendChild(card);
    });
  }
  // 距離表示は毎tick更新
  nearby.forEach(({ item, dist }) => {
    const el = wrap.querySelector(`[data-id="${item.id}"] [data-dist]`);
    if (el) el.textContent = Math.round(dist) + 'm';
  });
}

function expandItem(id) {
  state.expandedItemId = id;
  state.fitMode = false;
  document.getElementById('arContainer').classList.add('expanded');
  renderExpandedEntity();
  updateExpandedHUD();
}

function collapseItem() {
  state.expandedItemId = null;
  state.fitMode = false;
  document.getElementById('arContainer').classList.remove('expanded');
  renderExpandedEntity();
  updateExpandedHUD();
}

// ---- 展開中HUD（情報ピル・方向矢印・画角フィット） ----
function updateExpandedHUD() {
  const guide = document.getElementById('arGuide');
  const fit = document.getElementById('arFit');
  const info = document.getElementById('arExpandedInfo');
  const item = state.items.find(i => i.id === state.expandedItemId);

  if (!item || !state.userCoords) {
    guide.classList.remove('visible');
    fit.classList.remove('visible');
    if (!item && state.expandedItemId) collapseItem(); // 展開中に削除された場合
    return;
  }

  const dist = haversineDistance(state.userCoords.lat, state.userCoords.lng, item.lat, item.lng);
  info.textContent = `${item.name} · ${Math.round(dist)}m`;
  if (_expandedEls) {
    _expandedEls.label.setAttribute('value', `${item.name}\n${Math.round(dist)}m`);
  }

  // 10m以上離れている → ロケーションを指す矢印
  if (dist > ARROW_MIN_DIST) {
    guide.classList.add('visible');
    document.getElementById('arGuideText').textContent = `${item.name} · ${Math.round(dist)}m`;
    updateGuideArrow(item);
  } else {
    guide.classList.remove('visible');
  }

  // 10m以内 → 画角フィットの案内（フィット操作中は距離が揺れても出し続ける）
  if (state.fitMode || dist <= FIT_MAX_DIST) {
    fit.classList.add('visible');
    document.getElementById('arFitRowIdle').style.display = state.fitMode ? 'none' : 'flex';
    document.getElementById('arFitRowActive').style.display = state.fitMode ? 'flex' : 'none';
    document.getElementById('btnFitReset').style.display =
      (!state.fitMode && item.heading != null) ? 'block' : 'none';
    document.getElementById('arFitMsg').textContent = state.fitMode
      ? '画像が実際の景色に正しく重なる向きへ、その場で身体ごと回ってください。合ったら「この向きで固定」。'
      : 'この画像を正しい画角にフィットさせることにご協力ください';
  } else {
    fit.classList.remove('visible');
  }
}

function updateGuideArrow(item) {
  const svg = document.getElementById('arGuideArrow');
  if (!svg || !state.userCoords) return;
  const bearing = bearingBetween(state.userCoords.lat, state.userCoords.lng, item.lat, item.lng);
  const rel = state.deviceHeading != null
    ? (bearing - state.deviceHeading + 360) % 360
    : bearing;
  svg.style.transform = `rotate(${rel}deg)`;
}

// ---- コンパス（方位トラッカー） ----
let _headingListening = false;
function startHeadingTracker() {
  if (_headingListening) return;
  _headingListening = true;
  window.addEventListener('deviceorientation', (e) => {
    let h = null;
    if (typeof e.webkitCompassHeading === 'number' && !isNaN(e.webkitCompassHeading)) {
      h = e.webkitCompassHeading; // iOS: 0=北・時計回り
    } else if (e.absolute === true && typeof e.alpha === 'number') {
      h = (360 - e.alpha) % 360;  // Android(absolute): alpha は反時計回り
    }
    if (h == null) return;
    state.deviceHeading = h;

    // 矢印とフィット中のパネルはセンサーイベント直結でなめらかに回す
    const item = state.items.find(i => i.id === state.expandedItemId);
    if (!item) return;
    if (document.getElementById('arGuide').classList.contains('visible')) {
      updateGuideArrow(item);
    }
    if (state.fitMode && _expandedEls) {
      const facing = (h + 180) % 360; // ユーザーの方を向く向き
      _expandedEls.group.setAttribute('rotation', `0 ${headingToYaw(facing)} 0`);
    }
  }, true);
}

// ---- ARループ（距離・カード・HUDの定期更新） ----
let _arLoop = null;
function startARLoop() {
  stopARLoop();
  _arLoop = setInterval(() => {
    const nearby = getNearbyItems();
    renderCards(nearby);
    updateExpandedHUD();
    updateInRangeCount();
  }, 600);
}
function stopARLoop() {
  if (_arLoop) { clearInterval(_arLoop); _arLoop = null; }
}

// ---- スワイプで戻す & 画角フィット操作 ----
function initARInteractions() {
  const zone = document.getElementById('arSwipeZone');
  let startY = null;
  zone.addEventListener('touchstart', (e) => { startY = e.touches[0].clientY; }, { passive: true });
  zone.addEventListener('touchend', (e) => {
    if (startY == null) return;
    const dy = e.changedTouches[0].clientY - startY;
    startY = null;
    if (dy > 70) collapseItem();
  }, { passive: true });
  document.getElementById('arSwipeHint').addEventListener('click', collapseItem);

  document.getElementById('btnFitStart').addEventListener('click', () => {
    if (state.deviceHeading == null) {
      toast('コンパスが取得できていません。端末を8の字に動かしてみてください', true);
      return;
    }
    state.fitMode = true;
    renderExpandedEntity();
    updateExpandedHUD();
  });

  document.getElementById('btnFitConfirm').addEventListener('click', () => {
    const item = state.items.find(i => i.id === state.expandedItemId);
    if (!item || state.deviceHeading == null) return;
    item.heading = Math.round(((state.deviceHeading + 180) % 360) * 10) / 10;
    save();
    state.fitMode = false;
    renderExpandedEntity();
    updateExpandedHUD();
    renderItemList();
    toast('向きを固定しました ✓');
  });

  document.getElementById('btnFitCancel').addEventListener('click', () => {
    state.fitMode = false;
    renderExpandedEntity();
    updateExpandedHUD();
  });

  document.getElementById('btnFitReset').addEventListener('click', () => {
    const item = state.items.find(i => i.id === state.expandedItemId);
    if (!item) return;
    item.heading = null;
    save();
    renderExpandedEntity();
    updateExpandedHUD();
    renderItemList();
    toast('向きをリセットしました（常に正面向きになります）');
  });
}

// ---- AR scene の動的マウント／破棄 ----
// iOS Safari では <a-scene> を display:none の親に最初から置くと
// カメラ初期化に失敗するため、LAUNCH 押下時にユーザージェスチャー内で生成する。
function mountARScene() {
  const container = document.getElementById('arContainer');
  if (container.querySelector('a-scene')) return;
  const scene = document.createElement('a-scene');
  scene.id = 'arScene';
  scene.setAttribute('embedded', '');
  scene.setAttribute('vr-mode-ui', 'enabled: false');
  // videoTexture は付けない（iOS で黒画面を招く）。default の <video> DOM 経路を使う。
  scene.setAttribute('arjs', 'sourceType: webcam; debugUIEnabled: false;');
  scene.setAttribute('renderer', 'antialias: true; alpha: true');
  scene.innerHTML = `
    <a-camera gps-camera rotation-reader></a-camera>
    <a-entity id="arEntities"></a-entity>
  `;
  // overlay より背面に来るよう先頭に挿入
  container.insertBefore(scene, container.firstChild);
}

function unmountARScene() {
  if (_arVideoObserver) { _arVideoObserver.disconnect(); _arVideoObserver = null; }
  const scene = document.getElementById('arScene');
  if (scene) scene.parentNode && scene.parentNode.removeChild(scene);
  // AR.js が body 直下や他所に挿した video もカメラを止めて削除
  document.querySelectorAll('video#arjs-video, video.arjs-video').forEach(v => {
    try {
      const stream = v.srcObject;
      if (stream && stream.getTracks) stream.getTracks().forEach(t => t.stop());
    } catch (_) {}
    v.parentNode && v.parentNode.removeChild(v);
  });
}

// AR.js が挿入した <video> を AR コンテナ内に取り込み、確実に全画面で再生させる。
// AR.js は video.style に transform/translate と絶対px幅高さをインラインで書き込み、
// portrait のスマホだと中央に細い縦帯として表示されてしまう。cssText で完全に
// 上書きし、AR.js が style 属性を書き換えてきても MutationObserver で即時上書きする。
const AR_VIDEO_CSS = [
  'position:absolute',
  'top:0',
  'left:0',
  'right:0',
  'bottom:0',
  'width:100%',
  'height:100%',
  'max-width:none',
  'max-height:none',
  'min-width:0',
  'min-height:0',
  'margin:0',
  'padding:0',
  'transform:none',
  'object-fit:cover',
  'z-index:1',
  'display:block',
  'opacity:1'
].map(s => s + ' !important').join(';') + ';';

let _arVideoObserver = null;

function forceVideoStyle(v) {
  if (v.style.cssText !== AR_VIDEO_CSS) v.style.cssText = AR_VIDEO_CSS;
}

function fixARJSVideoPlacement() {
  const container = document.getElementById('arContainer');
  const v = document.getElementById('arjs-video') || document.querySelector('video.arjs-video');
  if (!container || !v) return false;
  if (v.parentNode !== container) container.appendChild(v);
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.muted = true;
  forceVideoStyle(v);

  // AR.js が後から style を書き換えてきても即座に戻す
  if (_arVideoObserver) _arVideoObserver.disconnect();
  _arVideoObserver = new MutationObserver(() => forceVideoStyle(v));
  _arVideoObserver.observe(v, { attributes: true, attributeFilter: ['style'] });

  // iOS では明示 play() が要るケースがある
  const p = v.play && v.play();
  if (p && p.catch) p.catch(() => {});
  return true;
}

function initARLaunch() {
  document.getElementById('launchAR').addEventListener('click', async () => {
    if (state.items.length === 0) {
      toast('先に登録モードでタグを作成してください', true);
      return;
    }
    if (!state.userCoords) {
      toast('現在地が取得できていません', true);
      return;
    }

    // iOS: 端末方向センサーの許可
    try {
      if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
        const orientationPermission = await DeviceOrientationEvent.requestPermission();
        if (orientationPermission !== 'granted') {
          toast('端末方向の許可が必要です', true);
          return;
        }
      }
    } catch (e) {
      console.warn(e);
    }

    // コンテナを表示してからシーンを動的マウント（ユーザージェスチャー内）
    document.getElementById('arContainer').classList.add('active');
    document.getElementById('arStatusText').textContent = 'LOCATING...';
    mountARScene();
    startHeadingTracker(); // 許可取得後なので iOS でも webkitCompassHeading が来る
    startARLoop();

    // AR.js が video を挿入するまで少し時間がかかる。複数回試して取り込み・再生させる。
    [200, 700, 1500, 3000].forEach(t => setTimeout(() => {
      if (fixARJSVideoPlacement()) {
        document.getElementById('arStatusText').textContent = 'TRACKING';
      }
      renderARScene();
    }, t));
  });

  document.getElementById('closeAR').addEventListener('click', () => {
    collapseItem();
    stopARLoop();
    document.getElementById('arContainer').classList.remove('active');
    unmountARScene();
  });
}

// ====================================================
// DEV: サンプルデータ生成
// ?seed=100            … 現在地の半径200m内に100件配置（GPS取得後に一度だけ）
// ?seed=100&seedradius=500 … 半径を指定
// ?unseed=1            … シードしたサンプルだけ全削除（手動登録分は残る）
// ====================================================
function makeSampleImage(n, color) {
  const c = document.createElement('canvas');
  c.width = 160; c.height = 120;
  const ctx = c.getContext('2d');
  const g = ctx.createLinearGradient(0, 0, 160, 120);
  g.addColorStop(0, color);
  g.addColorStop(1, '#101522');
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, 160, 120);
  ctx.fillStyle = 'rgba(255,255,255,0.92)';
  ctx.font = 'bold 44px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(n), 80, 60);
  return c.toDataURL('image/jpeg', 0.7);
}

function seedSampleData(count, radiusM) {
  const { lat, lng } = state.userCoords;
  for (let i = 1; i <= count; i++) {
    // 面積一様分布（sqrt しないと中心に偏る）
    const r = radiusM * Math.sqrt(Math.random());
    const th = Math.random() * 2 * Math.PI;
    const dLat = (r * Math.cos(th)) / 111320;
    const dLng = (r * Math.sin(th)) / (111320 * Math.cos(lat * Math.PI / 180));
    const cat = state.categories[Math.floor(Math.random() * state.categories.length)];
    state.items.push({
      id: uid(),
      name: 'Sample ' + String(i).padStart(3, '0'),
      lat: lat + dLat,
      lng: lng + dLng,
      address: 'Seeded sample',
      image: makeSampleImage(i, cat.color),
      categoryId: cat.id,
      // 半分は向き固定、半分はビルボード（両方の挙動をテストできるように）
      heading: Math.random() < 0.5 ? Math.floor(Math.random() * 360) : null,
      seed: true,
      createdAt: Date.now()
    });
  }
  save();
}

function removeSampleData() {
  const before = state.items.length;
  state.items = state.items.filter(i => !i.seed);
  save();
  return before - state.items.length;
}

function refreshAfterSeed() {
  renderItemList();
  renderCategoryToggles();
  updateItemCount();
  updateInRangeCount();
}

function initSeedFromURL() {
  const params = new URLSearchParams(location.search);

  if (params.has('unseed')) {
    const n = removeSampleData();
    refreshAfterSeed();
    toast(`サンプル ${n} 件を削除しました`);
    history.replaceState(null, '', location.pathname); // リロードでの再実行を防ぐ
    return;
  }

  const n = Math.min(parseInt(params.get('seed'), 10) || 0, 500);
  if (n <= 0) return;
  const radius = parseInt(params.get('seedradius'), 10) || 200;

  // GPSが取れてから一度だけ実行
  const timer = setInterval(() => {
    if (!state.userCoords) return;
    clearInterval(timer);
    try {
      seedSampleData(n, radius);
      refreshAfterSeed();
      toast(`現在地の半径${radius}m内にサンプル ${n} 件を配置しました`);
    } catch (e) {
      // localStorage 容量超過など
      toast('サンプル生成に失敗: ' + e.message, true);
    }
    history.replaceState(null, '', location.pathname);
  }, 500);
}

// ====================================================
// INIT
// ====================================================
function init() {
  load();
  initModeSwitcher();
  initGeocoding();
  initImageUploader();
  initCategoryModal();
  initSave();
  initDistanceSlider();
  initARLaunch();
  initARInteractions();
  renderCategoryPicker();
  renderCategoryToggles();
  renderItemList();
  updateItemCount();
  watchUserLocation();
  initSeedFromURL();

  // モバイルブラウザの位置情報が出るまでの間、AR起動を案内
  if (!navigator.geolocation) {
    toast('お使いのブラウザは位置情報非対応です', true);
  }
}

window.addEventListener('DOMContentLoaded', init);
