// app.js

// === FIREBASE CONFIG ===
if (!window.ENV || !window.ENV.firebaseConfig) {
  console.error('Configuración de Firebase no encontrada.');
}

const firebaseConfig = window.ENV.firebaseConfig;

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const firestore = firebase.firestore();

// === ESTADO GLOBAL ===
const STORAGE_KEY = 'financeTrackerData';
let currentUser = null;
let appInitialized = false;

let db = {
  ingresos: [], gastos: [], ahorros: [], inversiones: [],
  creditos: [], deudas: [], recurrentes: [], presupuestos: [], config: []
};

const emptyDb = () => ({
  ingresos: [], gastos: [], ahorros: [], inversiones: [],
  creditos: [], deudas: [], recurrentes: [], presupuestos: [], config: []
});

// Generador de UUID v4 simple
function uuidv4() {
  return "10000000-1000-4000-8000-100000000000".replace(/[018]/g, c =>
    (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)
  );
}

// === AUTENTICACIÓN (Firebase Auth con Google) ===

document.addEventListener('DOMContentLoaded', () => {
  document.getElementById('btnGoogleLogin').addEventListener('click', loginWithGoogle);

  // Restaurar tema guardado
  applyTheme(localStorage.getItem('financeTheme') || 'default');

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
    await auth.signInWithPopup(provider);
  } catch (err) {
    console.error('Error en login:', err);
    if (err.code !== 'auth/popup-closed-by-user') {
      showToast('Error al iniciar sesión: ' + err.message, 'error');
    }
  }
}

function logOut() {
  auth.signOut();
}
window.logOut = logOut;

function showLogin() {
  document.getElementById('loginScreen').style.display = 'flex';
  document.querySelector('.app-container').style.display = 'none';
}

function showApp(user) {
  document.getElementById('loginScreen').style.display = 'none';
  document.querySelector('.app-container').style.display = 'block';

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

async function loadFromFirestore() {
  try {
    if (!currentUser) return;
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
  }
}

async function saveToFirestore() {
  if (!currentUser) return;
  try {
    markUnsaved();
    localStorage.setItem(STORAGE_KEY, JSON.stringify(db)); // Guardado local inmediato
    const promises = [];
    Object.keys(db).forEach(col => {
      if (Array.isArray(db[col])) {
        db[col].forEach(item => promises.push(saveItem(col, item)));
      }
    });
    await Promise.all(promises);
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

async function importFromFile() {
  try {
    if (window.showOpenFilePicker) {
      const [handle] = await window.showOpenFilePicker({
        types: [{ description: 'JSON', accept: { 'application/json': ['.json'] } }],
      });
      const file = await handle.getFile();
      const data = JSON.parse(await file.text());
      db = { ...emptyDb(), ...data };
    } else {
      await new Promise((resolve) => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.json';
        input.onchange = async () => {
          const file = input.files[0];
          if (file) {
            const data = JSON.parse(await file.text());
            db = { ...emptyDb(), ...data };
          }
          resolve();
        };
        input.click();
      });
    }
    await saveToFirestore();
    refreshViews();
    showToast('Datos importados y sincronizados con la nube', 'success');
  } catch (err) {
    if (err.name !== 'AbortError') console.error(err);
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
    <span class="toast-message">${message}</span>
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
      <span class="toast-message">${message}</span>
      <div class="toast-confirm-actions">
        <button class="btn btn-danger btn-sm toast-btn-confirm">${confirmLabel}</button>
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
        <h3>${title}</h3>
        <button class="close-modal" id="promptClose">&times;</button>
      </div>
      <div class="form-group">
        <input type="text" id="promptInput" class="form-control" value="${defaultValue || ''}">
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

        // Si entramos a Estadísticas, forzar renderizado (para recalcular dimensiones del Canvas)
        if(target === 'view-stats-mes' || target === 'view-stats-ano' || target === 'view-resumen'){
          refreshViews();
        }
      }
    });
  });
}


// === INICIALIZACIÓN Y RENDERIZADO ===

// Formato moneda CLP
const formatMoney = (val) => new Intl.NumberFormat('es-CL', { style: 'currency', currency: 'CLP' }).format(val);

function initApp() {
  initNav();
  
  // Setear filtros iniciales (Mes Actual)
  const d = new Date();
  const currentMonthStr = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  
  document.getElementById('filterResumenMonth').value = currentMonthStr;
  document.getElementById('filterRegMonth').value = currentMonthStr;
  document.getElementById('filterStatsMonth').value = currentMonthStr;
  document.getElementById('filterStatsYear').value = d.getFullYear();

  // Listeners Filtros
  document.getElementById('filterResumenMonth').addEventListener('change', renderResumen);
  document.getElementById('filterRegMonth').addEventListener('change', renderRegistro);
  document.getElementById('filterRegFondo').addEventListener('change', renderRegistro);
  document.getElementById('filterRegCat').addEventListener('change', renderRegistro);
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
    const card = document.createElement('div');
    card.className = 'card';
    card.style.cssText = 'padding: 1.2rem; display: flex; justify-content: space-between; align-items: center;';
    card.innerHTML = `
      <div>
        <div style="font-size: 1.1rem; font-weight: 600; margin-bottom: 0.3rem;">
          ${getIconForCat(p.categoria)} ${p.categoria.charAt(0).toUpperCase() + p.categoria.slice(1)}
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
  document.getElementById('btnAddMeta').onclick = () => {
    document.getElementById('formMeta').reset();
    document.getElementById('metaId').value = '';
    document.getElementById('metaCategoria').disabled = false;
    document.getElementById('modalMetaTitle').textContent = 'Nueva Meta';
    document.getElementById('modalMeta').classList.add('active');
  };
  
  document.getElementById('formMeta').addEventListener('submit', async (e) => {
    e.preventDefault();
    const editId = document.getElementById('metaId').value;
    const cat = document.getElementById('metaCategoria').value;
    const monto = Number(document.getElementById('metaMonto').value);
    
    if (!cat || !monto || monto <= 0) return;
    
    if (editId) {
      // Editing existing
      const idx = db.presupuestos.findIndex(p => p.id === editId);
      if (idx !== -1) {
        db.presupuestos[idx].categoria = cat;
        db.presupuestos[idx].monto = monto;
        await syncData('edit', 'presupuestos', db.presupuestos[idx]);
        showToast('Meta actualizada correctamente', 'success');
      }
    } else {
      // Check if category already has a goal
      const exists = db.presupuestos.find(p => p.categoria === cat);
      if (exists) {
        showToast('Ya existe una meta para esa categoría. Edítala en su lugar.', 'warning');
        return;
      }
      const obj = { id: `presupuesto_${cat}`, categoria: cat, monto: monto };
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
  
  document.getElementById('metaId').value = meta.id;
  document.getElementById('metaCategoria').value = meta.categoria;
  document.getElementById('metaCategoria').disabled = true; // Can't change category when editing
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

function refreshViews() {
  renderResumen();
  renderRegistro();
  renderStatsMensuales();
  renderStatsAnuales();
  renderDeudas();
  renderRecurrentes();
  renderMetasList();
}

// Funciones Auxiliares de Consulta
function getTransactionsByMonth(yearMonth) { // yearMonth = 'YYYY-MM'
  const filterFn = (t) => t.fecha.startsWith(yearMonth);
  return {
    ingresos: db.ingresos.filter(filterFn),
    gastos: db.gastos.filter(filterFn),
    ahorros: db.ahorros.filter(filterFn),
    inversiones: db.inversiones.filter(filterFn),
    creditos: db.creditos.filter(item => item.fecha_pago ? item.fecha_pago.startsWith(yearMonth) : item.fecha.startsWith(yearMonth)) // compatibilidad si la bd usar fecha en lugar de fecha_pago
  };
}

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
  
  let invTotal = tx.inversiones.reduce((acc, i) => acc + Number(i.monto), 0) + tx.ingresos.filter(i => i.fondo === 'Inversion' || i.fondo === 'Inversión').reduce((a, b) => a + Number(b.monto), 0);
  let cTotal = tx.creditos.reduce((acc, c) => acc + Number(c.monto), 0);
  
  let oldAhTotal = tx.ahorros.reduce((acc, a) => acc + Number(a.monto), 0);
  let oldInvTotal = tx.inversiones.reduce((acc, i) => acc + Number(i.monto), 0);

  document.getElementById('sumAhorro').dataset.raw = ahTotal;
  document.getElementById('sumInversion').dataset.raw = invTotal;
  document.getElementById('sumCredito').textContent = formatMoney(gCredito);
  document.getElementById('sumDebito').textContent = formatMoney(gDebito);

  // Dynamic Saldos Hero
  const heroContainer = document.getElementById('heroSaldosContainer');
  if (heroContainer) {
    heroContainer.innerHTML = '';
    window.userFondos.forEach(fondo => {
      let fIngresos = tx.ingresos.filter(i => i.fondo === fondo).reduce((a, b) => a + Number(b.monto), 0);
      let fGastos = tx.gastos.filter(g => g.fondo === fondo).reduce((a, b) => a + Number(b.monto), 0);
      let saldo = fIngresos - fGastos;
      
      heroContainer.innerHTML += `
        <div class="hero-saldo-box">
          <div class="card-title">${fondo}</div>
          <div class="card-value">${formatMoney(saldo)}</div>
        </div>
      `;
    });
  }

  // Generic Gasto display
  const sumPers = document.getElementById('sumGastoPersonal');
  if (sumPers && window.userFondos[0]) {
    sumPers.parentElement.querySelector('.card-title').innerHTML = `<span class="material-icons-round">shopping_cart</span> Gasto ${window.userFondos[0]}`;
    let g1 = tx.gastos.filter(g => g.fondo === window.userFondos[0]).reduce((a, b) => a + Number(b.monto), 0);
    sumPers.textContent = formatMoney(g1);
  } else if (sumPers) sumPers.parentElement.style.display = 'none';
  
  const sumU = document.getElementById('sumGastoU');
  if (sumU && window.userFondos[1]) {
    sumU.parentElement.querySelector('.card-title').innerHTML = `<span class="material-icons-round">school</span> Gasto ${window.userFondos[1]}`;
    let g2 = tx.gastos.filter(g => g.fondo === window.userFondos[1]).reduce((a, b) => a + Number(b.monto), 0);
    sumU.textContent = formatMoney(g2);
  } else if (sumU) sumU.parentElement.style.display = 'none';

  applyPrivacySettings();



  // Generar Barras de Presupuesto (Metas) en Resumen y en la Pestaña Metas
  const pList = document.getElementById('budgetProgressList');
  const pContainer = document.getElementById('budgetProgressContainer');
  const pCardsList = document.getElementById('budgetProgressCardsList');
  const pCardsContainer = document.getElementById('budgetProgressCardsContainer');

  if (db.presupuestos && db.presupuestos.length > 0) {
    if(pContainer) pContainer.style.display = 'block';
    if(pCardsContainer) pCardsContainer.style.display = 'block';
    if(pList) pList.innerHTML = '';
    if(pCardsList) pCardsList.innerHTML = '';
    
    let curGastos = {};
    tx.gastos.forEach(g => {
      let c = g.categoria || 'otro';
      curGastos[c] = (curGastos[c] || 0) + Number(g.monto);
    });

    db.presupuestos.forEach(p => {
      let spent = curGastos[p.categoria] || 0;
      let limit = p.monto;
      let pct = (spent / limit) * 100;
      if (pct > 100) pct = 100;
      let isDanger = pct >= 90;

      let htmlCode = `
        <div style="background: rgba(255,255,255,0.5); padding: 1rem; border-radius: 12px; border: 1px solid var(--color-border); box-shadow: var(--shadow-sm);">
          <div style="display:flex; justify-content:space-between; margin-bottom:0.5rem; font-size:0.9rem; font-weight:500;">
            <span>${getIconForCat(p.categoria)} ${p.categoria.charAt(0).toUpperCase() + p.categoria.slice(1)}</span>
            <span class="text-muted">${formatMoney(spent)} / ${formatMoney(limit)}</span>
          </div>
          <div class="progress-bar">
            <div class="fill ${isDanger ? 'danger' : ''}" style="width: ${pct}%"></div>
          </div>
        </div>
      `;
      if(pList) pList.innerHTML += htmlCode;
      if(pCardsList) pCardsList.innerHTML += htmlCode;
    });
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
  allTx.slice(0, 15).forEach(item => {
    let tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.fecha}</td>
      <td><span class="tag">${item._type}</span></td>
      <td>${item.descripcion || item.donde || ''}</td>
      <td>${item.fondo || ''} ${item.credito ? '💳' : ''}</td>
      <td class="${item._color}">${formatMoney(item.monto)}</td>
    `;
    table.appendChild(tr);
  });
}

// === RENDER: REGISTRO GENERAL ===
function getIconForCat(cat) {
  const icons = { comida: '🍔', transporte: '⛽', salud: '💊', entretención: '🎬', ropa: '👕', hogar: '🏠', educación: '📚', otro: '❓' };
  return icons[cat] || '❓';
}

function renderRegistro() {
  const month = document.getElementById('filterRegMonth').value;
  const fFondo = document.getElementById('filterRegFondo').value;
  const fCat = document.getElementById('filterRegCat').value;
  
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

  allTx.sort((a,b) => new Date(b.fecha) - new Date(a.fecha));

  const table = document.getElementById('registroTableBody');
  table.innerHTML = '';
  
  allTx.forEach(item => {
    let colorClass = 'text-muted';
    let catOrFondo = item.fondo || '';
    if (item._type === 'gasto') {
      colorClass = 'text-danger';
      catOrFondo = `${item.fondo} / ${getIconForCat(item.categoria)} ${item.categoria||''}`;
    }
    if (item._type === 'ingreso') colorClass = 'text-success';

    let desc = item._type === 'gasto' ? `<b>${item.donde}</b> - ${item.descripcion}` : item.descripcion;

    let tr = document.createElement('tr');
    tr.innerHTML = `
      <td>${item.fecha}</td>
      <td><span class="tag">${item._typeLabel}</span></td>
      <td>${desc}</td>
      <td>${catOrFondo}</td>
      <td class="${colorClass}">${formatMoney(item.monto)}</td>
      <td class="action-btns">
        <button class="btn btn-outline" onclick="editTx('${item.id}', '${item._type}')">✏️</button>
        <button class="btn btn-outline" onclick="deleteTx('${item.id}', '${item._type}')">🗑️</button>
      </td>
    `;
    table.appendChild(tr);
  });
}


// === LÓGICA DE FORMULARIOS DE REGISTRO ===
function setupRegistroModals() {
  document.getElementById('btnAddIngreso').onclick = () => openTxModal('ingreso');
  document.getElementById('btnAddGasto').onclick = () => openTxModal('gasto');
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

    let montoOrig = Number(document.getElementById('txMonto').value);
    let moneda = document.getElementById('txMoneda').value;
    let tasa = moneda === 'CLP' ? 1 : Number(document.getElementById('txTasaCambio').value);
    let montoCLP = montoOrig * tasa;

    let obj = {
      id: id,
      fecha: document.getElementById('txFecha').value,
      montoOriginal: montoOrig,
      moneda: moneda,
      tasaCambio: tasa,
      monto: montoCLP,
      descripcion: document.getElementById('txDesc').value
    };

    if (ctx === 'gasto') {
      obj.donde = document.getElementById('txDonde').value;
      obj.categoria = document.getElementById('txCat').value;
      obj.fondo = document.getElementById('txFondo').value;
      obj.credito = document.getElementById('txCredito').checked;
    } else if (ctx === 'ingreso') {
      obj.fondo = document.getElementById('txFondo').value;
    } else if (ctx === 'credito') {
      obj.fecha_pago = obj.fecha; // alias para mantener db contenta
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

  const userFondosOps = window.userFondos.map(f => `<option value="${f}">${f}</option>`).join('');

  if (context === 'gasto') {
    gGasto.style.display = 'block';
    gFondo.style.display = 'block';
    dFondo.innerHTML = userFondosOps + `<option value="Ahorro">Ahorro</option>`;
  } else if (context === 'ingreso') {
    gFondo.style.display = 'block';
    dFondo.innerHTML = userFondosOps + `<option value="Ahorro">Ahorro</option><option value="Inversion">Inversión</option>`;
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
  sel.innerHTML = window.userFondos.map(f => `<option value="${f}">${f}</option>`).join('');
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
      <td>${item.fecha}</td>
      <td><b>${item.persona}</b></td>
      <td>${item.descripcion}</td>
      <td>${item.tipo === 'me_deben' ? '✅ A Mi Favor' : '⛔ Yo Debo'}</td>
      <td>${item.fondo || '-'}</td>
      <td class="${item.tipo==='me_deben' ? 'text-success' : 'text-danger'}">${formatMoney(item.monto)}</td>
      <td>${item.pagado ? 'Saldado' : 'Pendiente'}</td>
      <td class="action-btns">
        ${!item.pagado ? `<button class="btn btn-success btn-sm" onclick="toggleDeuda('${item.id}')">Pagado</button>` : `<button class="btn btn-outline btn-sm" onclick="toggleDeuda('${item.id}')">Deshacer</button>`}
        <button class="btn btn-danger btn-sm" onclick="deleteDeuda('${item.id}')">🗑</button>
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
    
    // reset fondo options
    const fSelect = document.getElementById('recFondo');
    fSelect.innerHTML = isGasto 
      ? `<option value="Personal">Personal</option><option value="U">U</option><option value="Ahorro">Ahorro</option>`
      : `<option value="Personal">Personal</option><option value="U">U</option><option value="Ahorro">Ahorro</option><option value="Inversion">Inversión</option>`;
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
    let details = item.fondo;
    if(item.tipo === 'gasto') details += ` / ${item.categoria || ''} ${item.credito ? '💳' : ''}`;

    tr.innerHTML = `
      <td>
        <input type="checkbox" ${item.activo ? 'checked' : ''} onchange="toggleActivoRecurrente('${item.id}')">
      </td>
      <td><span class="tag">${item.tipo.toUpperCase()}</span></td>
      <td>${item.tipo === 'gasto' ? `<b>${item.donde}</b> - ` : ''}${item.descripcion}</td>
      <td>${details}</td>
      <td class="${color}">${formatMoney(item.monto)}</td>
      <td class="action-btns">
        <button class="btn btn-outline btn-sm" onclick="editRecurrente('${item.id}')">✏️</button>
        <button class="btn btn-danger btn-sm" onclick="delRecurrente('${item.id}')">🗑</button>
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
      datasets: [{ label: 'Monto COP', data: [iTotal, gTotal], backgroundColor: [colors.success, colors.danger] }]
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

  // 3. Gastos por Fondo
  let fondoSums = { 'Personal': 0, 'U': 0, 'Ahorro': 0 };
  tx.gastos.forEach(g => { fondoSums[g.fondo] = (fondoSums[g.fondo] || 0) + Number(g.monto); });

  if(chartFondoDonut) chartFondoDonut.destroy();
  chartFondoDonut = new Chart(document.getElementById('chartFondoDonut'), {
    type: 'doughnut',
    data: {
      labels: Object.keys(fondoSums),
      datasets: [{ data: Object.values(fondoSums), backgroundColor: [colors.primary, colors.warning, colors.success] }]
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
    tr.innerHTML = `<td>${getIconForCat(entry[0])} ${entry[0]}</td><td class="text-danger">${formatMoney(entry[1])}</td>`;
    tbody.appendChild(tr);
  });
}

// === SELECTOR DE TEMA ===

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme');
  const next = current === 'pink' ? 'default' : 'pink';
  applyTheme(next);
  localStorage.setItem('financeTheme', next);
}
window.toggleTheme = toggleTheme;

function applyTheme(theme) {
  if (theme === 'pink') {
    document.documentElement.setAttribute('data-theme', 'pink');
  } else {
    document.documentElement.removeAttribute('data-theme');
  }
}

// === EXPORTAR A EXCEL (CARTOLA MENSUAL) ===
window.exportCartolaMensual = function() {
  const month = document.getElementById('filterStatsMonth').value;
  if (!month) { showToast('Selecciona un mes a analizar primero', 'warning'); return; }

  if (typeof XLSX === 'undefined') {
    showToast('Error: librería Excel no cargada. Revisa tu conexión', 'error');
    return;
  }
  
  const tx = getTransactionsByMonth(month);
  
  // Consolidar todas las transacciones en una sola lista para simular cartola
  let allTx = [
    ...tx.gastos.map(g => ({...g, _type: 'Gasto' })),
    ...tx.ingresos.map(i => ({...i, _type: 'Ingreso' })),
    ...tx.ahorros.map(a => ({...a, _type: 'Ahorro' })),
    ...tx.inversiones.map(inv => ({...inv, _type: 'Inversión' })),
    ...tx.creditos.map(c => ({...c, _type: 'Pago Crédito', fecha: c.fecha_pago || c.fecha }))
  ];

  // Ordenar cronológicamente (ascendente)
  allTx.sort((a,b) => new Date(a.fecha) - new Date(b.fecha));

  generateExcelFromTransactions(allTx, `Cartola_Mensual_${month}`);
}

// === EXPORTAR A EXCEL (CARTOLA ANUAL) ===
window.exportCartolaAnual = function() {
  const year = document.getElementById('filterStatsYear').value;
  if (!year) { showToast('Ingresa un año primero', 'warning'); return; }

  if (typeof XLSX === 'undefined') {
    showToast('Error: librería Excel no cargada. Revisa tu conexión', 'error');
    return;
  }

  // Filtrar del DB completo por el año
  const filterFn = (t) => t.fecha && t.fecha.startsWith(year);
  const filterCredito = (t) => {
    const f = t.fecha_pago || t.fecha;
    return f && f.startsWith(year);
  };

  let allTx = [
    ...db.gastos.filter(filterFn).map(g => ({...g, _type: 'Gasto' })),
    ...db.ingresos.filter(filterFn).map(i => ({...i, _type: 'Ingreso' })),
    ...db.ahorros.filter(filterFn).map(a => ({...a, _type: 'Ahorro' })),
    ...db.inversiones.filter(filterFn).map(inv => ({...inv, _type: 'Inversión' })),
    ...db.creditos.filter(filterCredito).map(c => ({...c, _type: 'Pago Crédito', fecha: c.fecha_pago || c.fecha }))
  ];

  allTx.sort((a,b) => new Date(a.fecha) - new Date(b.fecha));

  generateExcelFromTransactions(allTx, `Cartola_Anual_${year}`);
}

// Funcionalidad base para regenerar la planilla
function generateExcelFromTransactions(allTx, fileName) {
  let excelData = [];
  let saldoAcumulado = 0;
  
  allTx.forEach(t => {
    let cargo = '';
    let abono = '';
    
    if (t._type === 'Ingreso') {
      abono = Number(t.monto);
      saldoAcumulado += abono;
    } else {
      cargo = Number(t.monto);
      saldoAcumulado -= cargo;
    }

    let descripcion = t.descripcion;
    if (t._type === 'Gasto' && t.donde) {
      descripcion = `${t.donde} - ${t.descripcion}`;
    }

    let categoriaFondo = t.categoria || t.fondo || "-";
    
    excelData.push({
      "Fecha": t.fecha,
      "Tipo": t._type,
      "Concepto": categoriaFondo,
      "Descripción": descripcion,
      "Cargos (-)": cargo,
      "Abonos (+)": abono,
      "Saldo Cuenta": saldoAcumulado
    });
  });

  excelData.push({ "Fecha": "", "Tipo": "", "Concepto": "", "Descripción": "", "Cargos (-)": "", "Abonos (+)": "", "Saldo Cuenta": "" });
  
  let totalCargos = excelData.reduce((acc, curr) => acc + (Number(curr["Cargos (-)"]) || 0), 0);
  let totalAbonos = excelData.reduce((acc, curr) => acc + (Number(curr["Abonos (+)"]) || 0), 0);
  
  excelData.push({
    "Fecha": "RESUMEN TOTAL",
    "Tipo": "",
    "Concepto": "",
    "Descripción": "",
    "Cargos (-)": totalCargos,
    "Abonos (+)": totalAbonos,
    "Saldo Cuenta": totalAbonos - totalCargos
  });

  const worksheet = XLSX.utils.json_to_sheet(excelData);
  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, `Cartola`);

  worksheet['!cols'] = [
    { wch: 12 }, 
    { wch: 15 }, 
    { wch: 18 }, 
    { wch: 40 }, 
    { wch: 12 }, 
    { wch: 12 }, 
    { wch: 15 }  
  ];

  XLSX.writeFile(workbook, `${fileName}.xlsx`);
}

// === EXPORTAR DESDE REGISTRO ===
window.exportCartolaMensualFromReg = function() {
  const month = document.getElementById('filterRegMonth').value;
  if (!month) { showToast('Selecciona un mes primero', 'warning'); return; }

  if (typeof XLSX === 'undefined') {
    showToast('Error: librería Excel no cargada. Revisa tu conexión', 'error');
    return;
  }

  const tx = getTransactionsByMonth(month);
  let allTx = [
    ...tx.gastos.map(g => ({...g, _type: 'Gasto' })),
    ...tx.ingresos.map(i => ({...i, _type: 'Ingreso' })),
    ...tx.ahorros.map(a => ({...a, _type: 'Ahorro' })),
    ...tx.inversiones.map(inv => ({...inv, _type: 'Inversión' })),
    ...tx.creditos.map(c => ({...c, _type: 'Pago Crédito', fecha: c.fecha_pago || c.fecha }))
  ];
  allTx.sort((a,b) => new Date(a.fecha) - new Date(b.fecha));
  generateExcelFromTransactions(allTx, `Cartola_Mensual_${month}`);
}

window.exportCartolaAnualFromReg = function() {
  const month = document.getElementById('filterRegMonth').value;
  if (!month) { showToast('Selecciona un mes primero para determinar el año', 'warning'); return; }
  const year = month.split('-')[0];

  if (typeof XLSX === 'undefined') {
    showToast('Error: librería Excel no cargada. Revisa tu conexión', 'error');
    return;
  }

  const filterFn = (t) => t.fecha && t.fecha.startsWith(year);
  const filterCredito = (t) => {
    const f = t.fecha_pago || t.fecha;
    return f && f.startsWith(year);
  };

  let allTx = [
    ...db.gastos.filter(filterFn).map(g => ({...g, _type: 'Gasto' })),
    ...db.ingresos.filter(filterFn).map(i => ({...i, _type: 'Ingreso' })),
    ...db.ahorros.filter(filterFn).map(a => ({...a, _type: 'Ahorro' })),
    ...db.inversiones.filter(filterFn).map(inv => ({...inv, _type: 'Inversión' })),
    ...db.creditos.filter(filterCredito).map(c => ({...c, _type: 'Pago Crédito', fecha: c.fecha_pago || c.fecha }))
  ];
  allTx.sort((a,b) => new Date(a.fecha) - new Date(b.fecha));
  generateExcelFromTransactions(allTx, `Cartola_Anual_${year}`);
}

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
        <div style="font-weight:500;">${fondo}</div>
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
  refreshViews();
}
