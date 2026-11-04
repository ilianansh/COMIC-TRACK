// Comic Tracker — all application code in one file.
// Sections: storage, ui helpers, folders, entries, library, profile, app (router).

// ============================================================
// STORAGE
// ============================================================
// storage.js — persistence only.
// Small structured data -> localStorage. Cover/profile images (blobs) -> IndexedDB.

const STORAGE_KEY = 'comicTracker.v1';
const DB_NAME = 'comicTrackerImages';
const STORE = 'images';

const defaultState = () => ({
  comics: [],   // { id, title, coverId, author, releaseDate, type, review, rating, status, favorite, folderId, createdAt }
  folders: [],  // { id, name }
  profile: { name: 'Reader', pfpId: null, faves: [] } // faves = up to 4 comic ids
});

const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);

function loadState() {
  try {
    return { ...defaultState(), ...JSON.parse(localStorage.getItem(STORAGE_KEY)) };
  } catch {
    return defaultState(); // corrupted data: start fresh instead of crashing
  }
}

/** The single source of truth. Modules mutate it, then call commit(). */
const state = loadState();

/** Save to localStorage and tell the app to re-render. */
function commit() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
  } catch {
    alert('Could not save your data: browser storage is full or unavailable.');
  }
  document.dispatchEvent(new Event('state-changed'));
}

// ---------- Images (IndexedDB) ----------
let dbPromise;
const urlCache = new Map(); // image id -> object URL

function openDb() {
  dbPromise ||= new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(STORE);
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
  return dbPromise;
}

async function run(mode, action) {
  const db = await openDb();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, mode);
    const request = action(tx.objectStore(STORE));
    tx.oncomplete = () => resolve(request.result);
    tx.onerror = () => reject(tx.error);
  });
}

async function saveImage(file) {
  const id = uid();
  await run('readwrite', store => store.put(file, id));
  return id;
}

/** Returns an object URL for the image, or null if missing. */
async function getImageUrl(id) {
  if (!id) return null;
  if (urlCache.has(id)) return urlCache.get(id);
  try {
    const blob = await run('readonly', store => store.get(id));
    if (!blob) return null;
    const url = URL.createObjectURL(blob);
    urlCache.set(id, url);
    return url;
  } catch {
    return null;
  }
}

async function deleteImage(id) {
  if (!id) return;
  if (urlCache.has(id)) URL.revokeObjectURL(urlCache.get(id));
  urlCache.delete(id);
  try { await run('readwrite', store => store.delete(id)); } catch { /* ignore */ }
}

// ============================================================
// UI
// ============================================================
// ui.js — small DOM helpers shared by every view.

/** h('div', {class:'x', onclick: fn}, child, ...) -> element. Text is inserted safely. */
function h(tag, props = {}, ...children) {
  const el = document.createElement(tag);
  for (const [key, value] of Object.entries(props)) {
    if (value == null || value === false) continue;
    if (key === 'class') el.className = value;
    else if (key.startsWith('on')) el.addEventListener(key.slice(2), value);
    else if (key in el) el[key] = value;
    else el.setAttribute(key, value === true ? '' : value);
  }
  for (const child of children.flat()) if (child != null && child !== false) el.append(child);
  return el;
}

/** Cover box that shows a placeholder until (or instead of) the stored image. */
function coverEl(comic, cls = 'cover') {
  const box = h('div', { class: cls }, h('span', { class: 'ph' }, comic.title || 'No cover'));
  getImageUrl(comic.coverId).then(url => {
    if (url) box.replaceChildren(h('img', { src: url, alt: comic.title, loading: 'lazy' }));
  });
  return box;
}

const starText = n => '★'.repeat(n) + '☆'.repeat(5 - n);

/** Clickable 5-star control. Clicking the current value clears the rating. */
function stars(value, onChange) {
  const wrap = h('div', { class: 'stars', role: 'group', 'aria-label': 'Rating' });
  const paint = v => [...wrap.children].forEach((b, i) => b.classList.toggle('on', i < v));
  for (let i = 1; i <= 5; i++) {
    wrap.append(h('button', {
      type: 'button', class: 'star', 'aria-label': `${i} star${i > 1 ? 's' : ''}`,
      onclick: () => { value = value === i ? 0 : i; paint(value); onChange(value); }
    }, '★'));
  }
  paint(value);
  return wrap;
}

function openModal(title, body) {
  const dlg = h('dialog', { class: 'modal' },
    h('header', {}, h('h2', {}, title),
      h('button', { class: 'icon-btn', type: 'button', 'aria-label': 'Close', onclick: () => dlg.close() }, '✕')),
    body);
  dlg.addEventListener('close', () => dlg.remove());
  document.body.append(dlg);
  dlg.showModal();
  return dlg;
}

/** Resolves true if the user confirms. */
function confirmDialog(message, okLabel = 'Delete') {
  return new Promise(resolve => {
    let ok = false;
    const dlg = openModal('Please confirm', h('div', { class: 'form' },
      h('p', {}, message),
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn danger', type: 'button', onclick: () => { ok = true; dlg.close(); } }, okLabel))));
    dlg.addEventListener('close', () => resolve(ok));
  });
}

/** Asks for one line of text. validate(text) returns an error string or ''. Resolves text or null. */
function promptDialog(title, label, initial = '', validate = () => '') {
  return new Promise(resolve => {
    let result = null;
    const input = h('input', { class: 'input', name: 'value', value: initial, maxLength: 40, required: true });
    const error = h('p', { class: 'error', role: 'alert' });
    const form = h('form', { class: 'form' },
      h('label', { class: 'field' }, h('span', {}, label), input), error,
      h('div', { class: 'row end' },
        h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
        h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
    const dlg = openModal(title, form);
    form.addEventListener('submit', e => {
      e.preventDefault();
      const text = input.value.trim();
      error.textContent = text ? validate(text) : 'Please enter a name.';
      if (!error.textContent) { result = text; dlg.close(); }
    });
    dlg.addEventListener('close', () => resolve(result));
    input.select();
  });
}

// ============================================================
// FOLDERS
// ============================================================
// folders.js — folder data operations and the Folders page.

const nameTaken = (name, ignoreId) =>
  state.folders.some(f => f.id !== ignoreId && f.name.toLowerCase() === name.toLowerCase());

async function createFolder() {
  const name = await promptDialog('New folder', 'Folder name', '',
    n => (nameTaken(n) ? 'A folder with that name already exists.' : ''));
  if (!name) return;
  state.folders.push({ id: uid(), name });
  commit();
}

async function renameFolder(folder) {
  const name = await promptDialog('Rename folder', 'Folder name', folder.name,
    n => (nameTaken(n, folder.id) ? 'A folder with that name already exists.' : ''));
  if (!name) return;
  folder.name = name;
  commit();
}

/** Deleting a folder never deletes comics: they move to "Unsorted". */
async function deleteFolder(folder) {
  const count = state.comics.filter(c => c.folderId === folder.id).length;
  const ok = await confirmDialog(
    `Delete the folder "${folder.name}"? Its ${count} comic(s) will be kept and moved to Unsorted.`);
  if (!ok) return;
  state.comics.forEach(c => { if (c.folderId === folder.id) c.folderId = null; });
  state.folders = state.folders.filter(f => f.id !== folder.id);
  commit();
}

/** The Folders page (#/folders): open, create, rename or delete folders. */
function renderFoldersPage(root) {
  const item = (href, label, count, actions = []) => h('div', { class: 'folder-item' },
    h('a', { class: 'folder-open', href }, h('span', {}, label), h('small', {}, `${count} comic${count === 1 ? '' : 's'}`)),
    actions);
  const buttons = f => [
    h('button', { class: 'icon-btn', type: 'button', title: 'Rename', 'aria-label': `Rename ${f.name}`, onclick: () => renameFolder(f) }, '✎'),
    h('button', { class: 'icon-btn', type: 'button', title: 'Delete', 'aria-label': `Delete ${f.name}`, onclick: () => deleteFolder(f) }, '✕')
  ];

  root.append(h('section', {},
    h('a', { class: 'back', href: '#/' }, '← Library'),
    h('div', { class: 'row between' },
      h('h1', {}, 'Folders'),
      h('button', { class: 'btn primary', type: 'button', onclick: createFolder }, '+ New folder')),
    h('div', { class: 'folder-list' },
      item('#/', 'All comics', state.comics.length),
      item('#/folder/none', 'Unsorted', state.comics.filter(c => !c.folderId).length),
      state.folders.map(f => item(`#/folder/${f.id}`, f.name, state.comics.filter(c => c.folderId === f.id).length, buttons(f)))),
    state.folders.length ? null : h('p', { class: 'muted' }, 'No folders yet. Create one to organize your comics.')));
}

// ============================================================
// ENTRIES
// ============================================================
// entries.js — comic data operations, the add/edit form and the detail view.

const STATUSES = { want: 'Want to Read', reading: 'Currently Reading', read: 'Read' };
const MAX_COVER_BYTES = 10 * 1024 * 1024;

const findComic = id => state.comics.find(c => c.id === id);

async function saveComic(data, file, existing) {
  let coverId = existing?.coverId ?? null;
  if (file) {
    const newId = await saveImage(file);
    await deleteImage(coverId); // replace old cover
    coverId = newId;
  }
  if (existing) Object.assign(existing, data, { coverId });
  else state.comics.unshift({ id: uid(), createdAt: Date.now(), coverId, ...data });
  commit();
}

async function deleteComic(comic) {
  if (!await confirmDialog(`Delete "${comic.title}" permanently? This cannot be undone.`)) return;
  await deleteImage(comic.coverId);
  state.comics = state.comics.filter(c => c.id !== comic.id);
  state.profile.faves = state.profile.faves.filter(id => id !== comic.id); // keep profile consistent
  location.hash = '#/';
  commit();
}

/** Add form (comic = null) or edit form. defaultFolder pre-selects a folder for new entries. */
function openEntryForm(comic = null, defaultFolder = null) {
  let rating = comic?.rating || 0;
  const err = h('p', { class: 'error', role: 'alert' });
  const preview = comic ? coverEl(comic, 'cover small') : h('div', { class: 'cover small' }, h('span', { class: 'ph' }, 'No cover'));
  const fileInput = h('input', {
    type: 'file', name: 'cover', accept: 'image/*', class: 'input',
    onchange: () => {
      const file = fileInput.files[0];
      if (file) preview.replaceChildren(h('img', { src: URL.createObjectURL(file), alt: 'Cover preview' }));
    }
  });
  const field = (label, input) => h('label', { class: 'field' }, h('span', {}, label), input);
  const folderId = comic ? comic.folderId : (defaultFolder !== 'none' ? defaultFolder : null);

  const form = h('form', { class: 'form' },
    h('div', { class: 'row' }, preview, field('Cover image', fileInput)),
    field('Title *', h('input', { class: 'input', name: 'title', required: true, maxLength: 150, value: comic?.title ?? '' })),
    h('div', { class: 'two-col' },
      field('Author', h('input', { class: 'input', name: 'author', maxLength: 100, value: comic?.author ?? '' })),
      field('Release date', h('input', { class: 'input', name: 'releaseDate', type: 'date', value: comic?.releaseDate ?? '' }))),
    h('div', { class: 'two-col' },
      field('Comic type', h('input', { class: 'input', name: 'type', maxLength: 40, placeholder: 'Manga, graphic novel…', value: comic?.type ?? '' })),
      field('Reading status', h('select', { class: 'input', name: 'status' },
        Object.entries(STATUSES).map(([v, l]) => h('option', { value: v, selected: (comic?.status ?? 'want') === v }, l))))),
    field('Folder', h('select', { class: 'input', name: 'folderId' },
      h('option', { value: '', selected: !folderId }, 'Unsorted'),
      state.folders.map(f => h('option', { value: f.id, selected: f.id === folderId }, f.name)))),
    h('div', { class: 'field' }, h('span', {}, 'Rating'), stars(rating, v => { rating = v; })),
    field('Personal review', h('textarea', { class: 'input', name: 'review', rows: 4, maxLength: 5000, value: comic?.review ?? '' })),
    h('label', { class: 'row' }, h('input', { type: 'checkbox', name: 'favorite', checked: !!comic?.favorite }), 'Mark as favorite'),
    err,
    h('div', { class: 'row end' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, comic ? 'Save changes' : 'Add comic')));

  const dlg = openModal(comic ? 'Edit comic' : 'New entry', form);
  form.addEventListener('submit', async e => {
    e.preventDefault();
    const fd = new FormData(form);
    const title = fd.get('title').trim();
    const file = fileInput.files[0];
    if (!title) { err.textContent = 'Title is required.'; return; }
    if (file && !file.type.startsWith('image/')) { err.textContent = 'The cover must be an image file.'; return; }
    if (file && file.size > MAX_COVER_BYTES) { err.textContent = 'The cover must be smaller than 10 MB.'; return; }
    await saveComic({
      title, rating,
      author: fd.get('author').trim(),
      releaseDate: fd.get('releaseDate'),
      type: fd.get('type').trim(),
      status: fd.get('status'),
      folderId: fd.get('folderId') || null,
      review: fd.get('review').trim(),
      favorite: fd.has('favorite')
    }, file, comic);
    dlg.close();
  });
}

const formatDate = iso => {
  const date = new Date(iso + 'T00:00:00');
  return isNaN(date) ? iso : date.toLocaleDateString(undefined, { year: 'numeric', month: 'long', day: 'numeric' });
};

function renderDetail(root, id) {
  const comic = findComic(id);
  const folder = state.folders.find(f => f.id === comic.folderId);
  const menu = h('details', { class: 'menu' },
    h('summary', { 'aria-label': 'More actions' }, '⋮'),
    h('div', { class: 'menu-list' },
      h('button', { type: 'button', onclick: () => { menu.open = false; openEntryForm(comic); } }, 'Edit'),
      h('button', { type: 'button', class: 'danger-text', onclick: () => { menu.open = false; deleteComic(comic); } }, 'Delete')));

  const rows = [
    ['Author', comic.author],
    ['Released', comic.releaseDate && formatDate(comic.releaseDate)],
    ['Type', comic.type],
    ['Folder', folder ? h('a', { href: `#/folder/${folder.id}` }, folder.name) : 'Unsorted']
  ].filter(([, v]) => v).flatMap(([k, v]) => [h('dt', {}, k), h('dd', {}, v)]);

  root.append(h('article', { class: 'detail' },
    h('a', { class: 'back', href: '#/' }, '← Library'),
    h('div', { class: 'detail-body' },
      coverEl(comic, 'cover large'),
      h('div', { class: 'detail-info' },
        h('div', { class: 'row between' }, h('h1', {}, comic.title), menu),
        h('dl', { class: 'meta' }, rows),
        h('div', { class: 'row' },
          h('select', { class: 'input', style: 'width:auto', 'aria-label': 'Reading status', onchange: e => { comic.status = e.target.value; commit(); } },
            Object.entries(STATUSES).map(([v, l]) => h('option', { value: v, selected: comic.status === v }, l))),
          stars(comic.rating || 0, v => { comic.rating = v; commit(); }),
          h('button', { class: 'btn' + (comic.favorite ? ' pink-on' : ''), type: 'button', onclick: () => { comic.favorite = !comic.favorite; commit(); } },
            comic.favorite ? '♥ Favorite' : '♡ Mark favorite')),
        comic.review ? h('p', { class: 'review' }, comic.review) : h('p', { class: 'muted' }, 'No review yet. Use the ⋮ menu to edit this entry.')))));
}

// ============================================================
// LIBRARY
// ============================================================
// library.js — library page: folder panel, search/filters and the cover grid.

// Filters survive re-renders (e.g. after editing a status) but reset on reload.
const filters = { query: '', status: '' };

function matches(comic, folderId) {
  if (folderId === 'none' && comic.folderId) return false;
  if (folderId && folderId !== 'none' && comic.folderId !== folderId) return false;
  if (filters.status && comic.status !== filters.status) return false;
  const q = filters.query.trim().toLowerCase();
  return !q || [comic.title, comic.author, comic.type].some(v => (v || '').toLowerCase().includes(q));
}

function card(comic) {
  return h('a', { class: 'card', href: `#/comic/${comic.id}`, title: comic.title },
    coverEl(comic),
    h('div', { class: 'card-title' }, comic.title),
    h('div', { class: 'card-meta' },
      h('span', { class: `badge ${comic.status}` }, STATUSES[comic.status] || ''),
      comic.rating ? h('span', { class: 'stars-ro', 'aria-label': `${comic.rating} of 5 stars` }, starText(comic.rating)) : null,
      comic.favorite ? h('span', { class: 'heart', 'aria-label': 'Favorite' }, '♥') : null));
}

function emptyState(folderId) {
  const libraryEmpty = state.comics.length === 0;
  return h('div', { class: 'empty' },
    h('h2', {}, libraryEmpty ? 'Your library is empty yasmine :(' : 'No comics found'),
    h('p', {}, libraryEmpty ? 'Add your first comic!' : 'Mmh try a different search, status or folder.'),
    libraryEmpty ? h('button', { class: 'btn primary', type: 'button', onclick: () => openEntryForm(null, folderId) }, 'Add a comic') : null);
}

function renderLibrary(root, folderId) {
  const folder = state.folders.find(f => f.id === folderId);
  const title = folder ? folder.name : folderId === 'none' ? 'Unsorted' : 'All comics';
  const grid = h('div', { class: 'grid' });

  // Only the grid is redrawn while typing so the search box keeps focus.
  const refreshGrid = () => {
    const visible = state.comics.filter(c => matches(c, folderId));
    grid.replaceChildren(...(visible.length ? visible.map(card) : [emptyState(folderId)]));
  };

  const search = h('input', {
    class: 'input search', type: 'search', placeholder: 'Search title, author or type', 'aria-label': 'Search', value: filters.query,
    oninput: e => { filters.query = e.target.value; refreshGrid(); }
  });
  const status = h('select', {
    class: 'input', 'aria-label': 'Filter by status', style: 'flex:0 0 auto;width:auto',
    onchange: e => { filters.status = e.target.value; refreshGrid(); }
  }, h('option', { value: '' }, 'Any status'),
    Object.entries(STATUSES).map(([v, l]) => h('option', { value: v, selected: filters.status === v }, l)));

  refreshGrid();
  root.append(h('section', { class: 'library' },
    folderId ? h('a', { class: 'back', href: '#/folders' }, '← Folders') : null,
    h('div', { class: 'row between', style: 'margin-bottom:.8rem' },
      h('h1', { class: 'library-title' }, title),
      h('button', { class: 'btn primary', type: 'button', onclick: () => openEntryForm(null, folderId) }, '+ New entry')),
    h('div', { class: 'toolbar' }, search, status, h('a', { class: 'btn', href: '#/folders' }, 'View Folders')),
    grid));
}

// ============================================================
// PROFILE
// ============================================================
// profile.js — profile page: avatar, stats, Four Faves and Currently Reading.
// All profile editing (name, picture, favorites) happens in ONE dialog: openProfileForm.

const MAX_FAVES = 4;

const coverLink = comic => h('a', { href: `#/comic/${comic.id}`, title: comic.title }, coverEl(comic));
const countStatus = status => state.comics.filter(c => c.status === status).length;
const stat = (value, label) => h('div', { class: 'stat' }, h('strong', {}, value), label);

/** Cover grid where the user toggles up to four favorites. Mutates `selected`. */
function favoritePicker(selected) {
  const counter = h('p', { class: 'muted' });
  const updateCounter = () => { counter.textContent = `${selected.length} of ${MAX_FAVES} selected`; };
  const buttons = state.comics.map(comic => {
    const button = h('button', {
      class: 'pick' + (selected.includes(comic.id) ? ' selected' : ''), type: 'button', 'aria-pressed': selected.includes(comic.id),
      onclick: () => {
        const at = selected.indexOf(comic.id);
        if (at >= 0) selected.splice(at, 1);
        else if (selected.length < MAX_FAVES) selected.push(comic.id);
        else { counter.textContent = `You can pick at most ${MAX_FAVES}. Deselect one first.`; return; }
        button.classList.toggle('selected', at < 0);
        button.setAttribute('aria-pressed', at < 0);
        updateCounter();
      }
    }, coverEl(comic), comic.title);
    return button;
  });
  updateCounter();
  return h('div', { class: 'field' }, h('span', {}, 'Four favorites'),
    state.comics.length ? h('div', { class: 'pick-grid' }, buttons) : h('p', { class: 'muted' }, 'Add comics to your library to choose favorites.'),
    counter);
}

function openProfileForm() {
  const { profile } = state;
  const selected = profile.faves.filter(id => findComic(id)); // working copy; only saved on "Save"
  const err = h('p', { class: 'error', role: 'alert' });
  const file = h('input', { class: 'input', type: 'file', accept: 'image/*' });
  const name = h('input', { class: 'input', required: true, maxLength: 40, value: profile.name });
  const form = h('form', { class: 'form' },
    h('label', { class: 'field' }, h('span', {}, 'Display name'), name),
    h('label', { class: 'field' }, h('span', {}, 'Profile picture'), file),
    favoritePicker(selected),
    err,
    h('div', { class: 'row end' },
      h('button', { class: 'btn', type: 'button', onclick: () => dlg.close() }, 'Cancel'),
      h('button', { class: 'btn primary', type: 'submit' }, 'Save')));
  const dlg = openModal('Edit profile', form);

  form.addEventListener('submit', async e => {
    e.preventDefault();
    const picked = file.files[0];
    if (!name.value.trim()) { err.textContent = 'Display name is required.'; return; }
    if (picked && !picked.type.startsWith('image/')) { err.textContent = 'The picture must be an image file.'; return; }
    if (picked) {
      const newId = await saveImage(picked);
      await deleteImage(profile.pfpId);
      profile.pfpId = newId;
    }
    profile.name = name.value.trim();
    profile.faves = selected;
    commit(); // re-renders the page and the header picture
    dlg.close();
  });
}

function renderProfile(root) {
  const { profile } = state;
  const avatar = h('div', { class: 'avatar' }, profile.name.charAt(0).toUpperCase());
  getImageUrl(profile.pfpId).then(url => url && avatar.replaceChildren(h('img', { src: url, alt: 'Profile picture' })));

  const faves = profile.faves.map(findComic).filter(Boolean);
  const slots = Array.from({ length: MAX_FAVES }, (_, i) => faves[i]
    ? coverLink(faves[i])
    : h('button', { class: 'slot-empty', type: 'button', 'aria-label': 'Add a favorite (opens Edit profile)', onclick: openProfileForm }, '+'));
  const reading = state.comics.filter(c => c.status === 'reading');

  root.append(h('div', { class: 'profile' },
    h('div', { class: 'profile-head' }, avatar,
      h('div', {}, h('h1', {}, profile.name), h('button', { class: 'btn small', type: 'button', onclick: openProfileForm }, 'Edit profile')),
      h('div', { class: 'stats' }, stat(countStatus('read'), 'Total Read'), stat(countStatus('want'), 'Want to Read'))),
    h('div', { class: 'faves', role: 'group', 'aria-label': 'Favorite comics' }, slots),
    h('section', { class: 'section' },
      h('div', { class: 'row' }, h('h2', {}, 'Currently Reading')),
      reading.length
        ? h('div', { class: 'grid' }, reading.map(coverLink))
        : h('p', { class: 'muted' }, 'Nothing in progress. Set a comic to "Currently Reading" and it will show up here.'))));
}

// ============================================================
// APP
// ============================================================
// app.js — entry point: hash router, quick-action button, re-render on data changes.

const root = document.getElementById('app');

// Header avatar: shows the saved profile picture, or the default silhouette from index.html.
const avatarBox = document.getElementById('header-avatar');
const defaultAvatar = avatarBox.firstElementChild.cloneNode(true);
let shownPfp; // last picture id displayed, to skip needless reloads
async function updateHeaderAvatar() {
  const id = state.profile.pfpId;
  if (id === shownPfp) return;
  shownPfp = id;
  const url = await getImageUrl(id);
  if (id !== shownPfp) return; // changed while loading
  avatarBox.replaceChildren(url ? h('img', { src: url, alt: '' }) : defaultAvatar.cloneNode(true));
}

/** Routes: #/ , #/folders , #/folder/<id|none> , #/comic/<id> , #/profile */
function render() {
  const [, route = '', param] = location.hash.slice(1).split('/');
  let active = 'library';
  root.replaceChildren();
  if (route === 'profile') { active = 'profile'; renderProfile(root); }
  else if (route === 'folders') renderFoldersPage(root);
  else if (route === 'comic' && state.comics.some(c => c.id === param)) renderDetail(root, param);
  else if (route === 'folder' && (param === 'none' || state.folders.some(f => f.id === param))) renderLibrary(root, param);
  else renderLibrary(root, null);
  updateHeaderAvatar();
  document.querySelectorAll('[data-route]').forEach(a => a.classList.toggle('active', a.dataset.route === active));
}

function buildFab() {
  const close = () => { menu.hidden = true; toggle.classList.remove('open'); toggle.setAttribute('aria-expanded', 'false'); };
  const action = (label, fn) => h('button', { class: 'btn', type: 'button', onclick: () => { close(); fn(); } }, label);
  const menu = h('div', { class: 'fab-menu', hidden: true },
    action('New Entry', () => openEntryForm()),
    action('New Folder', createFolder),
    action('View Profile', () => { location.hash = '#/profile'; }));
  const toggle = h('button', {
    class: 'fab', type: 'button', 'aria-label': 'Quick actions', 'aria-expanded': 'false',
    onclick: () => {
      const opening = menu.hidden;
      menu.hidden = !opening;
      toggle.classList.toggle('open', opening);
      toggle.setAttribute('aria-expanded', opening);
    }
  }, '+');
  document.getElementById('fab-root').append(menu, toggle);
}

window.addEventListener('hashchange', () => { render(); window.scrollTo(0, 0); });
document.addEventListener('state-changed', render);
buildFab();
render();