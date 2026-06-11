# Finance Tracker 💸

Aplicación web para llevar el control de tus finanzas personales. Es una app estática (HTML, CSS y JavaScript puro) que usa **Firebase** para autenticación (Google) y almacenamiento en la nube (**Cloud Firestore**), con caché local y soporte offline.

## Arquitectura

- **Frontend:** HTML/CSS/JS sin frameworks. Gráficos con Chart.js, exportación a Excel con xlsx-js-style.
- **Autenticación:** Firebase Auth con Google Sign-In.
- **Datos:** Cloud Firestore, bajo `users/{uid}/...` (subcolecciones: ingresos, gastos, ahorros, inversiones, creditos, deudas, recurrentes, presupuestos, config).
- **Offline:** persistencia offline de Firestore habilitada — los cambios sin conexión se encolan y sincronizan solos.

> Nota: la configuración de Firebase en `env.js` (apiKey, projectId, etc.) **no es secreta** — se descarga con la página. La protección real de tus datos son las **reglas de Firestore** y las restricciones de la API key.

## Configuración inicial

1. Copia `env.example.js` como `env.js` y completa la configuración de tu proyecto de Firebase.
2. En `firestore.rules`, **reemplaza `TU_EMAIL_AQUI@gmail.com` por tu cuenta de Google**. Esto restringe la base de datos exclusivamente a tu cuenta (cualquier otra persona con cuenta Google podrá iniciar sesión, pero no leer ni escribir datos).
3. Despliega las reglas: `firebase deploy --only firestore:rules`.
4. Despliega el hosting: `firebase deploy --only hosting`.

### Recomendaciones de seguridad adicionales (consola de Google Cloud / Firebase)

- Restringe la API key por **HTTP referrers** (tu dominio de hosting) en Google Cloud Console → Credentials.
- Habilita **App Check** (reCAPTCHA) en la consola de Firebase.
- En Firebase Auth, deja habilitado solo el proveedor de Google.

## Desarrollo local

Sirve la carpeta con cualquier servidor estático (el login de Google no funciona abriendo el archivo directo con `file://`):

```bash
firebase serve --only hosting
# o
npx serve .
```

## Respaldo local (data.json)

La app puede exportar/importar un respaldo en JSON (funciones `exportToFile` / `importFromFile`, disponibles desde la consola del navegador). El archivo `data.json` del repo es solo una plantilla vacía con la estructura:

```json
{
  "ingresos": [],
  "gastos": [],
  "ahorros": [],
  "inversiones": [],
  "creditos": [],
  "deudas": [],
  "recurrentes": []
}
```

⚠️ `data.json` y `env.js` están en `.gitignore` y excluidos del deploy de hosting — nunca subas datos financieros reales al repo ni al hosting.

## Funcionalidades

- Resumen mensual con flujo por fondo, comparativas vs mes anterior y gráfico de categorías.
- Registro de ingresos/gastos multimoneda (CLP/USD/EUR) con notas.
- Distribución automática de ingresos entre fondos por porcentajes.
- **Crédito por pagar:** los gastos con tarjeta de crédito se acumulan como deuda pendiente (visible en el Resumen sin importar el mes) y se saldan registrando un "Pago Crédito".
- Deudas informales (me deben / les debo) con transacción automática al saldar.
- Plantillas recurrentes, metas de gasto por categoría/fondo.
- Estadísticas mensuales y anuales, exportación de cartolas a Excel.
