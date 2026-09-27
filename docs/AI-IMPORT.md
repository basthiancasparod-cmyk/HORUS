# Importar el cuadrante con IA de visión

Aquí llegan los cuadrantes que **no** son un PDF con texto: fotos hechas al
horario de la pared, capturas de pantalla, PDF escaneados. Para eso no sirve el
lector determinista (`pdf-text.js`), hace falta un modelo con visión.

## 1. Lo que está medido sobre la API real

Todo lo de esta sección se comprobó con llamadas de verdad, no es teoría.

### Gemini (Google AI Studio)

- Endpoint: `POST https://generativelanguage.googleapis.com/v1beta/models/{modelo}:generateContent`
- Cabecera de autenticación: `x-goog-api-key: <clave>`
- Cuerpo: `{ contents: [{ parts: [{ inline_data: { mime_type, data } }, { text }] }], generationConfig: { temperature: 0, responseMimeType: 'application/json', responseSchema } }`
- Respuesta: `candidates[0].content.parts[].text` (JSON, porque se pide salida estructurada).
- **Modelos saturados (HTTP 503)**: `gemini-3.8-flash`, `gemini-flash-latest` y
  `gemini-3.5-flash` devolvieron 503 «experiencing high demand» en la prueba.
  `gemini-3.1-flash-lite` respondió a la primera. **Por eso hay lista de
  reserva**: ante un 503 se prueba el siguiente modelo.
- `gemini-2.5-flash` responde `404 ... no longer available to new users`.
- Con el PDF del cuadrante: **926 tokens de entrada y ~3 000 de salida**. Es
  decir, una importación al mes son céntimos (y en la capa gratuita, nada).

### Calidad real de la interpretación (probada con el cuadrante de Henares)

Con el prompt de interpretación, Gemini acertó **todo**:

```json
{ "month": 10, "year": 2026, "monthNameRaw": "OCTUBRE 26",
  "leadingPreviousMonthDays": [28, 29, 30], "trailingNextMonthDays": [1],
  "people": ["JAVIER","WILLIAM","ALEJANDRA","DANIEL","SERGIO","YORBELI C."],
  "grid": { "columns": 35, "rows": 6 }, "weekdayHeader": "L M X J V S D",
  "codes": [{"code":"M","meaning":"Turno mañana"},{"code":"VC","meaning":"Vacaciones"},
            {"code":"RE","meaning":"Reunión"},{"code":"AF","meaning":"Ausencia justificada"}],
  "confidence": "high",
  "warnings": ["El año indicado es 26, interpretado como 2026."] }
```

Detectó solo lo del mes anterior (`28, 29, 30`) sin que se lo dijéramos, que es
justo la trampa del formato.

### Lo que la IA hace MAL (y por qué no se le puede creer a ciegas)

1. **Se inventa la letra del día de la semana.** En la transcripción, a las seis
   personas les dijo «día 1: columna X» cuando el 1 de octubre de 2026 es
   jueves (J). No lee la cabecera: **deduce la letra con un calendario
   equivocado**. Falla en los 6 de 6.
2. **Rellena casillas vacías.** Para JAVIER devolvió 29 casillas con 17 `M`
   seguidas, cuando la fila tiene muchas menos. Tiende a completar el hueco
   con el código anterior.
3. **Los recuentos por código no cuadran** (dijo `M × 75` cuando son ~48).

**Conclusión de diseño:** la IA sirve para *entender* el documento y para
localizar los códigos, pero **no** para decidir fechas ni para dar por buena una
casilla. Todo lo que devuelve pasa por la verificación determinista y por la
pantalla de revisión.

## 2. La cadena

```
archivo (foto / PDF escaneado)
   ↓
1. INTERPRETAR   la IA dice mes, año, días del mes anterior al principio,
                 personas, códigos y avisos. NO transcribe.
   ↓
2. TRANSCRIBIR   la IA devuelve, por persona, casillas {day, code, column}.
                 Recibe la interpretación como contexto y la orden de omitir
                 lo que no lea con seguridad.
   ↓
3. VERIFICAR     código puro: cada día contra el calendario real, la letra de
                 la columna contra el día de la semana de verdad, días
                 duplicados, fuera de mes, códigos desconocidos.
   ↓
4. REVISAR       la pantalla de revisión de siempre. Nada se guarda sin verlo.
   ↓
5. IMPORTAR      un solo paso de deshacer (ya probado).
```

El paso 3 es el que hace que esto sea fiable: la IA puede equivocarse, pero
**una casilla cuya letra de columna no cuadre con el calendario se marca en
ámbar y se pide al usuario**.

## 3. Contrato del módulo

`js/core/ai-vision.js` — sin DOM, sin `fetch` global (se inyecta), sin `node:*`.

```js
export const AI_PROVIDERS;
export const AI_FALLBACK_MODELS;
export async function interpretSchedule(opts);
export async function transcribeSchedule(opts);
export function buildParseResult(opts);
export function verifyParse(parseResult, opts);
export async function readScheduleWithAI(opts);
```

### `opts.file`

`{ data: string /* base64, sin prefijo data: */, mimeType: string, name?: string }`

### `interpretSchedule({ provider, apiKey, model, file, fetchImpl })`

Devuelve:

```js
{ ok: true, month, year, monthNameRaw, leadingPreviousMonthDays: number[],
  trailingNextMonthDays: number[], people: string[],
  codes: { code, meaning, count }[], weekdayHeader,
  grid: { columns, rows }, confidence: 'high'|'medium'|'low', warnings: string[],
  usage?: object }
```

o `{ ok: false, reason: string }`. **Nunca lanza**: los errores se devuelven.

### `transcribeSchedule({ ..., interpretation })`

```js
{ ok: true,
  cells: { label: string, entries: { day: number, code: string, column?: string }[] }[],
  uncertainPeople: string[], warnings: string[], usage?: object }
```

### `buildParseResult({ interpretation, transcription, knownCodes? })`

Devuelve **exactamente** el `ParseResult` que ya consumen
`js/ui/import-review.js` y `buildEntriesFromParse` de `schedule-import.js`:
`{ ok, reason, monthKey, monthConfidence, monthCandidates, page, people, unknownCodes, issues, stats, meta }`
con `people[].entries[] = { date, day, code, confidence, reason }`.

De ahí hacia abajo **no hay que tocar nada**: la revisión, el volcado y el
deshacer ya funcionan con esa forma.

### `verifyParse(parseResult, { year, month })`

Reglas, todas deterministas:

| Comprobación | Qué hace |
| --- | --- |
| Día dentro del mes | un día fuera de 1..díasDelMes se descarta y suma a `outsideMonth` |
| **Letra de columna** | si la IA dijo `column`, se compara con el día de la semana real de esa fecha. Si no cuadra → `confidence: 'low'` + issue `column-mismatch` |
| Sin columna | si la IA no dio `column`, la casilla queda `low` (no se puede comprobar) |
| Día repetido | se queda el primero, issue `duplicate-day` |
| Días del mes anterior | los `leadingPreviousMonthDays` **no se importan** (issue `outside-month`) |
| Códigos | lo que no esté en `KNOWN_CODES` va a `unknownCodes` + `low` |
| Recuentos | se recalculan del resultado, **nunca** se copian de `codes[].count` |
| Confianza global | si `confidence !== 'high'` o hay `warnings` de ilegibilidad, todas las casillas bajan a `low` |

La verificación del **mes** es la misma que usa el lector de PDF: se prueba cada
mes candidato contra el calendario real (día de la semana) y, si ninguno cuadra
al 100 %, `monthConfidence` baja y la UI pregunta. **Nunca se adivina el mes.**

### `readScheduleWithAI({ provider, apiKey, model, file, fetchImpl })`

Orquesta 1 → 2 → 3 y devuelve el `ParseResult` verificado.

## 4. Adaptadores y comportamiento de red (medido)

| Proveedor | Endpoint | Imagen | Notas |
| --- | --- | --- | --- |
| `gemini` | `…/v1beta/models/{modelo}:generateContent` | `inline_data` | salida estructurada nativa (`responseSchema`). **Preferido.** |
| `openrouter` | `…/api/v1/chat/completions` | `image_url` con data URL | compatible OpenAI; gratis con `:free` |
| `mistral` | `…/v1/ocr` y luego `…/v1/chat/completions` | `image_url` | el OCR devuelve markdown; hace falta una segunda llamada de chat para estructurar |

- **503 / 429**: se reintenta con el siguiente modelo de `AI_FALLBACK_MODELS`;
  si se agotan, `{ ok:false, reason }` explicando que el servicio está saturado
  y que se intente en unos minutos.
- **401 / 403**: «la clave no es válida o no tiene permiso».
- **404**: «ese modelo no está disponible en tu cuenta» (con el nombre probado).
- **Red caída**: `{ ok:false, reason }`, nunca una excepción.
- Reintento con espera creciente entre intentos (2 intentos por modelo como
  mucho) y **sin** reintentar en 400/401/403/404.

## 5. Claves: BYOK y nunca en el repositorio

- La clave la escribe el usuario en **Ajustes** y se guarda con
  `storage.loadUI/saveUI` (preferencias locales). **No va en el documento**, así
  que **nunca se sincroniza** a Supabase ni sale del dispositivo.
- **Prohibido** escribir una clave en cualquier archivo versionado: ni en
  `config.js`, ni en un `.env` con seguimiento, ni en un fixture, ni en un test.
- `js/core/ai-vision.js` recibe la clave como parámetro: no la lee de ningún
  sitio ni la registra en consola.
- En los mensajes de error **nunca** se incluye la clave (ni recortada).

## 6. Privacidad (hay que decirlo en la interfaz)

Una foto del cuadrante lleva los nombres de los compañeros y se envía a un
tercero. En la capa gratuita de Gemini, Google puede usar esas peticiones para
mejorar sus productos. La app lo avisa en Ajustes, junto al selector de
proveedor, y **la importación por IA está apagada hasta que el usuario pone una
clave**: no hay ningún servicio por defecto.
