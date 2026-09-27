# Contrato de integración — vistas de HORUS

Documento de referencia para quien escriba una vista (`js/ui/views/*.js`).
Es vinculante: `js/app.js` y `js/ui/context.js` esperan exactamente esto.

---

## 1. Forma de un módulo de vista

```js
// js/ui/views/<nombre>.js
import { byId, el, clear, icon, $$ } from '../../core/utils.js';
import { getContext, registerRenderer } from '../context.js';
import { emptyState, barRow, avatar, toast, notify, openDialog } from '../toolkit.js';
import * as dialogs from '../dialogs.js';

export const VIEW = 'nombre';            // debe coincidir con context.VIEWS

export function mount(ctx) {
  // 1) Obtener referencias del DOM UNA sola vez (no en cada render).
  // 2) Cablear listeners UNA sola vez.
  // 3) Registrar el pintado:
  registerRenderer(VIEW, render);
  render();
}
```

Reglas:

- **`mount(ctx)` se llama una sola vez.** Dentro, guardar referencias y cablear
  eventos es correcto; **no** volver a cablear en `render`, o los handlers se
  duplicarán en cada repintado.
- **`render()` no recibe argumentos** y debe leer el estado actual con
  `getContext()`. Se llama cada vez que el store cambia y la vista está visible.
- Los elementos DOM creados en cada `render` se descartan: usar `clear(box)` y
  volver a construir. Para los elementos estáticos del HTML, reutilizarlos.
- Nada de `innerHTML` con datos del usuario. Usar `el()`/`textContent`, o `esc()`
  si hay que construir cadenas HTML.
- Todo el texto visible y los comentarios, en **español**.

## 2. El contexto

`getContext()` devuelve:

```js
{
  store,          // { doc, subscribe, actions, apply, batch, undo, redo, canUndo, ... }
  doc,            // ¡solo lectura! Es store.doc en el momento de la llamada.
  actions,        // store.actions
  undo(), redo(), canUndo(), canRedo(),
  batch(label, fn),                       // agrupa varias acciones en un solo "deshacer"
  sync,           // motor de sincronización (getState, subscribe, sync, conflicts…)
  scheduler,      // avisos: { start, stop, inspect, onDuty, nextFor, testNotification }
  auth,           // { isSignedIn, currentUser, signOut, ... }
  navigate(view), // cambia de vista
  openAssign(preset), openDay(date), openType(id), openMember(id), openExport(opts)
}
```

**Importante:** `ctx.doc` es una referencia viva del store. Leerlo dentro de
`render()` siempre, no capturarlo fuera.

## 3. Estado compartido de interfaz

```js
import {
  getCurrentView, getFocusDate, setFocusDate, onFocusDateChange,
  getFilters, setFilter, clearFilters, onFiltersChange,
  invalidate, registerRenderer,
} from '../context.js';
```

- `getFocusDate()` devuelve `"YYYY-MM-DD"` o `null`. Es la fecha "activa" que
  comparten Calendario, Cuadrante y Horas. Si es `null`, usar `todayKey()`.
- `invalidate(view)` marca una vista para repintar en el siguiente frame. Úsalo
  tras cambiar filtros, no llames a `render()` a mano desde otra vista.
- El repintado solo se ejecuta para la vista visible.

## 4. Acciones del store que se usan en las vistas

```js
actions.setEntry({ memberId, date, typeId, blocks?, notes?, demandOverride?, approved? })
actions.setEntryMany({ memberIds, date, typeId })
actions.setEntryRange({ memberId, from, to, typeId, weekdays, blocks?, skipExisting? })
actions.removeEntries({ memberId, date? , from?, to? })
actions.removeEntriesInRange({ memberIds?, from, to })
actions.moveEntry(id, newDate, newMemberId?)
actions.copyRange({ from, to, targetFrom, memberIds?, mode? })
actions.copyDayToMembers({ date, fromMemberId, toMemberIds })
actions.rotateTeam({ memberIds, from, to, direction })
actions.applyPattern({ patternId, memberId, from, to })
actions.toggleApproved(id)
actions.updateEntry(id, patch)
actions.setDayMeta(date, patch)                 // { dayType, label, demandOverride, notes }
actions.setDayMetaRange({ from, to, dayType, label })
actions.toggleHoliday(date)
actions.addMember(patch) / updateMember(id, patch) / removeMember(id, { reassignTo })
actions.setActiveMember(id)
actions.addShiftType(patch) / updateShiftType(id, patch) / removeShiftType(id)
actions.reorderShiftTypes(ids) / reorderMembers(ids)
actions.addPattern(patch) / updatePattern(id, patch) / removePattern(id)
actions.updateSettings(patch)                   // fusión en profundidad
actions.renameDocument(name)
actions.importDocument(doc, { merge }) / clearSchedule() / reset()
```

Todas devuelven `true`/`false` según si cambiaron algo. Ninguna lanza.

## 5. Análisis (motor de cobertura)

```js
import {
  analyzeDate, analyzeRange, analyzeMonth, whoIsNow, nextShift, upcomingShifts,
  summarize, summarizeMonth, weeklyBreakdown, findConflicts, findOverstaffed,
  coverageRate, effectiveDemand, MIN_PER_DAY,
} from '../../core/coverage.js';
```

- `analyzeDate(doc, 'YYYY-MM-DD')` →
  `{ date, projections, intervals, working, off, coverageMin, gapMin, gaps,
     peak, headsOnShift, workMinutes, dayMeta, isHoliday, demand, status }`
  - `status`: `'covered' | 'gaps' | 'empty'`.
  - `projections[]`: `{ start, end, entry, type, member, isWork, demand,
    continuedFromPrevDay, continuesNextDay, zeroLength }` con `start`/`end` en
    minutos de ese día (0–1440).
  - `intervals[]`: `{ start, end, count, required, entries, members, status }`
    donde `status` es `'ok' | 'under' | 'over' | 'none'`.
  - **Ojo:** los turnos nocturnos se reparten entre los dos días, así que
    `coverageMin` de un día incluye la madrugada que viene de ayer.
- `summarize(doc, { from, to, memberId })` →
  `{ totalMinutes, totalNightMinutes, shifts, workDays, overnight,
     weekendMinutes, holidayMinutes, perMember, perType, averageMinutesPerMember }`
  - `perMember[]`: `{ memberId, member, minutes, nightMinutes, shifts, workDays,
    overnight, weekendMinutes, types }`.
- `weeklyBreakdown(doc, { from, to, memberId })` →
  `[{ weekStart, week, minutes, shifts, days }]`.
- `findConflicts(doc, { from, to })` → `[{ date, member, entries, detail }]`.

## 6. Fechas y formato

```js
import {
  todayKey, toKey, fromKey, dateKey, addDays, addMonths, daysInMonth, monthDays,
  monthGrid, weekDays, startOfWeek, isoWeek, monthKeyOf,
  formatLongDate, formatShortDate, formatMonth, formatDuration, formatHours,
  formatBlocks, formatClock, formatRelative, humanTime, minToTime, timeToMin,
  blockMinutes, normalizeBlocks, DOW_SHORT, DOW_FULL, MONTHS, MONTHS_SHORT, stamp,
} from '../../core/date.js';
```

## 7. Utilidades de interfaz disponibles

De `../toolkit.js`:

```js
toast(msg, { type, duration, action: { label, onClick } })
notify.info|success|error|warning(msg, opts)
confirmAction({ title, message, confirmLabel, danger, extra })  // → Promise<boolean>
openDialog(dialog, { focus })   closeDialog(dialog)
emptyState({ iconName, title, message, action: { label, onClick } })
barRow({ label, value, max, color, valueText, sub, onClick })
progressBar(value, max, { className, label })
avatar(member, { size: 'xs'|'sm'|'md'|'lg', ring })
avatarStack(members, { max, size })
typeBadge(type, { showLabel, overnight })
switchControl(id, checked, onChange, { label, large })   // devuelve un nodo NUEVO
colorPicker(palette, current, onPick)
fillSelect(select, [{ value, label, disabled }], { selected })
readNumber(input, { min, max, fallback })
```

De `../dialogs.js`:

```js
openAssignDialog(ctx, { date, memberIds, typeId, rangeMode })
openDayEditor(ctx, date)
openTypeEditor(ctx, typeId | null, { onSaved })
openMemberEditor(ctx, memberId | null, { onSaved })
openPatternDialog(ctx, { memberId, mode: 'pattern' | 'rotate' })
openExportDialog(ctx, { from, to, presetMemberIds })
renderTimeline(analysis, { height, showHourMarks })   // barra de 24 h
renderCoverageStrip(analysis)                          // barra verde/ámbar/rojo
coverageSummary(analysis)                              // texto resumido
minLabel(minutes)                                      // 510 → "08:30"
entrySummary(doc, entry)
fillRegionSelect(select, selected)                     // comunidades autónomas
```

`switchControl` **crea un nodo nuevo**: hay que reemplazar el existente con
`byId(id).replaceWith(switchControl(...))` y guardar la referencia devuelta para
poder leer `getAttribute('aria-checked')`.

## 8. Clases CSS ya definidas (no inventar otras)

Estructura: `#app`, `.topbar`, `.nav`, `.main`, `.view`, `.view.is-active`,
`.view-header`, `.section`, `.section-label`, `.grid-2`, `.grid-3`, `.row`,
`.row-between`, `.col`, `.stack`, `.stack-sm`, `.grow`, `.text-right`.

Componentes: `.card`, `.card-flush`, `.card-header`, `.card-body`,
`.card-interactive`, `.stat`, `.stat-value`, `.stat-label`, `.stat-sub`,
`.badge`, `.badge-accent|success|warning|danger|info|solid`, `.chip`,
`.chip-row`, `.chip-scroll`, `.avatar`, `.avatar-sm|xs|lg`, `.avatar-stack`,
`.tabs`, `.tabs button[aria-selected]`, `.settings-group`, `.setting-row`,
`.list`, `.list-item`, `.empty-state`, `.bars`, `.bar-row`, `.bar-track`,
`.bar-fill`, `.bar-value`, `.table-wrap`, `table.data`, `.progress`, `.switch`,
`.segmented`, `.input`, `.select`, `.textarea`, `.field`, `.field-label`,
`.field-hint`, `.btn`, `.btn-primary|danger|ghost|outline|sm|lg|block`,
`.icon-btn`, `.fab`, `.toast`, `.status-bar`, `.status-dot`, `.about-lines`.

Específicas del producto (ya escritas en `css/app.css`, usarlas tal cual):
`.now-card` (`.now-time`, `.now-date`, `.now-zone`), `.onduty-list`,
`.onduty-item` (`.who`, `.what`, `.left`), `.next-card` (`.countdown`),
`.gap-list`, `.gap-item`, `.gap-item.is-empty`, `.month-nav`, `.month-title`,
`.dow-header`, `.month-grid`, `.month-cell` (`.cell-head`, `.cell-day`,
`.cell-week`, `.cell-bars`, `.cell-bar`, `.cell-more`, `.cell-coverage`),
`.timeline-axis`, `.day-row` (`.day-meta`, `.day-num`, `.day-dow`, `.day-track`,
`.day-flags`), `.roster-wrap`, `table.roster`, `.shift-cell`, `.shift-pill`,
`.col-name`, `.col-total`, `.coverage-strip`, `.member-card`, `.type-card`,
`.schedule-preview`, `.now-card`, `.settings-group`.

Variables CSS disponibles: `--bg --bg-elevated --surface --surface-2 --surface-3
--border --border-strong --border-subtle --text --text-dim --text-muted
--accent --accent-soft --success --success-soft --warning --warning-soft
--danger --danger-soft --info --info-soft --radius` y la escala de espaciado
`--sp-1 … --sp-12`, radios `--r-xs … --r-xl`, tipografía `--fs-2xs … --fs-4xl`,
`--font-display --font-sans --font-mono`.

Para colorear algo según un tipo de turno o una persona, fijar en el estilo
`--type-color` / `--chip-color` y `--type-fg` (texto legible) con
`readableOn(hex)` de `utils.js`.

## 9. Iconos

`icon(name, size)` de `utils.js` devuelve un `<svg>`. Nombres disponibles
(usar solo estos):
`calendar clock users layers chart settings plus minus close check trash edit
copy download upload refresh sun moon logout alert bell search chevronLeft
chevronRight chevronDown grid list printer repeat undo filter star briefcase
arrowRight info`.

## 10. Prohibiciones

- No importar `js/app.js` (ciclo). Usar `getContext()`.
- No usar `alert()`, `confirm()` ni `prompt()`: usar `notify`/`confirmAction`.
- No mutar `ctx.doc` a mano: siempre por `actions`.
- No añadir `<style>` ni CSS en línea más allá de variables y posiciones
  porcentuales.
- No usar `innerHTML` con datos que vengan del usuario o del documento.
