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
  displayRadius: 500,
  selectedNewCategoryColor: COLOR_PALETTE[0]
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
    state.displayRadius = settings.displayRadius || 500;
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

// 日本の住所は番地・建物番号が末尾に来る。Nominatim は番地まで解決できない
// ことが多いので、フル住所で空振りしたら数字以降を外した町名で再検索する。
function buildAddressVariants(address) {
  const variants = [address];
  const noNum = address.replace(/[0-9０-９].*$/u, '').trim();
  if (noNum && noNum !== address) variants.push(noNum);
  return variants;
}

async function geocodeAddress(address) {
  const variants = buildAddressVariants(address);
  for (let i = 0; i < variants.length; i++) {
    const url = `https://nominatim.openstreetmap.org/search?format=json&accept-language=ja&limit=1&q=${encodeURIComponent(variants[i])}`;
    let res;
    try {
      res = await fetch(url, { headers: { 'Accept': 'application/json' } });
    } catch (_) { continue; }
    if (!res.ok) continue;
    const data = await res.json();
    if (data && data.length) {
      return {
        lat: parseFloat(data[0].lat),
        lng: parseFloat(data[0].lon),
        displayName: data[0].display_name,
        approximate: i > 0
      };
    }
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
      resultEl.classList.add('visible');
      toast(coords.approximate ? '番地までは特定できず、町名のおおよその位置です' : '位置を取得しました', coords.approximate);
    } catch (e) {
      toast('住所が見つかりません。下の「現在地を使う」が確実です', true);
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
        <div class="item-meta">${formatCoord(item.lat)}, ${formatCoord(item.lng)}</div>
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
// AR SCENE
// ====================================================
function renderARScene() {
  const container = document.getElementById('arEntities');
  if (!container) return;
  container.innerHTML = '';

  if (!state.userCoords) return;

  let visibleCount = 0;
  state.items.forEach(item => {
    if (!state.activeCategories.has(item.categoryId)) return;
    const dist = haversineDistance(
      state.userCoords.lat, state.userCoords.lng,
      item.lat, item.lng
    );
    if (dist > state.displayRadius) return;
    visibleCount++;

    const cat = getCategory(item.categoryId);

    // 画像エンティティ
    const entity = document.createElement('a-image');
    entity.setAttribute('src', item.image);
    entity.setAttribute('gps-entity-place', `latitude: ${item.lat}; longitude: ${item.lng};`);
    entity.setAttribute('scale', '15 15 15');
    entity.setAttribute('look-at', '[gps-camera]');
    container.appendChild(entity);

    // ラベル
    const label = document.createElement('a-text');
    label.setAttribute('value', `${item.name}\n${Math.round(dist)}m`);
    label.setAttribute('color', cat.color);
    label.setAttribute('align', 'center');
    label.setAttribute('gps-entity-place', `latitude: ${item.lat}; longitude: ${item.lng};`);
    label.setAttribute('scale', '20 20 20');
    label.setAttribute('position', '0 -10 0');
    label.setAttribute('look-at', '[gps-camera]');
    container.appendChild(label);
  });

  document.getElementById('arVisibleCount').textContent = visibleCount;
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
function fixARJSVideoPlacement() {
  const container = document.getElementById('arContainer');
  const v = document.getElementById('arjs-video') || document.querySelector('video.arjs-video');
  if (!container || !v) return false;
  if (v.parentNode !== container) container.appendChild(v);
  v.setAttribute('playsinline', '');
  v.setAttribute('webkit-playsinline', '');
  v.muted = true;
  // iOS では明示 play 必要なケースがある
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

    // AR.js が video を挿入するまで少し時間がかかる。複数回試して取り込み・再生させる。
    [200, 700, 1500, 3000].forEach(t => setTimeout(() => {
      if (fixARJSVideoPlacement()) {
        document.getElementById('arStatusText').textContent = 'TRACKING';
      }
      renderARScene();
    }, t));
  });

  document.getElementById('closeAR').addEventListener('click', () => {
    document.getElementById('arContainer').classList.remove('active');
    unmountARScene();
  });
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
  renderCategoryPicker();
  renderCategoryToggles();
  renderItemList();
  updateItemCount();
  watchUserLocation();

  // モバイルブラウザの位置情報が出るまでの間、AR起動を案内
  if (!navigator.geolocation) {
    toast('お使いのブラウザは位置情報非対応です', true);
  }
}

window.addEventListener('DOMContentLoaded', init);
