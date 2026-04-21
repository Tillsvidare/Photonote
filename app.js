const DB_NAME = 'photonote-db';
const DB_VERSION = 1;
const STORE = 'entries';

let db;

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = (e) => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE)) {
        d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

function tx(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const req = fn(s);
    req.onsuccess = (e) => resolve(e.target.result);
    req.onerror = (e) => reject(e.target.error);
  });
}

const getAll = () => tx('readonly', s => s.getAll());
const getOne = (id) => tx('readonly', s => s.get(id));
const addEntry = (entry) => tx('readwrite', s => s.add(entry));
const putEntry = (entry) => tx('readwrite', s => s.put(entry));
const delEntry = (id) => tx('readwrite', s => s.delete(id));

function readFileAsDataURL(file) {
  return new Promise((resolve) => {
    const reader = new FileReader();
    reader.onload = (e) => resolve(e.target.result);
    reader.readAsDataURL(file);
  });
}

function compressImage(dataUrl, maxDim = 1400, quality = 0.82) {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      const scale = Math.min(maxDim / img.width, maxDim / img.height, 1);
      const canvas = document.createElement('canvas');
      canvas.width = Math.round(img.width * scale);
      canvas.height = Math.round(img.height * scale);
      canvas.getContext('2d').drawImage(img, 0, 0, canvas.width, canvas.height);
      resolve(canvas.toDataURL('image/jpeg', quality));
    };
    img.src = dataUrl;
  });
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('sv-SE', {
    year: 'numeric', month: 'long', day: 'numeric'
  });
}

function escHtml(str) {
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

async function renderGallery() {
  const gallery = document.getElementById('gallery');
  const entries = (await getAll()).reverse();

  if (entries.length === 0) {
    gallery.innerHTML = `
      <div class="empty-state">
        <div class="empty-icon">📷</div>
        <p>Inga foton ännu</p>
        <small>Tryck på kameraknappen nedtill för att komma igång</small>
      </div>`;
    return;
  }

  gallery.innerHTML = entries.map(e => `
    <article class="card" data-id="${e.id}">
      <div class="card-img-wrap">
        <img src="${e.image}" alt="Foto" loading="lazy">
      </div>
      <div class="card-body">
        <p class="card-note">${e.note ? escHtml(e.note) : '<em>Ingen anteckning</em>'}</p>
        <time class="card-date">${formatDate(e.timestamp)}</time>
      </div>
    </article>
  `).join('');

  gallery.querySelectorAll('.card').forEach(card => {
    card.addEventListener('click', () => openViewModal(Number(card.dataset.id)));
  });
}

// ── Capture modal ──────────────────────────────────────────
let pendingImage = null;

function openCaptureModal() {
  pendingImage = null;
  document.getElementById('preview-img').classList.add('hidden');
  document.getElementById('capture-label').classList.remove('hidden');
  document.getElementById('note-input').value = '';
  document.getElementById('save-btn').disabled = true;
  document.getElementById('file-input').value = '';
  showModal('capture-modal');
}

function closeCaptureModal() {
  hideModal('capture-modal');
}

// ── View modal ─────────────────────────────────────────────
let currentEntry = null;

async function openViewModal(id) {
  currentEntry = await getOne(id);
  if (!currentEntry) return;
  document.getElementById('view-img').src = currentEntry.image;
  document.getElementById('view-note').value = currentEntry.note || '';
  document.getElementById('view-date').textContent = formatDate(currentEntry.timestamp);
  showModal('view-modal');
}

function closeViewModal() {
  hideModal('view-modal');
  currentEntry = null;
}

// ── Modal helpers ──────────────────────────────────────────
function showModal(id) {
  const modal = document.getElementById(id);
  modal.classList.remove('hidden');
  requestAnimationFrame(() =>
    modal.querySelector('.modal-content').classList.add('slide-up')
  );
}

function hideModal(id) {
  const modal = document.getElementById(id);
  const content = modal.querySelector('.modal-content');
  content.classList.remove('slide-up');
  content.addEventListener('transitionend', () => modal.classList.add('hidden'), { once: true });
}

// ── Boot ───────────────────────────────────────────────────
async function init() {
  db = await openDB();
  await renderGallery();

  if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js').catch(console.error);
  }

  document.getElementById('capture-btn').addEventListener('click', openCaptureModal);
  document.getElementById('cancel-btn').addEventListener('click', closeCaptureModal);

  document.getElementById('file-input').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    const raw = await readFileAsDataURL(file);
    pendingImage = await compressImage(raw);
    const preview = document.getElementById('preview-img');
    preview.src = pendingImage;
    preview.classList.remove('hidden');
    document.getElementById('capture-label').classList.add('hidden');
    document.getElementById('save-btn').disabled = false;
  });

  // Clicking the preview re-opens file picker
  document.getElementById('preview-img').addEventListener('click', () => {
    document.getElementById('file-input').click();
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    if (!pendingImage) return;
    await addEntry({
      image: pendingImage,
      note: document.getElementById('note-input').value.trim(),
      timestamp: Date.now()
    });
    closeCaptureModal();
    await renderGallery();
  });

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

  // Close on backdrop click
  document.querySelectorAll('.modal').forEach(modal => {
    modal.addEventListener('click', (e) => {
      if (e.target !== modal) return;
      if (modal.id === 'capture-modal') closeCaptureModal();
      else closeViewModal();
    });
  });
}

init().catch(console.error);
