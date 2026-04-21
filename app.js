const DB_NAME = 'photonote-db';
const DB_VERSION = 1;
const STORE = 'entries';
let db;

async function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, DB_VERSION);
    req.onupgradeneeded = e => {
      const d = e.target.result;
      if (!d.objectStoreNames.contains(STORE))
        d.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
    };
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

function dbOp(mode, fn) {
  return new Promise((resolve, reject) => {
    const t = db.transaction(STORE, mode);
    const s = t.objectStore(STORE);
    const req = fn(s);
    req.onsuccess = e => resolve(e.target.result);
    req.onerror = e => reject(e.target.error);
  });
}

const getAll = () => dbOp('readonly', s => s.getAll());
const getOne = id => dbOp('readonly', s => s.get(id));
const addEntry = e => dbOp('readwrite', s => s.add(e));
const putEntry = e => dbOp('readwrite', s => s.put(e));
const delEntry = id => dbOp('readwrite', s => s.delete(id));

function compress(dataUrl, maxDim = 1400, q = 0.88) {
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

function splitLines(ctx, text, maxWidth) {
  const result = [];
  for (const para of text.split('\n')) {
    if (!para.trim()) { result.push(''); continue; }
    const words = para.split(' ');
    let cur = '';
    for (const w of words) {
      const test = cur ? cur + ' ' + w : w;
      if (ctx.measureText(test).width > maxWidth && cur) { result.push(cur); cur = w; }
      else cur = test;
    }
    if (cur) result.push(cur);
  }
  return result;
}

function buildComposite(imageDataUrl, note) {
  return new Promise(resolve => {
    const img = new Image();
    img.onload = () => {
      const w = img.width;
      const fontSize = Math.max(24, Math.round(w * 0.038));
      const pad = Math.round(w * 0.045);
      const lh = Math.round(fontSize * 1.5);
      const canvas = document.createElement('canvas');
      const ctx = canvas.getContext('2d');
      ctx.font = `${fontSize}px -apple-system, sans-serif`;
      const lines = note ? splitLines(ctx, note, w - pad * 2) : [];
      const stripH = lines.length ? pad + lines.length * lh + pad : 0;
      canvas.width = w;
      canvas.height = img.height + stripH;
      ctx.drawImage(img, 0, 0);
      if (lines.length) {
        ctx.fillStyle = 'rgba(15,15,25,0.93)';
        ctx.fillRect(0, img.height, w, stripH);
        ctx.fillStyle = '#e8e8f0';
        ctx.font = `${fontSize}px -apple-system, sans-serif`;
        ctx.textBaseline = 'top';
        lines.forEach((l, i) => ctx.fillText(l, pad, img.height + pad + i * lh));
      }
      resolve(canvas.toDataURL('image/jpeg', 0.92));
    };
    img.src = imageDataUrl;
  });
}

function triggerDownload(dataUrl, filename) {
  const a = document.createElement('a');
  a.href = dataUrl; a.download = filename;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
}

function dateFilename() {
  const d = new Date(), p = n => String(n).padStart(2,'0');
  return `photonote-${d.getFullYear()}${p(d.getMonth()+1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}.jpg`;
}

function formatDate(ts) {
  return new Date(ts).toLocaleDateString('sv-SE', { year:'numeric', month:'long', day:'numeric' });
}

function noteToHtml(note) {
  if (!note) return '<em>Ingen anteckning</em>';
  return note.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/\n/g,'<br>');
}

async function renderGallery() {
  const gallery = document.getElementById('gallery');
  const entries = (await getAll()).reverse();
  if (!entries.length) {
    gallery.innerHTML = `<div class="empty-state"><div class="empty-icon">📷</div><p>Inga foton ännu</p><small>Tryck på kameraknappen nedtill för att komma igång</small></div>`;
    return;
  }
  gallery.innerHTML = entries.map(e => `
    <article class="card" data-id="${e.id}">
      <div class="card-img-wrap"><img src="${e.image}" alt="Foto" loading="lazy"></div>
      <div class="card-body">
        <p class="card-note">${noteToHtml(e.note)}</p>
        <time class="card-date">${formatDate(e.timestamp)}</time>
      </div>
    </article>`).join('');
  gallery.querySelectorAll('.card').forEach(card =>
    card.addEventListener('click', () => openViewModal(Number(card.dataset.id)))
  );
}

// ── Modal helpers ──────────────────────────────────────────
function showModal(id) {
  const m = document.getElementById(id);
  m.classList.remove('hidden');
  requestAnimationFrame(() => m.querySelector('.modal-content').classList.add('slide-up'));
}
function hideModal(id) {
  const m = document.getElementById(id);
  const c = m.querySelector('.modal-content');
  c.classList.remove('slide-up');
  c.addEventListener('transitionend', () => m.classList.add('hidden'), { once: true });
}

// ── Kamera (getUserMedia) ──────────────────────────────────
let cameraStream = null;
let pendingImage = null;

async function startCamera() {
  try {
    cameraStream = await navigator.mediaDevices.getUserMedia({
      video: { facingMode: { ideal: 'environment' }, width: { ideal: 1920 }, height: { ideal: 1080 } },
      audio: false
    });
    const video = document.getElementById('cam-video');
    video.srcObject = cameraStream;
    document.getElementById('camera-view').classList.remove('hidden');
  } catch (err) {
    // Fallback: vanlig file input
    document.getElementById('file-fallback').click();
  }
}

function stopCamera() {
  if (cameraStream) { cameraStream.getTracks().forEach(t => t.stop()); cameraStream = null; }
  document.getElementById('camera-view').classList.add('hidden');
}

async function snapPhoto() {
  const video = document.getElementById('cam-video');
  const canvas = document.createElement('canvas');
  canvas.width = video.videoWidth;
  canvas.height = video.videoHeight;
  canvas.getContext('2d').drawImage(video, 0, 0);
  stopCamera();
  const dataUrl = canvas.toDataURL('image/jpeg', 0.95);
  pendingImage = await compress(dataUrl);
  document.getElementById('preview-img').src = pendingImage;
  document.getElementById('note-input').value = '';
  showModal('capture-modal');
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
function closeViewModal() { hideModal('view-modal'); currentEntry = null; }

// ── Init ───────────────────────────────────────────────────
async function init() {
  db = await openDB();
  await renderGallery();

  if ('serviceWorker' in navigator)
    navigator.serviceWorker.register('./sw.js').catch(console.error);

  document.getElementById('capture-btn').addEventListener('click', startCamera);
  document.getElementById('cam-close').addEventListener('click', stopCamera);
  document.getElementById('cam-shutter').addEventListener('click', snapPhoto);

  // Fallback file input
  document.getElementById('file-fallback').addEventListener('change', async e => {
    const file = e.target.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onload = async ev => {
      pendingImage = await compress(ev.target.result);
      document.getElementById('preview-img').src = pendingImage;
      document.getElementById('note-input').value = '';
      e.target.value = '';
      showModal('capture-modal');
    };
    reader.readAsDataURL(file);
  });

  document.getElementById('retake-btn').addEventListener('click', () => {
    hideModal('capture-modal');
    pendingImage = null;
    setTimeout(startCamera, 300);
  });

  document.getElementById('cancel-btn').addEventListener('click', () => {
    hideModal('capture-modal'); pendingImage = null;
  });

  document.getElementById('save-btn').addEventListener('click', async () => {
    if (!pendingImage) return;
    const note = document.getElementById('note-input').value.trim();
    await addEntry({ image: pendingImage, note, timestamp: Date.now() });
    const composite = await buildComposite(pendingImage, note);
    triggerDownload(composite, dateFilename());
    hideModal('capture-modal');
    pendingImage = null;
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

  document.getElementById('download-btn').addEventListener('click', async () => {
    if (!currentEntry) return;
    const composite = await buildComposite(currentEntry.image, currentEntry.note);
    triggerDownload(composite, dateFilename());
  });

  document.querySelectorAll('.modal').forEach(modal =>
    modal.addEventListener('click', e => {
      if (e.target !== modal) return;
      if (modal.id === 'capture-modal') { hideModal('capture-modal'); pendingImage = null; }
      else closeViewModal();
    })
  );
}

init().catch(console.error);
