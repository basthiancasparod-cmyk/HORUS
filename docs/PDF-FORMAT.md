# Formato del cuadrante PDF de Henares — hallazgos verificados

Documento de trabajo para quien implemente `js/core/schedule-import.js`.
Todo lo de aquí está **medido sobre un archivo real**, no supuesto.

---

## 0. CORRECCIONES (leer antes que nada)

Este documento se escribió a mano mientras se investigaba el PDF, y algunas de
sus conclusiones eran **artefactos de un fallo del propio extractor**, no del
archivo. Después se midió todo otra vez, ya con el extractor arreglado, y esto es
lo que resultó falso:

| Lo que decía aquí | Lo que es en realidad |
| --- | --- |
| El avance del texto está «estirado» porque `multiply()` de `pdf-text.js` no escala el desplazamiento. | **Falso.** `multiply()` es correcto (hace `m × n` con `n` aplicada primero, que es la convención del PDF). El error real era que el extractor suponía **0,5 em por carácter** en vez de leer los anchos del array `/W` de cada fuente. |
| Emparejar cada código con la columna del número impreso más cercano «falla». | **Falso.** Con las x correctas es el método bueno y es el que se usa. Fallaba con las x distorsionadas, que es lo que había entonces. |
| `AFAFAF` de DANIEL son seis códigos de una letra. | **Falso.** Son **tres casillas «AF»** en días consecutivos. La `A` y la `F` están a 8 px y las columnas a ~21: dos glifos a 8 px no pueden ser de columnas distintas. Se quedan como código desconocido y la app pregunta qué son. |
| ALEJANDRA tiene las vacaciones en dos tramos (7 + 3). | **Falso.** Son **10 casillas `VC` seguidas**, del 20 al 29 de octubre. |
| La tirada de números pierde los últimos dígitos por caer fuera de página. | **Falso.** La tirada del archivo son **57 dígitos = 33 días** (28, 29, 30, 1…30). La hoja imprime esas 33 columnas con número y **las 2 últimas sin número**; ésas se completan con el calendario y quedan marcadas como no verificadas. |
| Las x medidas que aparecen más abajo (110, 135, 153…) | Son las que daba el extractor **antes** del arreglo. No las uses como referencia. |

Lo que sí se confirmó y sigue en pie: la naturaleza del archivo (§1), la
estructura de la página (§2), la duplicación de la rejilla, los códigos conocidos
(§7) y las reglas de honestidad (§10).

Y la conclusión de fondo, que es la que importa: **la señal autoritativa de cada
columna es el número de día impreso**, no la letra de la cabecera. Comprobando
los 33 números contra el calendario real, el mes sale con confianza alta y las
fechas quedan fijadas sin ambigüedad. Las letras `L M X J V S D` se usan como
señal secundaria: en este archivo traen un par de fragmentos descolocados (dos
letras a 2 px cuando las columnas están a 21), así que se avisa de ellas pero no
mandan.

---

Archivo de referencia: `tests/fixtures/cuadrante-octubre-henares.pdf`
(558 727 bytes, PDF 1.7, generado con «Microsoft: Print To PDF»).

---

## 1. Naturaleza del PDF

- **Es texto real**, no una imagen: se puede leer con exactitud. 687 fragmentos.
- Página **A4 apaisada: 841.92 × 595.32** unidades PDF, 1 sola página.
- 4 fuentes CID (`F1`–`F4`), todas con `/Encoding /Identity-H` y mapa
  `/ToUnicode`, así que los glifos se traducen a caracteres sin ambigüedad.
- Los streams van con `FlateDecode` y **`/Length` fiable**. Hay que usarlo para
  cortar el stream: buscar «endstream» por texto incluía el salto de línea
  previo y `DecompressionStream` lo rechazaba.

Ya está resuelto en `js/core/pdf-text.js` (`readPdfText(bytes)`), que devuelve
`{ pdf, fontMaps, items, page }` con cada fragmento y su posición real.
**No hay que tocar ese módulo**: úsalo.

## 2. Estructura de la página

De arriba abajo (coordenadas Y medidas):

| Y | Contenido |
|---|---|
| 556 | `OCTUBRE 26` — **mes y año explícitos** |
| 537 | `VIERNES 16 REUNION` — ancla de día concreto |
| 525 | `octubre` + `SALON SEMANA LUCIA` |
| 492 | **Cabecera de días: `L M X J V S D` repetido ×5 = 35 columnas** |
| 478 | **Tirada de números de día** |
| 464–391 | **Seis filas de personas con sus códigos** |
| 363 | repetición de la tirada de números |
| 349 | repetición de la cabecera de días |
| 335 | `OBSERVACIONES` / `DIAS ESPECIALES` |
| 312 | `DE  DOMINGO A JUEVES` / `VIERNES , SABADO Y VISPERAS DE FESTIVO` |
| 289/276/264 | leyenda: `MAÑANA 08:30 A 17`, `TARDE 16:30 A 01:00`, `INTERMEDIO 13:30 A 22` |
| 32 | `Página 1` |

**La rejilla aparece DUPLICADA** (una copia arriba, otra abajo). No son días
distintos: es el mismo mes repetido. Hay que **elegir una** copia, no fusionarlas
como si fueran fechas distintas.

## 3. Cómo vienen los números de día (lo más delicado)

No son celdas independientes: son **57 fragmentos de texto** con separación de
~8 px, formando una tirada continua de dígitos.

X reales (fila y=478):

```
107=2 114=8 133=2 141=9 154=3 162=0 181=1 204=2 225=3 246=4 278=5 300=6
321=7 342=8 364=9 381=1 389=0 402=1 410=1 431=1 439=2 452=1 460=3 474=1
481=4 495=1 502=5 516=1 523=6 537=1 545=7 559=1 566=8 587=1 595=9 609=2
616=0 630=2 637=1 651=2 658=2 672=2 680=3 694=2 701=4 715=2 722=5 745=2
752=6 766=2 774=7 788=2 795=8 807=2 815=9 827=3 835=0
```

Leído como texto continuo: `2 8 2 9 3 0 1 2 3 4 5 6 7 8 9 1 0 1 1 1 2 1 3 …`

Eso es la secuencia `28 29 30 1 2 3 4 5 6 7 8 9 10 11 12 13 … 29 30`.

**Consecuencia:** emparejar cada número con la columna más cercana **falla**,
porque un número de dos cifras ocupa dos fragmentos y el encuadre no coincide
con el centro de la columna. Lo que funciona es:

1. Unir los fragmentos de la fila en una sola cadena de dígitos.
2. Partirla en números reconstruyendo la secuencia: un bloque es
   «1-2-3…-31» con reinicio a 1 tras el 31 (o tras el 30, según el mes).
   Se determinan los cortes buscando la partición que produce una secuencia
   monótona creciente de 1 en 1 y que encaja con el número de columnas.
3. Asignar el número i-ésimo a la columna i-ésima de la cabecera `L M X J V S D`.

## 4. Cabecera de días

Fila y=492, **35 elementos** (5 semanas de 7). X medidas:

```
110 135 153 178 180 196 217 249 250 268 285 308 329 350 378 398 416 439 461
482 503 532 551 570 593 615 636 657 687 707 725 747 768 789 810
```

Letras: `LMXJVSD` repetido 5 veces.
`L`=lunes, `M`=martes, `X`=miércoles, `J`=jueves, `V`=viernes, `S`=sábado,
`D`=domingo.

Hay pares casi idénticos (178/180, 249/250) que **no son duplicados exactos** de
texto: se comprobó y no hay ningún par con mismo texto y x a menos de 4. No hay
que «limpiar duplicados»; hay que quedarse con la fila de 35 columnas tal cual.

## 5. Determinación del mes (ancla)

Dos señales, y la segunda manda si hay conflicto:

1. **Cabecera en texto**: `OCTUBRE 26` (Y=556). `MONTHS` en español +
   año de dos cifras → 2026.
2. **Verificación por día de la semana**: el día `N` debe caer en la columna
   cuyo nombre de día de la semana corresponde a la fecha real. En el archivo,
   el 16 cae en `V` (viernes) y el texto `VIERNES 16 REUNION` lo confirma:
   en **octubre de 2026** el 1 es jueves y el 16 es viernes. ✔

Regla: se calcula la fecha real de cada día del mes candidato y se comprueba
contra la columna. Si **todas** las columnas con número cuadran → confianza alta.
Si fallan algunas → esas celdas van a la lista de dudas. Si no hay candidato que
cuadre → **se pregunta al usuario**, nunca se adivina.

El mes puede estar incompleto: la rejilla empieza en el 28 de septiembre y
termina el 1 de noviembre. Las columnas fuera del mes se marcan como
`outsideMonth` y no deben generar turnos.

## 6. Códigos y filas de personas (medido)

Filas (Y descendente), con el nombre a la izquierda y los códigos después:

| Y | Nombre | Códigos |
|---|---|---|
| 464 | `JAVIER` | `I M P P M M M M T T T RE M M M M M  M M M M M` |
| 447 | `WILLIAM` | `I M P M M M M M T T I I I T I I I I T T T T T` |
| 432 | `ALEJANDRA` | `T T I T T T M M M M M M T VCVCVCVCVCVCVC VCVCVC T I T` |
| 419 | `DANIEL` | `M M T T T T M M T T T P T T AFAFAF M M M M M T T` |
| 405 | `SERGIO` | `M M M T T T T M M M M T T T M T T T T T M M T` |
| 391 | `YORBELI C.` | `T T T T M M T T T T P M M T T T T M M T T` |

**Los códigos se parten en fragmentos** y hay que reagruparlos: `VC` llega como
`V`+`C` pegados, `RE` como `R`+`E`, y `AFAFAF` es `A`,`F`,`A`,`F`,`A`,`F`
(códigos de una letra seguidos). La agrupación es por **proximidad horizontal**:
fragmentos a menos de ~8 px con el mismo tamaño de fuente son el mismo código.

**Ojo con `AFAFAF`:** son seis códigos de una letra, NO un código `AF` repetido.
La ambigüedad se resuelve con la rejilla de columnas: cada código debe caer en su
columna. Si al repartir `AFAFAF` entre columnas cada letra cae en una columna
distinta, son códigos sueltos.

## 7. Códigos conocidos (confirmados por el usuario)

| Código | Significado | Turno del catálogo |
|---|---|---|
| `M` | Mañana | Mañana (08:30–17:00) |
| `T` | Tarde | Tarde (16:15–00:45) |
| `I` | Intermedio | Intermedio (13:30–22:00) |
| `P` | Partido | Partido |
| `V`, `VC` | Vacaciones | Vacaciones |
| `F` | Feriado | Festivo |
| `RE`, `R` | Reunión | Reunión (turno propio) |

Cualquier otro código → **desconocido**, va a la lista de dudas para que el
usuario lo asigne. Nunca se descarta en silencio.

## 8. Bordes reales del archivo

- `OCTUBRE 26` en la cabecera: el `26` es el año (2026).
- Aparecen los días 26, 28, 29, 30, 31 en la tirada: la rejilla abarca finales de
  septiembre y principios de noviembre.
- La leyenda `TARDE 16:30 A 01:00` y `INTERMEDIO 13:30 A 22` **no coincide**
  exactamente con los horarios del catálogo actual (`16:15–00:45`). Es un dato a
  tener en cuenta: puede que los horarios cambien entre plantas o temporadas. El
  parser **no** debe cambiar el catálogo por su cuenta; si detecta que la leyenda
  discrepa, puede avisar, pero el horario lo manda el catálogo de la app.

## 9. Resultado esperado del parser

```js
{
  monthKey: '2026-10',
  monthConfidence: 'high',
  page: { width, height },
  people: [
    { label: 'JAVIER', memberId: null, entries: [ { day: 1, code: 'I', confidence: 'high' }, … ] },
    …
  ],
  unknownCodes: { A: 6, Z: 2 },       // código → veces que aparece
  issues: [ { kind: 'unknown-code', code: 'A', count: 6 }, … ],
  stats: { people: 6, entries: 180, high: 175, low: 5, outsideMonth: 12 },
}
```

## 10. Reglas de honestidad (importantes)

1. **Nunca inventar un turno.** Si una celda no se puede situar con seguridad, se
   marca `low` y se enseña para que la corrija el usuario.
2. **Nunca adivinar el mes** si la comprobación por día de la semana no cuadra.
3. **Nunca modificar el catálogo** de turnos automáticamente.
4. Si el PDF es un escaneo (no hay fuentes ni texto) o el formato no se reconoce,
   devolver un error claro y explicable, no una rejilla vacía.
5. Todo el código y los comentarios, en español.
