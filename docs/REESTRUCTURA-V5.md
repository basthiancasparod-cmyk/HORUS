# HORUS v5 — reestructura y sincronización de equipo

Esta versión no cambia el modelo de datos ni el SQL. Cambia **el orden en que se
sincroniza**, **cómo se entra en un equipo** y **cómo se presenta la aplicación**
para que se pueda usar como producto y no como un panel de ajustes.

---

## 1. El problema que se arregla

### 1.1. La PC pisaba lo del móvil

El ciclo antiguo era `push → pull`. Una PC que llevaba días sin abrir la app
tenía un cuadrante viejo; al sincronizar, subía primero ese cuadrante y
sobrescribía en el servidor lo que el móvil había escrito después. El pull
posterior ya no podía recuperar nada.

Ahora el ciclo es `pull → push`:

1. Baja lo cambiado desde la última marca de agua.
2. Fusiona fila a fila (gana la marca más reciente).
3. Sube solo lo que sigue pendiente.

Los borrados locales se convierten en lápidas **antes** del pull, para que una
fila que aún vive en el servidor no resucite. El primer sync de un dispositivo
hace un pull extra para fijar la marca de agua con la hora **del servidor**.

### 1.2. La PC no sabía que pertenecía a un equipo

`teamId` se guardaba dentro del documento local. Una PC nueva se quedaba en el
ámbito personal y no veía el cuadrante del equipo, aunque la cuenta estuviera
dentro.

Ahora, al arrancar con sesión, `adoptTeamWorkspace()` consulta
`horus_team_members` y entra en el último equipo usado (o en el único que haya).
El primer cambio de ámbito usa `pull({ replace: true })`: el cuadrante personal
de esa PC no se sube al equipo. Antes de reemplazarlo se guarda en las copias
rotativas. Si el equipo está vacío, se conserva el cuadrante local y se sube.

La preferencia `horus.team.auto = '0'` respeta a quien elige «volver a modo
personal»: no se le vuelve a meter en el equipo en cada arranque.

### 1.3. Los cambios de otros no aparecían sin recargar

Ahora hay un ciclo cada 30 s (solo con la pestaña visible), al volver a la
pestaña, al recuperar el foco y al volver la conexión. Es incremental: no vuelve
a bajar el cuadrante entero.

---

## 2. La interfaz

### Navegación

| Antes | Ahora |
|---|---|
| Inicio, Calendario, Cuadrante, Turnos, Equipo, Horas, Ajustes | **Inicio, Cuadrante, Equipo, Ajustes** |
| — | Calendario, Horas y Turnos en **Ajustes → General → Herramientas** y en el «Más» del móvil |

Las rutas y las vistas siguen existiendo (`calendar`, `hours`, `shifts`), así que
los atajos de teclado y los enlaces antiguos no se rompen.

### Ajustes

| Pestaña | Qué contiene |
|---|---|
| **General** | Apariencia, avisos, herramientas |
| **Equipo y cuenta** | Cuenta, equipo, código de invitación, miembros y roles |
| **Avanzado** | Nombre del cuadrante, semana, demanda, horas, festivos, Supabase propio, importar con IA, copias, datos y zona delicada |

Las opciones que parecían hechas para un solo cliente (clave de IA, URL de
Supabase, vaciar la nube, borrar todo) ya no están en el camino del usuario:
siguen disponibles, pero dentro de Avanzado.

### Cabecera

Un indicador muestra `Personal` o el nombre del equipo. Al pulsarlo se abre
Ajustes → Equipo y cuenta. El color del punto distingue los dos ámbitos.

---

## 3. Archivos tocados

- `js/core/sync.js` — orden pull → push, lápidas antes del pull, `replace`,
  `updated_at` del servidor, pull extra de la primera sincronización.
- `js/app.js` — adopción automática del equipo, refresco periódico, indicador de
  espacio de trabajo, pestañas de Ajustes, navegación simplificada.
- `js/ui/views/settings.js` — pestañas, pasos de ámbito que guardan el equipo
  usado y lanzan la sincronización.
- `js/ui/context.js` — «Hoy» pasa a llamarse «Inicio».
- `js/core/teams.js` — se quitan los `console.log` de depuración de `insertar`.
- `index.html`, `css/app.css` — navegación, indicador, pestañas y paneles.
- `sw.js`, `js/config.js`, `package.json` — versión 5.0.0 y caché nueva.

No hay migración SQL nueva. La 0002 ya crea `owner_key`, las políticas por rol y
el trigger que rellena el ámbito.

---

## 4. Comprobación manual recomendada

1. En el móvil, inicia sesión y crea un equipo. Añade un turno.
2. En la PC, inicia sesión con la misma cuenta. Debe entrar sola en el equipo y
   mostrar el turno. La cabecera debe decir el nombre del equipo.
3. Edita un turno en la PC. En el móvil, sin recargar, espera ≤ 30 s o cambia de
   pestaña: el cambio debe aparecer.
4. En la PC, elige Ajustes → Equipo y cuenta → «Volver a modo personal». Recarga:
   debe seguir en personal.
5. Vuelve al equipo desde la tarjeta del equipo. Debe cargar el cuadrante del
   equipo, no el personal.

Las suites `tests/io.js`, `tests/smoke.mjs` y `tests/app.mjs` cubren el orden de
sincronización, la navegación y el arranque.
