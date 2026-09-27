# Arquitectura de HORUS

Este documento explica **por qué** la aplicación está construida así, y qué se
arregló respecto a la versión anterior. Si vas a tocar el código, empieza por
aquí y sigue por [`VIEW-CONTRACT.md`](VIEW-CONTRACT.md).

---

## 1. Principios

1. **Local primero.** La aplicación funciona entera sin red y sin cuenta. La nube
   es una mejora opcional, nunca un requisito para abrir un turno.
2. **El núcleo no toca el DOM.** Todo `js/core/` es lógica pura y se ejecuta en
   Node. Eso permite probarlo a fondo sin navegador, que es donde aparecen los
   errores de verdad (cobertura, horas, zonas horarias).
3. **Los datos se normalizan en la frontera.** Nada entra en el estado sin pasar
   por `normalizeDocument()`. Ante datos corruptos, la aplicación degrada; no
   revienta.
4. **El usuario manda sobre sus datos.** Deshacer real, copias de seguridad,
   exportación en cuatro formatos y posibilidad de borrarlo todo.
5. **Español en todo lo que se ve y se lee.** Código, comentarios y textos.

---

## 2. Capas

```
          ┌──────────────────────────────────────────────┐
          │  Vistas (js/ui/views/*)                      │  pintan y capturan gestos
          │  today · calendar · roster · team · hours    │
          └───────────────┬──────────────────────────────┘
                          │ acciones, nunca mutaciones
          ┌───────────────▼──────────────────────────────┐
          │  Store reactivo (core/store.js)              │  estado único + historial
          │  apply() · batch() · undo/redo · subscribe() │
          └───────────────┬──────────────────────────────┘
                          │ documento normalizado
   ┌──────────────────────┼──────────────────────┬─────────────────┐
   │                      │                      │                 │
┌──▼──────────┐  ┌────────▼────────┐  ┌──────────▼───────┐  ┌──────▼──────┐
│ core/model  │  │ core/coverage   │  │ core/storage     │  │ core/sync   │
│ entidades   │  │ análisis        │  │ persistencia     │  │ nube        │
└─────────────┘  └─────────────────┘  └──────────────────┘  └──────┬──────┘
                                                                   │
                                                        ┌──────────▼───────┐
                                                        │ core/auth (GoTrue)│
                                                        └───────────────────┘
```

**La regla que sostiene todo:** las vistas nunca modifican el documento. Llaman a
`store.actions.*`, que aplican un cambio, suben la revisión, guardan historial y
notifican. El repintado es una consecuencia, no una decisión de la vista.

---

## 3. El modelo de datos

El documento es un único objeto serializable con cinco colecciones. La decisión
clave es que **`entries` es plano**, no anidado por persona:

```js
{
  schema: 4,
  members:    [{ id, name, initials, hex, role, active, weeklyHours, ... }],
  shiftTypes: [{ id, code, label, hex, kind, blocks, demand, ... }],
  entries:    [{ id, memberId, date, typeId, blocks, dayType, notes, ... }],
  patterns:   [{ id, name, cycle, stepDays, startDate }],
  dayMeta:    { 'YYYY-MM-DD': { dayType, label, demandOverride, notes, imported } },
  settings:   { theme, weekStartsOn, notifications, hours, coverage, ... },
}
```

¿Por qué plano? Porque la pregunta más frecuente es «¿quién trabaja el 12 de
junio?» y con `entries` plano eso es un filtro por fecha, no un recorrido de
todos los miembros. Anidar por persona obligaría a recorrer el equipo entero para
pintar un solo día del cuadrante.

Un turno partido (mañana y tarde) es **una** entrada con **varios** bloques. Un
turno puntual puede llevar sus propios bloques (`blocks`), y si son `null` hereda
los del catálogo. Así, cambiar el horario del turno de mañana actualiza de golpe
todo el cuadrante que lo use, salvo los días que alguien haya ajustado a mano.

### Los turnos que cruzan medianoche

`{ start: '22:00', end: '06:00' }` significa que el fin es **anterior** al
inicio, y por tanto el turno termina al día siguiente. Es una decisión del
formato, no un caso especial del código: `blockMinutes()` devuelve 480 minutos y
`blockSpans()` proyecta el turno de 1320 a 1800 minutos sobre la línea del tiempo
del día en que empieza.

Consecuencia importante: **la cobertura de un día incluye la madrugada que viene
de ayer**. `projectEntryOntoDate()` recorta cada turno al día que se está
analizando, y el día 4 recoge de 00:00 a 06:00 el turno que empezó el día 3.
Esto es lo correcto para responder «¿hay alguien a las 3 de la mañana?», y está
documentado en el código porque es la fuente de confusión número uno.

### Marca de tiempo por entidad

Cada entidad lleva `updatedAt`. Es lo que permite sincronizar sin bloques: dos
personas editando días distintos no se pisan nunca, y si editan el mismo, gana la
marca más reciente. Un `updatedAt` que falte es un error grave: sin él no hay
forma de decidir quién gana, y el motor acabaría reenviando todo en cada ciclo.

---

## 4. El store reactivo

```js
store.actions.setEntry({ memberId, date, typeId })
  ↓
apply(recipe, { label, group })
  → pushHistory(doc)          ← copia para deshacer
  → recipe(copia)             ← la mutación, aislada
  → normalizeDocument(copia)  ← frontera: nada entra sin normalizar
  → ¿cambió de verdad?        ← si no, se descarta y no ensucia el historial
  → doc = nuevo
  → notify()                  ← las vistas se repintan
```

Tres detalles que costaron sangre y conviene no romper:

**a) El documento se reemplaza, no se muta.** Por eso las vistas y los diálogos
**nunca** deben guardar `const { doc } = ctx` en una variable de módulo: en
cuanto se hace un cambio, esa referencia apunta al documento viejo. Hay que leer
siempre `ctx.doc` (que es un getter) o recibir un contexto vivo. Este error
provocó fallos difíciles de ver, como que un botón de festivo no se desmarcara al
segundo clic.

**b) Los lotes mutan en el sitio y se normalizan una vez al final.** Dentro de
`batch()` no se clona el documento por cada acción; se guarda **una copia** al
empezar y se normaliza al acabar. Sin esto, pintar un año de turnos (1825
entradas) tardaba 23 segundos en lugar de 170 milisegundos, porque cada acción
clonaba y normalizaba el documento entero.

> Esa copia del lote tiene que ser una copia de verdad, no una referencia. Si se
> guarda la referencia, las mutaciones en el sitio la modifican también y
> «deshacer» deja de restaurar nada.

**c) La agrupación de historial no se aplica fuera de un lote.** Dos cambios
seguidos sobre el mismo hueco (asignar mañana y luego tarde) son dos pasos de
deshacer independientes desde el punto de vista del usuario. Dentro de un lote
sí se agrupan, para que deshacer un relleno de un mes sea una sola operación.

---

## 5. El motor de cobertura

Es lo que convierte un calendario en un cuadrante. Para cada día produce:

- `projections`: qué turnos tocan ese día, recortados a sus 24 horas.
- `intervals`: tramos con el mismo nivel de cobertura, con `count` (cuántos hay) y
  `required` (cuántos hacen falta). El estado de cada tramo es `ok`, `under`,
  `over` o `none`.
- `gaps`: las franjas del día sin nadie.

La demanda (`required`) se resuelve por prioridad: la entrada concreta → el tipo
de turno → el día → el valor por defecto de los ajustes.

**Los huecos se perdonan solo si el día tiene la demanda fijada a 0.** Un festivo
normal sigue mostrando sus huecos, porque puede que ese día sí haga falta
servicio; lo que expresa «este día no hace falta nadie» es la demanda 0, no la
etiqueta de festivo. Confundir las dos cosas haría que un festivo con servicio
mínimo pareciera cubierto sin estarlo.

Las funciones están separadas a propósito:
- `whoIsNow()` responde «¿quién está de guardia?».
- `nextShift()` responde «¿cuál es el próximo turno?» e **ignora** los turnos en
  curso y las ausencias.
- `summarize()` cuenta horas: cada turno se atribuye entero al día en que
  empieza, así que la suma de horas nunca duplica la madrugada.
- `analyzeDate()` reparte la cobertura entre los dos días, que es lo correcto para
  responder por franjas.

Dos preguntas distintas, dos criterios distintos. Está documentado en el código
para que nadie los unifique por parecer redundantes.

---

## 6. Persistencia

`localStorage` con tres mecanismos de seguridad:

1. **Guardado con retardo** (350 ms) para no escribir en cada tecla.
2. **Escritura inmediata** en los puntos críticos: al cerrar la pestaña, al
   terminar el asistente de configuración y al pasar la app a segundo plano.
3. **Tres copias rotativas.** Antes de cada escritura se desplazan las copias, así
   que se puede recuperar una versión anterior desde Ajustes aunque el documento
   actual esté corrupto.

Si `localStorage` no está disponible (modo privado de algunos navegadores), hay un
respaldo en memoria y la aplicación avisa de que los datos no sobrevivirán al
cierre. Si se llena la cuota, se liberan primero las copias de seguridad y se
reintenta.

La sesión de Supabase se guarda aparte, y las preferencias de interfaz (última
vista, filtros, tema) también: no se sincronizan porque son de cada dispositivo.

---

## 7. Sincronización

La versión anterior guardaba **todo el estado en una sola fila** con «gana el
último que escribe». Con un cuadrante compartido eso pierde trabajo: si tú y un
compañero tocáis días distintos a la vez, uno de los dos cambios desaparece sin
avisar.

La versión actual sincroniza **entidad por entidad**:

1. El motor guarda aparte un estado de sincronización con, por tabla, el conjunto
   de identificadores conocidos y una huella por fila.
2. Comparar la huella actual con la guardada dice exactamente qué filas son
   nuevas, modificadas o borradas. Nada de esto vive dentro del documento.
3. Sube solo lo que cambió, en lotes de 400 filas, respetando el orden de
   dependencias (primero tipos y personas, después entradas).
4. Baja lo que haya cambiado desde la última marca de agua, y fusiona **fila a
   fila**: gana la marca `updatedAt` más reciente.

### Decisiones que evitan errores concretos

- **La marca de agua del pull es la hora del servidor, no la del cliente.** Si se
  usara la hora local y el reloj del móvil fuera adelantado, los cambios remotos
  con marca intermedia se perderían para siempre. Además se filtra por
  `client_updated_at`, que es exactamente el valor que decide quién gana, en lugar
  de por `updated_at` del servidor.
- **La huella se calcula sobre la entidad normalizada.** Si el push huella el
  borrador y el pull huella el resultado de `normalizeDocument()` (con las
  iniciales ya calculadas), las dos huellas nunca coinciden y el motor reenvía el
  documento entero en cada ciclo. Hay una única función
  `entityFingerprint()` usada por los dos lados.
- **Las lápidas mandan.** Si borro algo y la fila sigue viva en el servidor, la
  lápida local impide que resucite en mi dispositivo mientras se propaga el
  borrado.
- **No se mezclan campos de dos versiones.** Cuando hay conflicto gana la versión
  remota **entera**; un híbrido con la marca del servidor y el contenido local
  sería una mentira que corrompería la siguiente subida. La versión perdedora se
  guarda en el registro de conflictos y se le enseña al usuario.
- **Un conflicto no es un cambio remoto cualquiera.** Solo se marca conflicto si
  *ambas* partes modificaron la misma fila desde la última sincronización. Si mi
  copia sigue igual que cuando la subí, el servidor simplemente va por delante.

La descripción de las tablas, las políticas RLS y el SQL están en
[`../supabase/`](../supabase/).

---

## 8. Avisos

El problema de los avisos en el navegador es que no se puede confiar en un
temporizador que dure horas: se pierde al recargar, al cerrar la pestaña o cuando
el sistema suspende el móvil. La solución tiene tres piezas:

1. **Temporizadores solo para lo inmediato** (próximas 6 horas, máximo 40).
2. **Un vigilante cada 30 segundos** que comprueba si alguna alarma debería haber
   sonado en los últimos 10 minutos y no consta como entregada. Se ejecuta además
   al volver a la pestaña, al recuperar conexión y al despertar la app.
3. **Un registro de avisos entregados** en el dispositivo, para no repetir ni
   perder avisos. Se conserva entero (con tope), porque recortarlo por fecha
   borraba justo las entradas que había que recordar.

Los avisos se entregan preferentemente a través del service worker, que respeta
el icono de la app instalada, con la notificación de la página como respaldo.

---

## 9. Importar el cuadrante desde el PDF de la empresa

En muchos sitios el cuadrante llega como un PDF que reparte la empresa, hecho con
«Imprimir a PDF». Ese PDF **es texto real**, aunque no se pueda copiar bien a
mano, así que se puede leer con exactitud en lugar de adivinar con OCR o con un
modelo de lenguaje.

La cadena es:

```
PDF (bytes)
  → js/core/pdf-text.js       interpreta el flujo de contenido y devuelve
                              fragmentos de texto CON SU POSICIÓN en la página
  → js/core/schedule-import.js  reconoce la rejilla: personas × días, mes, códigos
  → js/ui/import-review.js    pantalla de revisión: nada se guarda sin que lo veas
  → store.actions.setEntry    volcado al cuadrante en UN solo paso de deshacer
```

Tres decisiones que sostienen esto:

1. **Las posiciones hay que calcularlas, no leerlas.** El extractor mantiene la
   pila de estados gráficos (`q`/`Q`), la matriz de transformación (`cm`) y las
   matrices de texto (`Tm`/`Td`/`TD`/`T*`), y aplica la CTM a cada fragmento. Y,
   sobre todo, **no supone cuánto avanza cada letra**: lee los anchos reales del
   array `/W` de cada fuente. Suponer 0,5 em por carácter fue un error caro: en
   este cuadrante la `M` mide 0,854 em, la `I` 0,251 y los dígitos 0,506, así que
   el desfase se acumulaba a lo largo de cada fila y las columnas de la derecha
   acababan casi una casilla corridas. Como cada fila tiene letras distintas, el
   error era **distinto en cada fila**, y por eso la rejilla podía parecer
   correcta y estar mal por una persona.
2. **La señal autoritativa es el número de día impreso.** Se reconstruye la
   tirada de dígitos (28, 29, 30, 1, 2… 30) y se comprueba cada columna contra el
   calendario real. Las letras `L M X J V S D` de la cabecera son una señal
   **secundaria**: sirven de contraste, pero si discrepan manda el número. Que el
   número no cuadre y que la columna no traiga número son cosas distintas, y se
   cuentan por separado: lo segundo es «no verificable», no «mal».
3. **El mes no se adivina: se comprueba.** Se lee la cabecera (`OCTUBRE 26`), pero
   manda la comprobación por día: para cada día que aparece en la hoja, el día de
   la semana de la fecha candidata tiene que coincidir. Si cuadra todo, confianza
   alta; si no, se ofrecen candidatos y decide el usuario. Un cuadrante con las
   fechas corridas es peor que no importar nada. Y aquí hay un detalle que
   engaña: la comprobación por día de la semana es **periódica módulo 7**, así que
   varios meses «cuadran»; desempata la cabecera de texto.
4. **La revisión no es opcional.** El lector marca cada casilla con su confianza.
   Lo dudoso se enseña en ámbar, lo desconocido en rojo, y los códigos que no
   reconoce se agrupan para que el usuario diga qué turno son. El parser **nunca**
   inventa un turno, **nunca** cambia el catálogo por su cuenta y **nunca**
   descarta una casilla en silencio. Y si el PDF es un escaneo o el formato no se
   reconoce, lo dice y ofrece pegar el texto o usar el CSV, en lugar de producir
   una rejilla vacía que parezca correcta.

Y una nota sobre las pruebas, porque es lo que evitó que esto se quedara mal para
siempre: **no basta con que el lector no explote**. `tests/import.mjs` compara
personas concretas casilla a casilla contra la verdad de referencia medida sobre
el PDF. Sin eso, un desfase de un día pasa desapercibido durante semanas — pasó.

El formato concreto del cuadrante analizado, con las coordenadas medidas, está en
[`PDF-FORMAT.md`](PDF-FORMAT.md).

---

## 10. Interfaz

- **`context.js`** centraliza navegación, fecha en foco, filtros y repintado. El
  repintado se agenda por frame y **solo se ejecuta para la vista visible**:
  cambiar un turno no vuelve a pintar las seis secciones.
- **`toolkit.js`** contiene las piezas reutilizables: avisos flotantes, diálogos,
  confirmaciones con diálogo propio (nunca `confirm()`, que bloquea y no se puede
  estilar), barras, avatares, estados vacíos.
- **`dialogs.js`** agrupa todos los formularios. Leen y escriben siempre a través
  del contexto vivo, nunca de una referencia capturada.
- Las vistas se montan una vez y exponen `render()`. El montaje cablea los
  listeners; el pintado solo reconstruye hijos. Un `render()` que vuelva a cablear
  duplica los manejadores.

### Accesibilidad y móvil

- Todo control interactivo mide al menos 44 px en pantallas táctiles.
- Áreas de toque, `aria-label` en español en botones de icono, `role="switch"` con
  teclado, foco visible y enlace de salto al contenido.
- Se respeta `prefers-reduced-motion` y `prefers-contrast`.
- `input`/`select` a 16 px para que iOS no haga zoom al enfocar.
- Los diálogos se abren con `<dialog>` nativo (foco atrapado y `Escape` gratis) y
  en móvil entran desde abajo.

---

## 11. Qué se arregló respecto a la versión anterior

| Problema de la v1 | Qué había | Qué hay ahora |
|---|---|---|
| Sincronización que perdía trabajo | Todo el estado en una fila, «gana el último» | Fila por entidad, con marca propia y detección de conflictos |
| Horas mal contadas | El resumen se recalculaba a mano en varios sitios | Un único motor (`coverage.js`) y un único criterio documentado |
| Turnos de noche | Se trataban como un caso especial disperso | `end <= start` significa cruzar medianoche, resuelto en un sitio y con pruebas |
| Avisos que no llegaban | `setTimeout` de hasta 48 h, sin registro | Temporizadores cortos + vigilante con recuperación y registro de entregados |
| Cambios entre dispositivos | Sin resolución de conflictos | Marca por entidad, gana la más reciente, y el usuario se entera |
| Un solo horario para todos | «Perfiles» que solo cambiaban un nombre | Personas de verdad, cada una con sus turnos y su color |
| 450 líneas de `app.js` | Todo mezclado, sin pruebas | 22 módulos, 344 pruebas automatizadas |
| Sin exportación | Nada | JSON, CSV, iCal, texto y copias rotativas |
| Sin cobertura | No se sabía si faltaba gente | Cálculo por franjas, huecos y aviso |
| Código sin verificar | Ninguna prueba | 344 pruebas + comprobador estático |
| Errores silenciosos | `catch {}` por todas partes | Errores traducidos y visibles al usuario |

---

## 12. Decisiones discutibles (y por qué)

- **Sin framework y sin compilación.** El alcance no lo necesita y así la
  aplicación se sirve como archivos estáticos, se instala y se depura sin
  herramientas. El coste es escribir a mano lo que un framework daría hecho.
- **Sin IndexedDB.** `localStorage` es síncrono y suficiente para un cuadrante de
  equipo. Si algún día se manejan decenas de miles de entradas, habrá que pasar a
  IndexedDB; las copias rotativas ya avisan de cuándo el espacio aprieta.
- **Los festivos son una ayuda, no una verdad.** Los nacionales y los de Semana
  Santa se calculan con exactitud; los autonómicos van marcados por nivel de
  confianza y se avisa de que hay que revisarlos. Es preferible una lista más
  corta y honesta que una larga y equivocada.
- **La app no pide cuenta nunca.** Solo la ofrece cuando hay una nube configurada
  y podría haber datos que recuperar. El modo local se recuerda entre visitas para
  no volver a preguntar.

