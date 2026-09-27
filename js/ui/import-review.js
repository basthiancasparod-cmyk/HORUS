/**
 * HORUS — js/ui/import-review.js
 * Pantalla de revisión de un cuadrante importado desde PDF, foto o captura.
 *
 * Regla de oro: **nada se guarda sin que el usuario lo vea**. Lo que el lector
 * reconoce con seguridad se enseña ya resuelto; lo que no, se marca en ámbar o
 * en rojo y hay que decidirlo antes de importar. Si el archivo no se puede
 * leer, se explica por qué en lugar de inventar un cuadrante.
 *
 * Dos caminos, un solo resultado:
 *  - PDF con texto  → lector determinista (`schedule-import.js`), en local.
 *  - Foto, captura o PDF escaneado → IA de visión (`ai-vision.js`), que
 *    devuelve el MISMO ParseResult y entra en esta misma revisión.
 * El paso por la IA nunca decide fechas por su cuenta: `verifyParse` marca en
 * ámbar lo que no cuadra con el calendario (docs/AI-IMPORT.md).
 */

import { byId, el, clear, icon, fold } from '../core/utils.js';
import {
  fromKey, DOW_SHORT, MONTHS, formatMonth, dateKey, daysInMonth,
} from '../core/date.js';
import { shiftTypeByCode } from '../core/model.js';
import * as storage from '../core/storage.js';
import { openDialog, closeDialog, notify } from './toolkit.js';
import { avatar } from './toolkit.js';
import { getContext } from './context.js';

/* ------------------------------------------------------------------ *
 * Estado de la revisión
 * ------------------------------------------------------------------ */

let ctx = null;
let dialog = null;
let parseResult = null;
/** Correcciones del usuario: "PERSONA|YYYY-MM-DD" → typeCode o '' para vaciar. */
let corrections = new Map();
/** Decisiones sobre códigos desconocidos: código del PDF → typeCode del catálogo. */
let codeDecisions = new Map();
/**
 * Decisiones de identidad: etiqueta del cuadrante → id del miembro que ya existe
 * (o `null` si el usuario dice que es otra persona). Evita que una segunda
 * importación cree una ficha paralela de alguien que ya está en el equipo.
 */
let identidades = new Map();
/** Mes elegido a mano si el lector no lo tuvo claro. */
let chosenMonth = null;
/** Avisos que devolvió la IA (interpretación/transcripción). Solo informativos. */
let aiWarnings = [];
/** true si el cuadrante que se está revisando lo leyó la IA. */
let fromAI = false;

/**
 * Contexto VIVO. Los manejadores se cablean una sola vez, así que no pueden
 * quedarse con el contexto que recibió `openImportDialog`: si la aplicación
 * vuelve a montarlo (al cerrar sesión), escribirían en el store viejo.
 */
function liveCtx() {
  try {
    return getContext() || ctx;
  } catch {
    return ctx;
  }
}

/* ------------------------------------------------------------------ *
 * Configuración de IA (BYOK, solo en este dispositivo)
 * ------------------------------------------------------------------ */

/** Imagen máxima que se acepta para enviar a la IA (~8 MB). */
const MAX_IMAGE_BYTES = 8 * 1024 * 1024;
/** Lado mayor al que se reduce la imagen antes de enviarla. */
const MAX_IMAGE_EDGE = 2000;

/** Lee la configuración de IA de las preferencias locales (nunca del documento). */
function aiConfig() {
  const stored = storage.loadUI()?.ai;
  const data = stored && typeof stored === 'object' ? stored : {};
  return {
    provider: String(data.provider || ''),
    apiKey: String(data.apiKey || ''),
    model: String(data.model || ''),
  };
}

/** ¿Hay clave configurada? Sin ella la importación con IA está apagada. */
function aiReady() {
  const { apiKey, provider } = aiConfig();
  return !!apiKey && !!provider;
}

/** Lleva al usuario a Ajustes para configurar la IA, cerrando este diálogo. */
function goToSettings() {
  closeDialog(dialog);
  const navigate = liveCtx()?.navigate;
  if (typeof navigate === 'function') navigate('settings');
  else notify.info('Abre Ajustes y busca «Importar con IA» para poner tu clave.');
}


/* ------------------------------------------------------------------ *
 * Apertura
 * ------------------------------------------------------------------ */

/**
 * Abre el diálogo de importación.
 * @param {object} context contexto de la aplicación
 * @param {{file?:File, text?:string}} [preset]
 */
export async function openImportDialog(context, preset = {}) {
  ctx = context;
  dialog = byId('dialog-import');
  wireDialogOnce();

  corrections = new Map();
  codeDecisions = new Map();
  identidades = new Map();
  parseResult = null;
  chosenMonth = null;
  aiWarnings = [];
  fromAI = false;

  renderIntro();
  openDialog(dialog);

  if (preset.file) await loadFile(preset.file);
  else if (preset.text) await loadFromPaste(preset.text);
}

function wireDialogOnce() {
  /* OJO con la marca: `dialogs.js` usa `dialog.__wired` para TODOS los diálogos
     y la aplicación los cablea al arrancar. Cuando aquí se usaba la misma marca,
     el diálogo de importar ya venía marcado como cableado, esta función se salía
     sin enganchar nada y el botón de importar no hacía absolutamente nada: sin
     error, sin aviso, con la revisión pintada y perfecta. Costó encontrar porque
     el síntoma no se parece en nada a la causa.
     Por eso la marca es propia y con nombre distinto. */
  if (dialog.__importWired) return;
  dialog.__importWired = true;

  byId('import-cancel').addEventListener('click', () => closeDialog(dialog));
  byId('import-commit').addEventListener('click', commit);
  dialog.addEventListener('click', (event) => {
    if (event.target === dialog) closeDialog(dialog);
  });
}

function setSubtitle(text) {
  byId('import-sub').textContent = text;
}

function setCommitVisible(visible, label = 'Importar al cuadrante') {
  const button = byId('import-commit');
  button.hidden = !visible;
  button.textContent = label;
  // Si una importación anterior dejó el botón bloqueado, se recupera aquí: un
  // botón deshabilitado que nadie vuelve a habilitar es un «no hace nada».
  button.disabled = false;
}

/* ------------------------------------------------------------------ *
 * Paso 1: elegir el archivo
 * ------------------------------------------------------------------ */

/**
 * Pantalla de elección del archivo.
 * @param {?string} message aviso previo (por ejemplo, por qué falló el anterior)
 * @param {?{label:string, onClick:Function}} action botón opcional junto al aviso
 */
function renderIntro(message = null, action = null) {
  const body = byId('import-body');
  clear(body);
  setCommitVisible(false);
  setSubtitle('Desde el PDF, una foto o una captura');

  if (message) {
    body.appendChild(el('div', { class: 'gap-item', style: { marginBottom: 'var(--sp-4)' } }, [
      icon('alert', 16),
      el('span', { class: 'grow' }, message),
      action ? el('button', { type: 'button', class: 'btn btn-sm', onclick: action.onClick }, action.label) : null,
    ]));
  }

  // --- Zona de arrastre ---
  const zone = el('div', { class: 'drop-zone' }, [
    el('div', { class: 'drop-icon' }, icon('upload', 24)),
    el('h3', {}, 'Arrastra aquí el cuadrante'),
    el('p', {}, 'Vale el PDF de la empresa, una foto hecha a la hoja en la pared o una captura de pantalla.'),
    el('p', { class: 'field-hint' }, 'El PDF con texto se lee en tu dispositivo. Las fotos y capturas se envían al proveedor de IA que hayas configurado en Ajustes.'),
    el('div', { class: 'row wrap', style: { gap: 'var(--sp-2)', justifyContent: 'center' } }, [
      el('button', {
        type: 'button', class: 'btn btn-primary',
        onclick: () => pickFile(),
      }, 'Elegir archivo…'),
      el('button', {
        type: 'button', class: 'btn',
        onclick: () => pickFile({ accept: 'image/*', capture: 'environment' }),
      }, [icon('upload', 16), 'Hacer foto']),
    ]),
  ]);

  zone.addEventListener('dragover', (event) => {
    event.preventDefault();
    zone.classList.add('is-over');
  });
  zone.addEventListener('dragleave', () => zone.classList.remove('is-over'));
  zone.addEventListener('drop', async (event) => {
    event.preventDefault();
    zone.classList.remove('is-over');
    const file = event.dataTransfer?.files?.[0];
    if (file) await loadFile(file);
  });

  body.appendChild(zone);

  // --- Sin clave configurada: decirlo antes de que el usuario lo intente ---
  if (!aiReady()) {
    body.appendChild(el('div', { class: 'gap-item', style: { marginTop: 'var(--sp-4)' } }, [
      icon('alert', 16),
      el('span', { class: 'grow' }, 'Para importar fotos o PDF escaneados hace falta configurar la IA (proveedor y clave propia) en Ajustes. El PDF con texto funciona igual sin ella.'),
      el('button', { type: 'button', class: 'btn btn-sm', onclick: goToSettings }, 'Ir a Ajustes'),
    ]));
  }

  // --- Alternativa: pegar el texto ---
  const details = el('details', { style: { marginTop: 'var(--sp-4)' } });
  details.appendChild(el('summary', { class: 't-sm t-dim', style: { cursor: 'pointer' } },
    'El PDF no se lee bien: pegar el cuadrante como texto'));
  details.appendChild(el('p', { class: 'field-hint', style: { margin: 'var(--sp-2) 0' } },
    'Pega las filas tal cual aparecen, con el nombre de cada persona y sus códigos de turno. '
    + 'Una línea por persona. Se intentará interpretar igualmente.'));

  const textarea = el('textarea', {
    class: 'textarea',
    rows: '6',
    id: 'import-paste',
    placeholder: 'JAVIER   I M P P M M M M T T T RE M M\nWILLIAM  I M P M M M M M T T I I I T',
  });
  details.appendChild(textarea);
  details.appendChild(el('button', {
    type: 'button', class: 'btn btn-sm', style: { marginTop: 'var(--sp-2)' },
    onclick: () => {
      const text = textarea.value.trim();
      if (!text) { notify.warning('Pega primero el contenido.'); return; }
      loadFromPaste(text);
    },
  }, 'Interpretar lo pegado'));

  body.appendChild(details);
}

/**
 * Abre el selector de archivos del sistema.
 * @param {{accept?:string, capture?:?string}} [opts] `capture: 'environment'`
 *   abre directamente la cámara trasera en el móvil.
 */
function pickFile({ accept = '.pdf,application/pdf,image/*', capture = null } = {}) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = accept;
  if (capture) input.setAttribute('capture', capture);
  input.style.display = 'none';
  document.body.appendChild(input);
  input.addEventListener('change', async () => {
    const file = input.files?.[0];
    input.remove();
    if (file) await loadFile(file);
  });
  input.click();
}


/* ------------------------------------------------------------------ *
 * Paso 2: leer el archivo
 *
 * PDF con texto → camino determinista, en local.
 * Imagen, o PDF que el lector no reconoce → camino de IA de visión.
 * ------------------------------------------------------------------ */

/** Pantalla de espera mientras se lee (sin porcentajes inventados). */
function showBusy(title, text, phases = null) {
  const body = byId('import-body');
  clear(body);
  setCommitVisible(false);

  const panel = el('div', { class: 'empty-state' }, [
    el('div', { class: 'empty-icon' }, icon('refresh', 24)),
    el('h3', {}, title),
    el('p', {}, text),
  ]);

  if (phases) {
    const list = el('div', { class: 'import-phases' });
    const items = phases.map((label) => {
      const item = el('div', { class: 'import-phase' }, [
        el('span', { class: 'phase-dot' }),
        el('span', {}, label),
      ]);
      list.appendChild(item);
      return item;
    });
    panel.appendChild(list);
    panel.appendChild(el('p', { class: 'field-hint' },
      'El avance exacto depende del proveedor, así que no se enseña un porcentaje.'));

    let index = 0;
    const paint = () => {
      items.forEach((item, i) => {
        item.classList.toggle('is-done', i < index);
        item.classList.toggle('is-current', i === index);
      });
    };
    paint();
    const timer = setInterval(() => {
      index = Math.min(index + 1, items.length - 1);
      paint();
    }, 7000);
    body.appendChild(panel);
    return () => clearInterval(timer);
  }

  body.appendChild(panel);
  return () => {};
}

async function loadFile(file) {
  const isPdf = file.type === 'application/pdf' || /\.pdf$/i.test(file.name);
  const isImage = /^image\//i.test(file.type || '')
    || /\.(png|jpe?g|webp|heic|heif|avif|bmp|gif|tiff?)$/i.test(file.name);

  if (isPdf) { await loadPdf(file); return; }
  if (isImage) { await loadImage(file); return; }

  notify.error('Solo se pueden importar PDF, fotos o capturas de pantalla. Para hojas de cálculo usa la importación de CSV.');
}

/**
 * Segunda lectura del PDF con IA, para contrastar con el lector del dispositivo.
 *
 * NO sustituye al lector: éste es exacto con los PDF que traen texto, y la IA se
 * equivoca (medido: inventa la letra del día de la semana y rellena casillas
 * vacías). Lo que aporta es una opinión independiente: si los dos coinciden, hay
 * mucha más seguridad; y donde no coincidan, la casilla se marca en ámbar con lo
 * que leyó la IA, para que lo mire el usuario.
 *
 * Devuelve un aviso para enseñar, o `null` si no se pudo contrastar.
 */
async function contrastarPdfConIA(bytes, parse, config) {
  try {
    const mod = await import('../core/ai-vision.js');
    if (typeof mod.readScheduleWithAI !== 'function') return null;

    const data = await blobToBase64(new Blob([bytes], { type: 'application/pdf' }));
    const ia = await mod.readScheduleWithAI({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      file: { data, mimeType: 'application/pdf', name: 'cuadrante.pdf' },
    });

    if (!ia?.ok) {
      return `La IA no ha podido leer este PDF (${ia?.reason || 'sin motivo'}), así que se usa solo el lector del dispositivo.`;
    }

    // Las dos lecturas pueden escribir el nombre distinto («YORBELI» / «YORBELI
    // C.»), así que se emparejan por el principio del nombre.
    const clave = (s) => fold(String(s || '')).replace(/\s+/g, ' ').slice(0, 6);

    /** date → código, por persona. */
    const mapaDe = (resultado) => {
      const porPersona = new Map();
      for (const p of resultado.people) {
        const m = new Map();
        for (const e of p.entries) m.set(e.date, e.code);
        porPersona.set(clave(p.label), m);
      }
      return porPersona;
    };

    const nuestro = mapaDe(parse);
    const suyo = mapaDe(ia);

    /* LA IA SE DESPLAZA DE FORMA SISTEMÁTICA.
       Medido con el cuadrante real: la IA lee la rejilla corrida unos días (deduce
       la columna del número en vez de leer la cabecera). Marcar cada casilla como
       dudosa por eso es inútil: llenaba la revisión de ámbar sin señalar nada
       concreto. Así que primero se busca un desplazamiento uniforme y, si lo hay,
       se avisa UNA vez y no se toca ninguna casilla. Solo lo que no se explica por
       ese desplazamiento se marca, que es donde de verdad hay que mirar. */
    const compararCon = (desplazamiento) => {
      let iguales = 0;
      let distintos = 0;
      for (const [nombre, mio] of nuestro) {
        const otro = suyo.get(nombre);
        if (!otro) continue;
        for (const [fecha, codigo] of mio) {
          const fechaIA = desplazarFecha(fecha, desplazamiento);
          const suCodigo = otro.get(fechaIA);
          if (suCodigo === undefined) continue;
          if (suCodigo === codigo) iguales++;
          else distintos++;
        }
      }
      return { iguales, distintos, total: iguales + distintos };
    };

    let mejor = { desplazamiento: 0, ...compararCon(0) };
    for (let k = -4; k <= 4; k++) {
      if (k === 0) continue;
      const prueba = { desplazamiento: k, ...compararCon(k) };
      if (prueba.iguales > mejor.iguales) mejor = prueba;
    }

    const desplazado = mejor.desplazamiento !== 0
      && mejor.total > 0
      && mejor.iguales / mejor.total >= 0.6;

    parse.issues = parse.issues || [];

    if (desplazado) {
      parse.issues.push({
        kind: 'ai-cross-check',
        count: 0,
        message: `Segunda lectura con IA: la IA lee la rejilla desplazada ${Math.abs(mejor.desplazamiento)} día(s) `
          + `(${mejor.iguales} de ${mejor.total} casillas coinciden si se corrige ese desplazamiento). `
          + 'Es un error conocido suyo, así que mandan las fechas del lector del dispositivo. '
          + 'No se ha marcado ninguna casilla por esto.',
      });
      return `La IA lee el cuadrante desplazado ${Math.abs(mejor.desplazamiento)} día(s): se usa el lector del `
        + 'dispositivo, que es el que cuadra con los números impresos en la hoja.';
    }

    let distintos = 0;
    let comprobadas = 0;
    for (const [nombre, mio] of nuestro) {
      const otro = suyo.get(nombre);
      if (!otro) continue;
      for (const [fecha, codigo] of mio) {
        const suCodigo = otro.get(fecha);
        if (suCodigo === undefined) continue;
        comprobadas++;
        if (suCodigo === codigo) continue;
        distintos++;
        const persona = parse.people.find((p) => clave(p.label) === nombre);
        const entrada = persona?.entries.find((e) => e.date === fecha);
        if (entrada) {
          entrada.confidence = 'low';
          entrada.reason = `${entrada.reason ? `${entrada.reason}; ` : ''}la IA leyó «${suCodigo}» en esa casilla`;
        }
      }
    }

    // Lo que solo vio la IA: no se inventa nada, se avisa y se deja que decida.
    let soloIA = 0;
    for (const [nombre, otro] of suyo) {
      const mio = nuestro.get(nombre);
      for (const [fecha] of otro) if (!mio?.has(fecha)) soloIA++;
    }

    parse.issues.push({
      kind: 'ai-cross-check',
      count: distintos,
      message: `Segunda lectura con IA: ${comprobadas} casilla(s) contrastadas, ${distintos} en desacuerdo`
        + (soloIA ? ` y ${soloIA} que solo vio la IA` : '')
        + '. Las que no coinciden van marcadas para que las revises.',
    });

    // Los recuentos cambian al marcar casillas, así que se rehacen.
    let high = 0;
    let low = 0;
    for (const p of parse.people) {
      for (const e of p.entries) (e.confidence === 'high' ? high++ : low++);
    }
    parse.stats.high = high;
    parse.stats.low = low;

    return distintos
      ? `Contrastado con la IA: ${distintos} casilla(s) no coinciden y van marcadas en ámbar.`
      : `Contrastado con la IA: las ${comprobadas} casillas coinciden con el lector.`;
  } catch (err) {
    console.error('[import] el contraste con la IA falló:', err);
    return null;
  }
}

/** Suma (o resta) días a una clave "YYYY-MM-DD". */
function desplazarFecha(fecha, dias) {
  const dt = fromKey(fecha);
  if (!dt) return fecha;
  dt.setDate(dt.getDate() + dias);
  return dateKey(dt.getFullYear(), dt.getMonth(), dt.getDate());
}

async function loadPdf(file) {
  setSubtitle(file.name);
  const stop = showBusy('Leyendo el cuadrante…', 'Se interpreta en tu dispositivo. Con cuadrantes grandes puede tardar unos segundos.');

  let bytes = null;
  let parse;
  try {
    const mod = await import('../core/schedule-import.js');
    importMeta.KNOWN_CODES = mod.KNOWN_CODES || {};
    bytes = new Uint8Array(await file.arrayBuffer());
    parse = await mod.parseSchedulePdf(bytes);
  } catch (err) {
    console.error('[import] fallo al leer el PDF:', err);
    stop();
    renderIntro(`No se pudo leer el archivo: ${err.message}`);
    return;
  }
  stop();

  if (parse?.ok) {
    parseResult = parse;
    fromAI = false;
    aiWarnings = [];

    // Con clave de IA, se lee también con IA y se contrasta. Sin clave, solo el
    // lector del dispositivo: la app funciona igual, sin depender de nadie.
    if (aiReady()) {
      const config = aiConfig();
      const aviso = await contrastarPdfConIA(bytes, parse, config);
      renderReview();
      if (aviso) notify.info(aviso, { duration: 9000 });
      return;
    }

    renderReview();
    return;
  }

  // El lector determinista no reconoce este PDF (escaneo, formato raro…).
  const reason = parse?.reason || 'No se pudo interpretar el cuadrante de este PDF.';
  const config = aiConfig();
  if (!aiReady()) {
    renderIntro(`${reason} Si es un PDF escaneado o una foto, configura la IA en Ajustes y podrás importarlo igualmente.`,
      { label: 'Ir a Ajustes', onClick: goToSettings });
    return;
  }

  await sendToAI(file, { provider: config.provider, apiKey: config.apiKey, model: config.model },
    `El lector de PDF no ha reconocido este archivo (${reason}). Se intentará con la IA.`);
}

async function loadImage(file) {
  setSubtitle(file.name);

  if (!aiReady()) {
    renderIntro('Las fotos y capturas necesitan un modelo con visión. Configura el proveedor y tu clave propia en Ajustes y vuelve a intentarlo.',
      { label: 'Ir a Ajustes', onClick: goToSettings });
    return;
  }

  const prepared = await prepareImage(file);
  if (prepared.warning) notify.warning(prepared.warning, { duration: 6000 });
  if (!prepared.ok) {
    renderIntro(prepared.reason);
    return;
  }

  const config = aiConfig();
  await sendToAI(prepared.file, config);
}

/**
 * Prepara la imagen antes de enviarla: comprueba el tamaño y, si hace falta,
 * la reduce en el navegador (lado mayor ~2000 px, JPEG) para gastar menos
 * tokens y mejorar la fiabilidad. Respeta la orientación EXIF del original.
 *
 * @returns {Promise<{ok:boolean, reason?:string, warning?:string, file?:object}>}
 */
async function prepareImage(file) {
  const originalBytes = file.size || 0;
  let blob = file;
  let reduced = false;

  const edge = await imageEdge(file);
  const needsReduction = (edge && edge > MAX_IMAGE_EDGE) || originalBytes > MAX_IMAGE_BYTES;

  if (needsReduction) {
    const smaller = await reduceImage(file, edge);
    if (smaller) { blob = smaller; reduced = true; }
  }

  if (blob.size > MAX_IMAGE_BYTES) {
    return {
      ok: false,
      reason: `La imagen pesa ${formatMb(blob.size)} y el máximo es ${formatMb(MAX_IMAGE_BYTES)}. `
        + 'No se ha podido reducir en este navegador: haz la foto con menos resolución o recórtala antes de importarla.',
    };
  }

  const data = await blobToBase64(blob);
  if (!data) return { ok: false, reason: 'No se ha podido leer la imagen en este dispositivo.' };

  const warning = reduced && originalBytes > MAX_IMAGE_BYTES
    ? `La imagen pesaba ${formatMb(originalBytes)} y se ha reducido a ${formatMb(blob.size)} antes de enviarla.`
    : null;

  return {
    ok: true,
    warning,
    file: { data, mimeType: blob.type || 'image/jpeg', name: file.name || 'cuadrante.jpg' },
  };
}

function formatMb(bytes) {
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Lado mayor de la imagen, o 0 si el navegador no puede medirla. */
async function imageEdge(file) {
  if (typeof createImageBitmap !== 'function') return 0;
  try {
    // `from-image` aplica la orientación EXIF tal y como la ve el usuario.
    const bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
    const edge = Math.max(bitmap.width, bitmap.height);
    bitmap.close?.();
    return edge;
  } catch (err) {
    console.warn('[import] no se pudo medir la imagen:', err);
    return 0;
  }
}

/**
 * Redibuja la imagen en un canvas con el lado mayor a `MAX_IMAGE_EDGE` y la
 * recomprime a JPEG. Devuelve un Blob, o null si el navegador no puede.
 */
async function reduceImage(file, knownEdge = 0) {
  try {
    let source = null;
    let detach = null;

    if (typeof createImageBitmap === 'function') {
      source = await createImageBitmap(file, { imageOrientation: 'from-image' });
    } else {
      const loaded = await loadImageElement(file);
      if (!loaded) return null;
      source = loaded.img;
      detach = loaded.detach;
    }

    const width = source.width || source.naturalWidth || 0;
    const height = source.height || source.naturalHeight || 0;
    const edge = knownEdge || Math.max(width, height);
    if (!width || !height || !edge) { detach?.(); source.close?.(); return null; }

    const scale = Math.min(1, MAX_IMAGE_EDGE / edge);
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(width * scale));
    canvas.height = Math.max(1, Math.round(height * scale));

    const context = canvas.getContext('2d');
    if (!context) { detach?.(); source.close?.(); return null; }
    context.drawImage(source, 0, 0, canvas.width, canvas.height);

    const blob = await new Promise((resolve) => canvas.toBlob(resolve, 'image/jpeg', 0.85));
    detach?.();
    source.close?.();
    return blob || null;
  } catch (err) {
    console.warn('[import] no se pudo reducir la imagen:', err);
    return null;
  }
}

/** Reserva para navegadores sin `createImageBitmap`: carga la imagen normal. */
function loadImageElement(file) {
  return new Promise((resolve) => {
    const url = URL.createObjectURL(file);
    const img = new Image();
    img.onload = () => resolve({ img, detach: () => URL.revokeObjectURL(url) });
    img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
    img.src = url;
  });
}

/** base64 sin el prefijo `data:` (lo que espera `opts.file.data`). */
async function blobToBase64(blob) {
  try {
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let binary = '';
    const chunk = 0x8000;
    for (let i = 0; i < bytes.length; i += chunk) {
      binary += String.fromCharCode(...bytes.subarray(i, i + chunk));
    }
    return btoa(binary);
  } catch (err) {
    console.error('[import] no se pudo convertir la imagen:', err);
    return '';
  }
}

/* ------------------------------------------------------------------ *
 * Camino de IA
 * ------------------------------------------------------------------ */

/** Manda el archivo a la IA de visión y revisa lo que devuelva. */
async function sendToAI(file, config, notice = null) {
  if (notice) notify.info(notice, { duration: 6000 });
  setSubtitle(file.name || 'Lectura con IA');
  const stop = showBusy('Leyendo el cuadrante con IA…',
    'Se envía una copia del archivo al proveedor que hayas configurado. Puede tardar entre unos segundos y un minuto.',
    ['Interpretando la hoja…', 'Transcribiendo la rejilla…', 'Verificando con el calendario…']);

  try {
    const mod = await import('../core/ai-vision.js');
    if (typeof mod.readScheduleWithAI !== 'function') {
      stop();
      renderIntro('La lectura con IA no está disponible en esta versión de la aplicación.');
      return;
    }

    // Hay proveedores que no aceptan PDF: se dice antes de gastar una llamada.
    const providerDef = mod.AI_PROVIDERS?.[config.provider];
    const isPdf = file.mimeType === 'application/pdf' || file.type === 'application/pdf'
      || /\.pdf$/i.test(file.name || '');
    if (isPdf && providerDef && providerDef.acceptsPdf === false) {
      stop();
      renderIntro(`${providerDef.label} no lee PDF escaneados. Hazle una foto a la hoja o cambia de proveedor en Ajustes.`,
        { label: 'Ir a Ajustes', onClick: goToSettings });
      return;
    }
    // Un PDF no se puede reducir en el navegador: solo se avisa.
    if (isPdf && (file.size || 0) > MAX_IMAGE_BYTES) {
      notify.warning(`El PDF pesa ${formatMb(file.size)}; puede que el proveedor lo rechace por tamaño.`, { duration: 6000 });
    }

    const payload = file.data
      ? { data: file.data, mimeType: file.mimeType, name: file.name }
      : await filePayload(file);

    if (!payload) {
      stop();
      renderIntro('No se ha podido leer el archivo en este dispositivo.');
      return;
    }

    const fetchImpl = typeof fetch === 'function' ? (input, init) => fetch(input, init) : undefined;
    const result = await mod.readScheduleWithAI({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      file: payload,
      fetchImpl,
    });
    stop();

    if (!result?.ok) {
      renderIntro(`La IA no ha podido leer el archivo: ${result?.reason || 'motivo desconocido'}.`,
        { label: 'Probar con otro archivo', onClick: () => pickFile() });
      return;
    }

    parseResult = result;
    fromAI = true;
    aiWarnings = collectAiWarnings(result);
    renderReview();
  } catch (err) {
    stop();
    console.error('[import] fallo de la IA:', err);
    renderIntro(`La IA no ha podido leer el archivo: ${err.message}`,
      { label: 'Probar con otro archivo', onClick: () => pickFile() });
  }
}

/** Convierte un File en el `{data, mimeType, name}` del contrato. */
async function filePayload(file) {
  const data = await blobToBase64(file);
  if (!data) return null;
  return { data, mimeType: file.type || 'application/pdf', name: file.name || 'cuadrante' };
}

/** Confianza de la interpretación, en palabras. */
const ETIQUETA_CONFIANZA = { high: 'alta', medium: 'media', low: 'baja' };

/**
 * Recoge los avisos que dejó la IA en el ParseResult, sin inventar nada: los de
 * la interpretación y los de la transcripción van en `meta`, y la confianza de
 * la interpretación se cuenta solo si no es alta.
 */
function collectAiWarnings(result) {
  const list = [];
  const push = (value) => {
    if (typeof value === 'string' && value.trim() && !list.includes(value.trim())) list.push(value.trim());
  };
  for (const item of result.warnings || []) push(item);
  for (const item of result.meta?.interpretation?.warnings || []) push(item);
  for (const item of result.meta?.transcription?.warnings || []) push(item);

  const confidence = result.meta?.interpretation?.confidence;
  if (confidence && confidence !== 'high') {
    push(`La IA no da por segura su lectura de la hoja (confianza ${ETIQUETA_CONFIANZA[confidence] || confidence}).`);
  }
  return list;
}


async function loadFromPaste(text) {
  try {
    const mod = await import('../core/schedule-import.js');
    if (typeof mod.parseScheduleText !== 'function') {
      renderIntro('La interpretación de texto pegado todavía no está disponible. Usa el PDF.');
      return;
    }
    parseResult = await mod.parseScheduleText(text);
    if (!parseResult?.ok) {
      renderIntro(parseResult?.reason || 'No se pudo interpretar el texto pegado.');
      return;
    }
    renderReview();
  } catch (err) {
    renderIntro(`No se pudo interpretar el texto: ${err.message}`);
  }
}

/* ------------------------------------------------------------------ *
 * Paso 3: revisión
 * ------------------------------------------------------------------ */

function renderReview() {
  const body = byId('import-body');
  clear(body);

  const doc = liveCtx().doc;
  const monthKey = chosenMonth || parseResult.monthKey;

  if (!monthKey) {
    renderMonthChooser('No se ha podido deducir el mes del cuadrante.');
    return;
  }

  setSubtitle(`${formatMonth(monthKey)} · revisa lo detectado antes de importar`);
  setCommitVisible(true, `Importar ${formatMonth(monthKey)}`);

  // --- Resumen ---
  const stats = parseResult.stats || {};
  const summary = el('div', { class: 'import-summary', style: { marginBottom: 'var(--sp-4)' } }, [
    summaryCard(String(stats.people ?? parseResult.people.length), 'personas'),
    summaryCard(String(stats.entries ?? 0), 'turnos'),
    summaryCard(String(stats.high ?? 0), 'seguros', 't-success'),
    summaryCard(String(stats.low ?? 0), (stats.low === 1 ? 'dudoso' : 'dudosos'),
      stats.low ? 't-warning' : 't-muted'),
  ]);
  body.appendChild(summary);

  // --- Avisos de la IA (aditivo: el resto de la revisión no cambia) ---
  if (fromAI && aiWarnings.length) {
    body.appendChild(renderAiWarnings());
  }

  // --- Códigos desconocidos: hay que decidirlos ---
  const unknowns = Object.entries(parseResult.unknownCodes || {}).filter(([code]) => !codeDecisions.has(code));
  if (unknowns.length) {
    body.appendChild(renderCodeDecisions(unknowns));
  }

  // --- Personas que podrían ser las mismas que ya tienes ---
  const parecidos = posiblesDuplicados(doc);
  if (parecidos.length) {
    body.appendChild(renderIdentidades(parecidos));
  }

  // --- Mes dudoso: ofrecer cambiarlo ---
  if (parseResult.monthConfidence !== 'high') {
    // Si lo leyó la IA y no ha podido confirmar el mes, el aviso va bien visible.
    const critical = fromAI && parseResult.monthConfidence === 'low';
    body.appendChild(el('div', { class: `gap-item${critical ? ' is-critical' : ''}`, style: { marginBottom: 'var(--sp-4)' } }, [
      icon('alert', 16),
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, critical
          ? 'La IA no ha podido confirmar el mes'
          : (parseResult.monthConfidence === 'medium'
            ? 'El mes se ha deducido, pero conviene que lo confirmes'
            : 'No se ha podido confirmar el mes')),
        el('div', { class: 'sub' }, critical
          ? `Se ha leído ${formatMonth(monthKey)}, pero los días de la semana no cuadran del todo con el calendario. Comprueba el mes en la hoja antes de importar.`
          : `Se ha leído ${formatMonth(monthKey)}. Comprueba que los días cuadran con los de la hoja.`),
      ]),
      el('button', {
        type: 'button', class: 'btn btn-sm',
        onclick: () => renderMonthChooser('Elige el mes del cuadrante:'),
      }, 'Cambiar'),
    ]));
  }

  // --- Avisos del análisis ---
  if (parseResult.issues?.length) {
    const list = el('ul', { class: 'import-issues', style: { marginBottom: 'var(--sp-4)' } });
    for (const issue of parseResult.issues.slice(0, 6)) {
      list.appendChild(el('li', {}, describeIssue(issue)));
    }
    body.appendChild(list);
  }

  // --- La rejilla ---
  body.appendChild(el('div', { class: 'section-label', style: { marginBottom: 'var(--sp-2)' } },
    'Lo que se va a importar'));
  body.appendChild(encuadre());
  body.appendChild(renderGrid(monthKey));

  // --- Leyenda ---
  body.appendChild(el('div', { class: 'review-legend', style: { marginTop: 'var(--sp-3)' } }, [
    legendItem('Detectado con seguridad', 'var(--surface)'),
    legendItem('Dudoso: revísalo', 'var(--warning-soft)'),
    legendItem('Código desconocido', 'var(--danger-soft)'),
  ]));

  body.appendChild(el('p', { class: 'field-hint', style: { marginTop: 'var(--sp-3)' } },
    'Toca cualquier casilla para cambiar el turno de ese día. Se importará en un solo paso, '
    + 'así que podrás deshacerlo entero si algo no encaja.'));
}

function summaryCard(value, label, className = '') {
  return el('div', { class: 'stat' }, [
    el('div', { class: `stat-value ${className}`.trim() }, value),
    el('div', { class: 'stat-label' }, label),
  ]);
}

/** Avisos que devolvió la IA: se enseñan tal cual, sin retocarlos. */
function renderAiWarnings() {
  const box = el('div', { class: 'ai-warnings', style: { marginBottom: 'var(--sp-4)' } }, [
    el('div', { class: 'label' }, 'Avisos de la lectura con IA'),
  ]);
  const list = el('ul');
  for (const warning of aiWarnings.slice(0, 8)) {
    list.appendChild(el('li', {}, warning));
  }
  box.appendChild(list);
  box.appendChild(el('div', { class: 'field-hint' },
    'La IA puede equivocarse al situar un día: lo que no cuadra con el calendario queda marcado en ámbar para que lo revises.'));
  return box;
}

function legendItem(label, background) {
  return el('span', {}, [
    el('span', { class: 'swatch-box', style: { background } }),
    label,
  ]);
}

function describeIssue(issue) {
  switch (issue.kind) {
    case 'unknown-code': return `El código «${issue.code}» aparece ${issue.count} ${issue.count === 1 ? 'vez' : 'veces'} y no está en el catálogo.`;
    case 'low-confidence': return `${issue.count} ${issue.count === 1 ? 'casilla' : 'casillas'} no se han podido situar con seguridad.`;
    case 'outside-month': return `${issue.count} casillas son de los meses vecinos: se importan a su fecha real y salen marcadas en la rejilla.`;
    case 'ambiguous-cluster': return `No se pudo repartir un grupo de códigos con seguridad: ${issue.message}`;
    case 'column-mismatch': return `${issue.count} ${issue.count === 1 ? 'casilla' : 'casillas'} caen en una columna que no cuadra con el día de la semana real: revísalas.`;
    case 'duplicate-day': return `${issue.count} día(s) venían repetidos: se conserva el primero de cada uno.`;
    case 'no-text': return 'El PDF no tiene texto seleccionable: parece un escaneo.';
    case 'duplicate-grid': return `La hoja trae la rejilla ${issue.count} veces: se usa una sola copia.`;
    default: return issue.message || 'Aviso del análisis.';
  }
}

/* ------------------------------------------------------------------ *
 * Decisiones sobre códigos desconocidos
 * ------------------------------------------------------------------ */

function renderCodeDecisions(unknowns) {
  const box = el('div', { style: { marginBottom: 'var(--sp-4)' } }, [
    el('div', { class: 'section-label', style: { marginBottom: 'var(--sp-2)' } },
      'Códigos que hay que aclarar'),
  ]);

  const list = el('div', { class: 'code-decisions' });
  const doc = liveCtx().doc;

  for (const [code, count] of unknowns) {
    const select = el('select', { class: 'select', 'aria-label': `Qué significa el código ${code}` }, [
      el('option', { value: '' }, '— Ignorar estos días —'),
      ...doc.shiftTypes.map((type) => el('option', { value: type.code }, `${type.code} · ${type.label}`)),
    ]);

    select.addEventListener('change', () => {
      if (select.value) codeDecisions.set(code, select.value);
      else codeDecisions.delete(code);
      renderReview();
    });

    list.appendChild(el('div', { class: 'code-decision' }, [
      el('span', { class: 'code-badge' }, code),
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, `Aparece ${count} ${count === 1 ? 'vez' : 'veces'}`),
        el('div', { class: 'sub' }, 'Dime qué turno es y se aplicará a todos esos días.'),
      ]),
      select,
    ]));
  }

  box.appendChild(list);
  return box;
}

/* ------------------------------------------------------------------ *
 * ¿Es la misma persona?
 * ------------------------------------------------------------------ */

/**
 * Busca filas del cuadrante cuyo nombre se PARECE al de alguien que ya está en el
 * equipo, sin ser idéntico: «YORBELI C.» frente a «Yorbeli», «JAVIER» frente a
 * «Javier Pérez». Es el caso que creaba fichas duplicadas al importar dos veces
 * (una por PDF y otra con la IA, que escribe los nombres a su manera).
 *
 * El nombre EXACTO no se pregunta: si coincide, se reutiliza su ficha y ya está.
 */
function posiblesDuplicados(doc) {
  const miembros = doc.members || [];
  if (!miembros.length) return [];

  const out = [];
  for (const persona of parseResult.people) {
    const suyo = fold(persona.label);
    if (!suyo) continue;

    const candidatos = miembros.filter((m) => {
      const otro = fold(m.name);
      if (!otro) return false;
      if (otro === suyo) return false; // idéntico: se reutiliza sin preguntar
      // Se parecen si uno empieza por el otro, o si comparten la primera palabra.
      const primera = (s) => s.split(/\s+/)[0];
      return otro.startsWith(suyo) || suyo.startsWith(otro) || primera(otro) === primera(suyo);
    });

    if (candidatos.length) out.push({ label: persona.label, candidatos });
  }
  return out;
}

function renderIdentidades(parecidos) {
  const box = el('div', { style: { marginBottom: 'var(--sp-4)' } }, [
    el('div', { class: 'section-label', style: { marginBottom: 'var(--sp-2)' } },
      '¿Son las mismas personas?'),
    el('div', { class: 'sub', style: { marginBottom: 'var(--sp-2)' } },
      'Estos nombres del cuadrante se parecen a gente que ya tienes en el equipo. '
      + 'Elige la ficha que les corresponde para que no se dupliquen.'),
  ]);

  const list = el('div', { class: 'code-decisions' });
  const doc = ctx.doc;

  for (const { label, candidatos } of parecidos) {
    // Por defecto se propone la ficha que ya existe: es lo que evita el duplicado,
    // y el usuario puede cambiarlo a «es otra persona» si de verdad lo es.
    const elegido = identidades.has(label) ? identidades.get(label) : candidatos[0].id;

    const select = el('select', { class: 'select', 'aria-label': `A quién corresponde ${label}` }, [
      el('option', { value: '', selected: !elegido }, '— Es otra persona: crear ficha nueva —'),
      ...candidatos.map((m) => el('option', {
        value: m.id, selected: elegido === m.id,
      }, `${m.name} · ${doc.entries.filter((e) => e.memberId === m.id).length} turnos`)),
    ]);

    select.addEventListener('change', () => {
      if (select.value) identidades.set(label, select.value);
      else identidades.set(label, null);
      renderReview();
    });

    list.appendChild(el('div', { class: 'code-decision' }, [
      el('span', { class: 'code-badge' }, label),
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, elegido ? 'Se usará la ficha que ya existe' : 'Se creará una ficha nueva'),
        el('div', { class: 'sub' }, elegido
          ? 'Sus turnos de este mes se añadirán a esa persona.'
          : 'Tendrás dos fichas con nombres parecidos.'),
      ]),
      select,
    ]));
  }

  box.appendChild(list);
  return box;
}



/* ------------------------------------------------------------------ *
 * Selector de mes
 * ------------------------------------------------------------------ */

function renderMonthChooser(reason) {
  const body = byId('import-body');
  clear(body);
  setCommitVisible(false);
  setSubtitle('Elige el mes');

  body.appendChild(el('div', { class: 'gap-item', style: { marginBottom: 'var(--sp-4)' } }, [
    icon('alert', 16),
    el('span', { class: 'grow' }, reason),
  ]));

  if (fromAI) {
    body.appendChild(el('p', { class: 'field-hint', style: { marginBottom: 'var(--sp-3)' } },
      'La IA no decide fechas: si ningún mes cuadra con los días de la semana de la hoja, elígelo tú aquí.'));
  }

  const now = new Date();
  const years = [now.getFullYear() - 1, now.getFullYear(), now.getFullYear() + 1];
  const yearSelect = el('select', { class: 'select', id: 'import-year' },
    years.map((y) => el('option', { value: String(y), selected: y === now.getFullYear() }, String(y))));
  const monthSelect = el('select', { class: 'select', id: 'import-month' },
    MONTHS.map((name, i) => el('option', { value: String(i + 1), selected: i === now.getMonth() }, name)));

  body.appendChild(el('div', { class: 'row', style: { gap: 'var(--sp-3)' } }, [
    el('div', { class: 'field grow' }, [el('label', { class: 'field-label' }, 'Mes'), monthSelect]),
    el('div', { class: 'field grow' }, [el('label', { class: 'field-label' }, 'Año'), yearSelect]),
  ]));

  if (parseResult?.monthCandidates?.length) {
    const list = el('div', { class: 'stack-sm' }, [
      el('div', { class: 'section-label' }, 'Sugerencias del análisis'),
    ]);
    for (const candidate of parseResult.monthCandidates.slice(0, 4)) {
      const key = `${candidate.year}-${String(candidate.month).padStart(2, '0')}`;
      list.appendChild(el('button', {
        type: 'button', class: 'setting-row is-clickable',
        style: { width: '100%', textAlign: 'left' },
        onclick: () => { chosenMonth = key; renderReview(); },
      }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 'label' }, formatMonth(key)),
          el('div', { class: 'sub' }, candidate.mismatches === 0
            ? 'Encaja perfectamente con los días de la semana'
            : `${candidate.mismatches} ${candidate.mismatches === 1 ? 'día' : 'días'} no cuadran`),
        ]),
        el('span', {}, icon('arrowRight', 16)),
      ]));
    }
    body.appendChild(list);
  }

  body.appendChild(el('div', { class: 'row', style: { marginTop: 'var(--sp-4)' } }, [
    el('span', { class: 'grow' }),
    el('button', {
      type: 'button', class: 'btn btn-primary',
      onclick: () => {
        const year = Number(yearSelect.value);
        const month = Number(monthSelect.value);
        chosenMonth = `${year}-${String(month).padStart(2, '0')}`;
        if (!parseResult) { renderIntro('Vuelve a elegir el archivo.'); return; }
        renderReview();
      },
    }, 'Usar este mes'),
  ]));
}

/* ------------------------------------------------------------------ *
 * Rejilla de revisión
 * ------------------------------------------------------------------ */

/**
 * Fechas que se van a importar, EN ORDEN: los últimos días del mes anterior, el
 * mes entero y los primeros del siguiente.
 *
 * Importa verlas todas: el lector trae las casillas del borde con su fecha real
 * (un cuadrante de octubre suele empezar a finales de septiembre), y la regla de
 * esta pantalla es que nada se guarda sin que el usuario lo haya visto.
 */
function fechasDeLaRevision(monthKey) {
  const totalDias = daysInMonth(monthKey);
  const primero = `${monthKey}-01`;
  const ultimo = `${monthKey}-${String(totalDias).padStart(2, '0')}`;

  const bordes = new Set();
  for (const persona of parseResult.people) {
    for (const e of persona.entries) {
      if (e.date.slice(0, 7) !== monthKey) bordes.add(e.date);
    }
  }

  const antes = [...bordes].filter((d) => d < primero).sort();
  const despues = [...bordes].filter((d) => d > ultimo).sort();

  const lista = [
    ...antes.map((date) => ({ date, outside: true })),
    ...Array.from({ length: totalDias }, (_, i) => ({
      date: `${monthKey}-${String(i + 1).padStart(2, '0')}`,
      outside: false,
    })),
    ...despues.map((date) => ({ date, outside: true })),
  ];
  return lista;
}

/**
 * Prueba del ENCUADRE, a la vista.
 *
 * Enseña la tira de números que el lector ha encontrado IMPRESA en la hoja, en
 * orden, y las letras de la cabecera. Es la comprobación más directa que puede
 * hacer el usuario: si esa tira no es la que tiene el papel delante, el encuadre
 * está mal y se ve al instante, sin tener que interpretar la rejilla.
 */
function encuadre() {
  const meta = parseResult.meta || {};
  const numeros = meta.printedDays || [];
  const letras = meta.headerLetters || [];
  if (!numeros.length) return el('div');

  const tira = numeros.length > 14
    ? `${numeros.slice(0, 7).join(' · ')} … ${numeros.slice(-4).join(' · ')}`
    : numeros.join(' · ');

  return el('div', { class: 'framing' }, [
    el('div', { class: 'framing-title' }, 'Encuadre leído en la hoja'),
    el('div', { class: 'framing-days' }, tira),
    letras.length
      ? el('div', { class: 'framing-letters' },
        `Cabecera: ${letras.slice(0, 7).join(' ')} (${letras.length} columnas)`)
      : null,
    el('div', { class: 'field-hint' },
      `${numeros.length} número(s) impresos · ${meta.columns || '?'} columnas · `
      + `el mes empieza en el ${meta.firstDay ?? '?'} y la tira acaba en ${meta.lastDay ?? '?'}. `
      + 'Compara esta tira con el papel: son los números que se han leído de la hoja.'),
  ]);
}

function renderGrid(monthKey) {
  const columnas = fechasDeLaRevision(monthKey);

  const wrap = el('div', { class: 'review-wrap' });
  const table = el('table', { class: 'review' });
  const thead = el('thead');
  const headRow = el('tr', {}, [el('th', { class: 'col-name' }, 'Persona')]);

  for (const col of columnas) {
    const fecha = fromKey(col.date);
    const dow = fecha.getDay();
    const dia = fecha.getDate();
    headRow.appendChild(el('th', {
      class: [
        dow === 0 || dow === 6 ? 'is-weekend' : '',
        dow === 0 ? 'is-sunday' : '',
        col.outside ? 'is-outside' : '',
      ].filter(Boolean).join(' '),
      title: col.outside ? `${col.date} (fuera del mes del cuadrante)` : col.date,
    }, [
      el('span', { class: 'th-dow' }, DOW_SHORT[(dow + 6) % 7]),
      el('span', { class: 'th-num' }, String(dia)),
      col.outside
        ? el('span', { class: 'th-month' }, MONTHS[fecha.getMonth()].slice(0, 3))
        : null,
    ]));
  }
  thead.appendChild(headRow);
  table.appendChild(thead);

  const tbody = el('tbody');
  for (const person of parseResult.people) {
    const row = el('tr', {}, [el('th', { class: 'col-name' }, [
      el('div', { class: 'member-line' }, [
        avatar({ name: person.label, initials: initialsOf(person.label), hex: person.hex || '#8a93a8' }, { size: 'xs' }),
        el('span', { class: 'member-name', title: person.label }, person.label),
      ]),
    ])]);

    for (const col of columnas) {
      row.appendChild(renderCell(person, col.date));
    }
    tbody.appendChild(row);
  }
  table.appendChild(tbody);
  wrap.appendChild(table);
  return wrap;
}

function initialsOf(name) {
  const parts = String(name || '?').trim().split(/\s+/).filter(Boolean);
  if (!parts.length) return '?';
  if (parts.length === 1) return parts[0].slice(0, 2).toUpperCase();
  return (parts[0][0] + parts[1][0]).toUpperCase();
}

function cellKey(label, date) {
  return `${label}|${date}`;
}

function renderCell(person, date) {
  const doc = liveCtx().doc;
  const key = cellKey(person.label, date);

  const detected = person.entries.find((e) => e.date === date);
  const corrected = corrections.has(key) ? corrections.get(key) : undefined;

  // Qué se va a importar realmente
  let typeCode = null;
  let state = 'empty';
  let reason = '';

  if (corrected !== undefined) {
    typeCode = corrected || null;
    state = corrected ? 'high' : 'empty';
  } else if (detected) {
    const resolved = resolveCode(detected.code);
    typeCode = resolved;
    if (!resolved) state = 'unknown';
    else if (detected.confidence === 'low') state = 'low';
    else state = 'high';
    reason = detected.reason || '';
  }

  const type = typeCode ? shiftTypeByCode(doc, typeCode) : null;
  const hex = type?.hex;
  const dia = Number(date.slice(8, 10));
  const fuera = date.slice(0, 7) !== (chosenMonth || parseResult.monthKey);
  const etiquetaDia = fuera
    ? `${dia} de ${MONTHS[Number(date.slice(5, 7)) - 1]}`
    : `día ${dia}`;

  const button = el('button', {
    type: 'button',
    class: `review-cell ${state === 'high' ? '' : `is-${state}`}`.trim(),
    title: `${person.label} · ${etiquetaDia}${fuera ? ' (fuera del mes del cuadrante)' : ''}`,
    'aria-label': `${person.label}, ${etiquetaDia}: ${type ? type.label : (detected ? `código ${detected.code}` : 'sin turno')}`,
    onclick: () => editCell(person, date, typeCode),
  }, [
    el('span', {
      class: 'cell-code',
      style: hex ? { '--type-color': hex, '--type-fg': readableOn(hex) } : null,
    }, detected?.code || (typeCode ? typeCode : '·')),
  ]);

  return el('td', {}, button);
}

/** Traduce el código del PDF al código del catálogo, aplicando las decisiones. */
function resolveCode(code) {
  if (!code) return null;
  const decided = codeDecisions.get(code);
  if (decided) return decided;
  const { KNOWN_CODES } = importMeta;
  const known = KNOWN_CODES?.[code];
  if (known) return known.typeCode || code;
  // Si el catálogo ya tiene ese mismo código, se usa
  if (shiftTypeByCode(liveCtx().doc, code)) return code;
  return null;
}

/** Se rellena al importar schedule-import.js (evita una importación circular arriba). */
const importMeta = { KNOWN_CODES: null };
async function ensureMeta() {
  if (importMeta.KNOWN_CODES) return;
  try {
    const mod = await import('../core/schedule-import.js');
    importMeta.KNOWN_CODES = mod.KNOWN_CODES || {};
  } catch {
    importMeta.KNOWN_CODES = {};
  }
}

function readableOn(hex) {
  const c = String(hex || '').replace('#', '');
  if (c.length !== 6) return '#fff';
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const s = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * s(r) + 0.7152 * s(g) + 0.0722 * s(b);
  return lum > 0.45 ? '#101319' : '#FFFFFF';
}

/**
 * Edita la casilla: elige turno o la deja vacía. Se hace con el diálogo de
 * confirmación como selector, para no inventar otro diálogo.
 */
async function editCell(person, date, currentTypeCode) {
  const doc = liveCtx().doc;
  let choice = currentTypeCode || '';

  const options = el('div', { class: 'chip-row' });
  const renderOptions = () => {
    clear(options);
    options.appendChild(el('button', {
      type: 'button', class: 'chip',
      'aria-pressed': String(choice === ''),
      onclick: () => { choice = ''; renderOptions(); },
    }, 'Sin turno'));

    for (const type of doc.shiftTypes) {
      options.appendChild(el('button', {
        type: 'button', class: 'chip',
        'aria-pressed': String(choice === type.code),
        style: {
          '--chip-color': type.hex,
          '--chip-soft': `color-mix(in srgb, ${type.hex} 18%, transparent)`,
          '--chip-fg': type.hex,
        },
        onclick: () => { choice = type.code; renderOptions(); },
      }, [el('span', { class: 'dot', style: { background: type.hex } }), `${type.code} · ${type.label}`]));
    }
  };
  renderOptions();

  const { confirmAction } = await import('./toolkit.js');
  const ok = await confirmAction({
    title: `${person.label} · día ${Number(date.slice(-2))}`,
    message: 'Elige el turno que se importará ese día.',
    confirmLabel: 'Aplicar',
    danger: false,
    extra: options,
  });
  if (!ok) return;

  corrections.set(cellKey(person.label, date), choice);
  renderReview();
}

/* ------------------------------------------------------------------ *
 * Paso 4: importar
 * ------------------------------------------------------------------ */

async function commit() {
  const button = byId('import-commit');
  const monthKey = chosenMonth || parseResult?.monthKey;

  // Sin mes no se puede importar nada, pero callarse es lo peor que se puede
  // hacer: el usuario pulsa y «no pasa nada». Se dice por qué.
  if (!monthKey) {
    notify.warning('Todavía no hay un mes elegido. Elige el mes del cuadrante y vuelve a intentarlo.');
    return;
  }
  if (!parseResult?.ok) {
    notify.warning('Todavía no se ha leído ningún cuadrante. Elige primero el archivo.');
    return;
  }

  button.disabled = true;
  const original = button.textContent;
  button.textContent = 'Importando…';

  try {
    const mod = await import('../core/schedule-import.js');
    const [year, month] = monthKey.split('-').map(Number);

    const entries = mod.buildEntriesFromParse(parseResult, {
      codeMap: Object.fromEntries(codeDecisions),
      corrections: Object.fromEntries(
        [...corrections.entries()].map(([key, code]) => [key, code || null]),
      ),
    });

    const result = mod.commitImportedEntries(liveCtx().store, entries, {
      year,
      month,
      // Respuestas a «¿es la misma persona?»: evitan crear fichas paralelas.
      identities: Object.fromEntries(identidades),
    });

    // Todo lo de después va en su propio try: cerrar y avisar es cosmético y no
    // puede convertir una importación correcta en un error.
    try {
      closeDialog(dialog);

      /* Rastro para diagnóstico. Si algo va mal, esto es lo que hay que mirar:
         antes no se imprimía nada y era imposible saber qué había pasado. */
      console.info('[import] resumen:', {
        mes: monthKey,
        propuestas: entries.length,
        importados: result?.imported ?? 0,
        personasNuevas: result?.members ?? 0,
        omitidos: result?.skipped ?? 0,
        motivos: result?.reasons ?? [],
      });

      if (!result?.imported) {
        /* POR QUÉ SE ENSEÑAN LOS MOTIVOS: si el motor no importa nada, guarda en
           `reasons` la explicación (por ejemplo, que un turno no está en el
           catálogo o que el lote falló a medias). Antes se descartaba y el
           usuario solo veía un aviso genérico; eso es lo que convertía cualquier
           problema en un misterio irresoluble. */
        const motivo = result?.reasons?.length
          ? result.reasons.slice(0, 3).join(' ')
          : 'Ningún turno tenía un tipo asignado: revisa los códigos del cuadrante.';
        notify.error(`No se ha importado nada. ${motivo}`, { duration: 12000 });
        return;
      }

      // El resumen que devuelve el motor es { imported, members, skipped, reasons }.
      // Antes se leía `membersCreated`, que no existe: nunca se decía cuántas
      // personas nuevas se habían creado.
      notify.success(
        `${result.imported} turno(s) de ${formatMonth(monthKey)} importados`
        + (result.members ? ` · ${result.members} persona(s) nueva(s)` : ''),
        { duration: 6000, action: { label: 'Deshacer', onClick: () => liveCtx().undo() } },
      );

      if (result.skipped) {
        // Si algo se ha omitido, se dice POR QUÉ. Antes salía un «N turnos
        // omitidos» sin explicación, y el motivo (un turno que no está en el
        // catálogo, por ejemplo) se quedaba guardado en `reasons` sin que nadie
        // lo leyera nunca.
        const porque = result.reasons?.length ? ` ${result.reasons[0]}` : ' No tenían tipo asignado.';
        setTimeout(() => notify.warning(`${result.skipped} turno(s) sin importar.${porque}`, {
          duration: 12000,
        }), 900);
      }

      /* Llevar la vista al mes importado, SIEMPRE y de forma explícita.
         `invalidate()` repinta la vista que esté abierta, y la importación se
         puede lanzar desde Ajustes: en ese caso el usuario se quedaba mirando
         Ajustes después de importar y parecía que no había pasado nada. Ahora se
         navega al Cuadrante y se pone el foco en el mes importado. */
      const { setFocusDate, invalidate, setCurrentView } = await import('./context.js');
      setFocusDate(`${monthKey}-01`);
      setCurrentView('roster');
      invalidate();
    } catch (err) {
      console.error('[import] el cuadrante se ha importado, pero falló el aviso posterior:', err);
    }
  } catch (err) {
    console.error('[import] no se pudo importar:', err);
    notify.error(`No se pudo importar: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = original;
  }
}

/* ------------------------------------------------------------------ *
 * Arranque diferido de los metadatos
 * ------------------------------------------------------------------ */

ensureMeta();
