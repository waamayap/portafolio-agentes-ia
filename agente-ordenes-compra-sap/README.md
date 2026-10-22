# Agente de Órdenes de Compra SAP

Reto técnico 03 · Periferia IT Group. Agente conversacional que lee el paquete de una solicitud de compra (correo, solicitud, cotización, aprobación y factura), lo valida contra los maestros (controles RC1–RC10), arma la orden de compra tal como quedaría en SAP, genera la evidencia de aprobación y crea la OC en un SAP simulado. Pide confirmación humana antes de crear la OC cuando hay excepciones.

- **Link de prueba:** https://agente-ordenes-compra-sap-lbaxqqiopa-uc.a.run.app (público, sin clave de acceso)
- **Planteamiento de la solución:** [SOLUCION.md](SOLUCION.md)

## Requisitos

- Node 20 o superior (probado con Node 22).
- Para usar el modelo real: una API key de OpenAI (`OPENAI_API_KEY`). También funciona con Gemini (AI Studio o Vertex AI). Sin clave se puede usar `LLM_PROVIDER=simulado`.

## Levantar en local

```bash
npm install
cp .env.example .env      # y pegar OPENAI_API_KEY
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
| `LLM_PROVIDER` | `openai`, `gemini` o `simulado` | `gemini` (el `.env.example` usa `openai`) |
| `OPENAI_API_KEY` | API key de OpenAI (solo backend; en Cloud Run, desde Secret Manager) | — |
| `OPENAI_MODEL` | Modelo de OpenAI | `gpt-5.4-mini` |
| `OPENAI_REASONING` | Esfuerzo de razonamiento (`none` para usar herramientas en Chat Completions) | — |
| `GEMINI_MODEL` · `GEMINI_THINKING` | Modelo y nivel de razonamiento de Gemini | `gemini-3.8-flash` · `LOW` |
| `GEMINI_API_KEY` | API key de AI Studio (solo backend) | — |
| `GOOGLE_GENAI_USE_VERTEXAI`, `GOOGLE_CLOUD_PROJECT`, `GOOGLE_CLOUD_LOCATION` | Vertex AI con credenciales de Google Cloud, sin clave | — |
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
# Una sola vez: repositorio de imágenes, secreto con la API key y acceso público
gcloud artifacts repositories create agente-ordenes-compra-sap --repository-format=docker --location=us-central1
printf "%s" "TU_OPENAI_API_KEY" | gcloud secrets create openai-api-key --data-file=-
gcloud secrets add-iam-policy-binding openai-api-key \
  --member="serviceAccount:<NUMERO_PROYECTO>-compute@developer.gserviceaccount.com" --role=roles/secretmanager.secretAccessor

# Cada despliegue (desde esta carpeta)
gcloud builds submit --config cloudbuild.yaml

# Una sola vez, después del primer despliegue: permitir el acceso sin login
gcloud run services add-iam-policy-binding agente-ordenes-compra-sap --region=us-central1 \
  --member=allUsers --role=roles/run.invoker
```

- La clave nunca está en la imagen ni en el repositorio: Cloud Run la inyecta desde Secret Manager como variable de entorno. `.gcloudignore` y `.dockerignore` excluyen `.env`.
- El servicio corre con `--max-instances=1`, porque las sesiones viven en memoria con respaldo en `out/sesiones/`. El disco de Cloud Run es efímero: al reiniciarse la instancia, `out/` empieza vacío.
- El costo está acotado por `MAX_ITERACIONES` y `MAX_TOKENS_SESION`.

## Estructura

```
agent/prompt.md                 comportamiento (system prompt)
src/knowledge/ordenes-compra.md conocimiento del proceso
src/tools/oc.ts                 herramientas oc_* (ejecución), sin dependencia del servidor
src/tools/reglas.ts             controles RC1–RC10 (función pura)
src/sap/adapter.ts · mock.ts    interfaz SapAdapter y SAP simulado sobre archivos
src/llm/adapter.ts              interfaz del proveedor LLM · openai.ts · gemini.ts · simulado.ts
src/agent/ciclo.ts              ciclo del agente: topes, confirmación humana, guardias, reintentos
src/agent/sesiones.ts           sesiones en memoria con respaldo en out/sesiones/
src/server.ts                   API HTTP + front estático
web/                            chat (HTML, CSS y JS, sin build)
demo.ts                         verificación sin modelo
```
