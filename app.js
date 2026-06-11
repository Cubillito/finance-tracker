// app.js

// === FIREBASE CONFIG ===
if (!window.ENV || !window.ENV.firebaseConfig) {
  console.error('Configuración de Firebase no encontrada.');
}

const firebaseConfig = window.ENV.firebaseConfig;

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const firestore = firebase.firestore();

// Persistencia offline de Firestore: las escrituras sin conexión se encolan
// y se reintentan solas al volver la red (evita perder cambios al recargar).
firestore.enablePersistence({ synchronizeTabs: true }).catch((err) => {
  console.warn('Persistencia offline no disponible:', err.code || err);
});

// === ESTADO GLOBAL ===
const STORAGE_KEY = 'financeTrackerData';
let currentUser = null;
let appInitialized = false;

let db = {
  ingresos: [], gastos: [], ahorros: [], inversiones: [],
  creditos: [], deudas: [], recurrentes: [], presupuestos: [], config: []
};

// Distribución de ingresos (porcentajes por fondo)
window.distribucionReglas = null;

const emptyDb = () => ({
  ingresos: [], gastos: [], ahorros: [], inversiones: [],
  creditos: [], deudas: [], recurrentes: [], presupuestos: [], config: []
});

// Generador de UUID v4
function uuidv4() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

// Escapa texto de usuario antes de insertarlo en HTML (previene XSS)
function escapeHtml(value) {
  return String(value ?? '').replace(/[&<>"']/g, c => ({
    '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
  }[c]));
}

// === AUTENTICACIÓN (Firebase Auth con Google) ===

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnGoogleLogin').addEventListener('click', loginWithGoogle);

  // Restaurar tema guardado
  applyTheme(localStorage.getItem('financeTheme') || 'default');

  // Manejar resultado de redirect (si venimos de signInWithRedirect)
  auth.getRedirectResult().then((result) => {
    // El onAuthStateChanged se encargará del usuario si el redirect fue exitoso
  }).catch((err) => {
    console.error('Error en redirect result:', err);
    if (err.code && err.code !== 'auth/popup-closed-by-user') {
      showToast('Error al iniciar sesión: ' + err.message, 'error');
    }
  });

  // Escuchar cambios de sesión
  auth.onAuthStateChanged(async (user) => {
    if (user) {
      currentUser = user;
      showApp(user);
      await loadFromFirestore();
      if (!appInitialized) {
        initApp();
        appInitialized = true;
      } else {
        refreshViews();
      }
    } else {
      currentUser = null;
      showLogin();
    }
  });
});

async function loginWithGoogle() {
  const provider = new firebase.auth.GoogleAuthProvider();
  try {
    await auth.signInWithRedirect(provider);
  } catch (err) {
    console.error('Error en login:', err);
    showToast('Error al iniciar sesión: ' + err.message, 'error');
  }
}

function logOut() {
  // No dejar datos financieros en el navegador al cerrar sesión
  localStorage.removeItem(STORAGE_KEY);
  auth.signOut();
}
window.logOut = logOut;

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.querySelector('.app-container').style.display = 'none';
  // Hide FAB on login
  const fab = document.getElementById('fabBtn');
  if (fab) fab.style.display = 'none';
}

function showApp(user) {
  document.getElementById('loginScreen').style.display = 'none';
  document.querySelector('.app-container').style.display = 'block';

  // Show FAB on mobile
  const fab = document.getElementById('fabBtn');
  if (fab && window.innerWidth <= 768) fab.style.display = 'flex';

  // Mostrar info del usuario
  const userInfo = document.getElementById('userInfo');
  const avatar = document.getElementById('userAvatar');
  const name = document.getElementById('userName');

  userInfo.style.display = 'flex';
  avatar.src = user.photoURL || '';
  name.textContent = user.displayName || user.email;
}

// === ALMACENAMIENTO (Firestore + localStorage como caché) ===

async function saveItem(collectionName, item) {
  if (!currentUser) return;
  const docRef = firestore.collection('users').doc(currentUser.uid).collection(collectionName).doc(item.id);
  await docRef.set(item);
}

async function deleteItem(collectionName, itemId) {
  if (!currentUser) return;
  const docRef = firestore.collection('users').doc(currentUser.uid).collection(collectionName).doc(itemId);
  await docRef.delete();
}

function showSkeleton() {
  const sk = document.getElementById('skeletonLoader');
  if (sk) sk.classList.add('visible');
}

function hideSkeleton() {
  const sk = document.getElementById('skeletonLoader');
  if (sk) sk.classList.remove('visible');
}

async function loadFromFirestore() {
  showSkeleton();
  try {
    if (!currentUser) { hideSkeleton(); return; }
    const collections = ['ingresos', 'gastos', 'ahorros', 'inversiones', 'creditos', 'deudas', 'recurrentes', 'presupuestos', 'config'];
    const baseRef = firestore.collection('users').doc(currentUser.uid);
    
    let newDb = emptyDb();
    const promises = collections.map(async (coll) => {
      const snapshot = await baseRef.collection(coll).get();
      newDb[coll] = snapshot.docs.map(doc => doc.data());
    });
    
    await Promise.all(promises);

    // Cargar documento principal por si hay datos sin migrar (esquema antiguo)
    let hasOldData = false;
    const docSnap = await baseRef.get();
    if (docSnap.exists) {
      const oldData = docSnap.data();
      collections.forEach(coll => {
        if (oldData[coll] && Array.isArray(oldData[coll]) && oldData[coll].length > 0) {
          const existingIds = new Set(newDb[coll].map(i => i.id));
          oldData[coll].forEach(item => {
            if (!existingIds.has(item.id)) {
              newDb[coll].push(item);
              hasOldData = true;
            }
          });
        }
      });
    }

    db = newDb;
    
    // Configurar fondos
    let confFondos = db.config.find(c => c.id === 'userFondos');
    if (!confFondos) {
      confFondos = { id: 'userFondos', items: ['Personal', 'U'] };
      db.config.push(confFondos);
      saveItem('config', confFondos);
    }
    window.userFondos = confFondos.items;

    // Configurar categorías personalizadas
    const confCats = db.config.find(c => c.id === 'userCategorias');
    if (confCats && Array.isArray(confCats.items) && confCats.items.length > 0) {
      CATEGORIAS = confCats.items;
    } else {
      CATEGORIAS = [...CATEGORIAS_DEFAULT];
    }

    // Configurar distribución de ingresos
    let confDist = db.config.find(c => c.id === 'ingresosDistribucion');
    if (confDist) {
      window.distribucionReglas = confDist.reglas;
    } else {
      window.distribucionReglas = null;
    }

    localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
    markSaved();

    // Migrar automáticamente los datos antiguos a subcolecciones
    if (hasOldData) {
      console.log('Migrando datos antiguos a subcolecciones...');
      setTimeout(async () => {
        await saveToFirestore();
        // Limpiamos los arrays del doc raíz para no migrar 2 veces
        const updates = {};
        collections.forEach(c => updates[c] = firebase.firestore.FieldValue.delete());
        try { await baseRef.update(updates); } catch (e) { console.warn('Error limpiando doc:', e); }
      }, 1500);
    }
  } catch (err) {
    console.error('Error cargando de Firestore:', err);
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) db = { ...emptyDb(), ...JSON.parse(raw) };
    } catch(e) {}
    markUnsaved();
  } finally {
    hideSkeleton();
  }
}

async function saveToFirestore() {
  if (!currentUser) return;
  try {
    markUnsaved();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); // Guardado local inmediato
    const baseRef = firestore.collection('users').doc(currentUser.uid);
    const ops = [];
    Object.keys(db).forEach(col => {
      if (Array.isArray(db[col])) {
        db[col].forEach(item => {
          if (item && item.id) ops.push({ col, item });
        });
      }
    });
    // Escrituras en lotes (límite de Firestore: 500 operaciones por batch)
    for (let i = 0; i < ops.length; i += 450) {
      const batch = firestore.batch();
      ops.slice(i, i + 450).forEach(op => {
        batch.set(baseRef.collection(op.col).doc(op.item.id), op.item);
      });
      await batch.commit();
    }
    markSaved();
  } catch (err) {
    console.error('Error masivo Firestore:', err);
    markUnsaved();
  }
}
window.saveToFirestore = saveToFirestore;

// === IMPORTAR / EXPORTAR a data.json (respaldo local) ===

async function exportToFile() {
  try {
    if (window.showSaveFilePicker) {
      const handle = await window.showSaveFilePicker({
        suggestedName: 'data.json',
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const writable = await handle.createWritable();
      await writable.write(JSON.stringify(db, null, 2));
      await writable.close();
    } else {
      const blob = new Blob([JSON.stringify(db, null, 2)], { type: 'application/json' });
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = 'data.json';
      a.click();
      URL.revokeObjectURL(a.href);
    }
    showToast('Archivo exportado con éxito', 'success');
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
  }
}
window.exportToFile = exportToFile;

// Valida y normaliza un data.json importado: solo colecciones conocidas,
// solo arrays de objetos, y cada item con un id válido.
function sanitizeImportedData(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    throw new Error('El archivo no tiene el formato esperado');
  }
  const clean = emptyDb();
  Object.keys(clean).forEach(coll => {
    if (!Array.isArray(data[coll])) return;
    clean[coll] = data[coll]
      .filter(item => item && typeof item === 'object' && !Array.isArray(item))
      .map(item => ({ ...item, id: (typeof item.id === 'string' && item.id) ? item.id : uuidv4() }));
  });
  return clean;
}

async function importFromFile() {
  try {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const file = await handle.getFile();
      const data = JSON.parse(await file.text());
      db = sanitizeImportedData(data);
    } else {
      await new Promise((resolve, reject) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async () => {
          try {
            const file = input.files[0];
            if (file) {
              const data = JSON.parse(await file.text());
              db = sanitizeImportedData(data);
            }
            resolve();
          } catch (e) { reject(e); }
        };
        input.click();
      });
    }
    await saveToFirestore();
    refreshViews();
    showToast('Datos importados y sincronizados con la nube', 'success');
  } catch (err) {
    if (err.name !== 'AbortError') {
      console.error(err);
      showToast('No se pudo importar el archivo: ' + err.message, 'error');
    }
  }
}
window.importFromFile = importFromFile;

// Indicadores visuales
function markUnsaved() {
  const status = document.getElementById('saveStatus');
  status.innerHTML = '<span class="indicator unsaved"></span> Guardando...';
  document.getElementById('btnSaveApp').style.display = 'inline-flex';
}

function markSaved() {
  const status = document.getElementById('saveStatus');
  status.innerHTML = '<span class="indicator saved"></span> Sincronizado';
  document.getElementById('btnSaveApp').style.display = 'none';
}

// === TOAST NOTIFICATIONS ===
function showToast(message, type = 'success', duration = 3500) {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast-notification toast-' + type;
  
  const icons = {
    success: 'check_circle',
    error: 'error',
    warning: 'warning',
    info: 'info',
    confirm: 'help_outline'
  };
  
  toast.innerHTML = `
    <span class="material-icons-round toast-icon">${icons[type] || icons.info}</span>
    <span class="toast-message">${escapeHtml(message)}</span>
    <button class="toast-close" onclick="dismissToast(this.parentElement)"><span class="material-icons-round">close</span></button>
    <div class="toast-progress"><div class="toast-progress-bar"></div></div>
  `;
  toast.style.pointerEvents = 'auto';
  
  container.appendChild(toast);
  
  // Trigger animation
  requestAnimationFrame(() => {
    toast.classList.add('toast-show');
    const bar = toast.querySelector('.toast-progress-bar');
    if (bar && duration > 0) {
      bar.style.transition = `width ${duration}ms linear`;
      requestAnimationFrame(() => bar.style.width = '0%');
    }
  });
  
  if (duration > 0) {
    toast._timeout = setTimeout(() => dismissToast(toast), duration);
  }
  
  return toast;
}

function dismissToast(toast) {
  if (!toast || toast._dismissed) return;
  toast._dismissed = true;
  if (toast._timeout) clearTimeout(toast._timeout);
  toast.classList.remove('toast-show');
  toast.classList.add('toast-hide');
  setTimeout(() => toast.remove(), 400);
}

function showConfirmToast(message, onConfirm, onCancel, confirmLabel = 'Sí, confirmar') {
  const container = document.getElementById('toastContainer');
  if (!container) return;

  const toast = document.createElement('div');
  toast.className = 'toast-notification toast-confirm';
  toast.style.pointerEvents = 'auto';
  
  toast.innerHTML = `
    <span class="material-icons-round toast-icon">help_outline</span>
    <div class="toast-confirm-body">
      <span class="toast-message">${escapeHtml(message)}</span>
      <div class="toast-confirm-actions">
        <button class="btn btn-danger btn-sm toast-btn-confirm">${escapeHtml(confirmLabel)}</button>
        <button class="btn btn-outline btn-sm toast-btn-cancel">Cancelar</button>
      </div>
    </div>
  `;
  
  container.appendChild(toast);
  requestAnimationFrame(() => toast.classList.add('toast-show'));
  
  toast.querySelector('.toast-btn-confirm').addEventListener('click', () => {
    dismissToast(toast);
    if (onConfirm) onConfirm();
  });
  
  toast.querySelector('.toast-btn-cancel').addEventListener('click', () => {
    dismissToast(toast);
    if (onCancel) onCancel();
  });
}

// Prompt modal inline (replaces window.prompt)
function showPromptModal(title, defaultValue, onConfirm) {
  const existing = document.getElementById('promptOverlay');
  if (existing) existing.remove();
  
  const overlay = document.createElement('div');
  overlay.id = 'promptOverlay';
  overlay.className = 'modal active';
  overlay.innerHTML = `
    <div class="modal-content" style="max-width: 400px;">
      <div class="modal-header">
        <h3>${escapeHtml(title)}</h3>
        <button class="close-modal" id="promptClose">&times;</button>
      </div>
      <div class="form-group">
        <input type="text" id="promptInput" class="form-control" value="${escapeHtml(defaultValue || '')}">
      </div>
      <div style="display: flex; gap: 0.8rem; margin-top: 1rem;">
        <button class="btn btn-primary" id="promptOk" style="flex:1;">Confirmar</button>
        <button class="btn btn-outline" id="promptCancel" style="flex:1;">Cancelar</button>
      </div>
    </div>
  `;
  document.body.appendChild(overlay);
  
  const input = document.getElementById('promptInput');
  input.focus();
  input.select();
  
  const close = () => overlay.remove();
  
  document.getElementById('promptOk').addEventListener('click', () => {
    const val = input.value.trim();
    close();
    if (val && onConfirm) onConfirm(val);
  });
  document.getElementById('promptCancel').addEventListener('click', close);
  document.getElementById('promptClose').addEventListener('click', close);
  
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') document.getElementById('promptOk').click();
    if (e.key === 'Escape') close();
  });
}

// Llamar cada vez que se agrega/edita/elimina algo
async function syncData(action, type, item) {
  markUnsaved();
  // Guardar offline inmediatamente antes del request a Firebase
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  
  try {
    if (action === 'add' || action === 'edit') {
      if (Array.isArray(item)) {
        await Promise.all(item.map(it => saveItem(type, it)));
      } else {
        await saveItem(type, item);
      }
    } else if (action === 'delete') {
      await deleteItem(type, item.id || item);
    }
    
    markSaved();
  } catch (err) {
    console.error('Error sincronizando a Firestore:', err);
    markUnsaved();
  }
  refreshViews();
}





// === NAVEGACIÓN Y TABS ===

window.toggleMoreMenu = function() {
  const menu = document.getElementById('mobileMoreMenu');
  if (menu.style.display === 'none' || menu.style.display === '') {
    menu.style.display = 'flex';
  } else {
    menu.style.display = 'none';
  }
}

function initNav() {
  const tabs = document.querySelectorAll('.tab-btn');
  const views = document.querySelectorAll('.view');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      if (tab.id === 'btnMoreMenuToggle') return;

      tabs.forEach(t => t.classList.remove('active'));
      views.forEach(v => v.classList.remove('active'));
      
      const target = tab.getAttribute('data-target');
      if (target) {
        document.querySelectorAll(`.tab-btn[data-target="${target}"]`).forEach(t => t.classList.add('active'));
        document.getElementById(target).classList.add('active');

        // Renderizar el contenido de la vista a la que entramos.
        // refreshViews() detecta la vista activa y dibuja su tabla/gráficos.
        // (Antes solo se hacía para Resumen/Estadísticas, por lo que Deudas,
        //  Recurrentes y Registrar quedaban sin renderizar al abrir la pestaña.)
        refreshViews();
      }
    });
  });
}


// === INICIALIZACIÓN Y RENDERIZADO ===

// Formato moneda CLP
const formatMoney = (val) => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(val);

// === CATEGORÍAS CENTRALIZADAS (personalizables) ===
const CATEGORIAS_DEFAULT = [
  { value: 'comida',       label: '🍔 Comida' },
  { value: 'transporte',   label: '⛽ Transporte' },
  { value: 'salud',        label: '💊 Salud' },
  { value: 'entretención', label: '🎬 Entretención' },
  { value: 'ropa',         label: '👕 Ropa' },
  { value: 'hogar',        label: '🏠 Hogar' },
  { value: 'educación',    label: '📚 Educación' },
  { value: 'otro',         label: 'Otro' }
];
let CATEGORIAS = [...CATEGORIAS_DEFAULT];

function populateCategoriasSelect(selectId, includePlaceholder = true) {
  const sel = document.getElementById(selectId);
  if (!sel) return;
  const placeholder = includePlaceholder ? '<option value="">Seleccione...</option>' : '<option value="">Todas</option>';
  sel.innerHTML = placeholder + CATEGORIAS.map(c => `<option value="${escapeHtml(c.value)}">${escapeHtml(c.label)}</option>`).join('');
}

function refreshCategoriasSelects() {
  ['txCat', 'recCat', 'metaCategoria'].forEach(id => populateCategoriasSelect(id, true));
  populateCategoriasSelect('filterRegCat', false);
}

// Gestión de categorías
window.openCategoriasModal = function() {
  renderCategoriasList();
  document.getElementById('modalCategorias').classList.add('active');
};

function renderCategoriasList() {
  const container = document.getElementById('categoriasListContainer');
  if (!container) return;
  container.innerHTML = '';
  CATEGORIAS.forEach((cat, idx) => {
    const isDefault = CATEGORIAS_DEFAULT.some(d => d.value === cat.value);
    const item = document.createElement('div');
    item.className = 'cat-list-item';
    item.innerHTML = `
      <span style="font-size:1.2rem;">${escapeHtml(cat.label.split(' ')[0])}</span>
      <span>${escapeHtml(cat.label.split(' ').slice(1).join(' ') || cat.label)}</span>
      ${!isDefault
        ? `<button class="btn btn-danger btn-sm" onclick="deleteCategoriaConfig(${idx})" title="Eliminar">🗑</button>`
        : `<span class="text-muted" style="font-size:0.75rem; margin-left:auto;">predeterminada</span>`
      }
    `;
    container.appendChild(item);
  });
}

window.addCategoriaConfig = async function() {
  const emoji = (document.getElementById('nuevaCatEmoji').value || '🏷️').trim();
  const nombre = document.getElementById('nuevaCatNombre').value.trim();
  if (!nombre) { showToast('Ingresa un nombre para la categoría', 'warning'); return; }
  const value = nombre.toLowerCase().replace(/\s+/g, '_').replace(/[^a-z0-9_áéíóúñ]/g, '');
  if (CATEGORIAS.some(c => c.value === value)) { showToast('Ya existe esa categoría', 'warning'); return; }
  CATEGORIAS.push({ value, label: `${emoji} ${nombre}` });
  document.getElementById('nuevaCatEmoji').value = '';
  document.getElementById('nuevaCatNombre').value = '';
  await saveCategoriasConfig();
  renderCategoriasList();
  refreshCategoriasSelects();
  showToast(`Categoría "${nombre}" agregada`, 'success');
};

window.deleteCategoriaConfig = async function(idx) {
  const cat = CATEGORIAS[idx];
  showConfirmToast(`¿Eliminar categoría "${cat.label}"?`, async () => {
    CATEGORIAS.splice(idx, 1);
    await saveCategoriasConfig();
    renderCategoriasList();
    refreshCategoriasSelects();
    showToast('Categoría eliminada', 'success');
  });
};

async function saveCategoriasConfig() {
  const doc = { id: 'userCategorias', items: CATEGORIAS };
  const existing = db.config.find(c => c.id === 'userCategorias');
  if (existing) { existing.items = CATEGORIAS; } else { db.config.push(doc); }
  await saveItem('config', doc);
}

function populateFilterRegFondo() {
  const sel = document.getElementById('filterRegFondo');
  if (!sel) return;
  sel.innerHTML = '<option value="">Todos</option>' +
    (window.userFondos || []).map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('') +
    '<option value="Ahorro">Ahorro</option>' +
    '<option value="Inversion">Inversión</option>';
}

function initApp() {
  initNav();
  
  // Setear filtros iniciales (Mes Actual)
  const d = new Date();
  const currentMonthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  
  document.getElementById('filterResumenMonth').value = currentMonthStr;
  document.getElementById('filterRegMonth').value = currentMonthStr;
  document.getElementById('filterStatsMonth').value = currentMonthStr;
  document.getElementById('filterStatsYear').value = d.getFullYear();

  // Poblar selects de categorías dinámicamente
  populateCategoriasSelect('txCat', true);
  populateCategoriasSelect('recCat', true);
  populateCategoriasSelect('metaCategoria', true);
  populateCategoriasSelect('filterRegCat', false);

  // Poblar filtro de fondo dinámicamente
  populateFilterRegFondo();

  // Listeners Filtros
  document.getElementById('filterResumenMonth').addEventListener('change', renderResumen);
  document.getElementById('filterRegMonth').addEventListener('change', renderRegistro);
  document.getElementById('filterRegFondo').addEventListener('change', renderRegistro);
  document.getElementById('filterRegCat').addEventListener('change', renderRegistro);
  document.getElementById('searchReg').addEventListener('input', renderRegistro);
  document.getElementById('filterStatsMonth').addEventListener('change', renderStatsMensuales);
  document.getElementById('filterStatsYear').addEventListener('change', renderStatsAnuales);

  // Listeners Botones Modales Generales
  document.querySelectorAll('[data-close]').forEach(btn => {
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      document.getElementById(btn.getAttribute('data-close')).classList.remove('active');
    });
  });

  // Setup de Modales Principales
  setupRegistroModals();
  setupDeudasModales();
  setupRecurrentesModales();

  // Listeners Formulario Meta
  setupMetasModal();

  // FAB button (mobile quick add)
  setupFAB();

  refreshViews();
}

function renderMetasList() {
  const container = document.getElementById('metasListContainer');
  const noMsg = document.getElementById('noMetasMsg');
  if (!container) return;
  container.innerHTML = '';
  
  if (!db.presupuestos || db.presupuestos.length === 0) {
    if (noMsg) noMsg.style.display = 'block';
    return;
  }
  if (noMsg) noMsg.style.display = 'none';
  
  db.presupuestos.forEach(p => {
    const fondoLabel = p.fondo ? ` — ${escapeHtml(p.fondo)}` : '';
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'padding: 1.2rem; display: flex; justify-content: space-between; align-items: center;';
    card.innerHTML = `
      <div>
        <div style="font-size: 1.1rem; font-weight: 600; margin-bottom: 0.3rem;">
          ${getIconForCat(p.categoria)} ${escapeHtml(p.categoria.charAt(0).toUpperCase() + p.categoria.slice(1))}${fondoLabel}
        </div>
        <div class="text-muted" style="font-size: 0.9rem;">Límite: ${formatMoney(p.monto)}</div>
      </div>
      <div class="action-btns">
        <button class="btn btn-outline btn-sm" onclick="editMeta('${p.id}')">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="deleteMeta('${p.id}')">🗑️</button>
      </div>
    `;
    container.appendChild(card);
  });
}

function setupMetasModal() {
  // Llenar el select de fondos dinámicamente
  function populateMetaFondos() {
    const sel = document.getElementById('metaFondo');
    if (!sel) return;
    sel.innerHTML = '<option value="">Todos los fondos</option>' +
      (window.userFondos || []).map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
  }

  document.getElementById('btnAddMeta').onclick = () => {
    document.getElementById('formMeta').reset();
    document.getElementById('metaId').value = '';
    document.getElementById('metaCategoria').disabled = false;
    document.getElementById('modalMetaTitle').textContent = 'Nueva Meta';
    populateMetaFondos();
    document.getElementById('modalMeta').classList.add('active');
  };
  
  document.getElementById('formMeta').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('metaId').value;
    const cat = document.getElementById('metaCategoria').value;
    const fondo = document.getElementById('metaFondo').value || null;
    const monto = Number(document.getElementById('metaMonto').value);
    
    if (!cat || !monto || monto <= 0) return;
    
    // ID incluye fondo para permitir misma categoría en distintos fondos
    const newId = editId || `presupuesto_${cat}_${fondo || 'all'}`;
    
    if (editId) {
      const idx = db.presupuestos.findIndex(p => p.id === editId);
      if (idx !== -1) {
        db.presupuestos[idx].categoria = cat;
        db.presupuestos[idx].monto = monto;
        db.presupuestos[idx].fondo = fondo;
        await syncData('edit', 'presupuestos', db.presupuestos[idx]);
        showToast('Meta actualizada correctamente', 'success');
      }
    } else {
      // Check if category+fondo combination already has a goal
      const exists = db.presupuestos.find(p => p.categoria === cat && (p.fondo || null) === fondo);
      if (exists) {
        showToast('Ya existe una meta para esa categoría y fondo. Edítala en su lugar.', 'warning');
        return;
      }
      const obj = { id: newId, categoria: cat, monto: monto, fondo: fondo };
      db.presupuestos.push(obj);
      await syncData('add', 'presupuestos', obj);
      showToast('Meta creada correctamente', 'success');
    }
    
    document.getElementById('modalMeta').classList.remove('active');
    refreshViews();
  });
}

window.editMeta = function(id) {
  const meta = db.presupuestos.find(p => p.id === id);
  if (!meta) return;
  
  // Repopulate fondo options
  const sel = document.getElementById('metaFondo');
  if (sel) {
    sel.innerHTML = '<option value="">Todos los fondos</option>' +
      (window.userFondos || []).map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
  }

  document.getElementById('metaId').value = meta.id;
  document.getElementById('metaCategoria').value = meta.categoria;
  document.getElementById('metaCategoria').disabled = true;
  if (sel) sel.value = meta.fondo || '';
  document.getElementById('metaMonto').value = meta.monto;
  document.getElementById('modalMetaTitle').textContent = 'Editar Meta';
  document.getElementById('modalMeta').classList.add('active');
}

window.deleteMeta = function(id) {
  showConfirmToast('¿Eliminar esta meta?', async () => {
    const idx = db.presupuestos.findIndex(p => p.id === id);
    if (idx !== -1) {
      const removed = db.presupuestos.splice(idx, 1)[0];
      await syncData('delete', 'presupuestos', removed.id);
      showToast('Meta eliminada', 'success');
      refreshViews();
    }
  });
}

function checkRecurrentesPendientes() {
  const activos = (db.recurrentes || []).filter(r => r.activo);
  if (activos.length === 0) {
    // Ocultar badge y banner
    document.querySelectorAll('.recurrentes-tab-badge').forEach(b => b.remove());
    const banner = document.getElementById('recurrentesBanner');
    if (banner) banner.style.display = 'none';
    return;
  }
  const d = new Date();
  const currentMonth = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const aplicados = [...db.gastos, ...db.ingresos].filter(t => t.recurrente && t.fecha && t.fecha.startsWith(currentMonth));
  const pendientes = aplicados.length === 0;

  // Badge en el tab
  document.querySelectorAll('.recurrentes-tab-badge').forEach(b => b.remove());
  if (pendientes) {
    document.querySelectorAll('[data-target="view-recurrentes"]').forEach(btn => {
      if (!btn.querySelector('.recurrentes-tab-badge')) {
        const badge = document.createElement('span');
        badge.className = 'tab-badge recurrentes-tab-badge';
        btn.style.position = 'relative';
        btn.appendChild(badge);
      }
    });
  }

  // Banner dentro de la vista
  const banner = document.getElementById('recurrentesBanner');
  if (banner) {
    if (pendientes) {
      const mes = new Date(d.getFullYear(), d.getMonth(), 1).toLocaleString('es-CL', { month: 'long' });
      document.getElementById('recurrentesBannerText').textContent =
        `Tienes ${activos.length} plantilla${activos.length > 1 ? 's' : ''} activa${activos.length > 1 ? 's' : ''} sin aplicar en ${mes}.`;
      banner.style.display = 'flex';
    } else {
      banner.style.display = 'none';
    }
  }
}

function refreshViews() {
  // Siempre actualizar resumen y metas (sin gráficos)
  renderPatrimonio();
  renderResumen();
  renderMetasList();
  checkRecurrentesPendientes();

  // Detectar vista activa
  const activeView = document.querySelector('.view.active');
  const activeId = activeView ? activeView.id : null;

  if (activeId === 'view-registro') {
    renderRegistro();
  } else if (activeId === 'view-stats-mes') {
    renderStatsMensuales();
  } else if (activeId === 'view-stats-ano') {
    renderStatsAnuales();
  } else if (activeId === 'view-deudas') {
    renderDeudas();
  } else if (activeId === 'view-recurrentes') {
    renderRecurrentes();
  } else if (activeId === 'view-presupuestos') {
    // renderMetasList ya fue llamado arriba
  }
}

// Funciones Auxiliares de Consulta
function getTransactionsByMonth(yearMonth) { // yearMonth = 'YYYY-MM'
  // Defensivo: un registro sin fecha no debe romper el render completo
  const filterFn = (t) => t && t.fecha && t.fecha.startsWith(yearMonth);
  return {
    ingresos: db.ingresos.filter(filterFn),
    gastos: db.gastos.filter(filterFn),
    ahorros: db.ahorros.filter(filterFn),
    inversiones: db.inversiones.filter(filterFn),
    creditos: db.creditos.filter(item => {
      const f = item && (item.fecha_pago || item.fecha); // compatibilidad si la bd usa fecha en lugar de fecha_pago
      return f && f.startsWith(yearMonth);
    })
  };
}

// === COUNT-UP ANIMATION ===
function animateCardValue(el, targetValue) {
  if (!el) return;
  const duration = 550;
  const startTime = performance.now();
  function step(now) {
    const elapsed = now - startTime;
    const progress = Math.min(elapsed / duration, 1);
    const eased = 1 - Math.pow(1 - progress, 3); // easeOutCubic
    el.textContent = formatMoney(Math.round(eased * targetValue));
    if (progress < 1) requestAnimationFrame(step);
  }
  requestAnimationFrame(step);
}

// === DELTA BADGE (comparativa mes anterior) ===
function renderDelta(elId, current, previous) {
  const el = document.getElementById(elId);
  if (!el) return;
  el.className = 'card-delta';
  if (previous === 0 && current === 0) { el.style.display = 'none'; return; }
  el.style.display = 'inline-flex';
  if (previous === 0) {
    el.textContent = 'Nuevo';
    el.classList.add('delta-neutral');
  } else {
    const pct = ((current - previous) / Math.abs(previous)) * 100;
    const arrow = pct > 0 ? '↑' : '↓';
    el.textContent = `${arrow} ${Math.abs(pct).toFixed(0)}% vs mes anterior`;
    el.classList.add(pct > 0 ? 'delta-up' : 'delta-down');
  }
  requestAnimationFrame(() => el.classList.add('visible'));
}

// === DONUT CHART (gastos por categoría) ===
let _donutChartInstance = null;

function renderDonutAndStats(tx, txPrev, iTotal) {
  const row = document.getElementById('resumenChartsRow');
  const canvas = document.getElementById('donutChart');
  const emptyMsg = document.getElementById('donutEmpty');
  const statsEl = document.getElementById('resumenMesStats');
  if (!row || !canvas) return;

  // Agrupar gastos por categoría
  const catMap = {};
  tx.gastos.forEach(g => {
    const c = g.categoria || 'otro';
    catMap[c] = (catMap[c] || 0) + Number(g.monto);
  });

  const hasCats = Object.keys(catMap).length > 0;
  row.style.display = 'grid';

  if (_donutChartInstance) { _donutChartInstance.destroy(); _donutChartInstance = null; }

  if (!hasCats) {
    canvas.style.display = 'none';
    if (emptyMsg) emptyMsg.style.display = 'block';
  } else {
    canvas.style.display = 'block';
    if (emptyMsg) emptyMsg.style.display = 'none';

    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';
    const palette = ['#3b82f6','#10b981','#f43f5e','#f59e0b','#8b5cf6','#ec4899','#06b6d4','#84cc16'];
    const labels = Object.keys(catMap).map(k => {
      const found = CATEGORIAS.find(c => c.value === k);
      return found ? found.label : k;
    });
    const data = Object.values(catMap);

    _donutChartInstance = new Chart(canvas, {
      type: 'doughnut',
      data: {
        labels,
        datasets: [{ data, backgroundColor: palette.slice(0, data.length), borderWidth: 2, borderColor: isDark ? '#0f172a' : '#fff' }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: true,
        cutout: '65%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: {
              color: isDark ? '#94a3b8' : '#64748b',
              font: { size: 11, family: 'Outfit' },
              padding: 12,
              boxWidth: 12,
              boxHeight: 12
            }
          },
          tooltip: {
            callbacks: {
              label: (ctx) => ` ${formatMoney(ctx.raw)}`
            }
          }
        }
      }
    });
  }

  // Panel de resumen del mes
  if (statsEl) {
    const gTotal = tx.gastos.reduce((a, b) => a + Number(b.monto), 0);
    const gPrev = txPrev.gastos.reduce((a, b) => a + Number(b.monto), 0);
    const iPrev = txPrev.ingresos.reduce((a, b) => a + Number(b.monto), 0);
    const balance = iTotal - gTotal;
    const isDark = document.documentElement.getAttribute('data-theme') === 'dark';

    const stat = (label, value, color) =>
      `<div style="display:flex; justify-content:space-between; align-items:center; padding:0.7rem 1rem; background:rgba(${color},0.08); border-radius:10px; border:1px solid rgba(${color},0.15);">
        <span style="font-size:0.9rem; color:var(--color-text-muted)">${label}</span>
        <span style="font-weight:700; font-size:1rem; color:var(--color-text)">${formatMoney(value)}</span>
      </div>`;

    const trendGasto = gPrev > 0 ? ((gTotal - gPrev) / gPrev * 100).toFixed(0) : null;
    const trendIngreso = iPrev > 0 ? ((iTotal - iPrev) / iPrev * 100).toFixed(0) : null;

    // Balance proyectado con recurrentes activos
    const activos = (db.recurrentes || []).filter(r => r.activo);
    const proyIngreso = activos.filter(r => r.tipo === 'ingreso').reduce((a, r) => a + Number(r.monto), 0);
    const proyGasto = activos.filter(r => r.tipo === 'gasto').reduce((a, r) => a + Number(r.monto), 0);
    const balanceProyectado = balance + proyIngreso - proyGasto;
    const tieneRecurrentes = activos.length > 0;

    statsEl.innerHTML =
      stat('💰 Ingresos del mes', iTotal, '16, 185, 129') +
      stat('💸 Gastos del mes', gTotal, '244, 63, 94') +
      stat('📊 Balance actual', balance, balance >= 0 ? '16, 185, 129' : '244, 63, 94') +
      (tieneRecurrentes ? `
        <div class="balance-proyectado-row">
          <span class="material-icons-round" style="font-size:0.95rem;">trending_flat</span>
          Balance proyectado (con recurrentes): <strong style="color:${balanceProyectado >= 0 ? 'var(--color-success-dark)' : 'var(--color-danger-dark)'}">${formatMoney(balanceProyectado)}</strong>
        </div>` : '') +
      (trendGasto !== null ? `<p class="text-muted" style="font-size:0.78rem; text-align:center; margin-top:0.4rem;">Gastos ${trendGasto > 0 ? '↑' : '↓'} ${Math.abs(trendGasto)}% vs mes anterior</p>` : '') +
      (trendIngreso !== null ? `<p class="text-muted" style="font-size:0.78rem; text-align:center;">Ingresos ${trendIngreso > 0 ? '↑' : '↓'} ${Math.abs(trendIngreso)}% vs mes anterior</p>` : '');
  }
}

// renderPatrimonio ya no se usa como widget independiente;
// el total mensual se calcula dentro de renderResumen al construir el hero.
function renderPatrimonio() { /* no-op, mantenido por compatibilidad */ }

// === RENDER: RESUMEN MENSUAL ===
function renderResumen() {
  const month = document.getElementById('filterResumenMonth').value;
  if (!month) return;
  const tx = getTransactionsByMonth(month);

  let gPersonal = 0; let gU = 0; let gTotal = 0;
  let gCredito = 0; let gDebito = 0;
  
  tx.gastos.forEach(g => {
    const val = Number(g.monto);
    gTotal += val;
    if (g.fondo === 'Personal') gPersonal += val;
    if (g.fondo === 'U') gU += val;
    
    if (g.credito) gCredito += val;
    else gDebito += val;
  });

  let iTotal = tx.ingresos.reduce((acc, i) => acc + Number(i.monto), 0);
  let ahTotal = 
    db.ingresos.filter(i => i.fondo === 'Ahorro').reduce((a, b) => a + Number(b.monto), 0) +
    db.ahorros.reduce((a, b) => a + Number(b.monto), 0) -
    db.gastos.filter(g => g.fondo === 'Ahorro').reduce((a, b) => a + Number(b.monto), 0);
  
  // Acumulado histórico, igual que el cálculo de Ahorro (antes era solo del mes, inconsistente)
  let invTotal =
    db.inversiones.reduce((a, b) => a + Number(b.monto), 0) +
    db.ingresos.filter(i => i.fondo === 'Inversion' || i.fondo === 'Inversión').reduce((a, b) => a + Number(b.monto), 0);
  let cTotal = tx.creditos.reduce((acc, c) => acc + Number(c.monto), 0);
  
  let oldAhTotal = tx.ahorros.reduce((acc, a) => acc + Number(a.monto), 0);
  let oldInvTotal = tx.inversiones.reduce((acc, i) => acc + Number(i.monto), 0);

  // --- Mes anterior para comparativas ---
  const [yr, mo] = month.split('-').map(Number);
  const prevDate = new Date(yr, mo - 2, 1); // mes anterior
  const prevMonth = `${prevDate.getFullYear()}-${String(prevDate.getMonth() + 1).padStart(2, '0')}`;
  const txPrev = getTransactionsByMonth(prevMonth);
  let gPersPersonal = txPrev.gastos.filter(g => g.fondo === (window.userFondos[0] || 'Personal')).reduce((a, b) => a + Number(b.monto), 0);
  let gPersU = txPrev.gastos.filter(g => g.fondo === (window.userFondos[1] || 'U')).reduce((a, b) => a + Number(b.monto), 0);
  let gCreditoPrev = 0; let gDebitoPrev = 0;
  txPrev.gastos.forEach(g => { if (g.credito) gCreditoPrev += Number(g.monto); else gDebitoPrev += Number(g.monto); });

  document.getElementById('sumAhorro').dataset.raw = ahTotal;
  document.getElementById('sumInversion').dataset.raw = invTotal;
  animateCardValue(document.getElementById('sumCredito'), gCredito);
  animateCardValue(document.getElementById('sumDebito'), gDebito);

  // Dynamic Saldos Hero (flujo del mes por fondo) + total
  const heroContainer = document.getElementById('heroSaldosContainer');
  const heroTotalBox  = document.getElementById('heroTotalBox');
  const heroTotalVal  = document.getElementById('heroTotalValue');
  if (heroContainer) {
    let heroHtml = '';
    let totalFondosMes = 0;
    window.userFondos.forEach(fondo => {
      let fIngresos = tx.ingresos.filter(i => i.fondo === fondo).reduce((a, b) => a + Number(b.monto), 0);
      let fGastos   = tx.gastos.filter(g => g.fondo === fondo).reduce((a, b) => a + Number(b.monto), 0);
      let saldo = fIngresos - fGastos;
      totalFondosMes += saldo;
      heroHtml += `
        <div class="hero-saldo-box">
          <div class="card-title">${escapeHtml(fondo)}</div>
          <div class="card-value">${formatMoney(saldo)}</div>
        </div>
      `;
    });
    heroContainer.innerHTML = heroHtml;
    // Mostrar total solo cuando hay más de un fondo
    if (heroTotalBox && heroTotalVal) {
      if (window.userFondos.length > 1) {
        heroTotalBox.style.display = 'flex';
        heroTotalVal.textContent = formatMoney(totalFondosMes);
      } else {
        heroTotalBox.style.display = 'none';
      }
    }
  }

  // Generic Gasto display con count-up y delta
  const sumPers = document.getElementById('sumGastoPersonal');
  if (sumPers && window.userFondos[0]) {
    sumPers.parentElement.querySelector('.card-title').innerHTML = `<span class="material-icons-round">shopping_cart</span> Gasto ${escapeHtml(window.userFondos[0])}`;
    let g1 = tx.gastos.filter(g => g.fondo === window.userFondos[0]).reduce((a, b) => a + Number(b.monto), 0);
    animateCardValue(sumPers, g1);
    renderDelta('deltaGastoPersonal', g1, gPersPersonal);
  } else if (sumPers) sumPers.parentElement.style.display = 'none';

  const sumU = document.getElementById('sumGastoU');
  if (sumU && window.userFondos[1]) {
    sumU.parentElement.querySelector('.card-title').innerHTML = `<span class="material-icons-round">school</span> Gasto ${escapeHtml(window.userFondos[1])}`;
    let g2 = tx.gastos.filter(g => g.fondo === window.userFondos[1]).reduce((a, b) => a + Number(b.monto), 0);
    animateCardValue(sumU, g2);
    renderDelta('deltaGastoU', g2, gPersU);
  } else if (sumU) sumU.parentElement.style.display = 'none';

  renderDelta('deltaCredito', gCredito, gCreditoPrev);
  renderDelta('deltaDebito', gDebito, gDebitoPrev);

  // Donut chart y panel de resumen
  renderDonutAndStats(tx, txPrev, iTotal);

  applyPrivacySettings();



  // Generar Barras de Presupuesto (Metas) en Resumen y en la Pestaña Metas
  const pList = document.getElementById('budgetProgressList');
  const pContainer = document.getElementById('budgetProgressContainer');
  const pCardsList = document.getElementById('budgetProgressCardsList');
  const pCardsContainer = document.getElementById('budgetProgressCardsContainer');

  if (db.presupuestos && db.presupuestos.length > 0) {
    if(pContainer) pContainer.style.display = 'block';
    if(pCardsContainer) pCardsContainer.style.display = 'block';
    let budgetHtml = '';

    let curGastos = {};
    tx.gastos.forEach(g => {
      let c = g.categoria || 'otro';
      curGastos[c] = (curGastos[c] || 0) + Number(g.monto);
    });

    db.presupuestos.forEach(p => {
      // Calcular gasto según el fondo de la meta
      let spent;
      if (p.fondo) {
        // Solo gastos de esa categoría en ese fondo específico
        spent = tx.gastos.filter(g => g.categoria === p.categoria && g.fondo === p.fondo)
          .reduce((a, b) => a + Number(b.monto), 0);
      } else {
        // Todos los gastos de esa categoría en todos los fondos
        spent = curGastos[p.categoria] || 0;
      }
      let limit = p.monto;
      let pct = (spent / limit) * 100;
      if (pct > 100) pct = 100;
      let isDanger = pct >= 90;
      const fondoLabel = p.fondo ? ` — ${escapeHtml(p.fondo)}` : '';

      budgetHtml += `
        <div style="background: rgba(255,255,255,0.5); padding: 1rem; border-radius: 12px; border: 1px solid var(--color-border); box-shadow: var(--shadow-sm);">
          <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem; font-size:0.9rem; font-weight:500;">
            <span>${getIconForCat(p.categoria)} ${escapeHtml(p.categoria.charAt(0).toUpperCase() + p.categoria.slice(1))}${fondoLabel}</span>
            <span class="text-muted">${formatMoney(spent)} / ${formatMoney(limit)}</span>
          </div>
          <div class="progress-bar">
            <div class="fill ${isDanger ? 'danger' : ''}" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
    });
    if(pList) pList.innerHTML = budgetHtml;
    if(pCardsList) pCardsList.innerHTML = budgetHtml;
  } else {
    if(pContainer) pContainer.style.display = 'none';
    if(pCardsContainer) pCardsContainer.style.display = 'none';
  }

  // Llenar tabla resumen
  const table = document.getElementById('resumenTableBody');
  table.innerHTML = '';
  
  let allTx = [
    ...tx.gastos.map(g => ({...g, _type: 'Gasto', _color: 'text-danger' })),
    ...tx.ingresos.map(i => {
      let t = 'Ingreso'; let c = 'text-success';
      if (i.fondo === 'Ahorro') { t = 'Ahorro'; c = 'text-primary'; }
      else if (i.fondo === 'Inversion' || i.fondo === 'Inversión') { t = 'Inversión'; c = 'text-primary'; }
      return {...i, _type: t, _color: c};
    }),
    ...tx.ahorros.map(a => ({...a, _type: 'Ahorro', _color: 'text-primary' })),
    ...tx.inversiones.map(i => ({...i, _type: 'Inversión', _color: 'text-primary' })),
    ...tx.creditos.map(c => ({...c, _type: 'Pago Créd.', _color: 'text-danger', fecha: c.fecha_pago || c.fecha }))
  ];

  allTx.sort((a,b) => new Date(b.fecha) - new Date(a.fecha)); // Orden desc

  // Limitar a ultimas 15
  const totalTx = allTx.length;
  allTx.slice(0, 15).forEach(item => {
    let tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(item.fecha)}</td>
      <td><span class="tag">${item._type}</span></td>
      <td>${escapeHtml(item.descripcion || item.donde || '')}</td>
      <td>${escapeHtml(item.fondo || '')} ${item.credito ? '💳' : ''}</td>
      <td class="${item._color}">${formatMoney(item.monto)}</td>
    `;
    table.appendChild(tr);
  });

  // Mensaje si hay más de 15 transacciones
  let resumenMsg = document.getElementById('resumenTxOverflowMsg');
  if (!resumenMsg) {
    resumenMsg = document.createElement('p');
    resumenMsg.id = 'resumenTxOverflowMsg';
    resumenMsg.className = 'text-muted';
    resumenMsg.style.cssText = 'text-align:center; font-size:0.85rem; margin-top:0.8rem; padding: 0.5rem;';
    table.closest('.table-container').after(resumenMsg);
  }
  if (totalTx > 15) {
    resumenMsg.textContent = `Mostrando 15 de ${totalTx} transacciones. Ve a la pestaña Registrar para ver todas.`;
    resumenMsg.style.display = 'block';
  } else {
    resumenMsg.style.display = 'none';
  }

  // === CRÉDITO POR PAGAR (acumulado de todos los meses, sin importar el filtro) ===
  renderCreditoPendiente();

  // === DEUDAS PENDIENTES (sin importar el mes) ===
  renderDeudasPendientesEnResumen();
}

// Deuda de tarjeta de crédito acumulada: todo lo gastado con crédito
// menos todos los pagos de crédito registrados. Persiste entre meses.
function renderCreditoPendiente() {
  const card = document.getElementById('cardCreditoPendiente');
  const valueEl = document.getElementById('sumCreditoPendiente');
  if (!card || !valueEl) return;

  const totalGastadoCredito = db.gastos.filter(g => g.credito).reduce((a, b) => a + Number(b.monto), 0);
  const totalPagado = db.creditos.reduce((a, b) => a + Number(b.monto), 0);
  const pendiente = totalGastadoCredito - totalPagado;

  if (pendiente > 0.5) {
    card.style.display = '';
    animateCardValue(valueEl, pendiente);
  } else {
    card.style.display = 'none';
  }
}

window.openPagoCreditoModal = function() {
  openTxModal('credito');
};

function renderDeudasPendientesEnResumen() {
  const section = document.getElementById('deudasPendientesSection');
  const grid = document.getElementById('deudasPendientesGrid');
  if (!section || !grid) return;

  const pendientes = (db.deudas || []).filter(d => !d.pagado);

  if (pendientes.length === 0) {
    section.style.display = 'none';
    return;
  }

  section.style.display = 'block';
  grid.innerHTML = '';

  pendientes.sort((a, b) => new Date(a.fecha) - new Date(b.fecha));

  pendientes.forEach(d => {
    const esMeDeben = d.tipo === 'me_deben';
    const card = document.createElement('div');
    card.className = `deuda-card-mini ${esMeDeben ? 'me-deben' : 'les-debo'}`;
    card.innerHTML = `
      <div class="deuda-persona">${esMeDeben ? '✅' : '⛽'} ${escapeHtml(d.persona)}</div>
      <div class="deuda-monto ${esMeDeben ? 'text-success' : 'text-danger'}">${formatMoney(d.monto)}</div>
      <div class="deuda-desc">${escapeHtml(d.descripcion || '')}</div>
      <div class="deuda-meta">
        <span>📅 ${escapeHtml(d.fecha)}</span>
        ${d.fondo ? `<span>• ${escapeHtml(d.fondo)}</span>` : ''}
      </div>
      <button class="btn btn-success btn-sm" style="margin-top:0.5rem;" onclick="toggleDeuda('${escapeHtml(d.id)}')">✓ Marcar pagada</button>
    `;
    grid.appendChild(card);
  });
}

// === RENDER: REGISTRO GENERAL ===
function getIconForCat(cat) {
  const found = CATEGORIAS.find(c => c.value === cat);
  if (found) return escapeHtml(found.label.split(' ')[0]); // Devuelve solo el emoji (escapado: es texto de usuario)
  return '❓';
}

function renderRegistro() {
  const month = document.getElementById('filterRegMonth').value;
  const fFondo = document.getElementById('filterRegFondo').value;
  const fCat = document.getElementById('filterRegCat').value;
  const searchEl = document.getElementById('searchReg');
  const fSearch = searchEl ? searchEl.value.trim().toLowerCase() : '';
  
  if (!month) return;

  const tx = getTransactionsByMonth(month);
  
  let allTx = [
    ...tx.gastos.map(g => ({...g, _type: 'gasto', _typeLabel: 'Gasto' })),
    ...tx.ingresos.map(i => {
      let l = 'Ingreso';
      if (i.fondo === 'Ahorro') l = 'Ahorro';
      else if (i.fondo === 'Inversion' || i.fondo === 'Inversión') l = 'Inversión';
      return {...i, _type: 'ingreso', _typeLabel: l};
    }),
    ...tx.ahorros.map(a => ({...a, _type: 'ahorro', _typeLabel: 'Ahorro' })),
    ...tx.inversiones.map(i => ({...i, _type: 'inversion', _typeLabel: 'Inversión' })),
    ...tx.creditos.map(c => ({...c, _type: 'credito', _typeLabel: 'P. Crédito', fecha: c.fecha_pago || c.fecha }))
  ];

  // Aplicar filtros extra
  if (fFondo) {
    allTx = allTx.filter(t => t.fondo === fFondo);
  }
  if (fCat) {
    if (fCat === 'uncategorized') {
      allTx = allTx.filter(t => t._type === 'gasto' && !t.categoria);
    } else {
      allTx = allTx.filter(t => t.categoria === fCat);
    }
  }
  if (fSearch) {
    allTx = allTx.filter(t =>
      (t.descripcion && t.descripcion.toLowerCase().includes(fSearch)) ||
      (t.donde && t.donde.toLowerCase().includes(fSearch))
    );
  }

  allTx.sort((a,b) => new Date(b.fecha) - new Date(a.fecha));

  const table = document.getElementById('registroTableBody');
  table.innerHTML = '';
  
  allTx.forEach(item => {
    let colorClass = 'text-muted';
    let catOrFondo = escapeHtml(item.fondo || '');
    if (item._type === 'gasto') {
      colorClass = 'text-danger';
      catOrFondo = `${escapeHtml(item.fondo)} / ${getIconForCat(item.categoria)} ${escapeHtml(item.categoria||'')}`;
    }
    if (item._type === 'ingreso') colorClass = 'text-success';

    let desc = item._type === 'gasto' ? `<b>${escapeHtml(item.donde)}</b> - ${escapeHtml(item.descripcion)}` : escapeHtml(item.descripcion);
    if (item.nota) desc += `<div class="tx-nota-display">📝 ${escapeHtml(item.nota)}</div>`;

    let tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${escapeHtml(item.fecha)}</td>
      <td><span class="tag">${item._typeLabel}</span></td>
      <td>${desc}</td>
      <td>${catOrFondo}</td>
      <td class="${colorClass}">${formatMoney(item.monto)}</td>
      <td class="action-btns">
        <button class="btn btn-outline" onclick="editTx('${escapeHtml(item.id)}', '${item._type}')">✏️</button>
        <button class="btn btn-outline" onclick="deleteTx('${escapeHtml(item.id)}', '${item._type}')">🗑️</button>
      </td>
    `;
    table.appendChild(tr);
  });
}


// === LÓGICA DE FORMULARIOS DE REGISTRO ===
function setupRegistroModals() {
  document.getElementById('btnAddIngreso').onclick = () => openTxModal('ingreso');
  document.getElementById('btnAddGasto').onclick = () => openTxModal('gasto');
  const btnPagoCred = document.getElementById('btnAddPagoCredito');
  if (btnPagoCred) btnPagoCred.onclick = () => openTxModal('credito');
  document.getElementById('btnAddIngresoFijo').onclick = () => {
    document.getElementById('formRecurrente').reset();
    document.getElementById('recId').value = '';
    document.getElementById('recTipo').value = 'ingreso';
    document.getElementById('recTipo').dispatchEvent(new Event('change'));
    document.getElementById('modalRecurrente').classList.add('active');
  };

  document.getElementById('formTx').addEventListener('submit', async (e) => {
    e.preventDefault();
    const id = document.getElementById('txId').value || uuidv4();
    const ctx = document.getElementById('txContext').value;
    const isEdit = document.getElementById('txId').value !== '';
    const distribuir = ctx === 'ingreso' && document.getElementById('txDistribuir').checked;

    let montoOrig = Number(document.getElementById('txMonto').value);
    let moneda = document.getElementById('txMoneda').value;
    let tasa = moneda === 'CLP' ? 1 : Number(document.getElementById('txTasaCambio').value);
    let montoCLP = montoOrig * tasa;

    // Si es ingreso con distribución por fondo (lee inputs inline del panel)
    if (distribuir && !isEdit) {
      const fondos = [...(window.userFondos || []), 'Ahorro', 'Inversión'];
      let total = 0;
      const reglas = fondos.map((fondo, idx) => {
        const inp = document.getElementById('txDistPct_' + idx);
        const pct = Number(inp ? inp.value : 0) || 0;
        total += pct;
        return { fondo, porcentaje: pct };
      }).filter(r => r.porcentaje > 0);

      if (Math.abs(total - 100) >= 0.01) {
        showToast('La suma de porcentajes debe ser exactamente 100%', 'error');
        return;
      }

      const fecha = document.getElementById('txFecha').value;
      const descripcion = document.getElementById('txDesc').value;
      const nuevosIngresos = reglas.map(regla => ({
        id: uuidv4(),
        fecha,
        montoOriginal: montoOrig,
        moneda,
        tasaCambio: tasa,
        monto: Math.round(montoCLP * regla.porcentaje / 100),
        descripcion,
        fondo: regla.fondo
      }));

      nuevosIngresos.forEach(i => db.ingresos.push(i));
      document.getElementById('modalTx').classList.remove('active');
      await syncData('add', 'ingresos', nuevosIngresos);
      showToast(`${formatMoney(montoCLP)} distribuido en ${nuevosIngresos.length} fondos`, 'success', 4000);
      return;
    }

    const notaVal = document.getElementById('txNota').value.trim();
    let obj = {
      id: id,
      fecha: document.getElementById('txFecha').value,
      montoOriginal: montoOrig,
      moneda: moneda,
      tasaCambio: tasa,
      monto: montoCLP,
      descripcion: document.getElementById('txDesc').value,
      ...(notaVal ? { nota: notaVal } : {})
    };

    if (ctx === 'gasto') {
      obj.donde = document.getElementById('txDonde').value;
      obj.categoria = document.getElementById('txCat').value;
      obj.fondo = document.getElementById('txFondo').value;
      obj.credito = document.getElementById('txCredito').checked;
    } else if (ctx === 'ingreso') {
      obj.fondo = document.getElementById('txFondo').value;
    } else if (ctx === 'credito') {
      obj.fecha_pago = obj.fecha;
    }

    const arrMap = { ingreso: 'ingresos', gasto: 'gastos', ahorro: 'ahorros', inversion: 'inversiones', credito: 'creditos' };
    const targetArr = db[arrMap[ctx]];

    if (isEdit) {
      const idx = targetArr.findIndex(x => x.id === id);
      if (idx !== -1) targetArr[idx] = obj;
    } else {
      targetArr.push(obj);
    }

    document.getElementById('modalTx').classList.remove('active');
    await syncData(isEdit ? 'edit' : 'add', arrMap[ctx], obj);
    showToast(isEdit ? 'Registro actualizado correctamente' : 'Registro agregado correctamente', 'success');
  });
}

// === FAB BUTTON (Mobile Quick Add) ===
function setupFAB() {
  const fabBtn = document.getElementById('fabBtn');
  const fabMenu = document.getElementById('fabMenu');
  const fabOverlay = document.getElementById('fabOverlay');
  if (!fabBtn || !fabMenu || !fabOverlay) return;

  function toggleFabMenu() {
    const isOpen = fabMenu.classList.contains('active');
    if (isOpen) {
      closeFabMenu();
    } else {
      fabMenu.classList.add('active');
      fabOverlay.classList.add('active');
      fabBtn.style.transform = 'rotate(45deg)';
    }
  }

  function closeFabMenu() {
    fabMenu.classList.remove('active');
    fabOverlay.classList.remove('active');
    fabBtn.style.transform = '';
  }

  fabBtn.addEventListener('click', toggleFabMenu);
  fabOverlay.addEventListener('click', closeFabMenu);

  document.getElementById('fabIngreso').addEventListener('click', () => {
    closeFabMenu();
    openTxModal('ingreso');
  });

  document.getElementById('fabGasto').addEventListener('click', () => {
    closeFabMenu();
    openTxModal('gasto');
  });

  document.getElementById('fabFijo').addEventListener('click', () => {
    closeFabMenu();
    // Open the recurring template modal pre-set to ingreso
    document.getElementById('formRecurrente').reset();
    document.getElementById('recId').value = '';
    document.getElementById('recTipo').value = 'ingreso';
    document.getElementById('recTipo').dispatchEvent(new Event('change'));
    document.getElementById('modalRecurrente').classList.add('active');
  });
}

// === CAMBIO DE DIVISA ===
window.toggleTasaCambio = function(prefix) {
  const moneda = document.getElementById(prefix + 'Moneda').value;
  const group = document.getElementById(prefix + 'GroupTasa');
  if (group && moneda) {
    if (moneda === 'CLP') {
      group.style.display = 'none';
    } else {
      group.style.display = 'block';
    }
  }
};

function openTxModal(context, editObj = null) {
  document.getElementById('formTx').reset();
  const d = new Date();
  document.getElementById('txFecha').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  document.getElementById('txContext').value = context;
  document.getElementById('txId').value = editObj ? editObj.id : '';

  document.getElementById('txMoneda').value = 'CLP';
  document.getElementById('txTasaCambio').value = '1';
  toggleTasaCambio('tx');

  const modalTitle = {
    ingreso: 'Nuevo Ingreso', gasto: 'Nuevo Gasto', ahorro: 'Nuevo Ahorro',
    inversion: 'Nueva Inversión', credito: 'Pago de Crédito'
  };
  document.getElementById('modalTxTitle').innerText = editObj ? 'Editar Entrada' : modalTitle[context];

  // Configurar visibilidad de campos
  const gGasto = document.getElementById('txGroupGasto');
  const gFondo = document.getElementById('txGroupFondo');
  const dFondo = document.getElementById('txFondo');
  
  gGasto.style.display = 'none';
  gFondo.style.display = 'none';

  const userFondosOps = window.userFondos.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');

  if (context === 'gasto') {
    gGasto.style.display = 'block';
    gFondo.style.display = 'block';
    dFondo.innerHTML = userFondosOps + `<option value="Ahorro">Ahorro</option>`;
  } else if (context === 'ingreso') {
    gFondo.style.display = 'block';
    dFondo.innerHTML = userFondosOps + `<option value="Ahorro">Ahorro</option><option value="Inversion">Inversión</option>`;
  }

  // Mostrar/ocultar checkbox distribuir (solo para ingreso nuevo)
  const gDistribuir = document.getElementById('txGroupDistribuir');
  const panel = document.getElementById('txDistribuirPanel');
  const chk = document.getElementById('txDistribuir');
  if (gDistribuir) {
    gDistribuir.style.display = context === 'ingreso' && !editObj ? 'block' : 'none';
    if (chk) chk.checked = false;
    if (panel) panel.style.display = 'none';
  }

  // Si es edicion, poblar data
  if (editObj) {
    document.getElementById('txFecha').value = editObj.fecha || editObj.fecha_pago;
    document.getElementById('txMonto').value = editObj.montoOriginal || editObj.monto;
    document.getElementById('txDesc').value = editObj.descripcion;
    
    if (editObj.moneda) {
      document.getElementById('txMoneda').value = editObj.moneda;
      document.getElementById('txTasaCambio').value = editObj.tasaCambio || 1;
      toggleTasaCambio('tx');
    }
    
    if (context === 'gasto') {
      document.getElementById('txDonde').value = editObj.donde;
      document.getElementById('txCat').value = editObj.categoria;
      document.getElementById('txFondo').value = editObj.fondo;
      document.getElementById('txCredito').checked = editObj.credito;
    } else if (context === 'ingreso') {
      document.getElementById('txFondo').value = editObj.fondo;
    }
    document.getElementById('txNota').value = editObj.nota || '';
  } else {
    document.getElementById('txNota').value = '';
  }

  document.getElementById('modalTx').classList.add('active');
}

window.editTx = function(id, type) {
  const arrMap = { ingreso: 'ingresos', gasto: 'gastos', ahorro: 'ahorros', inversion: 'inversiones', credito: 'creditos' };
  const targetArr = db[arrMap[type]];
  const obj = targetArr.find(x => x.id === id);
  if (obj) openTxModal(type, obj);
}

window.deleteTx = function(id, type) {
  showConfirmToast('¿Eliminar este registro?', async () => {
    const arrMap = { ingreso: 'ingresos', gasto: 'gastos', ahorro: 'ahorros', inversion: 'inversiones', credito: 'creditos' };
    db[arrMap[type]] = db[arrMap[type]].filter(x => x.id !== id);
    await syncData('delete', arrMap[type], id);
    showToast('Registro eliminado correctamente', 'success');
  });
}


// === DEUDAS INFORMALES ===
function populateDeudaFondos() {
  const sel = document.getElementById('deudaFondo');
  if (!sel) return;
  sel.innerHTML = window.userFondos.map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
}

function setupDeudasModales() {
  document.getElementById('btnAddDeuda').onclick = () => {
    document.getElementById('formDeuda').reset();
    document.getElementById('deudaId').value = '';
    const d = new Date();
    document.getElementById('deudaFecha').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    populateDeudaFondos();
    document.getElementById('modalDeuda').classList.add('active');
  };

  document.getElementById('formDeuda').addEventListener('submit', async(e) => {
    e.preventDefault();
    const id = document.getElementById('deudaId').value || uuidv4();
    const isEdit = document.getElementById('deudaId').value !== '';
    
    const obj = {
      id: id,
      fecha: document.getElementById('deudaFecha').value,
      persona: document.getElementById('deudaPersona').value,
      monto: Number(document.getElementById('deudaMonto').value),
      descripcion: document.getElementById('deudaDesc').value,
      tipo: document.getElementById('deudaTipo').value,
      fondo: document.getElementById('deudaFondo').value,
      pagado: false
    };

    if (isEdit) {
      const prev = db.deudas.find(d => d.id === id);
      obj.pagado = prev ? prev.pagado : false;
      obj.fondo = obj.fondo || (prev ? prev.fondo : window.userFondos[0]);
      const idx = db.deudas.findIndex(x => x.id === id);
      if (idx !== -1) db.deudas[idx] = obj;
    } else {
      db.deudas.push(obj);
    }
    document.getElementById('modalDeuda').classList.remove('active');
    await syncData(isEdit ? 'edit' : 'add', 'deudas', obj);
    showToast(isEdit ? 'Deuda actualizada' : 'Deuda registrada', 'success');
  });
}

function renderDeudas() {
  let meDeben = 0;
  let lesDebo = 0;

  const table = document.getElementById('deudasTableBody');
  table.innerHTML = '';
  
  // Clonar y ordenar
  let deudasSort = [...db.deudas].sort((a,b) => {
    // Pendientes primero
    if (a.pagado !== b.pagado) return a.pagado ? 1 : -1;
    return new Date(b.fecha) - new Date(a.fecha);
  });

  deudasSort.forEach(item => {
    if (!item.pagado) {
      if (item.tipo === 'me_deben') meDeben += Number(item.monto);
      else lesDebo += Number(item.monto);
    }

    const tr = document.createElement('tr');
    if (item.pagado) tr.style.opacity = '0.5';

    tr.innerHTML = `
      <td>${escapeHtml(item.fecha)}</td>
      <td><b>${escapeHtml(item.persona)}</b></td>
      <td>${escapeHtml(item.descripcion)}</td>
      <td>${item.tipo === 'me_deben' ? '✅ A Mi Favor' : '⛔ Yo Debo'}</td>
      <td>${escapeHtml(item.fondo || '-')}</td>
      <td class="${item.tipo==='me_deben' ? 'text-success' : 'text-danger'}">${formatMoney(item.monto)}</td>
      <td>${item.pagado ? 'Saldado' : 'Pendiente'}</td>
      <td class="action-btns">
        ${!item.pagado ? `<button class="btn btn-success btn-sm" onclick="toggleDeuda('${escapeHtml(item.id)}')">Pagado</button>` : `<button class="btn btn-outline btn-sm" onclick="toggleDeuda('${escapeHtml(item.id)}')">Deshacer</button>`}
        <button class="btn btn-danger btn-sm" onclick="deleteDeuda('${escapeHtml(item.id)}')">🗑</button>
      </td>
    `;
    table.appendChild(tr);
  });

  document.getElementById('sumMeDeben').textContent = formatMoney(meDeben);
  document.getElementById('sumLesDebo').textContent = formatMoney(lesDebo);
}

window.toggleDeuda = async function(id) {
  const t = db.deudas.find(x => x.id === id);
  if (!t) return;

  const newPagado = !t.pagado;
  t.pagado = newPagado;

  const d = new Date();
  const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  const fondo = t.fondo || window.userFondos[0];
  const txId = 'deuda_tx_' + t.id;

  if (newPagado) {
    // Crear transacción automática
    if (t.tipo === 'me_deben') {
      // Me pagaron → ingreso al fondo correspondiente
      const ingreso = {
        id: txId,
        fecha: todayStr,
        monto: Number(t.monto),
        montoOriginal: Number(t.monto),
        moneda: 'CLP',
        tasaCambio: 1,
        descripcion: `Pago deuda: ${t.persona} - ${t.descripcion || 'Sin desc.'}`,
        fondo: fondo
      };
      db.ingresos.push(ingreso);
      await syncData('add', 'ingresos', ingreso);
    } else {
      // Yo pagué → gasto del fondo correspondiente
      const gasto = {
        id: txId,
        fecha: todayStr,
        monto: Number(t.monto),
        montoOriginal: Number(t.monto),
        moneda: 'CLP',
        tasaCambio: 1,
        descripcion: `Pago deuda a ${t.persona} - ${t.descripcion || 'Sin desc.'}`,
        donde: 'Deuda',
        categoria: 'otro',
        fondo: fondo,
        credito: false
      };
      db.gastos.push(gasto);
      await syncData('add', 'gastos', gasto);
    }
    showToast(`Deuda saldada. Transacción registrada en ${t.tipo === 'me_deben' ? 'Ingresos' : 'Gastos'} (${fondo})`, 'success');
  } else {
    // Deshacer: eliminar la transacción automática
    const inIdx = db.ingresos.findIndex(x => x.id === txId);
    if (inIdx !== -1) {
      db.ingresos.splice(inIdx, 1);
      await syncData('delete', 'ingresos', txId);
    }
    const gaIdx = db.gastos.findIndex(x => x.id === txId);
    if (gaIdx !== -1) {
      db.gastos.splice(gaIdx, 1);
      await syncData('delete', 'gastos', txId);
    }
    showToast('Deuda reabierta. Transacción automática eliminada.', 'info');
  }

  await syncData('edit', 'deudas', t);
}
window.deleteDeuda = function(id) {
  showConfirmToast('¿Eliminar esta deuda?', async () => {
    db.deudas = db.deudas.filter(x => x.id !== id);
    await syncData('delete', 'deudas', id);
    showToast('Deuda eliminada', 'success');
  });
}


// === RECURRENTES ===
function setupRecurrentesModales() {
  document.getElementById('btnAddRecurrente').onclick = () => {
    document.getElementById('formRecurrente').reset();
    document.getElementById('recId').value = '';
    onRecurrenteTypeChange();
    document.getElementById('modalRecurrente').classList.add('active');
  };

  document.getElementById('recTipo').addEventListener('change', onRecurrenteTypeChange);

  function onRecurrenteTypeChange() {
    const isGasto = document.getElementById('recTipo').value === 'gasto';
    document.getElementById('recGroupLugar').style.display = isGasto ? 'block' : 'none';
    document.getElementById('recGroupCat').style.display = isGasto ? 'block' : 'none';
    document.getElementById('recGroupCredito').style.display = isGasto ? 'block' : 'none';
    
    // Poblar fondo dinámicamente desde window.userFondos
    const fSelect = document.getElementById('recFondo');
    const userOps = (window.userFondos || []).map(f => `<option value="${escapeHtml(f)}">${escapeHtml(f)}</option>`).join('');
    const extraOps = isGasto
      ? '<option value="Ahorro">Ahorro</option>'
      : '<option value="Ahorro">Ahorro</option><option value="Inversion">Inversión</option>';
    fSelect.innerHTML = userOps + extraOps;
  }

  document.getElementById('formRecurrente').addEventListener('submit', async(e) => {
    e.preventDefault();
    const id = document.getElementById('recId').value || uuidv4();
    const isEdit = document.getElementById('recId').value !== '';
    const tipo = document.getElementById('recTipo').value;

    let montoOrig = Number(document.getElementById('recMonto').value);
    let moneda = document.getElementById('recMoneda').value;
    let tasa = moneda === 'CLP' ? 1 : Number(document.getElementById('recTasaCambio').value);
    let montoCLP = montoOrig * tasa;

    const obj = {
      id: id,
      tipo: tipo,
      descripcion: document.getElementById('recDesc').value,
      montoOriginal: montoOrig,
      moneda: moneda,
      tasaCambio: tasa,
      monto: montoCLP,
      fondo: document.getElementById('recFondo').value,
      activo: document.getElementById('recActivo').checked
    };

    if (tipo === 'gasto') {
      obj.donde = document.getElementById('recDonde').value;
      obj.categoria = document.getElementById('recCat').value;
      obj.credito = document.getElementById('recCredito').checked;
    }

    if (isEdit) {
      const idx = db.recurrentes.findIndex(x => x.id === id);
      if (idx !== -1) db.recurrentes[idx] = obj;
    } else {
      db.recurrentes.push(obj);
    }
    
    document.getElementById('modalRecurrente').classList.remove('active');
    await syncData(isEdit ? 'edit' : 'add', 'recurrentes', obj);
    showToast(isEdit ? 'Plantilla actualizada' : 'Plantilla creada correctamente', 'success');
  });

  document.getElementById('btnApplyRecurrentes').addEventListener('click', async () => {
    const activos = db.recurrentes.filter(r => r.activo);
    if(activos.length === 0) {
      showToast('No hay plantillas activas para aplicar', 'warning');
      return;
    }
    
    const items = activos.map(a => `${a.descripcion} (${formatMoney(a.monto)})`).join(', ');
    showConfirmToast(`¿Aplicar ${activos.length} transacciones recurrentes? (${items})`, async () => {
      const d = new Date();
      const todayStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;

      const nuevosGastos = [];
      const nuevosIngresos = [];

      activos.forEach(rec => {
        let nTx = {
          id: uuidv4(),
          fecha: todayStr,
          monto: rec.monto,
          descripcion: rec.descripcion,
          fondo: rec.fondo,
          recurrente: true
        };
        if (rec.tipo === 'gasto') {
          nTx.donde = rec.donde;
          nTx.categoria = rec.categoria;
          nTx.credito = rec.credito;
          db.gastos.push(nTx);
          nuevosGastos.push(nTx);
        } else {
          db.ingresos.push(nTx);
          nuevosIngresos.push(nTx);
        }
      });

      try {
        if (nuevosGastos.length > 0) await syncData('add', 'gastos', nuevosGastos);
        if (nuevosIngresos.length > 0) await syncData('add', 'ingresos', nuevosIngresos);
        if (nuevosGastos.length === 0 && nuevosIngresos.length === 0) refreshViews();
        showToast(`${activos.length} transacciones recurrentes aplicadas`, 'success');
      } catch(err) {
        showToast('Error al aplicar recurrentes: ' + err.message, 'error');
      }
    }, null, 'Sí, aplicar');
  });
}

function renderRecurrentes() {
  const table = document.getElementById('recurrentesTableBody');
  table.innerHTML = '';
  
  db.recurrentes.forEach(item => {
    const tr = document.createElement('tr');
    if (!item.activo) tr.style.opacity = '0.6';

    const color = item.tipo === 'gasto' ? 'text-danger' : 'text-success';
    let details = escapeHtml(item.fondo);
    if(item.tipo === 'gasto') details += ` / ${escapeHtml(item.categoria || '')} ${item.credito ? '💳' : ''}`;

    tr.innerHTML = `
      <td>
        <input type="checkbox" ${item.activo ? 'checked' : ''} onchange="toggleActivoRecurrente('${escapeHtml(item.id)}')">
      </td>
      <td><span class="tag">${escapeHtml(item.tipo.toUpperCase())}</span></td>
      <td>${item.tipo === 'gasto' ? `<b>${escapeHtml(item.donde)}</b> - ` : ''}${escapeHtml(item.descripcion)}</td>
      <td>${details}</td>
      <td class="${color}">${formatMoney(item.monto)}</td>
      <td class="action-btns">
        <button class="btn btn-outline btn-sm" onclick="editRecurrente('${escapeHtml(item.id)}')">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="delRecurrente('${escapeHtml(item.id)}')">🗑</button>
      </td>
    `;
    table.appendChild(tr);
  });
}

window.toggleActivoRecurrente = async function(id) {
  const t = db.recurrentes.find(x => x.id === id);
  if (t) {
    t.activo = !t.activo;
    await syncData('edit', 'recurrentes', t);
    showToast(t.activo ? 'Plantilla activada' : 'Plantilla desactivada', 'info', 2000);
  }
}
window.delRecurrente = function(id) {
  showConfirmToast('¿Eliminar esta plantilla?', async () => {
    db.recurrentes = db.recurrentes.filter(x => x.id !== id);
    await syncData('delete', 'recurrentes', id);
    showToast('Plantilla eliminada', 'success');
  });
}
window.editRecurrente = function(id) {
  const r = db.recurrentes.find(x => x.id === id);
  if(!r) return;
  
  document.getElementById('recId').value = r.id;
  document.getElementById('recTipo').value = r.tipo;
  // disparar change manual
  document.getElementById('recTipo').dispatchEvent(new Event('change'));

  document.getElementById('recDesc').value = r.descripcion;
  document.getElementById('recMonto').value = r.montoOriginal || r.monto;
  
  if (r.moneda) {
    document.getElementById('recMoneda').value = r.moneda;
    document.getElementById('recTasaCambio').value = r.tasaCambio || 1;
    toggleTasaCambio('rec');
  } else {
    document.getElementById('recMoneda').value = 'CLP';
    toggleTasaCambio('rec');
  }

  document.getElementById('recFondo').value = r.fondo;
  document.getElementById('recActivo').checked = r.activo;

  if (r.tipo === 'gasto') {
    document.getElementById('recDonde').value = r.donde || '';
    document.getElementById('recCat').value = r.categoria || '';
    document.getElementById('recCredito').checked = r.credito || false;
  }

  document.getElementById('modalRecurrente').classList.add('active');
}


// === CHART.JS GLOBALS ===
let chartIncExpMes, chartCatDonut, chartFondoDonut, chartDebCred, chartSaldoEvol, chartAhorroMes, chartInversionMes;
let chartAnualBars, chartAhorroAcumulado, chartInversionAcumulado, chartAhorroInvMensual;

// Colores Palette
const colors = {
  success: '#1D9E75',
  danger: '#E24B4A',
  primary: '#378ADD',
  warning: '#F5A623',
  info: '#4A90E2',
  grey: '#9B9B9B',
  cat: ['#FF6384', '#36A2EB', '#FFCE56', '#4BC0C0', '#9966FF', '#FF9F40', '#8d6e63', '#26a69a']
};

function renderStatsMensuales() {
  const month = document.getElementById('filterStatsMonth').value;
  if (!month) return;
  const tx = getTransactionsByMonth(month);

  // 1. Ingresos vs Gastos
  let gTotal = tx.gastos.reduce((a,b) => a + Number(b.monto), 0);
  let iTotal = tx.ingresos.reduce((a,b) => a + Number(b.monto), 0);

  if(chartIncExpMes) chartIncExpMes.destroy();
  chartIncExpMes = new Chart(document.getElementById('chartIncExpMes'), {
    type: 'bar',
    data: {
      labels: ['Ingresos', 'Gastos'],
      datasets: [{ label: 'Monto CLP', data: [iTotal, gTotal], backgroundColor: [colors.success, colors.danger] }]
    },
    options: { plugins: { title: { display: true, text: 'Ingresos vs Gastos' } } }
  });

  // 2. Gastos por categoría
  let catSums = {};
  tx.gastos.forEach(g => {
    let c = g.categoria || 'Sin categoría';
    catSums[c] = (catSums[c] || 0) + Number(g.monto);
  });
  
  if(chartCatDonut) chartCatDonut.destroy();
  chartCatDonut = new Chart(document.getElementById('chartCatDonut'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(catSums),
      datasets: [{ data: Object.values(catSums), backgroundColor: colors.cat }]
    },
    options: { plugins: { title: { display: true, text: 'Gastos por Categoría' } } }
  });

  // 3. Gastos por Fondo (fondos dinámicos del usuario, no hardcodeados)
  let fondoSums = {};
  (window.userFondos || []).forEach(f => { fondoSums[f] = 0; });
  fondoSums['Ahorro'] = 0;
  tx.gastos.forEach(g => {
    const f = g.fondo || 'Sin fondo';
    fondoSums[f] = (fondoSums[f] || 0) + Number(g.monto);
  });

  if(chartFondoDonut) chartFondoDonut.destroy();
  chartFondoDonut = new Chart(document.getElementById('chartFondoDonut'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(fondoSums),
      datasets: [{ data: Object.values(fondoSums), backgroundColor: colors.cat }]
    },
    options: { plugins: { title: { display: true, text: 'Gastos por Fondo' } } }
  });

  // 4. Débito vs Crédito
  let cred = 0, deb = 0;
  tx.gastos.forEach(g => { if(g.credito) cred += Number(g.monto); else deb += Number(g.monto); });

  if(chartDebCred) chartDebCred.destroy();
  chartDebCred = new Chart(document.getElementById('chartDebCred'), {
    type: 'bar',
    data: {
      labels: ['Débito/Efectivo', 'Crédito'],
      datasets: [{ label: 'Total', data: [deb, cred], backgroundColor: [colors.info, colors.danger] }]
    },
    options: { plugins: { title: { display: true, text: 'Medio de Pago' } } }
  });

  // 5. Evolución del Saldo
  // Arreglo de dias del mes
  const parts = month.split('-');
  const daysInMonth = new Date(parts[0], parts[1], 0).getDate();
  let days = Array.from({length: daysInMonth}, (_, i) => i + 1);
  
  let balancePorDia = [];
  let balanceAcumulado = 0;

  days.forEach(d => {
    let diaStr = `${month}-${String(d).padStart(2, '0')}`;
    let dIng = tx.ingresos.filter(i => i.fecha === diaStr).reduce((a,b)=>a+Number(b.monto), 0);
    let dGast = tx.gastos.filter(i => i.fecha === diaStr).reduce((a,b)=>a+Number(b.monto), 0);
    balanceAcumulado += (dIng - dGast);
    balancePorDia.push(balanceAcumulado);
  });

  if(chartSaldoEvol) chartSaldoEvol.destroy();
  chartSaldoEvol = new Chart(document.getElementById('chartSaldoEvol'), {
    type: 'line',
    data: {
      labels: days,
      datasets: [{
        label: 'Saldo Acumulado en el Mes',
        data: balancePorDia,
        borderColor: colors.primary,
        tension: 0.1,
        fill: true,
        backgroundColor: 'rgba(55,138,221,0.1)'
      }]
    },
    options: { plugins: { title: { display: true, text: 'Evolución del flujo (Ingresos - Gastos diarios)' } } }
  });

  // 6. Ahorro del Mes (desglose por fuente)
  let ahDesdeIngresos = tx.ingresos.filter(i => i.fondo === 'Ahorro').reduce((a, b) => a + Number(b.monto), 0);
  let ahDesdeAhorros = tx.ahorros.reduce((a, b) => a + Number(b.monto), 0);
  let ahTotal = ahDesdeIngresos + ahDesdeAhorros;

  if(chartAhorroMes) chartAhorroMes.destroy();
  chartAhorroMes = new Chart(document.getElementById('chartAhorroMes'), {
    type: 'bar',
    data: {
      labels: ['Desde Ingresos', 'Depósito Directo', 'Total Ahorro'],
      datasets: [{
        label: 'Monto CLP',
        data: [ahDesdeIngresos, ahDesdeAhorros, ahTotal],
        backgroundColor: [colors.success, '#26a69a', colors.primary]
      }]
    },
    options: {
      plugins: { title: { display: true, text: 'Ahorro del Mes' } },
      scales: { y: { beginAtZero: true } }
    }
  });

  // 7. Inversión del Mes (desglose por fuente)
  let invDesdeIngresos = tx.ingresos.filter(i => i.fondo === 'Inversion' || i.fondo === 'Inversión').reduce((a, b) => a + Number(b.monto), 0);
  let invDesdeInversiones = tx.inversiones.reduce((a, b) => a + Number(b.monto), 0);
  let invTotalMes = invDesdeIngresos + invDesdeInversiones;

  if(chartInversionMes) chartInversionMes.destroy();
  chartInversionMes = new Chart(document.getElementById('chartInversionMes'), {
    type: 'bar',
    data: {
      labels: ['Desde Ingresos', 'Depósito Directo', 'Total Inversión'],
      datasets: [{
        label: 'Monto CLP',
        data: [invDesdeIngresos, invDesdeInversiones, invTotalMes],
        backgroundColor: [colors.warning, '#FF9F40', colors.info]
      }]
    },
    options: {
      plugins: { title: { display: true, text: 'Inversión del Mes' } },
      scales: { y: { beginAtZero: true } }
    }
  });

  // 8. Gráficos por Fondo
  renderChartsPorFondo(tx);
}

function renderStatsAnuales() {
  const year = document.getElementById('filterStatsYear').value;
  if (!year) return;

  const mNames = ['Ene','Feb','Mar','Abr','May','Jun','Jul','Ago','Sep','Oct','Nov','Dic'];
  let monthIngresos = new Array(12).fill(0);
  let monthGastos = new Array(12).fill(0);
  let monthAhorro = new Array(12).fill(0);

  // Parsear db para año actual
  db.ingresos.filter(i => i.fecha.startsWith(year)).forEach(i => {
    let m = parseInt(i.fecha.split('-')[1]) - 1;
    monthIngresos[m] += Number(i.monto);
  });
  db.gastos.filter(g => g.fecha.startsWith(year)).forEach(g => {
    let m = parseInt(g.fecha.split('-')[1]) - 1;
    monthGastos[m] += Number(g.monto);
  });
  db.ahorros.filter(a => a.fecha.startsWith(year)).forEach(a => {
    let m = parseInt(a.fecha.split('-')[1]) - 1;
    monthAhorro[m] += Number(a.monto);
  });
  db.ingresos.filter(i => i.fecha.startsWith(year) && i.fondo === 'Ahorro').forEach(i => {
    let m = parseInt(i.fecha.split('-')[1]) - 1;
    monthAhorro[m] += Number(i.monto);
  });

  // Chart 1: Barras apiladas
  if(chartAnualBars) chartAnualBars.destroy();
  chartAnualBars = new Chart(document.getElementById('chartAnualBars'), {
    type: 'bar',
    data: {
      labels: mNames,
      datasets: [
        { label: 'Ingresos', data: monthIngresos, backgroundColor: colors.success },
        { label: 'Gastos', data: monthGastos, backgroundColor: colors.danger }
      ]
    },
    options: {
      scales: { x: { stacked: false }, y: { stacked: false } },
      plugins: { title: { display: true, text: `Ingresos vs Gastos (${year})` } }
    }
  });

  // Chart 2: Ahorro Acumulado
  let acum = 0;
  let ahorroEvol = monthAhorro.map(v => { acum += v; return acum; });
  if(chartAhorroAcumulado) chartAhorroAcumulado.destroy();
  chartAhorroAcumulado = new Chart(document.getElementById('chartAhorroAcumulado'), {
    type: 'line',
    data: {
      labels: mNames,
      datasets: [{
        label: 'Ahorro Acumulado',
        data: ahorroEvol,
        borderColor: colors.success,
        fill: true,
        backgroundColor: 'rgba(29, 158, 117, 0.2)'
      }]
    },
    options: { plugins: { title: { display: true, text: 'Ahorro Acumulado en el Año' } } }
  });

  // Chart 3: Inversión Acumulada
  let monthInversion = new Array(12).fill(0);
  db.inversiones.filter(i => i.fecha.startsWith(year)).forEach(i => {
    let m = parseInt(i.fecha.split('-')[1]) - 1;
    monthInversion[m] += Number(i.monto);
  });
  db.ingresos.filter(i => i.fecha.startsWith(year) && (i.fondo === 'Inversion' || i.fondo === 'Inversión')).forEach(i => {
    let m = parseInt(i.fecha.split('-')[1]) - 1;
    monthInversion[m] += Number(i.monto);
  });

  let acumInv = 0;
  let invEvol = monthInversion.map(v => { acumInv += v; return acumInv; });
  if(chartInversionAcumulado) chartInversionAcumulado.destroy();
  chartInversionAcumulado = new Chart(document.getElementById('chartInversionAcumulado'), {
    type: 'line',
    data: {
      labels: mNames,
      datasets: [{
        label: 'Inversión Acumulada',
        data: invEvol,
        borderColor: colors.warning,
        fill: true,
        backgroundColor: 'rgba(245, 166, 35, 0.15)'
      }]
    },
    options: { plugins: { title: { display: true, text: 'Inversión Acumulada en el Año' } } }
  });

  // Chart 4: Ahorro vs Inversión Mensual
  if(chartAhorroInvMensual) chartAhorroInvMensual.destroy();
  chartAhorroInvMensual = new Chart(document.getElementById('chartAhorroInvMensual'), {
    type: 'bar',
    data: {
      labels: mNames,
      datasets: [
        { label: 'Ahorro', data: monthAhorro, backgroundColor: colors.success },
        { label: 'Inversión', data: monthInversion, backgroundColor: colors.warning }
      ]
    },
    options: {
      scales: { x: { stacked: false }, y: { stacked: false, beginAtZero: true } },
      plugins: { title: { display: true, text: `Ahorro vs Inversión Mensual (${year})` } }
    }
  });

  // Top 5 categorias
  let cMap = {};
  db.gastos.filter(g => g.fecha.startsWith(year)).forEach(g => {
    let c = g.categoria || 'Sin categoría';
    cMap[c] = (cMap[c] || 0) + Number(g.monto);
  });

  let sortArr = Object.entries(cMap).sort((a,b) => b[1] - a[1]).slice(0,5);
  const tbody = document.getElementById('topCatTableBody');
  tbody.innerHTML = '';
  sortArr.forEach(entry => {
    const tr = document.createElement('tr');
    tr.innerHTML = `<td>${getIconForCat(entry[0])} ${escapeHtml(entry[0])}</td><td class="text-danger">${formatMoney(entry[1])}</td>`;
    tbody.appendChild(tr);
  });
}

// === SELECTOR DE TEMA ===

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'default';
  const order = ['default', 'dark', 'pink'];
  const next = order[(order.indexOf(current) + 1) % order.length];
  applyTheme(next);
  localStorage.setItem('financeTheme', next);
}
window.toggleTheme = toggleTheme;

function applyTheme(theme) {
  if (theme === 'pink' || theme === 'dark') {
    document.documentElement.setAttribute('data-theme', theme);
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
  // Actualizar texto del botón
  const btn = document.getElementById('btnThemeToggle');
  if (btn) {
    const labels = { default: '🌙 Oscuro', dark: '🌸 Rosa', pink: '☀️ Claro' };
    btn.textContent = labels[theme] || '🌙 Oscuro';
  }
}

// === EXPORTAR A EXCEL — VERSIÓN MEJORADA ===

function _xlC(v, s) {
  var cell = {};
  if (v === null || v === undefined || v === '') { cell.t = 's'; cell.v = ''; }
  else if (typeof v === 'number') { cell.t = 'n'; cell.v = v; }
  else { cell.t = 's'; cell.v = String(v); }
  if (s) cell.s = s;
  return cell;
}
function _xlN(v, s, fmt) {
  var cell = { t: 'n', v: Number(v) || 0 };
  var st = s ? Object.assign({}, s) : {};
  if (fmt) st.numFmt = fmt;
  if (Object.keys(st).length) cell.s = st;
  return cell;
}
function _xlSheet(rows) {
  var ws = {}; var maxC = 0;
  rows.forEach(function(row, r) {
    if (row.length > maxC) maxC = row.length;
    row.forEach(function(cell, c) {
      ws[XLSX.utils.encode_cell({ r: r, c: c })] = cell || { t: 's', v: '' };
    });
  });
  ws['!ref'] = XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: rows.length - 1, c: maxC - 1 } });
  return ws;
}
function _colWidths(dataRows, headers) {
  var w = headers.map(function(h) { return String(h).length; });
  dataRows.forEach(function(row) {
    row.forEach(function(cell, c) {
      if (c < w.length) { var l = cell && cell.v != null ? String(cell.v).length : 0; if (l > w[c]) w[c] = l; }
    });
  });
  return w.map(function(x) { return { wch: Math.min(x + 2, 55) }; });
}
function _buildAllTx(tx) {
  return [].concat(
    tx.gastos.map(function(g) { return Object.assign({}, g, { _type: 'Gasto' }); }),
    tx.ingresos.map(function(i) { return Object.assign({}, i, { _type: 'Ingreso' }); }),
    tx.ahorros.map(function(a) { return Object.assign({}, a, { _type: 'Ahorro' }); }),
    tx.inversiones.map(function(i) { return Object.assign({}, i, { _type: 'Inversión' }); }),
    tx.creditos.map(function(c) { return Object.assign({}, c, { _type: 'Pago Crédito', fecha: c.fecha_pago || c.fecha }); })
  );
}
function _buildAllTxYear(year) {
  var fn = function(t) { return t.fecha && t.fecha.startsWith(year); };
  var fc = function(t) { var f = t.fecha_pago || t.fecha; return f && f.startsWith(year); };
  return [].concat(
    db.gastos.filter(fn).map(function(g) { return Object.assign({}, g, { _type: 'Gasto' }); }),
    db.ingresos.filter(fn).map(function(i) { return Object.assign({}, i, { _type: 'Ingreso' }); }),
    db.ahorros.filter(fn).map(function(a) { return Object.assign({}, a, { _type: 'Ahorro' }); }),
    db.inversiones.filter(fn).map(function(i) { return Object.assign({}, i, { _type: 'Inversión' }); }),
    db.creditos.filter(fc).map(function(c) { return Object.assign({}, c, { _type: 'Pago Crédito', fecha: c.fecha_pago || c.fecha }); })
  );
}

var _S = {
  hdr:  { font: { bold: true, color: { rgb: 'FFFFFF' }, sz: 11 }, fill: { fgColor: { rgb: '1D9E75' }, patternType: 'solid' }, alignment: { horizontal: 'center', wrapText: true } },
  grn:  { font: { color: { rgb: '1D7A5A' } } },
  red:  { font: { color: { rgb: 'C0392B' } } },
  grnA: { font: { color: { rgb: '1D7A5A' } }, fill: { fgColor: { rgb: 'F7F7F7' }, patternType: 'solid' } },
  redA: { font: { color: { rgb: 'C0392B' } }, fill: { fgColor: { rgb: 'F7F7F7' }, patternType: 'solid' } },
  tot:  { font: { bold: true }, fill: { fgColor: { rgb: 'EEEEEE' }, patternType: 'solid' } },
  sec:  { font: { bold: true, color: { rgb: '1D5E3A' }, sz: 12 }, fill: { fgColor: { rgb: 'E8F5F0' }, patternType: 'solid' } },
  th:   { font: { bold: true }, fill: { fgColor: { rgb: 'EEEEEE' }, patternType: 'solid' } },
  bold: { font: { bold: true } },
  num:  '#,##0',
  pct:  '0.0%'
};

function _sheetDetalle(allTx) {
  var H = ['Fecha','Tipo','Fondo','Categoría','Lugar/Origen','Descripción','Monto (CLP)','Moneda Original','Monto Original','Medio de Pago'];
  var hRow = H.map(function(h) { return _xlC(h, _S.hdr); });
  var dataRows = [];
  allTx.forEach(function(t, idx) {
    var inc = ['Ingreso','Ahorro','Inversión'].indexOf(t._type) >= 0;
    var alt = idx % 2 === 1;
    var bs = inc ? (alt ? _S.grnA : _S.grn) : (alt ? _S.redA : _S.red);
    var fx = t.moneda && t.moneda !== 'CLP';
    var row = [
      _xlC(t.fecha, bs),
      _xlC(t._type, bs),
      _xlC(t.fondo || '', bs),
      _xlC(t._type === 'Gasto' ? (t.categoria || '') : '', bs),
      _xlC(t._type === 'Gasto' ? (t.donde || '') : '', bs),
      _xlC(t.descripcion || '', bs),
      _xlN(t.monto, bs, _S.num),
      _xlC(fx ? t.moneda : '', bs),
      fx ? _xlN(t.montoOriginal || t.monto, bs, _S.num) : _xlC('', bs),
      _xlC(t._type === 'Gasto' ? (t.credito ? 'Tarjeta de Crédito' : 'Débito/Efectivo') : '', bs)
    ];
    dataRows.push(row);
  });
  var sumI = allTx.filter(function(t){ return ['Ingreso','Ahorro','Inversión'].indexOf(t._type)>=0; }).reduce(function(a,b){ return a+Number(b.monto); }, 0);
  var sumG = allTx.filter(function(t){ return ['Gasto','Pago Crédito'].indexOf(t._type)>=0; }).reduce(function(a,b){ return a+Number(b.monto); }, 0);
  var ts = Object.assign({}, _S.tot, { numFmt: _S.num });
  var totRow = [
    _xlC('TOTALES', _S.tot), _xlC('', _S.tot), _xlC('', _S.tot), _xlC('', _S.tot), _xlC('', _S.tot),
    _xlC('Ingresos / Gastos', _S.tot),
    _xlN(sumI, Object.assign({}, _S.tot, { font: { bold: true, color: { rgb: '1D7A5A' } } }), _S.num),
    _xlN(sumG, Object.assign({}, _S.tot, { font: { bold: true, color: { rgb: 'C0392B' } } }), _S.num),
    _xlN(sumI - sumG, Object.assign({}, _S.tot, { font: { bold: true } }), _S.num),
    _xlC('', _S.tot)
  ];
  var allRows = [hRow].concat(dataRows, [totRow]);
  var ws = _xlSheet(allRows);
  ws['!cols'] = _colWidths(dataRows, H);
  ws['!autofilter'] = { ref: XLSX.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: 0, c: H.length - 1 } }) };
  return ws;
}

function _sheetResumen(allTx) {
  var rows = [];
  var fondos = window.userFondos || [];
  var isI = function(t){ return ['Ingreso','Ahorro','Inversión'].indexOf(t._type)>=0; };
  var isG = function(t){ return ['Gasto','Pago Crédito'].indexOf(t._type)>=0; };
  var sumI = allTx.filter(isI).reduce(function(a,b){ return a+Number(b.monto); }, 0);
  var sumG = allTx.filter(isG).reduce(function(a,b){ return a+Number(b.monto); }, 0);
  var sumAh = allTx.filter(function(t){ return t._type==='Ahorro'||(t._type==='Ingreso'&&t.fondo==='Ahorro'); }).reduce(function(a,b){ return a+Number(b.monto); },0);
  var sumInv = allTx.filter(function(t){ return t._type==='Inversión'||(t._type==='Ingreso'&&(t.fondo==='Inversion'||t.fondo==='Inversión')); }).reduce(function(a,b){ return a+Number(b.monto); },0);
  var bal = sumI - sumG;
  var tasaAh = sumI > 0 ? sumAh / sumI : 0;

  // Sección 1
  rows.push([_xlC('RESUMEN GENERAL', _S.sec), _xlC('', _S.sec)]);
  rows.push([_xlC('Concepto', _S.th), _xlC('Monto', _S.th)]);
  rows.push([_xlC('Total Ingresos'), _xlN(sumI, { font: { color: { rgb: '1D7A5A' } } }, _S.num)]);
  rows.push([_xlC('Total Gastos'), _xlN(sumG, { font: { color: { rgb: 'C0392B' } } }, _S.num)]);
  rows.push([_xlC('Total Ahorro'), _xlN(sumAh, null, _S.num)]);
  rows.push([_xlC('Total Inversión'), _xlN(sumInv, null, _S.num)]);
  rows.push([_xlC('Balance Neto (Ingresos - Gastos)'), _xlN(bal, { font: { bold: true, color: { rgb: bal >= 0 ? '1D7A5A' : 'C0392B' } } }, _S.num)]);
  rows.push([_xlC('Tasa de Ahorro (Ahorro / Ingresos)'), _xlN(tasaAh, null, _S.pct)]);
  rows.push([_xlC('')]);

  // Sección 2 — Gastos por Categoría
  rows.push([_xlC('GASTOS POR CATEGORÍA', _S.sec), _xlC('', _S.sec), _xlC('', _S.sec)]);
  rows.push([_xlC('Categoría', _S.th), _xlC('Monto Total', _S.th), _xlC('% del Total', _S.th)]);
  var catMap = {};
  allTx.filter(function(t){ return t._type==='Gasto'; }).forEach(function(t){ var c = t.categoria||'otro'; catMap[c] = (catMap[c]||0) + Number(t.monto); });
  Object.entries(catMap).sort(function(a,b){ return b[1]-a[1]; }).forEach(function(e){
    rows.push([_xlC(e[0]), _xlN(e[1], null, _S.num), _xlN(sumG > 0 ? e[1]/sumG : 0, null, _S.pct)]);
  });
  rows.push([_xlC('')]);

  // Sección 3 — Por Fondo
  rows.push([_xlC('GASTOS POR FONDO', _S.sec), _xlC('', _S.sec), _xlC('', _S.sec), _xlC('', _S.sec)]);
  rows.push([_xlC('Fondo', _S.th), _xlC('Ingresos', _S.th), _xlC('Gastos', _S.th), _xlC('Balance', _S.th)]);
  fondos.forEach(function(f){
    var fi = allTx.filter(function(t){ return t.fondo===f && isI(t); }).reduce(function(a,b){ return a+Number(b.monto); },0);
    var fg = allTx.filter(function(t){ return t.fondo===f && isG(t); }).reduce(function(a,b){ return a+Number(b.monto); },0);
    rows.push([_xlC(f), _xlN(fi, null, _S.num), _xlN(fg, null, _S.num), _xlN(fi-fg, { font: { color: { rgb: fi-fg>=0?'1D7A5A':'C0392B' } } }, _S.num)]);
  });
  rows.push([_xlC('')]);

  // Sección 4 — Medio de Pago
  rows.push([_xlC('GASTOS POR MEDIO DE PAGO', _S.sec), _xlC('', _S.sec), _xlC('', _S.sec)]);
  rows.push([_xlC('Medio', _S.th), _xlC('Monto', _S.th), _xlC('% del Total', _S.th)]);
  var cred = allTx.filter(function(t){ return t._type==='Gasto' && t.credito; }).reduce(function(a,b){ return a+Number(b.monto); },0);
  var deb = allTx.filter(function(t){ return t._type==='Gasto' && !t.credito; }).reduce(function(a,b){ return a+Number(b.monto); },0);
  rows.push([_xlC('Tarjeta de Crédito'), _xlN(cred, null, _S.num), _xlN(sumG>0?cred/sumG:0, null, _S.pct)]);
  rows.push([_xlC('Débito/Efectivo'), _xlN(deb, null, _S.num), _xlN(sumG>0?deb/sumG:0, null, _S.pct)]);

  var ws = _xlSheet(rows);
  ws['!cols'] = [{ wch: 38 }, { wch: 18 }, { wch: 14 }, { wch: 14 }];
  return ws;
}

function _sheetMensual(year) {
  var mNames = ['Enero','Febrero','Marzo','Abril','Mayo','Junio','Julio','Agosto','Septiembre','Octubre','Noviembre','Diciembre'];
  var mI = new Array(12).fill(0); var mG = new Array(12).fill(0); var mAh = new Array(12).fill(0); var mInv = new Array(12).fill(0);
  db.ingresos.filter(function(i){ return i.fecha && i.fecha.startsWith(year); }).forEach(function(i){ mI[parseInt(i.fecha.split('-')[1])-1] += Number(i.monto); });
  db.gastos.filter(function(g){ return g.fecha && g.fecha.startsWith(year); }).forEach(function(g){ mG[parseInt(g.fecha.split('-')[1])-1] += Number(g.monto); });
  db.ahorros.filter(function(a){ return a.fecha && a.fecha.startsWith(year); }).forEach(function(a){ mAh[parseInt(a.fecha.split('-')[1])-1] += Number(a.monto); });
  db.ingresos.filter(function(i){ return i.fecha && i.fecha.startsWith(year) && i.fondo==='Ahorro'; }).forEach(function(i){ mAh[parseInt(i.fecha.split('-')[1])-1] += Number(i.monto); });
  db.inversiones.filter(function(i){ return i.fecha && i.fecha.startsWith(year); }).forEach(function(i){ mInv[parseInt(i.fecha.split('-')[1])-1] += Number(i.monto); });
  db.ingresos.filter(function(i){ return i.fecha && i.fecha.startsWith(year) && (i.fondo==='Inversion'||i.fondo==='Inversión'); }).forEach(function(i){ mInv[parseInt(i.fecha.split('-')[1])-1] += Number(i.monto); });

  var H = ['Mes','Ingresos','Gastos','Ahorro','Inversión','Balance'];
  var rows = [H.map(function(h){ return _xlC(h, _S.hdr); })];
  mNames.forEach(function(m, idx){
    rows.push([
      _xlC(m),
      _xlN(mI[idx], null, _S.num), _xlN(mG[idx], null, _S.num),
      _xlN(mAh[idx], null, _S.num), _xlN(mInv[idx], null, _S.num),
      _xlN(mI[idx]-mG[idx], { font: { color: { rgb: mI[idx]-mG[idx]>=0?'1D7A5A':'C0392B' } } }, _S.num)
    ]);
  });
  var ti=mI.reduce(function(a,b){return a+b;},0), tg=mG.reduce(function(a,b){return a+b;},0), tah=mAh.reduce(function(a,b){return a+b;},0), tinv=mInv.reduce(function(a,b){return a+b;},0);
  rows.push([_xlC('TOTAL',_S.tot),_xlN(ti,_S.tot,_S.num),_xlN(tg,_S.tot,_S.num),_xlN(tah,_S.tot,_S.num),_xlN(tinv,_S.tot,_S.num),_xlN(ti-tg,_S.tot,_S.num)]);
  var ws = _xlSheet(rows);
  ws['!cols'] = [{ wch: 14 },{ wch: 16 },{ wch: 14 },{ wch: 14 },{ wch: 14 },{ wch: 14 }];
  return ws;
}

function generateExcelFromTransactions(allTx, fileName, isAnual, period) {
  if (typeof XLSX === 'undefined') { showToast('Error: librería Excel no cargada', 'error'); return; }
  var wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, _sheetDetalle(allTx), 'Detalle');
  XLSX.utils.book_append_sheet(wb, _sheetResumen(allTx), 'Resumen');
  if (isAnual && period) XLSX.utils.book_append_sheet(wb, _sheetMensual(String(period)), 'Mensual');
  XLSX.writeFile(wb, fileName + '.xlsx');
  showToast('Excel generado correctamente', 'success');
}

window.exportCartolaMensual = function() {
  var month = document.getElementById('filterStatsMonth').value;
  if (!month) { showToast('Selecciona un mes a analizar primero', 'warning'); return; }
  if (typeof XLSX === 'undefined') { showToast('Error: librería Excel no cargada', 'error'); return; }
  var tx = getTransactionsByMonth(month);
  var allTx = _buildAllTx(tx);
  allTx.sort(function(a,b){ return new Date(a.fecha) - new Date(b.fecha); });
  generateExcelFromTransactions(allTx, 'Cartola_Mensual_' + month, false, month);
};

window.exportCartolaAnual = function() {
  var year = document.getElementById('filterStatsYear').value;
  if (!year) { showToast('Ingresa un año primero', 'warning'); return; }
  if (typeof XLSX === 'undefined') { showToast('Error: librería Excel no cargada', 'error'); return; }
  var allTx = _buildAllTxYear(year);
  allTx.sort(function(a,b){ return new Date(a.fecha) - new Date(b.fecha); });
  generateExcelFromTransactions(allTx, 'Cartola_Anual_' + year, true, year);
};

window.exportCartolaMensualFromReg = function() {
  var month = document.getElementById('filterRegMonth').value;
  if (!month) { showToast('Selecciona un mes primero', 'warning'); return; }
  if (typeof XLSX === 'undefined') { showToast('Error: librería Excel no cargada', 'error'); return; }
  var tx = getTransactionsByMonth(month);
  var allTx = _buildAllTx(tx);
  allTx.sort(function(a,b){ return new Date(a.fecha) - new Date(b.fecha); });
  generateExcelFromTransactions(allTx, 'Cartola_Mensual_' + month, false, month);
};

window.exportCartolaAnualFromReg = function() {
  var month = document.getElementById('filterRegMonth').value;
  if (!month) { showToast('Selecciona un mes primero para determinar el año', 'warning'); return; }
  var year = month.split('-')[0];
  if (typeof XLSX === 'undefined') { showToast('Error: librería Excel no cargada', 'error'); return; }
  var allTx = _buildAllTxYear(year);
  allTx.sort(function(a,b){ return new Date(a.fecha) - new Date(b.fecha); });
  generateExcelFromTransactions(allTx, 'Cartola_Anual_' + year, true, year);
};

// === PRIVACIDAD ===
window.togglePrivacy = function(type) {
  const isHidden = localStorage.getItem('hide' + type) === 'true';
  localStorage.setItem('hide' + type, isHidden ? 'false' : 'true');
  applyPrivacySettings();
}

function applyPrivacySettings() {
  ['Ahorro', 'Inver'].forEach(type => {
    const isHidden = localStorage.getItem('hide' + type) === 'true';
    const numEl = type === 'Ahorro' ? document.getElementById('sumAhorro') : document.getElementById('sumInversion');
    const iconEl = type === 'Ahorro' ? document.getElementById('iconPrivacyAhorro') : document.getElementById('iconPrivacyInver');
    
    if (numEl && iconEl) {
      if (isHidden) {
        numEl.textContent = '****';
        iconEl.textContent = 'visibility_off';
      } else {
        // Restaurar valor raw formated
        numEl.textContent = formatMoney(Number(numEl.dataset.raw || 0));
        iconEl.textContent = 'visibility';
      }
    }
  });
}

// === FONDOS CONFIG ===
window.openFondosModal = function() {
  document.getElementById('modalFondos').classList.add('active');
  renderFondosList();
}

function renderFondosList() {
  const container = document.getElementById('fondosListContainer');
  let html = '';
  window.userFondos.forEach((fondo, idx) => {
    html += `
      <div style="display:flex; justify-content:space-between; align-items:center; background: rgba(0,0,0,0.03); padding: 0.8rem 1rem; border-radius: 8px;">
        <div style="font-weight:500;">${escapeHtml(fondo)}</div>
        <div style="display:flex; gap:0.5rem;">
          <button class="btn btn-outline btn-sm" onclick="renameFondoConfig(${idx})"><span class="material-icons-round text-primary" style="font-size:1.1rem; margin-right:0;">edit</span></button>
          <button class="btn btn-outline btn-sm" onclick="deleteFondoConfig(${idx})"><span class="material-icons-round text-danger" style="font-size:1.1rem; margin-right:0;">delete</span></button>
        </div>
      </div>
    `;
  });
  container.innerHTML = html;
}

window.addFondoConfig = async function() {
  const ipt = document.getElementById('nuevoFondoName');
  const nf = ipt.value.trim();
  if (!nf) return;
  if (window.userFondos.includes(nf) || nf === 'Ahorro' || nf === 'Inversion' || nf === 'Inversión') {
    showToast('Ese nombre de fondo ya existe o está reservado', 'warning');
    return;
  }
  window.userFondos.push(nf);
  ipt.value = '';
  await saveConfigChange();
  showToast(`Fondo "${nf}" agregado`, 'success');
}

window.deleteFondoConfig = async function(idx) {
  if (window.userFondos.length <= 1) {
    showToast('Debes tener al menos un fondo configurado', 'warning');
    return;
  }
  const fondoName = window.userFondos[idx];
  showConfirmToast(`¿Eliminar fondo "${fondoName}"? Las transacciones asociadas no se borrarán`, async () => {
    window.userFondos.splice(idx, 1);
    await saveConfigChange();
    showToast(`Fondo "${fondoName}" eliminado`, 'success');
  }, null, 'Sí, eliminar');
}

window.renameFondoConfig = async function(idx) {
  const oldName = window.userFondos[idx];
  
  showPromptModal(`Renombrar fondo "${oldName}"`, oldName, async (newName) => {
    if (newName === oldName) return;
    
    if (window.userFondos.includes(newName)) {
      showToast('Ese nombre ya existe', 'warning');
      return;
    }
    
    window.userFondos[idx] = newName;
    
    markUnsaved();
    const collections = ['ingresos', 'gastos', 'recurrentes', 'deudas'];
    const promises = [];
    collections.forEach(coll => {
      db[coll].forEach(item => {
        if (item.fondo === oldName) {
          item.fondo = newName;
          promises.push(saveItem(coll, item));
        }
      });
    });
    
    try {
      await Promise.all(promises);
      await saveConfigChange();
      showToast(`Fondo renombrado: ${oldName} → ${newName}. Transacciones migradas.`, 'success', 4500);
    } catch(err) {
      showToast('Error al migrar transacciones: ' + err.message, 'error');
    }
  });
}

async function saveConfigChange() {
  const doc = db.config.find(c => c.id === 'userFondos');
  doc.items = window.userFondos;
  await saveItem('config', doc);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));
  renderFondosList();
  populateFilterRegFondo(); // mantener el filtro de fondos al día tras agregar/renombrar/eliminar
  refreshViews();
}


// === GRÁFICOS POR FONDO (Estadísticas Mensuales) ===
let chartsPorFondo = {};

function renderChartsPorFondo(tx) {
  const container = document.getElementById('chartsPerFondoContainer');
  if (!container) return;

  // Destruir gráficos anteriores
  Object.values(chartsPorFondo).forEach(c => { try { c.destroy(); } catch(e) {} });
  chartsPorFondo = {};
  container.innerHTML = '';

  const fondos = window.userFondos || [];
  if (fondos.length === 0) return;

  // Sección título
  const titleEl = document.createElement('div');
  titleEl.className = 'section-title';
  titleEl.style.marginTop = '2rem';
  titleEl.innerHTML = '<h3>Estadísticas por Fondo</h3>';
  container.appendChild(titleEl);

  // --- Chart 1: Ingresos vs Gastos por Fondo (barras agrupadas) ---
  const fondoIngTotals = fondos.map(f => tx.ingresos.filter(i => i.fondo === f).reduce((a, b) => a + Number(b.monto), 0));
  const fondoGasTotals = fondos.map(f => tx.gastos.filter(g => g.fondo === f).reduce((a, b) => a + Number(b.monto), 0));

  const barWrapper = document.createElement('div');
  barWrapper.className = 'charts-grid';
  barWrapper.style.marginBottom = '1.5rem';

  const barContainer = document.createElement('div');
  barContainer.className = 'chart-container';
  barContainer.style.gridColumn = '1 / -1';
  const barCanvas = document.createElement('canvas');
  barCanvas.id = 'chartFondoIncExp';
  barContainer.appendChild(barCanvas);
  barWrapper.appendChild(barContainer);
  container.appendChild(barWrapper);

  chartsPorFondo['incexp'] = new Chart(barCanvas, {
    type: 'bar',
    data: {
      labels: fondos,
      datasets: [
        { label: 'Ingresos', data: fondoIngTotals, backgroundColor: colors.success },
        { label: 'Gastos', data: fondoGasTotals, backgroundColor: colors.danger }
      ]
    },
    options: {
      plugins: { title: { display: true, text: 'Ingresos vs Gastos por Fondo' } },
      scales: { x: { stacked: false }, y: { stacked: false, beginAtZero: true } }
    }
  });

  // --- Chart 2+: Donut de gastos por categoría para cada fondo ---
  const donutGrid = document.createElement('div');
  donutGrid.className = 'charts-grid';
  container.appendChild(donutGrid);

  fondos.forEach(fondo => {
    const fondoGastos = tx.gastos.filter(g => g.fondo === fondo);
    const catSums = {};
    fondoGastos.forEach(g => {
      const c = g.categoria || 'Sin categoría';
      catSums[c] = (catSums[c] || 0) + Number(g.monto);
    });

    const donutContainer = document.createElement('div');
    donutContainer.className = 'chart-container';
    const donutCanvas = document.createElement('canvas');
    const canvasId = `chartFondoCat_${fondo.replace(/\s+/g, '_')}`;
    donutCanvas.id = canvasId;
    donutContainer.appendChild(donutCanvas);
    donutGrid.appendChild(donutContainer);

    if (Object.keys(catSums).length === 0) {
      // Sin datos: mostrar mensaje
      const msg = document.createElement('p');
      msg.className = 'text-muted';
      msg.style.cssText = 'text-align:center; padding-top: 2rem; font-size:0.9rem;';
      msg.textContent = `Sin gastos registrados en ${fondo}`;
      donutContainer.appendChild(msg);
      return;
    }

    chartsPorFondo[fondo] = new Chart(donutCanvas, {
      type: 'doughnut',
      data: {
        labels: Object.keys(catSums),
        datasets: [{ data: Object.values(catSums), backgroundColor: colors.cat }]
      },
      options: {
        plugins: { title: { display: true, text: `Gastos por Categoría — ${fondo}` } }
      }
    });
  });
}


// === DISTRIBUCIÓN DE INGRESOS ===
window.openDistribucionModal = function() {
  const container = document.getElementById('distribucionInputsContainer');
  if (!container) return;

  const fondos = window.userFondos || [];
  const reglas = window.distribucionReglas || [];

  container.innerHTML = '';
  fondos.forEach((fondo, idx) => {
    const regla = reglas.find(r => r.fondo === fondo);
    const pct = regla ? regla.porcentaje : 0;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background: rgba(0,0,0,0.03); padding: 0.8rem 1rem; border-radius: 8px;';
    row.innerHTML = `
      <div style="font-weight:500; flex:1;">${escapeHtml(fondo)}</div>
      <div style="display:flex; align-items:center; gap:0.5rem;">
        <input type="number" id="distPct_${idx}"
               class="form-control" min="0" max="100" step="0.1" value="${Number(pct) || 0}"
               style="width:90px; text-align:right;"
               oninput="updateDistribucionTotal()">
        <span>%</span>
      </div>
    `;
    container.appendChild(row);
  });

  updateDistribucionTotal();
  document.getElementById('modalDistribucion').classList.add('active');
};

window.updateDistribucionTotal = function() {
  const fondos = window.userFondos || [];
  let total = 0;
  fondos.forEach((fondo, idx) => {
    const inp = document.getElementById('distPct_' + idx);
    if (inp) total += Number(inp.value) || 0;
  });
  const totalEl = document.getElementById('distribucionTotal');
  const errorEl = document.getElementById('distribucionError');
  if (totalEl) {
    totalEl.textContent = total.toFixed(1) + '%';
    totalEl.style.color = Math.abs(total - 100) < 0.01 ? 'var(--color-success)' : 'var(--color-danger)';
  }
  if (errorEl) errorEl.style.display = Math.abs(total - 100) < 0.01 ? 'none' : 'block';
};

window.saveDistribucionReglas = async function() {
  const fondos = window.userFondos || [];
  let total = 0;
  const reglas = fondos.map((fondo, idx) => {
    const inp = document.getElementById('distPct_' + idx);
    const pct = Number(inp ? inp.value : 0) || 0;
    total += pct;
    return { fondo: fondo, porcentaje: pct };
  });

  if (Math.abs(total - 100) >= 0.01) {
    showToast('La suma de porcentajes debe ser exactamente 100%', 'error');
    return;
  }

  window.distribucionReglas = reglas;

  // Persistir en db.config
  let confDist = db.config.find(c => c.id === 'ingresosDistribucion');
  if (confDist) {
    confDist.reglas = reglas;
  } else {
    confDist = { id: 'ingresosDistribucion', reglas: reglas };
    db.config.push(confDist);
  }
  await saveItem('config', confDist);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(db));

  document.getElementById('modalDistribucion').classList.remove('active');
  showToast('Regla de distribución guardada correctamente', 'success');
};


// === PANEL INLINE DE DISTRIBUCIÓN EN MODAL DE INGRESO ===
window.toggleDistribuirPanel = function() {
  const chk = document.getElementById('txDistribuir');
  const panel = document.getElementById('txDistribuirPanel');
  const gFondo = document.getElementById('txGroupFondo');
  if (!chk || !panel) return;

  if (chk.checked) {
    panel.style.display = 'block';
    if (gFondo) gFondo.style.display = 'none'; // Ocultar selector de fondo único
    _populateDistribuirInputs();
  } else {
    panel.style.display = 'none';
    if (gFondo) gFondo.style.display = 'block'; // Restaurar selector de fondo único
  }
};

function _populateDistribuirInputs() {
  const container = document.getElementById('txDistribuirInputs');
  if (!container) return;

  // Todos los fondos disponibles para ingresos (igual que el selector de fondo)
  const fondos = [...(window.userFondos || []), 'Ahorro', 'Inversión'];
  // Prefill desde regla guardada si existe
  const reglas = window.distribucionReglas || [];

  container.innerHTML = '';
  fondos.forEach((fondo, idx) => {
    const regla = reglas.find(r => r.fondo === fondo);
    const pct = regla ? regla.porcentaje : 0;

    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; gap:0.8rem;';
    row.innerHTML = `
      <label style="font-weight:500; flex:1; font-size:0.9rem;">${escapeHtml(fondo)}</label>
      <div style="display:flex; align-items:center; gap:0.4rem;">
        <input type="number" id="txDistPct_${idx}" class="form-control"
               min="0" max="100" step="0.1" value="${Number(pct) || 0}"
               style="width:80px; text-align:right; padding: 0.5rem 0.6rem;"
               oninput="updateDistribuirTxTotal()">
        <span style="font-weight:500; color:var(--color-text-muted);">%</span>
      </div>
    `;
    container.appendChild(row);
  });

  updateDistribuirTxTotal();
}

window.updateDistribuirTxTotal = function() {
  const fondos = [...(window.userFondos || []), 'Ahorro', 'Inversión'];
  let total = 0;
  fondos.forEach((fondo, idx) => {
    const inp = document.getElementById('txDistPct_' + idx);
    if (inp) total += Number(inp.value) || 0;
  });

  const totalEl = document.getElementById('txDistribuirTotal');
  const errorEl = document.getElementById('txDistribuirError');
  const ok = Math.abs(total - 100) < 0.01;

  if (totalEl) {
    totalEl.textContent = total.toFixed(1) + '%';
    totalEl.style.color = ok ? 'var(--color-success)' : 'var(--color-danger)';
  }
  if (errorEl) errorEl.style.display = ok ? 'none' : 'block';
};


