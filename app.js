const DB_NAME = 'photonote-db';
const DB_VERSION = 1;
const STORE = 'entries';

let db;

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE))
        d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function dbOp(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const req = fn(s);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

const getAll = () => dbOp('readonly', s => s.getAll());
const getOne = (id) => dbOp('readonly', s => s.get(id));
const addEntry = (e) => dbOp('readwrite', s => s.add(e));
const putEntry = (e) => dbOp('readwrite', s => s.put(e));
const delEntry = (id) => dbOp('readwrite', s => s.delete(id));

function readFile(file) {
  return new Promise(resolve => {
    const r = new FileReader();
    r.onload = e => resolve(e.target.result);
    r.readAsDataURL(file);
  });
}

function compress(dataUrl, maxDim = 1400, q = 0.82) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * scale);
      c.height = Math.round(img.height * scale);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', q));
    };
    img.src = dataUrl;
  });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('sv-SE', { year: 'numeric', month: 'long', day: 'numeric' });
}

function esc(str) {
  return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function renderGallery() {
  const gallery = document.getElementById('gallery');
  const entries = (await getAll()).reverse();
  if (entries.length === 0) {
    gallery.innerHTML = `<div class="empty-state"><div class="empty-icon">📷</div><p>Inga foton ännu</p><small>Tryck på kameraknappen nedtill för att komma igång</small></div>`;
    return;
  }
  gallery.innerHTML = entries.map(e => `
    <article class="card" data-id="${e.id}">
      <div class="card-img-wrap"><img src="${e.image}" alt="Foto" loading="lazy"></div>
      <div class="card-body">
        <p class="card-note">${e.note ? esc(e.note) : '<em>Ingen anteckning</em>'}</p>
        <time class="card-date">${formatDate(e.timestamp)}</time>
      </div>
    </article>`).join('');
  gallery.querySelectorAll('.card').forEach(card =>
    card.addEventListener('click', () => openViewModal(Number(card.dataset.id)))
  );
}

// ── Modal helpers ─────────────────────────────────────
function showModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  requestAnimationFrame(() => modal.querySelector('.modal-content').classList.add('slide-up'));
}

function hideModal(id) {
  const modal = document.getElementById(id);
  const content = modal.querySelector('.modal-content');
  content.classList.remove('slide-up');
  content.addEventListener('transitionend', () => modal.classList.add('hidden'), { once: true });
}

// ── Capture modal ─────────────────────────────────────
let pendingImage = null;

function openCaptureModal() {
  pendingImage = null;
  document.getElementById('source-picker').classList.remove('hidden');
  document.getElementById('preview-area').classList.add('hidden');
  document.getElementById('note-input').value = '';
  document.getElementById('save-btn').disabled = true;
  document.getElementById('camera-input').value = '';
  document.getElementById('gallery-input').value = '';
  showModal('capture-modal');
}

function closeCaptureModal() { hideModal('capture-modal'); }

async function handleFile(file) {
  if (!file) return;
  const raw = await readFile(file);
  pendingImage = await compress(raw);
  document.getElementById('preview-img').src = pendingImage;
  document.getElementById('source-picker').classList.add('hidden');
  document.getElementById('preview-area').classList.remove('hidden');
  document.getElementById('save-btn').disabled = false;
}

// ── View modal ────────────────────────────────────────
let currentEntry = null;

async function openViewModal(id) {
  currentEntry = await getOne(id);
  if (!currentEntry) return;
  document.getElementById('view-img').src = currentEntry.image;
  document.getElementById('view-note').value = currentEntry.note || '';
  document.getElementById('view-date').textContent = formatDate(currentEntry.timestamp);
  showModal('view-modal');
}

function closeViewModal() { hideModal('view-modal'); currentEntry = null; }

// ── Init ───────────────────────────────────────────────
async function init() {
  db = await openDB();
  await renderGallery();

  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('./sw.js').catch(console.error);

  // FAB → open modal
  document.getElementById('capture-btn').addEventListener('click', openCaptureModal);
  document.getElementById('cancel-btn').addEventListener('click', closeCaptureModal);

  // Source picker buttons trigger the hidden file inputs
  document.getElementById('open-camera-btn').addEventListener('click', () =>
    document.getElementById('camera-input').click()
  );
  document.getElementById('open-gallery-btn').addEventListener('click', () =>
    document.getElementById('gallery-input').click()
  );

  // File inputs (outside the modal, always in DOM)
  document.getElementById('camera-input').addEventListener('change', e => handleFile(e.target.files[0]));
  document.getElementById('gallery-input').addEventListener('change', e => handleFile(e.target.files[0]));

  // Retake
  document.getElementById('retake-btn').addEventListener('click', () => {
    pendingImage = null;
    document.getElementById('camera-input').value = '';
    document.getElementById('gallery-input').value = '';
    document.getElementById('preview-area').classList.add('hidden');
    document.getElementById('source-picker').classList.remove('hidden');
    document.getElementById('save-btn').disabled = true;
  });

  // Save new entry
  document.getElementById('save-btn').addEventListener('click', async () => {
    if (!pendingImage) return;
    await addEntry({ image: pendingImage, note: document.getElementById('note-input').value.trim(), timestamp: Date.now() });
    closeCaptureModal();
    await renderGallery();
  });

  // View modal
  document.getElementById('close-btn').addEventListener('click', closeViewModal);

  document.getElementById('update-btn').addEventListener('click', async () => {
    if (!currentEntry) return;
    currentEntry.note = document.getElementById('view-note').value.trim();
    await putEntry(currentEntry);
    closeViewModal();
    await renderGallery();
  });

  document.getElementById('delete-btn').addEventListener('click', async () => {
    if (!currentEntry) return;
    if (!confirm('Radera detta foto och anteckning?')) return;
    await delEntry(currentEntry.id);
    closeViewModal();
    await renderGallery();
  });

  // Backdrop to close
  document.querySelectorAll('.modal').forEach(modal =>
    modal.addEventListener('click', e => {
      if (e.target !== modal) return;
      modal.id === 'capture-modal' ? closeCaptureModal() : closeViewModal();
    })
  );
}

init().catch(console.error);
