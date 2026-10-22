# Agente de Órdenes de Compra SAP

Reto técnico 03 · Periferia IT Group. Agente conversacional que lee el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura), lo valida contra los maestros (controles RC1–RC10), arma la orden de compra tal como quedaría en SAP, genera la evidencia de aprobación y crea la OC en un SAP simulado. Pide confirmación humana antes de crear la OC cuando hay excepciones.

- **Link de prueba:** _pendiente (Cloud Run)_
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md)

## Requisitos

- Node 20 o superior (probado con Node 22).
- Para usar el modelo real: una API key de Gemini ([Google AI Studio](https://aistudio.google.com/apikey), capa gratuita). Sin clave se puede usar `LLM_PROVIDER=simulado`.

## Levantar en local

```bash
npm install
cp .env.example .env      # y pegar GEMINI_API_KEY
npm run dev               # http://localhost:8080 (front + API)
```

## Verificación sin modelo

```bash
npm run demo
```

Procesa los 6 casos llamando directamente a las herramientas, sin clave. Limpia `out/` al inicio, crea `sol-001` dos veces para mostrar la idempotencia y confirma de forma explícita `sol-004`, `sol-005` y `sol-006`.

| Caso | Resultado esperado |
|---|---|
| sol-001 | OC creada sin intervención (y la segunda vez devuelve el mismo número) |
| sol-002 | Bloqueada: RC1, el proveedor no existe |
| sol-003 | Bloqueada: RC2, el aprobador no es de CC-2020 |
| sol-004 | Confirmación RC5: la cotización difiere 6 % |
| sol-005 | Confirmación RC8: OC retroactiva, marcada en `out/control.csv` |
| sol-006 | Confirmación RC6: IVA derivado del proveedor (y RC7 derivado) |

## Variables de entorno

| Variable | Uso | Por defecto |
|---|---|---|
| `LLM_PROVIDER` | `gemini` o `simulado` | `gemini` |
| `GEMINI_MODEL` | Modelo de Gemini | `gemini-3.8-flash` |
| `GEMINI_API_KEY` | API key de AI Studio (solo backend) | — |
| `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | Vertex AI con la cuenta de servicio, sin clave | — |
| `MAX_ITERACIONES` | Tope de vueltas herramienta → modelo por turno | `25` |
| `MAX_TOKENS_SESION` | Tope de tokens acumulados por sesión (control de costo) | `1000000` |
| `LLM_TIMEOUT_MS` | Espera máxima por respuesta del modelo | `60000` |
| `PORT` | Puerto HTTP | `8080` |

## API

| Método | Ruta | Cuerpo / respuesta |
|---|---|---|
| `POST` | `/api/chat` | `{ sessionId?, message }` → `{ sessionId, reply, toolCalls[], needsConfirmation, pendientes[] }` |
| `GET` | `/api/sessions/:id` | Historial visible de la sesión, casos pendientes de confirmación y tokens usados |
| `GET` | `/api/health` | `{ ok, provider, model }` (sin claves) |

## Salidas (`out/`)

| Archivo | Contenido |
|---|---|
| `out/sap/ordenes.jsonl` | OC creadas en el SAP simulado (numeración desde 4500000001) |
| `out/control.csv` | Cada intento: `solicitud_id, resultado, numero_oc, retroactiva, bloqueos, confirmaciones, ts` |
| `out/log.jsonl` | Cada llamada a herramienta: `{ ts, herramienta, caso, ok, resumen, sesion }` |
| `out/<caso>/aprobacion.txt` · `.pdf` | Evidencia de aprobación con su sha256 |
| `out/<caso>/payload.json` · `trazabilidad.json` | OC construida y la fuente de cada valor |
| `out/<caso>/orden-creada.json` | OC final con el número asignado |

## Despliegue en Cloud Run

```bash
# Una sola vez: repositorio de imágenes y secreto con la API key
gcloud artifacts repositories create agente-ordenes-compra-sap --repository-format=docker --location=us-central1
printf "%s" "TU_API_KEY" | gcloud secrets create gemini-api-key --data-file=-

# Cada despliegue
gcloud builds submit --config cloudbuild.yaml
```

La cuenta de servicio de Cloud Run necesita el rol `Secret Manager Secret Accessor` sobre `gemini-api-key`. El servicio corre con `--max-instances=1`, porque las sesiones viven en memoria.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 herramientas oc_* (ejecución), sin dependencia del servidor
src/tools/reglas.ts             controles RC1–RC10 (función pura)
src/sap/adapter.ts · mock.ts    interfaz SapAdapter y SAP simulado sobre archivos
src/llm/adapter.ts              interfaz del proveedor LLM · gemini.ts · simulado.ts
src/agent/ciclo.ts              ciclo del agente: topes, confirmación humana, errores
src/server.ts                   API HTTP + front estático
web/                            chat (HTML, CSS y JS, sin build)
demo.ts                         verificación sin modelo
```
