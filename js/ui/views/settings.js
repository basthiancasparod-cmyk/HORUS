/**
 * HORUS — js/ui/views/settings.js
 * Vista de Ajustes: cuadrante, horas, festivos, avisos, apariencia, cuenta en
 * la nube, datos y zona delicada.
 *
 * Es la vista con más formularios. Cada control se cablea UNA sola vez (con un
 * registro de «ya cableado») y el pintado solo sincroniza valores y visibilidad.
 */

import { byId, el, clear, icon, $$, debounce, formatBytes } from '../../core/utils.js';
import {
  todayKey, monthKeyOf, monthDays, formatShortDate, blockMinutes, formatBlocks,
} from '../../core/date.js';
import * as storage from '../../core/storage.js';
import { AI_PROVIDERS } from '../../core/ai-vision.js';
import * as auth from '../../core/auth.js';
import { cloudConfig, setCloudConfig, hasOwnCloudConfig, APP, DEFAULT_CLOUD } from '../../config.js';
import * as exporter from '../../core/exporter.js';
import { DATA_NOTES } from '../../core/holidays.js';
import { getContext, registerRenderer, invalidate } from '../context.js';
import {
  notify, confirmAction, switchControl, readNumber, avatar,
  openDialog, closeDialog,
} from '../toolkit.js';
import {
  openTypeEditor, openExportDialog, openBackupRestoreDialog, applyHolidays,
  fillRegionSelect,
} from '../dialogs.js';

export const VIEW = 'settings';

let refs = null;
const wired = new Set();

/**
 * Referencia viva al contexto.
 *
 * Los manejadores se cablean UNA sola vez, así que no pueden cerrar sobre el
 * contexto que recibió mount(): si la aplicación vuelve a montar la vista con
 * otro store (al cerrar sesión, por ejemplo), esos manejadores seguirían
 * escribiendo en el store viejo. Se lee siempre de aquí.
 */
let live = null;

/* ------------------------------------------------------------------ *
 * Montaje
 * ------------------------------------------------------------------ */

export function mount(ctx) {
  live = ctx;
  refs = {
    sub: byId('settings-sub'),
    name: byId('settings-name'),
    weekstart: byId('settings-weekstart'),
    demand: byId('settings-demand'),
    shiftTypes: byId('settings-shift-types'),
    weekly: byId('settings-weekly'),
    overtime: byId('settings-overtime'),
    region: byId('settings-region'),
    shiftSunday: byId('settings-shift-sunday'),
    loadHolidays: byId('settings-load-holidays'),
    clearHolidays: byId('settings-clear-holidays'),
    holidayNote: byId('settings-holiday-note'),
    permissionBanner: byId('settings-permission-banner'),
    askPermission: byId('settings-ask-permission'),
    notif: byId('settings-notif'),
    lead: byId('settings-lead'),
    briefing: byId('settings-briefing'),
    briefingHourRow: byId('settings-briefing-hour-row'),
    briefingHour: byId('settings-briefing-hour'),
    coverageAlerts: byId('settings-coverage-alerts'),
    testNotif: byId('settings-test-notif'),
    alarmPreview: byId('settings-alarm-preview'),
    theme: byId('settings-theme'),
    weeknumbers: byId('settings-weeknumbers'),
    compact: byId('settings-compact'),
    aiProvider: byId('settings-ai-provider'),
    aiNote: byId('settings-ai-note'),
    aiKey: byId('settings-ai-key'),
    aiStatus: byId('settings-ai-status'),
    aiModel: byId('settings-ai-model'),
    aiModelHint: byId('settings-ai-model-hint'),
    aiModelReset: byId('settings-ai-model-reset'),
    aiTest: byId('settings-ai-test'),
    aiKeyLink: byId('settings-ai-keylink'),
    aiTestResult: byId('settings-ai-test-result'),
    account: byId('settings-account'),
    cloud: byId('settings-cloud'),
    storage: byId('settings-storage'),
    storageBadge: byId('settings-storage-badge'),
    backup: byId('settings-backup'),
    restore: byId('settings-restore'),
    backups: byId('settings-backups'),
    importCsv: byId('settings-import-csv'),
    exportIcal: byId('settings-export-ical'),
    clearSchedule: byId('settings-clear-schedule'),
    signout: byId('settings-signout'),
    reset: byId('settings-reset'),
    about: byId('settings-about'),
  };

  fillRegionSelect(refs.region, 'ES');
  wireSettings();

  registerRenderer(VIEW, render);
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
}

/* ------------------------------------------------------------------ *
 * Cableado (una sola vez)
 * ------------------------------------------------------------------ */

function wireSettings() {
  const once = (key, fn) => {
    if (wired.has(key)) return;
    wired.add(key);
    fn();
  };

  /* ---------- Cuadrante ---------- */

  once('name', () => {
    const save = debounce(() => {
      const value = refs.name.value.trim();
      if (value && value !== live.doc.name) live.actions.renameDocument(value);
    }, 600);
    refs.name.addEventListener('input', save);
  });

  once('weekstart', () => {
    refs.weekstart.addEventListener('change', () => {
      try {
        live.actions.updateSettings({ weekStartsOn: Number(refs.weekstart.value) });
        notify.info('Preferencia guardada');
        invalidate('calendar');
        invalidate('roster');
      } catch (err) {
        throw err;
      }
    });
  });

  once('demand', () => {
    refs.demand.addEventListener('change', () => {
      live.actions.updateSettings({ coverage: { defaultDemand: Number(refs.demand.value) } });
      notify.info('Personas necesarias actualizado');
      invalidate();
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  once('shiftTypes', () => {
    refs.shiftTypes.addEventListener('click', () => openShiftTypesManager(live));
  });

  /* ---------- Horas ---------- */

  once('hours', () => {
    refs.weekly.addEventListener('change', () => {
      live.actions.updateSettings({
        hours: { weeklyTarget: readNumber(refs.weekly, { min: 0, max: 80, fallback: 40 }) },
      });
      notify.info('Jornada semanal actualizada');
      invalidate('hours');
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
    refs.overtime.addEventListener('change', () => {
      live.actions.updateSettings({
        hours: { overtimeAfter: readNumber(refs.overtime, { min: 0, max: 80, fallback: 40 }) },
      });
      notify.info('Umbral de horas extra actualizado');
      invalidate('hours');
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  /* ---------- Festivos ---------- */

  once('region', () => {
    refs.region.addEventListener('change', () => {
      live.setRegion(refs.region.value);
      notify.info(`Comunidad: ${refs.region.options[refs.region.selectedIndex]?.text || refs.region.value}`);
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  once('shiftSunday', () => {
    const control = switchControl('settings-shift-sunday', true, (checked) => {
      live.actions.updateSettings({ holidays: { shiftSundayToMonday: checked } });
      notify.info(checked
        ? 'Los festivos que caigan en domingo se pasarán al lunes'
        : 'Los festivos se marcarán en su fecha original');
    }, { label: 'Trasladar al lunes los festivos que caen en domingo' });
    refs.shiftSunday.replaceWith(control);
    refs.shiftSunday = control;
  });

  once('loadHolidays', () => {
    refs.loadHolidays.addEventListener('click', async () => {
      const year = new Date().getFullYear();
      const region = live.region();
      const label = refs.region.options[refs.region.selectedIndex]?.text || region;
      const ok = await confirmAction({
        title: `¿Cargar los festivos de ${year}?`,
        message: `Se marcarán en el calendario los festivos de ${label}. Los días que ya hayas marcado a mano no se tocan.`,
        confirmLabel: 'Cargar',
        danger: false,
      });
      if (!ok) return;
      const count = applyHolidays(live, { year, region });
      if (count) {
        notify.success(`${count} festivo(s) marcados`, {
          action: { label: 'Deshacer', onClick: () => live.undo() },
        });
      }
      invalidate();
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  once('clearHolidays', () => {
    refs.clearHolidays.addEventListener('click', async () => {
      const imported = Object.entries(live.doc.dayMeta || {}).filter(([, meta]) => meta.imported);
      if (!imported.length) {
        notify.info('No hay festivos cargados automáticamente.');
        return;
      }
      const ok = await confirmAction({
        title: '¿Quitar los festivos cargados?',
        message: `Se quitarán ${imported.length} día(s) marcados automáticamente. Los que hayas marcado tú se conservan.`,
        confirmLabel: 'Quitar',
      });
      if (!ok) return;
      live.batch('quitar festivos importados', () => {
        for (const [date] of imported) live.actions.setDayMeta(date, { dayType: 'normal', label: '' });
      });
      notify.success(`${imported.length} festivo(s) quitados`, {
        action: { label: 'Deshacer', onClick: () => live.undo() },
      });
      invalidate();
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  /* ---------- Avisos ---------- */

  once('permission', () => {
    refs.askPermission.addEventListener('click', async () => {
      const { requestPermission } = await import('../../core/reminders.js');
      const result = await requestPermission();
      if (result.ok) {
        notify.success('Permiso concedido');
        live.actions.updateSettings({ notifications: { enabled: true } });
        live.scheduler?.reschedule?.();
      } else if (result.reason === 'denied') {
        notify.error('El navegador ha bloqueado las notificaciones. Actívalas en los ajustes del sitio.');
      } else if (result.reason === 'unsupported') {
        notify.warning('Este navegador no admite notificaciones.');
      } else {
        notify.warning('No se concedió el permiso.');
      }
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  once('notif', () => {
    const control = switchControl('settings-notif', false, async (checked) => {
      if (checked) {
        const { requestPermission, permissionState } = await import('../../core/reminders.js');
        if (permissionState() !== 'granted') {
          const result = await requestPermission();
          if (!result.ok) {
            notify.error('Sin permiso del navegador no se pueden mostrar los avisos.');
            control.setAttribute('aria-checked', 'false');
            return;
          }
        }
      }
      live.actions.updateSettings({ notifications: { enabled: checked } });
      live.scheduler?.reschedule?.();
      notify.info(checked ? 'Avisos activados' : 'Avisos desactivados');
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    }, { label: 'Aviso antes de cada turno' });
    refs.notif.replaceWith(control);
    refs.notif = control;
  });

  once('lead', () => {
    refs.lead.addEventListener('change', () => {
      live.actions.updateSettings({ notifications: { minutesBefore: Number(refs.lead.value) } });
      live.scheduler?.reschedule?.();
      notify.info(`Avisaré ${refs.lead.value} minutos antes`);
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  once('briefing', () => {
    const control = switchControl('settings-briefing', false, (checked) => {
      live.actions.updateSettings({ notifications: { dailyBriefing: checked } });
      live.scheduler?.reschedule?.();
      notify.info(checked ? 'Resumen diario activado' : 'Resumen diario desactivado');
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    }, { label: 'Resumen del día siguiente' });
    refs.briefing.replaceWith(control);
    refs.briefing = control;
  });

  once('briefingHour', () => {
    refs.briefingHour.addEventListener('change', () => {
      live.actions.updateSettings({ notifications: { briefingHour: refs.briefingHour.value || '20:00' } });
      live.scheduler?.reschedule?.();
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  once('coverageAlerts', () => {
    const control = switchControl('settings-coverage-alerts', false, (checked) => {
      live.actions.updateSettings({ notifications: { coverageAlerts: checked } });
      live.scheduler?.reschedule?.();
      notify.info(checked ? 'Te avisaré de los días sin cubrir' : 'Aviso de huecos desactivado');
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    }, { label: 'Avisar de días sin cubrir' });
    refs.coverageAlerts.replaceWith(control);
    refs.coverageAlerts = control;
  });

  once('testNotif', () => {
    refs.testNotif.addEventListener('click', async () => {
      const { requestPermission } = await import('../../core/reminders.js');
      const permission = await requestPermission();
      if (!permission.ok) {
        notify.error(permission.reason === 'unsupported'
          ? 'Este navegador no admite notificaciones.'
          : 'El navegador no ha dado permiso para las notificaciones.');
        return;
      }
      const result = await live.scheduler?.testNotification?.();
      if (result?.ok) notify.success(`Notificación enviada (${result.via || 'navegador'})`);
      else notify.warning('No se pudo mostrar la notificación.');
    });
  });

  /* ---------- Apariencia ---------- */

  once('theme', () => {
    refs.theme.addEventListener('change', async () => {
      const value = refs.theme.value;
      storage.storage.set('horus.theme', value);
      live.actions.updateSettings({ theme: value });
      try {
        const mod = await import('../../app.js');
        mod.applyTheme(value);
      } catch { /* el tema se aplicará al recargar */ }
      notify.info({ dark: 'Tema oscuro', light: 'Tema claro', auto: 'Tema automático' }[value] || 'Tema cambiado');
    });
  });

  once('weeknumbers', () => {
    const control = switchControl('settings-weeknumbers', true, (checked) => {
      live.actions.updateSettings({ showWeekNumbers: checked });
      invalidate('calendar');
      invalidate('roster');
    }, { label: 'Números de semana' });
    refs.weeknumbers.replaceWith(control);
    refs.weeknumbers = control;
  });

  once('compact', () => {
    const control = switchControl('settings-compact', false, (checked) => {
      live.actions.updateSettings({ compactMode: checked });
      document.documentElement.dataset.density = checked ? 'compact' : 'comfortable';
      invalidate();
    }, { label: 'Modo compacto' });
    refs.compact.replaceWith(control);
    refs.compact = control;
  });

  /* ---------- Importar con IA (BYOK) ---------- */

  once('ai', () => {
    // El selector se construye desde la interfaz congelada de ai-vision.js:
    // aquí no se escribe a mano ningún proveedor.
    for (const provider of Object.values(AI_PROVIDERS)) {
      refs.aiProvider.appendChild(el('option', { value: provider.id }, provider.label));
    }

    refs.aiProvider.addEventListener('change', () => {
      // Al cambiar de proveedor el modelo guardado ya no sirve: vuelve al suyo.
      saveAiConfig({ provider: refs.aiProvider.value, model: '' });
      paintAi();
      clear(refs.aiTestResult);
      notify.info(`Proveedor: ${AI_PROVIDERS[refs.aiProvider.value]?.label || refs.aiProvider.value}`);
    });

    // La clave se guarda sola, sin botón, pero solo en las preferencias locales.
    // Mientras el usuario escribe no se pisa el campo (aunque la vista se
    // repinte por un cambio del store), porque todavía no se ha guardado.
    const saveKey = debounce(() => {
      saveAiConfig({ provider: refs.aiProvider.value, apiKey: refs.aiKey.value.trim() });
      aiTouched.key = false;
      paintAiStatus();
    }, 500);
    refs.aiKey.addEventListener('input', () => {
      aiTouched.key = true;
      saveKey();
    });

    const saveModel = debounce(() => {
      saveAiConfig({ provider: refs.aiProvider.value, model: refs.aiModel.value.trim() });
      aiTouched.model = false;
    }, 500);
    refs.aiModel.addEventListener('input', () => {
      aiTouched.model = true;
      saveModel();
    });

    refs.aiModelReset.addEventListener('click', () => {
      const provider = AI_PROVIDERS[refs.aiProvider.value];
      if (!provider) return;
      refs.aiModel.value = provider.defaultModel;
      aiTouched.model = false;
      saveAiConfig({ provider: provider.id, model: provider.defaultModel });
      notify.info(`Modelo: ${provider.defaultModel}`);
    });

    refs.aiTest.addEventListener('click', testAiKey);
  });

  /* ---------- Datos ---------- */

  once('backup', () => {
    refs.backup.addEventListener('click', () => {
      const name = exporter.downloadBackup(live.doc);
      notify.success(`Copia descargada: ${name}`);
    });
  });

  once('restore', () => {
    refs.restore.addEventListener('click', async () => {
      const { pickTextFile } = await import('../../core/utils.js');
      const file = await pickTextFile('.json');
      if (!file?.text) return;
      const parsed = exporter.parseBackup(file.text);
      if (!parsed.doc) {
        notify.error(parsed.error || 'No se pudo leer el archivo.');
        return;
      }
      for (const warning of parsed.warnings || []) notify.warning(warning, { duration: 7000 });

      const when = parsed.exportedAt ? formatShortDate(String(parsed.exportedAt).slice(0, 10)) : 'fecha desconocida';
      const merge = await askMergeOrReplace({
        title: 'Cómo aplicar la copia',
        context: `Del ${when} · ${parsed.doc.members.length} persona(s) · ${parsed.doc.entries.length} turno(s).`,
      });
      if (merge === null) return;

      live.actions.importDocument(parsed.doc, { merge });
      notify.success(merge ? 'Datos combinados con los actuales' : 'Copia restaurada', {
        action: { label: 'Deshacer', onClick: () => live.undo() },
      });
      invalidate();
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  once('backups', () => {
    refs.backups.addEventListener('click', async () => {
      const list = storage.listBackups();
      await openBackupRestoreDialog(live, list, (slot) => {
        const doc = storage.readBackup(slot);
        if (!doc) {
          notify.error('Esa copia ya no está disponible.');
          return;
        }
        live.actions.importDocument(doc, { merge: false });
        notify.success('Versión anterior recuperada', {
          action: { label: 'Deshacer', onClick: () => live.undo() },
        });
        invalidate();
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
      });
    });
  });

  once('importPdf', () => {
    const button = byId('settings-import-pdf');
    if (!button) return;
    button.addEventListener('click', () => live.openImport());
  });

  once('importCsv', () => {
    refs.importCsv.addEventListener('click', async () => {
      const { pickTextFile } = await import('../../core/utils.js');
      const file = await pickTextFile('.csv,.txt');
      if (!file?.text) return;
      const { rows, errors, headers } = exporter.parseScheduleCSV(file.text);
      if (!rows.length) {
        notify.error(errors[0] || `No se encontraron filas. Cabeceras leídas: ${headers.join(', ') || '(ninguna)'}`);
        return;
      }
      await importCsvRows(rows, errors);
    });
  });

  once('exportIcal', () => {
    refs.exportIcal.addEventListener('click', () => {
      const monthKey = monthKeyOf(todayKey());
      const days = monthDays(monthKey);
      openExportDialog(live, { from: days[0], to: days[days.length - 1] });
    });
  });

  /* ---------- Peligro ---------- */

  once('clearSchedule', () => {
    refs.clearSchedule.addEventListener('click', async () => {
      const total = live.doc.entries.length;
      if (!total) {
        notify.info('El cuadrante ya está vacío.');
        return;
      }
      const ok = await confirmAction({
        title: '¿Borrar todos los turnos?',
        message: `Se quitarán los ${total} turno(s). Las personas, los tipos de turno y los festivos se conservan.`,
        confirmLabel: 'Borrar todo',
      });
      if (!ok) return;
      live.actions.clearSchedule();
      notify.success('Cuadrante vaciado', {
        action: { label: 'Deshacer', onClick: () => live.undo() },
      });
      invalidate();
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
    });
  });

  once('signout', () => {
    refs.signout.addEventListener('click', () => live.signOut());
  });

  once('reset', () => {
    refs.reset.addEventListener('click', async () => {
      const ok = await confirmAction({
        title: '¿Empezar de cero?',
        message: 'Se borrarán TODOS los datos de este dispositivo: cuadrante, equipo, tipos de turno y ajustes. Descarga antes una copia de seguridad: esto no se puede deshacer.',
        confirmLabel: 'Continuar',
      });
      if (!ok) return;
      const sure = await confirmAction({
        title: 'Última confirmación',
        message: 'Esta acción es irreversible. ¿Seguro que quieres borrar el cuadrante completo?',
        confirmLabel: 'Sí, borrar todo',
      });
      if (!sure) return;
      storage.clearAll();
      notify.info('Todo borrado. Recargando…', { duration: 1500 });
      setTimeout(() => window.location.reload(), 1200);
    });
  });
}


/* ------------------------------------------------------------------ *
 * IA de visión: proveedor, clave y modelo (BYOK)
 *
 * La clave vive SOLO en las preferencias locales de interfaz
 * (`storage.loadUI`), bajo la clave `ai`, junto al proveedor y el modelo.
 * NO entra en el documento: el documento se sincroniza con la nube y la
 * clave no puede salir de este dispositivo.
 * ------------------------------------------------------------------ */

/** Clave propia dentro de las preferencias de interfaz (no se mezcla con el resto). */
const AI_PREF = 'ai';

/**
 * Campos de IA que el usuario está editando ahora mismo. Mientras estén
 * marcados no se sincronizan desde lo guardado: si la vista se repinta antes
 * de que el guardado con retardo se complete, se perdería lo escrito.
 */
const aiTouched = { key: false, model: false };

/**
 * PNG de 1×1 embebido: es la llamada de verificación más barata que permite el
 * contrato congelado de ai-vision.js (no hay ninguna función «ping»).
 */
const TINY_PNG_BASE64 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGNIm3kGAAM0AcyDMO/AAAAAAElFTkSuQmCC';

/** Lee la configuración de IA saneada contra la interfaz congelada. */
function aiConfig() {
  const stored = storage.loadUI()?.[AI_PREF];
  const data = stored && typeof stored === 'object' ? stored : {};
  const ids = Object.keys(AI_PROVIDERS);
  const provider = ids.includes(data.provider) ? data.provider : (ids[0] || '');
  const providerDef = AI_PROVIDERS[provider] || null;
  const model = String(data.model || '').trim() || providerDef?.defaultModel || '';
  return { provider, providerDef, apiKey: String(data.apiKey || ''), model };
}

/** Guarda la configuración de IA sin tocar ninguna otra preferencia de interfaz. */
function saveAiConfig(patch) {
  const stored = storage.loadUI()?.[AI_PREF];
  const current = stored && typeof stored === 'object' ? stored : {};
  storage.saveUI({ [AI_PREF]: { ...current, ...patch } });
}

/**
 * Comprobación real de la clave: una interpretación con una imagen de 1×1.
 * Sin clave no se llama a ningún sitio (no hay servicio por defecto).
 */
async function testAiKey() {
  const config = aiConfig();
  if (!config.providerDef) {
    setAiTestResult('error', 'No hay ningún proveedor seleccionado.');
    return;
  }
  if (!config.apiKey) {
    setAiTestResult('warning', 'Escribe primero tu clave y vuelve a probar.');
    notify.warning('Falta la clave del proveedor');
    return;
  }

  const button = refs.aiTest;
  const label = button.textContent;
  button.disabled = true;
  button.textContent = 'Probando…';
  setAiTestResult('info', `Comprobando la clave con ${config.providerDef.label}…`);

  try {
    const mod = await import('../../core/ai-vision.js');
    const fetchImpl = typeof fetch === 'function' ? (input, init) => fetch(input, init) : undefined;
    const result = await mod.interpretSchedule({
      provider: config.provider,
      apiKey: config.apiKey,
      model: config.model,
      file: { data: TINY_PNG_BASE64, mimeType: 'image/png', name: 'prueba.png' },
      fetchImpl,
    });
    paintAiVerdict(result, config);
  } catch (err) {
    // El contrato dice que nunca lanza; si aun así pasa, se explica sin la clave.
    setAiTestResult('error', `La comprobación ha fallado: ${err.message}`);
  } finally {
    button.disabled = false;
    button.textContent = label;
  }
}

/**
 * Traduce el resultado de la prueba a un mensaje claro para el usuario.
 *
 * El PNG de 1×1 solo sirve para comprobar la AUTENTICACIÓN: el proveedor puede
 * responder «esto no es un cuadrante» con la clave perfectamente válida. Por eso
 * los fallos de contenido cuentan como «la clave se ha aceptado» y solo los de
 * transporte, clave, modelo o cuota se cuentan como fallo de la prueba.
 */
function paintAiVerdict(result, config) {
  const name = config.providerDef?.label || config.provider;

  if (result?.ok) {
    setAiTestResult('success', `La clave funciona: ${name} ha respondido con el modelo ${config.model}.`);
    notify.success('La clave funciona');
    return;
  }

  const reason = String(result?.reason || 'motivo desconocido');
  if (/no está implementada|todavía no/i.test(reason)) {
    setAiTestResult('warning', `${name} todavía no está disponible en esta versión: ${reason}`);
  } else if (/clave|401|403|permiso|autentic/i.test(reason)) {
    setAiTestResult('error', `La clave no vale o no tiene permiso para ese modelo: ${reason}`);
    notify.error('La clave no vale');
  } else if (/satur|503|429|demanda|ocupad|no responde|reinténtalo/i.test(reason)) {
    setAiTestResult('warning', `El servicio está saturado ahora mismo: ${reason} Prueba dentro de unos minutos.`);
    notify.warning('El servicio está saturado');
  } else if (/modelo|404|no disponible/i.test(reason)) {
    setAiTestResult('warning', `Ese modelo no está disponible en tu cuenta (${config.model}): ${reason}`);
  } else if (/conexi|sin red|internet/i.test(reason)) {
    setAiTestResult('error', `No se ha podido llegar al servicio: ${reason}`);
  } else if (/proveedor/i.test(reason)) {
    setAiTestResult('error', `Falta elegir proveedor: ${reason}`);
  } else if (/rechazado la petición|error \d{3}/i.test(reason)) {
    setAiTestResult('warning', `El proveedor ha respondido con un error, así que la prueba no es concluyente: ${reason}`);
  } else {
    // El proveedor ha contestado: la clave se ha aceptado. Lo que no vale es la
    // imagen de prueba, y eso se dice tal cual.
    setAiTestResult('success', `La clave parece correcta: ${name} ha respondido. La imagen de prueba es de un píxel, así que no se puede leer como cuadrante: ${reason}`);
    notify.success('La clave se ha aceptado');
  }
}

/** Mensaje de resultado de la prueba, sin `innerHTML` y con icono de la casa. */
function setAiTestResult(kind, message) {
  const box = refs.aiTestResult;
  if (!box) return;
  clear(box);
  const iconName = kind === 'success' ? 'check' : kind === 'error' ? 'alert' : 'info';
  box.appendChild(el('div', { class: `gap-item gap-item-${kind}` }, [
    icon(iconName, 16),
    el('span', { class: 'grow' }, message),
  ]));
}

/** Sincroniza el bloque de IA con lo guardado. */
function paintAi() {
  const config = aiConfig();
  const provider = config.providerDef;

  if (refs.aiProvider.value !== config.provider) refs.aiProvider.value = config.provider;
  refs.aiNote.textContent = provider?.note
    || 'No hay ningún proveedor disponible en esta versión.';

  if (provider?.keyUrl) {
    refs.aiKeyLink.href = provider.keyUrl;
    refs.aiKeyLink.hidden = false;
  } else {
    refs.aiKeyLink.hidden = true;
  }

  // Nunca se pisa lo que el usuario está escribiendo en ese momento.
  if (!aiTouched.key && document.activeElement !== refs.aiKey) refs.aiKey.value = config.apiKey;
  if (!aiTouched.model && document.activeElement !== refs.aiModel) refs.aiModel.value = config.model;

  refs.aiModel.placeholder = provider?.defaultModel || 'modelo';
  refs.aiModelHint.textContent = provider
    ? `Recomendado: ${provider.defaultModel}. Si está saturado, la app prueba los modelos de reserva que ya conoce.`
    : '';

  paintAiStatus();
}

function paintAiStatus() {
  const config = aiConfig();
  const name = config.providerDef?.label;
  refs.aiStatus.textContent = config.apiKey
    ? `Clave guardada solo en este dispositivo${name ? ` (${name})` : ''}. Nunca se sube a la nube.`
    : 'Todavía no hay ninguna clave guardada en este dispositivo.';
}

/** Pregunta si combinar la copia con lo actual o reemplazarlo. */
function askMergeOrReplace({ title, context }) {
  const box = el('div', { class: 'stack-sm' });
  let choice = false;

  const makeOption = (value, label, sub) => {
    const row = el('button', {
      type: 'button',
      class: 'setting-row is-clickable',
      style: { width: '100%', textAlign: 'left' },
      'aria-pressed': String(choice === value),
      onclick: () => {
        choice = value;
        $$('button', box).forEach((node) => node.setAttribute('aria-pressed', 'false'));
        row.setAttribute('aria-pressed', 'true');
      },
    }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 'label' }, label),
        el('div', { class: 'sub' }, sub),
      ]),
      el('span', {}, icon('check', 16)),
    ]);
    return row;
  };

  box.appendChild(makeOption(false, 'Reemplazar todo', 'El cuadrante actual se sustituye por el del archivo.'));
  box.appendChild(makeOption(true, 'Combinar', 'Se añaden del archivo solo las personas y los turnos que falten.'));

  return new Promise((resolve) => {
    const dialog = byId('dialog-confirm');
    byId('confirm-title').textContent = title;
    byId('confirm-sub').textContent = context || '';
    const message = byId('confirm-message');
    message.textContent = 'Elige cómo quieres aplicar la copia:';
    message.hidden = false;
    byId('confirm-extra').replaceChildren(box);
    const okBtn = byId('confirm-ok');
    const cancelBtn = byId('confirm-cancel');
    okBtn.textContent = 'Aplicar';
    okBtn.className = 'btn btn-primary';
    cancelBtn.hidden = false;
    cancelBtn.textContent = 'Cancelar';

    const finish = (value) => {
      okBtn.onclick = null;
      cancelBtn.onclick = null;
      dialog.removeEventListener('close', onClose);
      message.hidden = true;
      byId('confirm-sub').textContent = '';
      closeDialog(dialog);
      resolve(value);
    };
    const onClose = () => finish(null);
    okBtn.onclick = () => finish(choice);
    cancelBtn.onclick = () => finish(null);
    dialog.addEventListener('close', onClose);
    openDialog(dialog);
  });
}

/** Importa filas de CSV tras enseñar un resumen de lo que va a ocurrir. */
async function importCsvRows(rows, errors) {
  const ctx = live;
  const doc = ctx.doc;
  const byName = new Map(doc.members.map((m) => [m.name.toLowerCase(), m]));
  const byCode = new Map(doc.shiftTypes.map((t) => [t.code.toLowerCase(), t]));
  for (const t of doc.shiftTypes) byCode.set(t.label.toLowerCase(), t);

  const unknownPeople = [...new Set(rows.map((r) => r.person))].filter((n) => !byName.has(n.toLowerCase()));
  const unknownCodes = [...new Set(rows.map((r) => r.code).filter(Boolean))].filter((c) => !byCode.has(c.toLowerCase()));
  const dates = rows.map((r) => r.date).sort();

  const summary = el('div', { class: 'stack-sm' }, [
    el('div', { class: 'row-between' }, [
      el('span', { class: 't-sm' }, 'Filas válidas'),
      el('span', { class: 'badge' }, String(rows.length)),
    ]),
    el('div', { class: 'row-between' }, [
      el('span', { class: 't-sm' }, 'Periodo'),
      el('span', { class: 'badge' }, `${formatShortDate(dates[0])} → ${formatShortDate(dates[dates.length - 1])}`),
    ]),
  ]);

  if (unknownPeople.length) {
    summary.appendChild(el('div', { class: 'gap-item' }, [
      icon('alert', 16),
      el('span', { class: 'grow' }, `${unknownPeople.length} persona(s) nueva(s): ${unknownPeople.slice(0, 4).join(', ')}${unknownPeople.length > 4 ? '…' : ''}. Se crearán.`),
    ]));
  }
  if (unknownCodes.length) {
    summary.appendChild(el('div', { class: 'gap-item' }, [
      icon('alert', 16),
      el('span', { class: 'grow' }, `Códigos desconocidos: ${unknownCodes.join(', ')}. Esas filas quedarán como turno suelto.`),
    ]));
  }
  if (errors.length) {
    summary.appendChild(el('div', { class: 'gap-item is-empty' }, [
      icon('alert', 16),
      el('span', { class: 'grow' }, `${errors.length} fila(s) con errores se ignorarán. ${errors[0]}`),
    ]));
  }

  const ok = await confirmAction({
    title: '¿Importar el cuadrante?',
    message: 'Se asignarán los turnos del archivo. Los días que ya tengan turno se reemplazarán.',
    confirmLabel: 'Importar',
    danger: false,
    extra: summary,
  });
  if (!ok) return;

  ctx.batch('importar cuadrante', () => {
    for (const name of unknownPeople) {
      if (!ctx.doc.members.some((m) => m.name.toLowerCase() === name.toLowerCase())) {
        ctx.actions.addMember({ name });
      }
    }
  });

  const members = new Map(ctx.doc.members.map((m) => [m.name.toLowerCase(), m]));
  const types = new Map(ctx.doc.shiftTypes.map((t) => [t.code.toLowerCase(), t]));
  for (const t of ctx.doc.shiftTypes) types.set(t.label.toLowerCase(), t);

  let applied = 0;
  ctx.batch('importar turnos', () => {
    for (const row of rows) {
      const member = members.get(row.person.toLowerCase());
      if (!member) continue;
      const type = row.code ? (types.get(row.code.toLowerCase()) || null) : null;
      if (ctx.actions.setEntry({
        memberId: member.id,
        date: row.date,
        typeId: type ? type.id : null,
        notes: row.notes || undefined,
      })) applied++;
    }
  });

  notify.success(`${applied} turno(s) importados`, {
    action: { label: 'Deshacer', onClick: () => ctx.undo() },
  });
  invalidate();
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
}

/* ------------------------------------------------------------------ *
 * Gestor del catálogo de turnos (reutiliza #dialog-type)
 * ------------------------------------------------------------------ */

let managerCleanup = null;

function openShiftTypesManager(ctx = live) {
  const dialog = byId('dialog-type');
  const panel = dialog.querySelector('.dialog-panel');
  const form = byId('form-type');
  const footer = panel.querySelector('.dialog-footer');

  const restore = () => {
    form.hidden = false;
    footer.hidden = false;
    dialog.querySelector('.dialog-header h2').textContent = 'Tipo de turno';
    byId('type-sub').textContent = '';
    managerCleanup = null;
  };

  managerCleanup = restore;

  // El formulario de edición se oculta y en su lugar va la lista
  form.hidden = true;
  footer.hidden = true;

  const list = el('div', { class: 'dialog-body' });
  panel.insertBefore(list, footer);

  dialog.querySelector('.dialog-header h2').textContent = 'Catálogo de turnos';
  byId('type-sub').textContent = 'Código, color, horario y personas necesarias de cada turno.';

  const paint = () => {
    clear(list);
    const sorted = [...ctx.doc.shiftTypes].sort((a, b) => a.order - b.order);

    for (const type of sorted) {
      const used = ctx.doc.entries.filter((e) => e.typeId === type.id).length;
      const total = type.blocks.reduce((acc, b) => acc + blockMinutes(b), 0);

      const card = el('div', { class: 'type-card', style: { '--type-color': type.hex, marginBottom: 'var(--sp-2)' } }, [
        el('span', {
          class: 'type-code',
          style: { background: type.hex, color: readableOnHex(type.hex) },
        }, type.code),
        el('div', { class: 'grow' }, [
          el('div', { class: 'type-name' }, type.label),
          el('div', { class: 'type-detail' }, describeType(type, used, total)),
          type.blocks.length ? renderSchedulePreview(type) : null,
        ]),
        el('div', { class: 'type-actions' }, [
          el('button', {
            type: 'button', class: 'icon-btn', 'aria-label': `Editar ${type.label}`,
            onclick: () => {
              list.remove();
              restore();
              openTypeEditor(ctx, type.id, {
                onSaved: () => {
                  openShiftTypesManager(live);
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
                },
              });
            },
          }, icon('edit', 16)),
          el('button', {
            type: 'button', class: 'icon-btn', 'aria-label': `Eliminar ${type.label}`,
            onclick: async () => {
              const ok = await confirmAction({
                title: `¿Eliminar «${type.label}»?`,
                message: used
                  ? `Hay ${used} turno(s) con este tipo. No se perderán: conservarán su horario pero sin tipo asociado.`
                  : 'Se quitará del catálogo de turnos.',
                confirmLabel: 'Eliminar',
              });
              if (!ok) return;
              ctx.actions.removeShiftType(type.id);
              paint();
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
            },
          }, icon('trash', 16)),
        ]),
      ]);
      list.appendChild(card);
    }

    list.appendChild(el('button', {
      type: 'button', class: 'btn btn-block', style: { marginTop: 'var(--sp-2)' },
      onclick: () => {
        list.remove();
        restore();
        openTypeEditor(ctx, null, {
          onSaved: () => {
            openShiftTypesManager(live);
      // El repintado lo dispara la suscripción al store; aquí se leería el documento anterior.
          },
        });
      },
    }, [icon('plus', 16), 'Añadir un tipo de turno']));

    list.appendChild(el('button', {
      type: 'button', class: 'btn btn-block', style: { marginTop: 'var(--sp-2)' },
      onclick: () => {
        list.remove();
        restore();
        closeDialog(dialog);
      },
    }, 'Cerrar'));
  };

  dialog.addEventListener('close', () => {
    if (managerCleanup) {
      const cleanup = managerCleanup;
      managerCleanup = null;
      list.remove();
      cleanup();
    }
  }, { once: true });

  paint();
  openDialog(dialog);
}

function describeType(type, used, minutes) {
  const kindLabels = {
    work: 'Turno trabajado',
    leave: 'Vacaciones',
    sick: 'Baja',
    free: 'Libre',
    rest: 'Festivo',
  };
  const parts = [kindLabels[type.kind] || type.kind];
  if (type.kind === 'work' && minutes) parts.push(formatBlocks(type.blocks));
  parts.push(`${used} turno${used === 1 ? '' : 's'}`);
  parts.push(`hacen falta ${type.demand}`);
  return parts.join(' · ');
}

/** Barra de 24 h con los tramos del horario del tipo. */
function renderSchedulePreview(type) {
  const box = el('div', { class: 'schedule-preview', style: { '--type-color': type.hex } });
  for (const block of type.blocks) {
    const [sh, sm] = String(block.start).split(':').map(Number);
    const start = sh * 60 + (sm || 0);
    const minutes = blockMinutes(block);
    box.appendChild(el('div', {
      class: 'seg',
      style: {
        left: `${(start / 1440) * 100}%`,
        width: `${(Math.min(minutes, 1440 - start) / 1440) * 100}%`,
      },
      title: `${block.start}–${block.end}`,
    }));
  }
  return box;
}

function readableOnHex(hex) {
  const c = String(hex || '').replace('#', '');
  if (c.length !== 6) return '#fff';
  const r = parseInt(c.slice(0, 2), 16);
  const g = parseInt(c.slice(2, 4), 16);
  const b = parseInt(c.slice(4, 6), 16);
  const s = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; };
  const lum = 0.2126 * s(r) + 0.7152 * s(g) + 0.0722 * s(b);
  return lum > 0.45 ? '#101319' : '#FFFFFF';
}

/* ------------------------------------------------------------------ *
 * Pintado
 * ------------------------------------------------------------------ */

function render() {
  live = getContext();
  const ctx = live;
  const doc = ctx.doc;
  const settings = doc.settings;

  refs.sub.textContent = `${doc.name} · ${doc.members.length} personas · ${doc.entries.length} turnos`;

  /* Cuadrante */
  if (document.activeElement !== refs.name) refs.name.value = doc.name;
  refs.weekstart.value = String(settings.weekStartsOn ?? 1);
  refs.demand.value = String(settings.coverage?.defaultDemand ?? 1);
  refs.shiftTypes.textContent = `Editar el catálogo de turnos (${doc.shiftTypes.length})`;

  /* Horas */
  if (document.activeElement !== refs.weekly) refs.weekly.value = String(settings.hours?.weeklyTarget ?? 40);
  if (document.activeElement !== refs.overtime) refs.overtime.value = String(settings.hours?.overtimeAfter ?? 40);

  /* Festivos */
  refs.region.value = ctx.region();
  setSwitch(refs.shiftSunday, settings.holidays?.shiftSundayToMonday !== false);
  const imported = Object.values(doc.dayMeta || {}).filter((m) => m.imported).length;
  refs.holidayNote.textContent = imported
    ? `${imported} festivo(s) cargados automáticamente. Puedes quitar cualquiera desde el editor de su día.`
    : (DATA_NOTES?.[0] || 'Los festivos son una ayuda: revísalos y ajústalos a tu convenio.');

  /* Avisos */
  const notif = settings.notifications || {};
  paintNotificationSupport();
  setSwitch(refs.notif, !!notif.enabled);
  refs.lead.value = String(notif.minutesBefore ?? 30);
  setSwitch(refs.briefing, !!notif.dailyBriefing);
  refs.briefingHourRow.hidden = !notif.dailyBriefing;
  if (document.activeElement !== refs.briefingHour) refs.briefingHour.value = notif.briefingHour || '20:00';
  setSwitch(refs.coverageAlerts, !!notif.coverageAlerts);
  paintAlarmPreview(ctx);

  /* Apariencia */
  refs.theme.value = storage.storage.get('horus.theme') || settings.theme || 'dark';
  setSwitch(refs.weeknumbers, settings.showWeekNumbers !== false);
  setSwitch(refs.compact, !!settings.compactMode);

  /* Importar con IA (clave local, nunca en el documento) */
  paintAi();

  /* Cuenta y datos */
  paintAccount(ctx);
  paintCloud(ctx);
  paintStorage();
  paintAbout(ctx);
}

function setSwitch(node, checked) {
  if (!node) return;
  node.setAttribute('aria-checked', String(!!checked));
}

function paintNotificationSupport() {
  const supported = typeof window !== 'undefined' && typeof window.Notification === 'function';
  if (supported && window.Notification.permission === 'granted') {
    refs.permissionBanner.hidden = true;
    return;
  }

  refs.permissionBanner.hidden = false;
  refs.permissionBanner.className = supported ? 'gap-item' : 'gap-item is-empty';
  clear(refs.permissionBanner);

  const denied = supported && window.Notification.permission === 'denied';
  refs.permissionBanner.appendChild(icon(supported ? 'bell' : 'alert', 18));
  refs.permissionBanner.appendChild(el('div', { class: 'grow' }, [
    el('div', { class: 'label' }, !supported
      ? 'Este navegador no admite notificaciones'
      : (denied ? 'Las notificaciones están bloqueadas' : 'Falta el permiso del navegador')),
    el('div', { class: 'sub' }, !supported
      ? 'Puedes seguir usando HORUS; solo no habrá avisos.'
      : (denied
        ? 'Actívalas en los ajustes del sitio de tu navegador y recarga la página.'
        : 'Sin permiso no se pueden mostrar los avisos de turno.')),
  ]));

  if (supported && !denied) {
    refs.permissionBanner.appendChild(el('button', {
      type: 'button', class: 'btn btn-sm btn-primary',
      onclick: () => refs.askPermission.click(),
    }, 'Permitir'));
  }
}

/** Resumen de los avisos programados, para que el usuario confíe en ellos. */
function paintAlarmPreview(ctx = live) {
  clear(refs.alarmPreview);
  const info = ctx.scheduler?.inspect?.();
  if (!info) return;

  if (!info.enabled || info.permission !== 'granted') {
    refs.alarmPreview.appendChild(el('p', { class: 'field-hint' },
      info.permission === 'unsupported'
        ? 'Los avisos no están disponibles en este navegador.'
        : info.permission === 'denied'
          ? 'Las notificaciones están bloqueadas en el navegador.'
          : 'Activa los avisos para ver aquí los próximos.'));
    return;
  }

  if (!info.upcoming?.length) {
    refs.alarmPreview.appendChild(el('p', { class: 'field-hint' },
      'No hay avisos programados para las próximas 72 horas.'));
    return;
  }

  const box = el('div', { class: 'stack-sm', style: { marginTop: 'var(--sp-3)' } }, [
    el('div', { class: 'section-label' }, 'Próximos avisos'),
  ]);
  for (const alarm of info.upcoming.slice(0, 5)) {
    box.appendChild(el('div', { class: 'row-between' }, [
      el('span', { class: 't-xs t-truncate' }, alarm.title),
      el('span', { class: 'badge t-nums' }, new Date(alarm.at).toLocaleString('es-ES', {
        weekday: 'short', hour: '2-digit', minute: '2-digit',
      })),
    ]));
  }
  refs.alarmPreview.appendChild(box);
}

function paintAccount(ctx = live) {
  const box = refs.account;
  clear(box);
  const user = auth.currentUser();

  if (ctx.isLocalMode() || !user) {
    refs.signout.hidden = true;
    const body = el('div', { class: 'card-body' }, [
      el('div', { class: 'row-between' }, [
        el('div', { class: 'grow' }, [
          el('div', { class: 't-md t-semibold' }, 'Sin cuenta'),
          el('div', { class: 'field-hint' },
            'El cuadrante vive solo en este dispositivo. Con una cuenta lo verías en el móvil y el ordenador a la vez.'),
        ]),
        avatar({ name: '?', initials: '—', hex: '#8a93a8' }, { size: 'md' }),
      ]),
    ]);

    if (cloudConfig().configured) {
      body.appendChild(el('button', {
        type: 'button', class: 'btn btn-primary btn-block', style: { marginTop: 'var(--sp-3)' },
        onclick: () => ctx.showAuth(),
      }, 'Iniciar sesión o crear cuenta'));
    } else {
      body.appendChild(el('p', { class: 'field-hint', style: { marginTop: 'var(--sp-3)' } },
        'Este dispositivo no tiene ninguna nube configurada. Puedes añadir una más abajo.'));
    }
    box.appendChild(body);
    return;
  }

  refs.signout.hidden = false;
  box.appendChild(el('div', { class: 'card-body' }, [
    el('div', { class: 'row-between' }, [
      el('div', { class: 'grow' }, [
        el('div', { class: 't-md t-semibold t-truncate' }, user.email || 'Sesión iniciada'),
        el('div', { class: 'field-hint' }, 'Datos sincronizados con la nube.'),
      ]),
      avatar({ name: user.email || '?', initials: (user.email || '?').slice(0, 2).toUpperCase(), hex: '#5b8def' }, { size: 'md' }),
    ]),
    el('div', { class: 'row wrap', style: { marginTop: 'var(--sp-3)', gap: 'var(--sp-2)' } }, [
      el('button', {
        type: 'button', class: 'btn btn-sm',
        onclick: () => changePassword(),
      }, 'Cambiar contraseña'),
      el('button', {
        type: 'button', class: 'btn btn-sm',
        onclick: () => ctx.runSync({ manual: true, full: true }),
      }, 'Sincronizar todo'),
      el('button', {
        type: 'button', class: 'btn btn-sm btn-danger',
        onclick: () => wipeCloud(ctx),
      }, 'Vaciar la nube'),
    ]),
  ]));
}

async function changePassword() {
  const field = el('div', { class: 'field' }, [
    el('label', { class: 'field-label', for: 'settings-new-password' }, 'Nueva contraseña'),
    el('input', { class: 'input', type: 'password', id: 'settings-new-password', autocomplete: 'new-password', placeholder: 'Mínimo 8 caracteres' }),
  ]);
  const ok = await confirmAction({
    title: 'Cambiar la contraseña',
    message: 'Escribe la contraseña nueva de tu cuenta.',
    confirmLabel: 'Cambiar',
    danger: false,
    extra: field,
  });
  if (!ok) return;
  const value = byId('settings-new-password')?.value || '';
  try {
    await auth.updatePassword(value);
    notify.success('Contraseña cambiada');
  } catch (err) {
    notify.error(err.message || 'No se pudo cambiar la contraseña.');
  }
}

async function wipeCloud(ctx) {
  const ok = await confirmAction({
    title: '¿Borrar los datos de la nube?',
    message: 'Se vaciará la copia de la nube. El cuadrante de este dispositivo NO se toca.',
    confirmLabel: 'Vaciar la nube',
  });
  if (!ok) return;
  try {
    await ctx.sync.wipeCloud();
    notify.success('Datos de la nube borrados');
  } catch (err) {
    notify.error(`No se pudo vaciar: ${err.message}`);
  }
}

function paintCloud(ctx = live) {
  const box = refs.cloud;
  clear(box);

  const config = cloudConfig();
  const own = hasOwnCloudConfig();
  const body = el('div', { class: 'card-body stack-sm' });

  body.appendChild(el('div', { class: 'row-between' }, [
    el('div', { class: 'grow' }, [
      el('div', { class: 't-md t-semibold' }, config.configured ? 'Nube configurada' : 'Sin nube'),
      el('div', { class: 'field-hint' }, config.configured
        ? (own ? 'Usando tu propio proyecto de Supabase.' : 'Usando el servidor por defecto de HORUS.')
        : 'HORUS funciona igual sin nube: todo se queda en este dispositivo.'),
    ]),
    el('span', { class: `badge ${config.configured ? 'badge-success' : ''}`.trim() },
      config.configured ? 'Activa' : 'Local'),
  ]));

  const state = ctx.sync?.status;
  if (state) {
    body.appendChild(el('div', { class: 'row-between' }, [
      el('span', { class: 't-sm' }, 'Estado'),
      el('span', { class: 'badge' }, {
        idle: 'Al día', syncing: 'Sincronizando', offline: 'Sin conexión',
        error: 'Con error', conflict: 'Con conflictos',
      }[state] || state),
    ]));
  }

  const pending = ctx.sync?.pendingCount?.() ?? 0;
  if (pending > 0) {
    body.appendChild(el('div', { class: 'gap-item' }, [
      icon('refresh', 16),
      el('span', { class: 'grow' }, `${pending} cambio(s) pendientes de subir.`),
      el('button', {
        type: 'button', class: 'btn btn-sm btn-primary',
        onclick: () => ctx.runSync({ manual: true }),
      }, 'Subir ahora'),
    ]));
  }

  if (ctx.sync?.lastError) {
    body.appendChild(el('div', { class: 'gap-item is-empty' }, [
      icon('alert', 16),
      el('span', { class: 'grow' }, `Último error: ${ctx.sync.lastError.message}`),
    ]));
  }

  const details = el('details', { style: { marginTop: 'var(--sp-2)' } });
  details.appendChild(el('summary', { class: 't-sm t-dim', style: { cursor: 'pointer' } },
    own ? 'Cambiar o quitar tu proyecto' : 'Usar tu propio proyecto de Supabase'));
  details.appendChild(el('p', { class: 'field-hint', style: { margin: 'var(--sp-2) 0' } },
    'La clave «anon» es pública por diseño: viaja en el navegador, y lo que protege los datos son las políticas de la base de datos. Necesitas haber aplicado antes el archivo SQL de la carpeta «supabase» del proyecto.'));

  details.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'field-label', for: 'cloud-url' }, 'URL del proyecto'),
    el('input', {
      class: 'input', type: 'url', id: 'cloud-url',
      placeholder: DEFAULT_CLOUD.url || 'https://tuproyecto.supabase.co',
      value: own ? config.url : '',
    }),
  ]));
  details.appendChild(el('div', { class: 'field' }, [
    el('label', { class: 'field-label', for: 'cloud-key' }, 'Clave anon'),
    el('input', {
      class: 'input', type: 'password', id: 'cloud-key',
      placeholder: 'eyJhbGciOi…', autocomplete: 'off',
      value: own ? config.anonKey : '',
    }),
  ]));
  details.appendChild(el('div', { class: 'row wrap', style: { gap: 'var(--sp-2)' } }, [
    el('button', {
      type: 'button', class: 'btn btn-sm btn-primary',
      onclick: () => {
        const result = setCloudConfig({
          url: byId('cloud-url')?.value || '',
          anonKey: byId('cloud-key')?.value || '',
        });
        if (!result.ok) {
          notify.error(result.error);
          return;
        }
        notify.success('Nube configurada. Recargando…');
        setTimeout(() => window.location.reload(), 900);
      },
    }, 'Guardar y recargar'),
    own
      ? el('button', {
        type: 'button', class: 'btn btn-sm',
        onclick: () => {
          setCloudConfig(null);
          notify.success('Vuelto al servidor por defecto. Recargando…');
          setTimeout(() => window.location.reload(), 900);
        },
      }, 'Volver al servidor por defecto')
      : null,
  ]));

  body.appendChild(details);
  box.appendChild(body);
}

function paintStorage() {
  const stats = storage.storageStats();
  const max = 5 * 1024 * 1024;
  const pct = Math.round((stats.approxBytes / max) * 100);
  refs.storage.textContent = `${formatBytes(stats.approxBytes)} · ${stats.keys} clave(s) · ${stats.backend === 'memory' ? 'almacenamiento temporal' : 'guardado en este dispositivo'}`;
  refs.storageBadge.textContent = `${pct}% del límite`;
  refs.storageBadge.className = `badge ${pct > 80 ? 'badge-danger' : pct > 50 ? 'badge-warning' : ''}`.trim();

  const backups = storage.listBackups();
  refs.backups.textContent = backups.length
    ? `Recuperar una versión anterior (${backups.length})`
    : 'Recuperar una versión anterior (no hay ninguna)';
  refs.backups.disabled = backups.length === 0;
}

function paintAbout(ctx = live) {
  clear(refs.about);
  const rows = [
    ['Aplicación', `${APP.name} ${APP.version}`],
    ['Esquema de datos', `v${ctx.doc.schema}`],
    ['Revisiones locales', String(ctx.doc.rev)],
    ['Última modificación', new Date(ctx.doc.updatedAt).toLocaleString('es-ES', { dateStyle: 'medium', timeStyle: 'short' })],
    ['Turnos en total', String(ctx.doc.entries.length)],
    ['Pasos de deshacer', String(ctx.store.historySize?.() ?? 0)],
    ['Última sincronización', ctx.sync?.lastResult
      ? new Date(ctx.sync.lastResult.at).toLocaleString('es-ES', { dateStyle: 'short', timeStyle: 'short' })
      : 'nunca'],
  ];
  for (const [label, value] of rows) {
    refs.about.appendChild(el('dt', {}, label));
    refs.about.appendChild(el('dd', {}, value));
  }
}

export { render };





















