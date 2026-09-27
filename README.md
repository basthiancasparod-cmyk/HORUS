# HORUS

**El cuadrante de turnos de tu equipo.** Sabe quién trabaja, cuándo y quién
falta. Funciona sin conexión y sin cuenta.

Es una aplicación web instalable (PWA) sin dependencias ni compilación: se sirve
tal cual y funciona en el navegador. Los datos viven primero en el dispositivo y,
si quieres, se sincronizan con Supabase.

---

## Qué resuelve

Un cuadrante de turnos no es un calendario personal. Las preguntas que importan
son otras:

| Pregunta | Dónde se responde |
|---|---|
| ¿Quién trabaja ahora mismo? | **Hoy** → «De guardia ahora», con lo que le queda a cada uno |
| ¿Qué franjas del día se quedan sin nadie? | **Hoy** → «Huecos de cobertura», y el punto de color en cada día del calendario |
| ¿Cómo queda el mes completo, persona por persona? | **Cuadrante** → rejilla equipo × días con totales y fila de cobertura |
| ¿Cuántas horas lleva cada uno, y cuántas de noche? | **Horas** → mes, trimestre o año, con objetivos y desviaciones |
| ¿Quién está por encima de su contrato esta semana? | **Equipo** → avisos y carga de trabajo |
| ¿Puedo enseñárselo al grupo del trabajo? | **Exportar** → texto para pegar, CSV para Excel, `.ics` para el calendario del móvil |

## Funciones

**Cuadrante**
- Rejilla de equipo × días con el mes completo de un vistazo, columna de nombres
  y de totales fijos al desplazar.
- Fila inferior con la cobertura hora a hora de cada día (verde cubierto, ámbar
  con huecos, rojo sin nadie).
- Asignar un turno tocando la casilla, o arrastrándolo a otro día u otra persona.
- Copiar una semana a otra, rotar el equipo en un clic y aplicar ciclos de
  rotación («2 mañanas, 2 tardes, 2 noches, 2 libres») a un periodo.
- Marcar festivos y eventos por rango de fechas.

**Calendario**
- Vista de mes con una barra por turno y una vista de lista con línea de tiempo
  de 24 h por día, agrupada por semanas ISO.
- Filtros por persona y por tipo de turno, compartidos con el cuadrante y las
  horas.
- Navegación con teclado (flechas, `[` `]`, `Alt+←/→`) y rejilla accesible.

**Avisos**
- Notificación antes de cada turno, con la antelación que elijas.
- Resumen de los turnos del día siguiente a la hora que prefieras.
- Aviso de días sin cubrir.
- **Fiables:** los temporizadores se programan solo para lo inmediato y un
  vigilante recupera los avisos que se perdieron al cerrar la pestaña o suspender
  el móvil, sin repetirlos.

**Datos**
- Todo funciona sin conexión: la aplicación abre y se usa igual sin internet.
- Sin cuenta: los datos se quedan en el dispositivo. Con cuenta: se sincronizan
  entre dispositivos, **entidad por entidad**, no como un bloque.
- Copia de seguridad en JSON, restauración, tres versiones anteriores
  recuperables y exportación a CSV, iCal y texto.
- Importación de un cuadrante desde CSV (con cabeceras flexibles y fechas en
  varios formatos).

**Extras**
- Festivos de las 19 comunidades autónomas, calculados (incluidos los de Semana
  Santa) y editables uno a uno.
- Tema claro, oscuro o automático; modo compacto; atajos de teclado.
- Deshacer y rehacer de verdad, con historial de 60 pasos y acciones agrupadas.
- Instalable en el móvil, con atajos directos a Hoy, Cuadrante y Asignar.

---

## Empezar a usarla

No hay que instalar ni compilar nada, pero **no se puede abrir con doble clic**:
los módulos ES y el service worker necesitan HTTP.

```bash
node tools/serve.mjs        # → http://127.0.0.1:5173
```

Cualquier servidor estático sirve. Para publicarla en GitHub Pages, Netlify,
Vercel o Cloudflare Pages, sube el repositorio tal cual: no hay paso de
construcción.

Al abrirla por primera vez:
1. Si no hay nube configurada, entra directo al asistente de configuración.
2. Escribe tu nombre, añade a tus compañeros (o importa un CSV).
3. Elige tu comunidad autónoma y si quieres avisos.
4. Listo. Ya puedes pintar turnos en el cuadrante.

### Sin cuenta (por defecto)

La aplicación **no pide cuenta para funcionar**. Con la configuración por defecto
hay un servidor de Supabase disponible: en ese caso la primera pantalla ofrece
iniciar sesión, porque puede que ya tengas tu cuadrante en la nube de otro
dispositivo. El botón **«Usar sin cuenta»** entra igualmente y todo se queda en
el dispositivo.

### Con cuenta (opcional)

Crea una cuenta desde la propia pantalla de acceso. A partir de ahí, el cuadrante
se sincroniza entre tus dispositivos. Detalles en
[`supabase/README.md`](supabase/README.md), incluido el SQL que hay que aplicar.

---

## Estructura del proyecto

```
index.html            La aplicación (una sola página, sin plantillas)
manifest.json         Metadatos de la PWA instalable
sw.js                 Service worker: caché y funcionamiento sin conexión
css/
  tokens.css          Sistema de diseño: color, tipografía, espaciado, temas
  base.css            Reset, accesibilidad y primitivas de layout
  components.css      Botones, campos, tarjetas, diálogos, avisos
  app.css             Estructura y vistas del producto
js/
  app.js              Arranque, sesión, asistente, navegación, atajos
  config.js           Credenciales de la nube y nombres de las tablas
  core/               Núcleo puro, sin DOM (probado en Node)
    date.js           Fechas, horas, bloques, semanas ISO
    model.js          Entidades, normalización, migración, consultas
    store.js          Estado reactivo, acciones, deshacer/rehacer
    storage.js        Persistencia local, copias rotativas, migración
    coverage.js       Motor de cobertura, huecos, quién trabaja ahora, horas
    sync.js           Sincronización por tablas y resolución de conflictos
    auth.js           Sesión contra Supabase
    exporter.js       JSON, CSV, iCal y texto
    reminders.js      Avisos de turno
    holidays.js       Festivos de España (fijos y de Semana Santa)
    utils.js          DOM, texto, archivos, CSV
  ui/
    context.js        Contexto compartido, navegación, repintado por frames
    toolkit.js        Piezas de interfaz reutilizables
    dialogs.js        Todos los diálogos (asignar, día, turnos, personas…)
    views/            Una vista por sección: today, calendar, roster, team,
                      hours, settings
supabase/
  migrations/         Esquema SQL, políticas RLS e índices
  README.md           Cómo configurarlo
tests/                Ver «Pruebas»
tools/
  serve.mjs           Servidor de desarrollo
  check.mjs           Comprobador estático del proyecto
  make-icons.mjs      Genera los iconos PNG
docs/
  ARCHITECTURE.md     Decisiones de diseño y qué se arregló respecto a la v1
  VIEW-CONTRACT.md    Contrato para escribir una vista nueva
```

---

## Pruebas

```bash
npm run verify     # comprobación estática + las 5 suites
npm test           # solo las suites
```

| Suite | Qué comprueba | Pruebas |
|---|---|---|
| `tests/run.js` | Núcleo: fechas, modelo, cobertura, store, persistencia, utilidades | 111 |
| `tests/io.js` | Exportación/importación, sincronización (con un Supabase falso) y avisos | 66 |
| `tests/scenario.js` | Un equipo real: 5 personas, rotaciones, noche, festivos y rendimiento | 81 |
| `tests/smoke.mjs` | Las 6 vistas montadas sobre el `index.html` real, con clics y diálogos | 65 |
| `tests/app.mjs` | Arranque real: asistente, uso, recarga, migración, exportación | 21 |
| `tools/check.mjs` | Enlazado de módulos, ids del HTML, clases CSS, precache, manifiesto | — |

El núcleo es puro y se ejecuta en Node sin navegador. Las vistas se prueban con
un DOM mínimo escrito para la ocasión (`tests/dom.mjs`), que implementa lo que
HORUS usa de verdad, incluido el comportamiento real de `<select>`, `<dialog>` y
`DocumentFragment`.

---

## Requisitos y compatibilidad

- **Node 18+** solo para el servidor de desarrollo y las pruebas. La aplicación
  en sí no necesita Node.
- Navegadores con módulos ES: Chrome/Edge 90+, Firefox 90+, Safari 15+.
- Para notificaciones, el navegador debe permitirlas; en iOS requieren tener la
  app instalada en la pantalla de inicio.

## Licencia

MIT.

