# Finance Tracker 💸
      
Una aplicación web limpia y privada para llevar el control de tus finanzas personales. Al ser una aplicación estática usando HTML, CSS y JavaScript puro, no requieres un servidor backend ni base de datos en la nube. 

**Toda tu información está almacenada de manera local en un archivo json dentro de tu PC, proporcionando total privacidad.**

## ¿Cómo abrir?

Como este proyecto no cuenta con un servidor, usarlo es tan fácil como:
1. Asegurarte de estar usando un navegador basado en Chromium, como **Google Chrome, Microsoft Edge, u Opera**. (⚠️ Firefox y Safari no soportan algunas funciones de acceso al sistema de archivos local de manera transparente).
2. Hacer doble clic sobre el archivo `index.html` para abrirlo en tu navegador.
3. En la pantalla principal que aparece, presionar **"Abrir data.json"** y seleccionar el archivo `data.json` que viene incluido en esta carpeta.
4. Si quieres un control desde cero, dale a **"Crear nuevo archivo"** y guarda un nuevo `data.json` en tu carpeta.

## Uso del Guardado Local (File System Access API)

Este proyecto usa la **File System Access API** del navegador para leer y escribir tu archivo directamente en el disco.
- Cuando realices algún cambio, la aplicación automáticamente detectará el cambio y guardará en segundo plano, por lo que tus cambios persistirán de inmediato.
- Para ello tu navegador solicitará "Permitir editar archivos" al momento de abrir el JSON. Autoriza el permiso para su correcto uso.

## Estructura de Datos (data.json)
El archivo json sigue este molde principal:
```json
{
  "ingresos": [
    { "id": "...", "fecha": "2026-05-01", "monto": 100000, "descripcion": "Sueldo", "fondo": "Personal" }
  ],
  "gastos": [
    { "id": "...", "fecha": "2026-05-02", "monto": 5000, "donde": "Supermercado", "descripcion": "Comida", "categoria": "comida", "fondo": "Personal", "credito": true }
  ],
  "ahorros": [],
  "inversiones": [],
  "creditos": [],
  "deudas": [],
  "recurrentes": []
}
```

## Configuración de Firebase (Variables de Entorno)

Para proteger tus credenciales y no subirlas al repositorio público de GitHub, la configuración de Firebase se carga mediante un archivo de variables de entorno.

**Pasos para configurar tu base de datos localmente:**
1. En la raíz del proyecto, haz una copia del archivo \`env.example.js\` y nómbrala \`env.js\`.
2. Edita \`env.js\` con tu propia configuración obtenida de la consola de Firebase.
3. El archivo \`env.js\` ya está incluido en \`.gitignore\`, por lo que tus credenciales estarán seguras y no se subirán a GitHub.
