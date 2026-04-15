// app.js

// === FIREBASE CONFIG ===
const firebaseConfig = {
  apiKey: "AIzaSyBpwX8bdKx7bnyqCg6_Zyt1P_zPpkl4c64",
  authDomain: "control-de-finanzas-pers-c9e87.firebaseapp.com",
  projectId: "control-de-finanzas-pers-c9e87",
  storageBucket: "control-de-finanzas-pers-c9e87.firebasestorage.app",
  messagingSenderId: "153776794388",
  appId: "1:153776794388:web:464c2af8ad373f96d47001",
  measurementId: "G-DQTXVXR5WQ"
};

firebase.initializeApp(firebaseConfig);
const auth = firebase.auth();
const firestore = firebase.firestore();

// === ESTADO GLOBAL ===
const STORAGE_KEY = 'financeTrackerData';
let currentUser = null;
let appInitialized = false;

let db = {
  ingresos: [],
  gastos: [],
  ahorros: [],
  inversiones: [],
  creditos: [],
  deudas: [],
  recurrentes: []
};

const emptyDb = () => ({
  ingresos: [], gastos: [], ahorros: [], inversiones: [],
  creditos: [], deudas: [], recurrentes: []
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
      alert('Error al iniciar sesión: ' + err.message);
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
    const collections = ['ingresos', 'gastos', 'ahorros', 'inversiones', 'creditos', 'deudas', 'recurrentes'];
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
    alert('Archivo exportado con éxito.');
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
    alert('Datos importados y sincronizados con la nube.');
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

function initNav() {
  const tabs = document.querySelectorAll('.tab-btn');
  const views = document.querySelectorAll('.view');
  
  tabs.forEach(tab => {
    tab.addEventListener('click', (e) => {
      tabs.forEach(t => t.classList.remove('active'));
      views.forEach(v => v.classList.remove('active'));
      
      const target = e.target.getAttribute('data-target');
      e.target.classList.add('active');
      document.getElementById(target).classList.add('active');

      // Si entramos a Estadísticas, forzar renderizado (para recalcular dimensiones del Canvas)
      if(target === 'view-stats-mes' || target === 'view-stats-ano'){
        refreshViews();
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

  refreshViews();
}

function refreshViews() {
  renderResumen();
  renderRegistro();
  renderStatsMensuales();
  renderStatsAnuales();
  renderDeudas();
  renderRecurrentes();
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
  let ahTotal = tx.ahorros.reduce((acc, a) => acc + Number(a.monto), 0) + tx.ingresos.filter(i => i.fondo === 'Ahorro').reduce((a, b) => a + Number(b.monto), 0);
  let invTotal = tx.inversiones.reduce((acc, i) => acc + Number(i.monto), 0) + tx.ingresos.filter(i => i.fondo === 'Inversion' || i.fondo === 'Inversión').reduce((a, b) => a + Number(b.monto), 0);
  let cTotal = tx.creditos.reduce((acc, c) => acc + Number(c.monto), 0);
  
  let oldAhTotal = tx.ahorros.reduce((acc, a) => acc + Number(a.monto), 0);
  let oldInvTotal = tx.inversiones.reduce((acc, i) => acc + Number(i.monto), 0);

  document.getElementById('sumGastoPersonal').textContent = formatMoney(gPersonal);
  document.getElementById('sumGastoU').textContent = formatMoney(gU);
  document.getElementById('sumGastoTotal').textContent = formatMoney(gTotal);
  document.getElementById('sumIngresos').textContent = formatMoney(iTotal);
  document.getElementById('sumAhorro').textContent = formatMoney(ahTotal);
  document.getElementById('sumInversion').textContent = formatMoney(invTotal);
  document.getElementById('sumCredito').textContent = formatMoney(gCredito);
  document.getElementById('sumDebito').textContent = formatMoney(gDebito);

  // Saldos
  // Ingresos van a ciertos fondos o simplemente vemos en global.
  let iPersonal = tx.ingresos.filter(i => i.fondo === 'Personal').reduce((a, b) => a + Number(b.monto), 0);
  let iU = tx.ingresos.filter(i => i.fondo === 'U').reduce((a, b) => a + Number(b.monto), 0);
  let saldoP = iPersonal - gPersonal;
  let saldoUStr = iU - gU;
  
  document.getElementById('saldoPersonal').textContent = formatMoney(saldoP);
  document.getElementById('saldoU').textContent = formatMoney(saldoUStr);
  document.getElementById('totalCuenta').textContent = formatMoney(iTotal - gTotal - oldAhTotal - oldInvTotal - cTotal);

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

    let obj = {
      id: id,
      fecha: document.getElementById('txFecha').value,
      monto: Number(document.getElementById('txMonto').value),
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
  });
}

function openTxModal(context, editObj = null) {
  document.getElementById('formTx').reset();
  const d = new Date();
  document.getElementById('txFecha').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
  document.getElementById('txContext').value = context;
  document.getElementById('txId').value = editObj ? editObj.id : '';

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

  if (context === 'gasto') {
    gGasto.style.display = 'block';
    gFondo.style.display = 'block';
    dFondo.innerHTML = `<option value="Personal">Personal</option><option value="U">U</option><option value="Ahorro">Ahorro</option>`;
  } else if (context === 'ingreso') {
    gFondo.style.display = 'block';
    dFondo.innerHTML = `<option value="Personal">Personal</option><option value="U">U</option><option value="Ahorro">Ahorro</option><option value="Inversion">Inversión</option>`;
  }

  // Si es edicion, poblar data
  if (editObj) {
    document.getElementById('txFecha').value = editObj.fecha || editObj.fecha_pago;
    document.getElementById('txMonto').value = editObj.monto;
    document.getElementById('txDesc').value = editObj.descripcion;
    
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

window.deleteTx = async function(id, type) {
  if (!confirm("¿Eliminar este registro?")) return;
  const arrMap = { ingreso: 'ingresos', gasto: 'gastos', ahorro: 'ahorros', inversion: 'inversiones', credito: 'creditos' };
  
  db[arrMap[type]] = db[arrMap[type]].filter(x => x.id !== id);
  await syncData('delete', arrMap[type], id);
}


// === DEUDAS INFORMALES ===
function setupDeudasModales() {
  document.getElementById('btnAddDeuda').onclick = () => {
    document.getElementById('formDeuda').reset();
    document.getElementById('deudaId').value = '';
    const d = new Date();
    document.getElementById('deudaFecha').value = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
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
      pagado: false
    };

    if (isEdit) {
      // mantener estado de pagado si ya lo estaba (though un likely si editan via ui)
      const prev = db.deudas.find(d => d.id === id);
      obj.pagado = prev ? prev.pagado : false;
      const idx = db.deudas.findIndex(x => x.id === id);
      if (idx !== -1) db.deudas[idx] = obj;
    } else {
      db.deudas.push(obj);
    }
    document.getElementById('modalDeuda').classList.remove('active');
    await syncData(isEdit ? 'edit' : 'add', 'deudas', obj);
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
  if (t) {
    t.pagado = !t.pagado;
    await syncData('edit', 'deudas', t);
  }
}
window.deleteDeuda = async function(id) {
  if(!confirm("Borrar deuda?")) return;
  db.deudas = db.deudas.filter(x => x.id !== id);
  await syncData('delete', 'deudas', id);
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

    const obj = {
      id: id,
      tipo: tipo,
      descripcion: document.getElementById('recDesc').value,
      monto: Number(document.getElementById('recMonto').value),
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
  });

  document.getElementById('btnApplyRecurrentes').addEventListener('click', async () => {
    const activos = db.recurrentes.filter(r => r.activo);
    if(activos.length === 0) return alert("No hay recurrentes activos.");
    
    let msg = "Se agregarán las siguientes transacciones con fecha de HOY:\n\n";
    activos.forEach(a => msg += `- ${a.descripcion} ($${a.monto})\n`);
    msg += "\n¿Proceder?";
    
    if(!confirm(msg)) return;

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

    if (nuevosGastos.length > 0) await syncData('add', 'gastos', nuevosGastos);
    if (nuevosIngresos.length > 0) await syncData('add', 'ingresos', nuevosIngresos);
    if (nuevosGastos.length === 0 && nuevosIngresos.length === 0) refreshViews(); // Fallback

    alert("Transacciones recurrentes aplicadas con éxito.");
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
  }
}
window.delRecurrente = async function(id) {
  if(!confirm("¿Borrar plantilla?")) return;
  db.recurrentes = db.recurrentes.filter(x => x.id !== id);
  await syncData('delete', 'recurrentes', id);
}
window.editRecurrente = function(id) {
  const r = db.recurrentes.find(x => x.id === id);
  if(!r) return;
  
  document.getElementById('recId').value = r.id;
  document.getElementById('recTipo').value = r.tipo;
  // disparar change manual
  document.getElementById('recTipo').dispatchEvent(new Event('change'));

  document.getElementById('recDesc').value = r.descripcion;
  document.getElementById('recMonto').value = r.monto;
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
let chartIncExpMes, chartCatDonut, chartFondoDonut, chartDebCred, chartSaldoEvol;
let chartAnualBars, chartAhorroAcumulado;

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
    options: { plugins: { title: { display: true, text: 'Ahorro Realizado en el Año' } } }
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
