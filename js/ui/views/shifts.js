/**
 * HORUS — js/ui/views/shifts.js
 * Vista TURNOS: el catálogo de tipos de turno (código, nombre, horario, color,
 * demanda, si cuenta horas y si está archivado) con crear, modificar, archivar
 * y eliminar.
 *
 * Por qué es una vista de la navegación y no una sección de Ajustes: el
 * catálogo no es un ajuste que se toca una vez y se olvida. Se consulta a
 * diario («¿a qué hora entra la tarde?») y se mantiene. Y por qué no vive en el
 * Cuadrante: el Cuadrante es quién trabaja cuándo; poder abrir ahí el editor de
 * un turno hacía fácil cambiar el horario de TODO el equipo creyendo que se
 * cambiaba un día.
 *
 * Reparto de responsabilidades (ver docs/VIEW-CONTRACT.md):
 *  - Esta vista es la cáscara: identidad (`VIEW`), registro del pintado y el
 *    contenido declarado en index.html.
 *  - El catálogo —la lista y las acciones— lo gobierna `js/ui/shift-catalog.js`,
 *    que es también lo que usa el Cuadrante para traer al usuario aquí y señalar
 *    un turno. Un solo dueño del catálogo, aunque lo llamen dos sitios.
 */

import { registerRenderer } from '../context.js';
import * as shiftCatalog from '../shift-catalog.js';

/** Identificador de la vista; debe coincidir con `context.VIEWS`. */
export const VIEW = 'shifts';

/**
 * Monta la vista: el catálogo se cablea UNA sola vez y se registra el pintado.
 * @param {object} ctx contexto de la aplicación
 */
export function mount(ctx) {
  void ctx;
  shiftCatalog.mount(ctx);
  registerRenderer(VIEW, render);
  render();
}

/** Repinta el catálogo. No recibe argumentos: el estado se lee del contexto. */
export function render() {
  shiftCatalog.render();
}

/**
 * Deja la vista del catálogo a la vista con un turno señalado.
 *
 * Lo llama el Cuadrante (que antes abría aquí el editor de un turno) y también
 * `ctx.openType()`. La navegación la hace quien llama; esto solo pinta y
 * señala.
 *
 * Se reexporta desde aquí para que quien venga de la rejilla no tenga que
 * conocer los dos módulos: la vista es la puerta, el catálogo es la lógica.
 */
export function focusShift(typeId = null) {
  shiftCatalog.focusShiftCatalog(typeId);
}
