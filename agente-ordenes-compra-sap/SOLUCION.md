# SOLUCIÓN — Agente de Órdenes de Compra SAP

Reto técnico 03 · Periferia IT Group · Equipo Perxia 2.0

- **Link de prueba:** https://agente-ordenes-compra-sap-lbaxqqiopa-uc.a.run.app
- **Verificación sin modelo:** `npm run demo`
- **Cómo levantarlo:** ver [README.md](README.md)

---

## 1. El problema en una frase

Cada compra obliga a la analista administrativa a digitar a mano en SAP datos que ya vienen en tres documentos, y a validar de memoria si el proveedor existe, si quien aprueba puede aprobar ese monto y si la cotización cuadra. A ella le duele en tiempo; a Contabilidad, en errores que se corrigen en el cierre; y a la dirección, porque no puede medir cuántas OC se crean después de que llegó la factura.

---

## 2. Arquitectura

```
┌──────────────────────────┐   POST /api/chat    ┌──────────────────────────────────────────────┐
│  Front de chat (web/)    │ ──────────────────▶ │  Backend Hono (src/server.ts)                │
│  · historial             │ ◀────────────────── │  · sesiones: memoria + out/sesiones/*.json   │
│  · llamadas a            │  reply, toolCalls,  │                                              │
│    herramientas visibles │  needsConfirmation  │  Ciclo del agente (src/agent/ciclo.ts)       │
│  · barra de confirmación │                     │  · topes: iteraciones, tokens, timeout       │
└──────────────────────────┘                     │  · guardias: confirmación humana, afirmación │
                                                 │    de OC creada, reintentos                  │
                                                 │            │                  │              │
                                                 │            ▼                  ▼              │
                                                 │  Adaptador LLM          Herramientas oc_*    │
                                                 │  (src/llm/)             (src/tools/oc.ts)    │
                                                 │  openai · gemini ·      zod, nunca lanzan    │
                                                 │  simulado                     │              │
                                                 └───────────────────────────────┼──────────────┘
                                                                                 │
                              ┌──────────────────────────────────────────────────┼─────────────────┐
                              ▼                                                  ▼                 ▼
              fixtures/reto-03/ (solo lectura)              SapAdapter → SapMock (src/sap/)    out/
              solicitudes/<caso>/… · maestros/*.json        out/sap/ordenes.jsonl              control.csv · log.jsonl
                                                                                               <caso>/aprobacion.txt|pdf
                                                                                               <caso>/payload.json · trazabilidad.json
```

**Dónde vive cada cosa.** Esta separación es la que pide el PRD: cambiar una regla de negocio no toca el servidor.

| Capa | Archivo | Qué contiene |
|---|---|---|
| **Comportamiento** | `agent/prompt.md` | Rol, flujo, reglas que el modelo no puede romper y formato de respuesta. Se relee en cada turno: editarlo no exige reiniciar. |
| **Conocimiento** | `src/knowledge/ordenes-compra.md` | El proceso: actores, controles RC1–RC10, campos SAP y qué pedir en cada excepción. Se anexa al system prompt. |
| **Ejecución** | `src/tools/` | `oc.ts` expone las herramientas; `reglas.ts` (función pura) aplica RC1–RC10; `paquete.ts` normaliza los adjuntos; `payload.ts` arma la OC; `evidencia.ts` genera txt y pdf con sha256. |
| **Integración** | `src/sap/adapter.ts` · `mock.ts` | La interfaz `SapAdapter` obligatoria y su implementación sobre archivos. |
| **Parámetros de negocio** | `src/tools/reglas.ts` → `PARAMETROS` | Tolerancias de RC5 (2 %) y RC10 (± 1). |

Las herramientas no importan nada del servidor. Por eso `demo.ts` las ejecuta directamente, sin modelo.

**Herramientas expuestas al modelo**

| Herramienta | Entrada | Qué hace |
|---|---|---|
| `oc_listar_casos` | `{}` | Lista las solicitudes disponibles. Es un extra para el chat. |
| `oc_leer_paquete` | `{ caso }` | Devuelve el `Paquete` normalizado (7.2). Los adjuntos faltantes quedan en `null` y se listan en `faltantes`. |
| `oc_validar` | `{ caso }` | Devuelve `{ apta, bloqueos[], confirmaciones[], derivados, retroactiva, controles[] }`. |
| `oc_generar_evidencia` | `{ caso }` | Genera `aprobacion.txt` y `aprobacion.pdf` y devuelve `{ ruta, sha256 }`. |
| `oc_construir_payload` | `{ caso }` | Devuelve la `OrdenCompra` validada con zod y su trazabilidad campo por campo. |
| `oc_crear` | `{ caso, payload?, confirmado? }` | Crea la OC con idempotencia y control de confirmaciones. Escribe `out/control.csv`. |

---

## 3. Ciclo del agente

Lo implementé sin framework, en `src/agent/ciclo.ts` (unas 240 líneas), para tener control total sobre las reglas CA1–CA5 y poder explicar cada paso.

```
turno(mensaje del usuario):
  si la sesión ya pasó el tope de tokens → responder y cortar
  repetir hasta MAX_ITERACIONES (25):
    respuesta = modelo(historial, herramientas)        ← timeout de 60 s, hasta 3 reintentos (2, 4 y 8 s)
    si no pidió herramientas:
      si afirma "OC creada" sin un oc_crear exitoso en este turno → corregir una vez y seguir
      devolver la respuesta
    para cada llamada:
      validar los argumentos con zod (si fallan, el error vuelve al modelo)
      guardia de confirmación (ver abajo)
      ejecutar → registrar en out/log.jsonl → actualizar los casos pendientes
  tope alcanzado → devolver lo hecho y lo que falta, sin otra llamada al modelo
```

**Tope de iteraciones (CA1).** El tope es `MAX_ITERACIONES`. Al alcanzarlo, el ciclo arma la respuesta con las herramientas que ya ejecutó y lo que falta, sin gastar otra llamada. Hay además un tope de tokens acumulados por sesión (`MAX_TOKENS_SESION`) como control de costo, con su propio mensaje.

**El modelo no afirma valores propios (CA2).** Hay tres capas:
1. El prompt lo prohíbe.
2. Las herramientas **releen la fuente**: aunque el modelo envíe `paquete`, `derivados` o `payload`, se recalculan desde los fixtures, y `oc_crear` rechaza un payload que no sea idéntico al validado.
3. Una **guardia en el ciclo** detecta si la respuesta final dice que una OC "fue creada" sin que `oc_crear` lo haya confirmado en ese turno. Si pasa, le devuelve el turno al modelo una vez para que corrija; si insiste, el ciclo agrega un aviso visible de que la OC no se creó. La agregué porque en las pruebas el modelo llegó a escribir "Se creó la orden de compra" sin haber llamado `oc_crear`.

**Confirmación humana (CA3).** No depende del prompt:
- Al terminar cada turno, el ciclo registra qué casos quedaron esperando confirmación: `oc_validar` devolvió confirmaciones, o `oc_crear` respondió "requiere confirmación".
- `oc_crear` con `confirmado: true` **solo se ejecuta** si el caso estaba pendiente al cierre del turno anterior **y** el mensaje actual del usuario es una confirmación ("confirmo", "sí", "dale"…, sin negaciones). Si no se cumple, el ciclo no llama la herramienta y le explica al modelo que debe preguntar.
- El front recibe `needsConfirmation` y resalta el turno en ámbar, con los botones **Confirmo** y **No, no la crees**.
- La herramienta exige a su vez `confirmado = true` cuando hay confirmaciones: es una segunda barrera.
- La excepción queda en la OC con `confirmado_por`, que identifica la sesión que confirmó.

**Trazabilidad y errores (CA4, CA5).** Cada llamada queda en el chat (nombre, argumentos y resumen) y en `out/log.jsonl`. Un error de herramienta llega como `{ ok: false, error }` y el modelo lo explica. Un error del proveedor (timeout, cuota, saldo, credencial o modelo no disponible) se traduce a lenguaje claro. Además se descarta el turno incompleto, así que la sesión sigue usable.

---

## 4. Elección del modelo

**Proveedor y modelo:** OpenAI **`gpt-5.4-mini`** con `reasoning_effort: none`, vía Chat Completions con function calling.

**Por qué este y no otro.** Lo decidí comparando con mediciones, no por preferencia:

| Opción probada | Resultado | Decisión |
|---|---|---|
| Gemini `gemini-3.8-flash` vía Vertex AI | Funcionaba, pero con 10–60 s por turno y errores 429 *Resource exhausted* frecuentes por la capacidad compartida de Vertex. | Descartado como principal; queda como alternativa. |
| `gpt-4.1-mini` | El más rápido (~3,8 s por turno), pero resumía en vez de mostrar la matriz completa RC1–RC10 que pide el prompt. | Descartado. |
| **`gpt-5.4-mini` (none)** | 4–7 s por turno, sigue el formato y el flujo, sin errores de capacidad. | **Elegido.** |

El ciclo no depende del proveedor: `src/llm/adapter.ts` define `enviar(mensajes, herramientas, opciones)`, y hay tres implementaciones (`openai.ts`, `gemini.ts` y `simulado.ts`, un guion determinista sin clave). Se cambia de proveedor con `LLM_PROVIDER`, sin tocar el ciclo.

**Costo por caso.** Lo medí procesando los 6 casos de punta a punta, con la confirmación incluida. Precio de lista: USD 0,75 por 1M de tokens de entrada y USD 4,50 por 1M de salida.

| Caso | Llamadas al modelo | Tokens de entrada | Tokens de salida | Costo (USD) |
|---|---|---|---|---|
| sol-001 (flujo normal) | 5 | 16.895 | 596 | 0,0154 |
| sol-002 (bloqueo) | 3 | 8.789 | 445 | 0,0086 |
| sol-003 (bloqueo) | 3 | 8.882 | 469 | 0,0088 |
| sol-004 (+ confirmación) | 4 | 17.321 | 727 | 0,0163 |
| sol-005 (+ confirmación) | 6 | 23.097 | 757 | 0,0207 |
| sol-006 (+ confirmación) | 6 | 22.783 | 596 | 0,0198 |
| **Promedio** | | **16.295** | **598** | **≈ 0,015** |

Es decir, **cerca de 1,5 centavos de dólar por OC procesada**: 100 OC al mes costarían unos USD 1,5. La entrada pesa más que la salida porque en cada llamada se reenvía el system prompt y el historial. El caché de prompts de OpenAI (USD 0,075 por 1M) baja ese costo en conversaciones largas.

---

## 5. Matriz de controles

Las reglas viven en `src/tools/reglas.ts`, en una función pura `validarPaquete(paquete, maestros)` que no lee ni escribe archivos. Cada regla deja una fila en `controles[]` con estado `ok`, `bloqueo`, `confirmacion`, `derivado` o `no_aplica`; así el chat puede mostrar qué pasó y qué no.

| Regla | Implementación | Tipo |
|---|---|---|
| RC1 | Busca por NIT normalizado (sin puntos ni dígito de verificación). Si no hay NIT, por nombre normalizado (sin tildes, signos ni sufijos societarios). Si no existe o está inactivo → bloqueo con la acción para Compras. | Bloqueo |
| RC2 | Exige aprobación, que el cuerpo diga "Aprobado" (sin negación) y que el remitente esté entre los aprobadores del centro de costo. Si el aprobador pertenece a otro centro, lo dice. | Bloqueo |
| RC3 | Compara `valor_total` con el tope de **ese** aprobador en **ese** centro. Solo se evalúa si RC2 pasó; si no, queda "no aplica". | Bloqueo |
| RC4 | El centro de costo existe y la subárea le pertenece. Si la subárea es de otro centro, sugiere ese centro. | Bloqueo |
| RC5 | `abs(cotización − solicitud) / solicitud > 2 %`, una cotización ausente o una moneda distinta → confirmación con los dos valores y el porcentaje. | Confirmación |
| RC6 | Sin IVA → propone el `indicador_iva_default` del proveedor y pide confirmación. Un código que no existe en el maestro bloquea. | Confirmación + derivado |
| RC7 | Sin condiciones de pago → toma las del proveedor y solo informa. Un código inexistente bloquea. | Derivado |
| RC8 | Factura con fecha anterior a `fecha_solicitud` → `retroactiva = true` y confirmación. Queda en `out/control.csv`. | Confirmación |
| RC9 | Fecha de la aprobación, tomada en su propia zona horaria, anterior a `fecha_solicitud` → confirmación. | Confirmación |
| RC10 | `abs(cantidad × valor_unitario − valor_total) > 1` → bloqueo. | Bloqueo |

**La más difícil: RC2 con RC3.** Cada una por separado es simple. Lo difícil fue que la respuesta fuera útil. En sol-003, quien aprueba (Felipe Vargas) ni siquiera es aprobador de CC-2020, así que RC3 no tiene contra qué compararse y debe quedar "no aplica", no "ok" ni "bloqueo". Y la acción sugerida no puede ser un genérico "pida otra aprobación": la regla busca qué aprobadores del centro tienen tope suficiente. En este caso **ninguno lo tiene** (máximo 30 M frente a 74 M), y por eso recomienda escalar a la dirección financiera o dividir la compra. Ese tipo de respuesta es lo que convierte un bloqueo en una acción.

---

## 6. Diseño del adaptador SAP real

La interfaz ya existe (`SapAdapter`: `consultarProveedor`, `crearOrden`, `buscarOrdenPorReferencia`). Producción solo necesita otra implementación, sin tocar las herramientas ni el agente.

### Opción elegida

**Plan A: OData `API_PURCHASEORDER_PROCESS_SRV`, expuesto a través de SAP Integration Suite / API Management** (o SAP Cloud Connector si el sistema es on-premise).

- Es la API estándar y liberada de S/4HANA para órdenes de compra: está documentada, es estable entre versiones y se consume por HTTPS/JSON, sin librerías propietarias en el agente.
- Al pasar por Integration Suite, Periferia controla en un solo punto la autenticación, la limitación de tasa y el registro, y el agente nunca habla directamente con el ERP.

**Si el sistema es SAP ECC**, que no expone esa API, la alternativa es **RFC/BAPI `BAPI_PO_CREATE1`**, envuelta en un servicio intermedio que la publique como REST.

**Plan B, porque la viabilidad no está confirmada: carga por archivo.** El adaptador genera un archivo por lote (CSV para LSMW / *Migration Cockpit*, o IDoc `ORDERS05`) y lo deja en una carpeta o bucket. La analista lo carga en SAP, y una tarea posterior lee el número de OC asignado para completar `buscarOrdenPorReferencia`. Se pierde inmediatez, pero se conserva todo lo que hace el agente: validación, payload, evidencia y control.

### Mapeo del payload (7.4) a OData

| Payload | `A_PurchaseOrder` / `A_PurchaseOrderItem` | Nota |
|---|---|---|
| `sociedad` | `CompanyCode` | |
| `organizacion_compras` | `PurchasingOrganization` | Falta `PurchasingGroup`, que SAP exige: se agrega por configuración o por centro de costo. |
| `proveedor.codigo_sap` | `Supplier` | |
| `moneda` | `DocumentCurrency` | |
| `condiciones_pago` | `PaymentTerms` | |
| `referencia.solicitud_id` | `YourReference` (o un campo Z) | Es la llave de idempotencia de `buscarOrdenPorReferencia`. |
| `posiciones[].numero` | `PurchaseOrderItem` | 10, 20… |
| `posiciones[].descripcion` | `PurchaseOrderItemText` | Ya viene recortada a 40 caracteres. |
| `posiciones[].cantidad` / `unidad` | `OrderQuantity` / `PurchaseOrderQuantityUnit` | |
| `posiciones[].precio_unitario` | `NetPriceAmount` | **Ojo:** los fixtures traen precios con IVA incluido; SAP espera el neto, `precio / (1 + tasa)` (ver supuestos). |
| `posiciones[].indicador_iva` | `TaxCode` | |
| `posiciones[].centro_costo` | `AccountAssignmentCategory = "K"` + `CostCenter` en `A_PurOrdAccountAssignment` | |
| `posiciones[].subarea` | Campo de imputación adicional (orden interna, centro de beneficio o campo Z) | Depende de cómo Periferia modele las subáreas en SAP. |
| `aprobador` + evidencia | Adjunto al documento `BUS2012` vía `API_CV_ATTACHMENT_SRV` | Se sube el PDF y su sha256 queda en el texto de cabecera. |
| `excepciones[]` | Texto de cabecera de la OC | Para auditoría. |

Con BAPI, el equivalente es `POHEADER`/`POHEADERX` (cabecera), `POITEM`/`POITEMX` (posiciones) y `POACCOUNT` (centro de costo, con `ACCTASSCAT = 'K'`).

### Autenticación y credenciales

- Un **usuario técnico** con un rol mínimo: crear y consultar OC, y leer proveedores. Nada más.
- OData autenticado con **OAuth 2.0 (client credentials)** contra Integration Suite. Con BAPI, el usuario técnico se conecta por SNC a través de Cloud Connector.
- Las credenciales viven en **Secret Manager** (o el gestor de secretos de Periferia) y solo las lee el adaptador del backend en tiempo de ejecución. **Nunca** pasan por el prompt, el modelo, los logs ni el front: el modelo solo ve el resultado de `oc_crear` (número y fecha).
- Se usa el mismo patrón que hoy aplica la clave de OpenAI en Cloud Run.

---

## 7. Lectura del proceso: OC retroactivas

**Lo que le diría a la dirección.** Una OC retroactiva no es un error de digitación: es una compra que **ya ocurrió sin control previo**. Cuando la factura llega antes que la solicitud, la cotización y la aprobación se vuelven trámites para poder pagar, no decisiones. sol-005 lo muestra: la factura es del 10 de agosto, la solicitud del 27 y la aprobación del 28, y el correo del líder lo dice textualmente: *"Ya llegó la factura, por favor crear la OC para poder radicarla"*. Mientras el proceso lo permita, los controles de aprobación y de tope (RC2 y RC3) solo protegen las compras de quien decide respetarlos.

**Qué mide el agente.** Cada intento queda en `out/control.csv` con `retroactiva = true/false`. Con eso se puede reportar cada mes el **porcentaje de OC retroactivas**, por centro de costo, proveedor y aprobador. Antes de cambiar la política conviene medir al menos dos meses, para saber si el problema está concentrado (un área, un proveedor recurrente) o es general.

**Qué cambio de proceso propondría**, en este orden:
1. **Tolerar con marca y reportar** desde ya. Es lo que hace el agente: no bloquea, pero cada retroactiva exige confirmación explícita y queda medida.
2. **Que la recepción de facturas exija número de OC.** Una factura sin OC previa se devuelve al proveedor o entra a una cola de excepciones con el visto bueno de la dirección financiera, no de la analista.
3. **Compras recurrentes de bajo valor** (papelería, licencias, suministros) a **OC marco o pedidos abiertos** anuales. Gran parte de las retroactivas son compras repetitivas que nadie siente que necesiten aprobación cada vez.
4. Fijar una **meta** (por ejemplo, menos del 10 % de retroactivas en seis meses) y revisarla en el comité mensual con los datos de `control.csv`.

La decisión de tolerar o rechazar las retroactivas es de la dirección (pregunta abierta del PRD, sección 10). El agente ya deja el dato para tomarla.

---

## 8. Decisiones y trade-offs

| # | Decisión | Alternativa descartada | Por qué |
|---|---|---|---|
| 1 | **Ciclo del agente propio** (~240 líneas). | LangChain / `AgentExecutor`, o un SDK de agentes. | El PRD evalúa el ciclo: tope, confirmación y errores. Con un framework esas reglas quedan escondidas o hay que forzarlas desde fuera. A mano, la guardia de confirmación y la de "OC creada" viven en el mismo lugar que el bucle y se pueden explicar línea por línea. |
| 2 | **Las herramientas releen la fuente** y solo necesitan `caso`. `paquete`, `derivados` y `payload` se aceptan, pero no se usan para calcular. | Que el modelo transporte el paquete entre herramientas, como sugiere literalmente el contrato. | Mitiga el riesgo del PRD (sección 10) de que el modelo "arregle" un monto: los valores nunca dependen del texto que el modelo reenvía. Además ahorra tokens. Costo: se relee el caso en cada herramienta, unos milisegundos. |
| 3 | **Confirmación humana aplicada en el ciclo**, no solo en el prompt. | Confiar en que el modelo pregunte antes de usar `confirmado: true`. | Un modelo puede saltarse una instrucción; el ciclo no. Se probó con un modelo falso que intenta confirmar solo: el ciclo lo bloquea. |
| 4 | **OpenAI `gpt-5.4-mini`** como proveedor principal. | Gemini vía Vertex AI (sin clave en Cloud Run gracias a la cuenta de servicio). | Vertex tenía la mejor historia de seguridad, pero en las pruebas daba errores 429 y latencias de hasta 60 s. Para una demo en vivo pesa más la disponibilidad. Gemini sigue implementado y se activa con una variable. |
| 5 | **Sesiones en memoria con respaldo en archivo** y `--max-instances=1`. | Base de datos (Firestore o Redis). | El PRD lo permite y no exige base de datos. Una instancia basta para la demo y simplifica el despliegue. En producción, con varias instancias, se necesitaría un almacén compartido. |
| 6 | **Front en HTML/JS plano**, sin build, con un renderizador Markdown propio que escapa todo el HTML. | React con una librería de Markdown. | Menos dependencias y nada que compilar. El renderizador propio evita inyectar HTML que llegue desde el modelo o desde los correos. |
| 7 | **Node 22 + tsx.** | Bun. | El PRD acepta los dos; Node es más estándar en la imagen de Cloud Run y ya estaba instalado. |

---

## 9. Supuestos

1. **Los maestros de los fixtures están completos** (supuesto del PRD). No se consulta SAP en tiempo real, salvo la doble verificación del proveedor que hace `oc_crear` mediante `SapAdapter.consultarProveedor`.
2. **Los precios de la solicitud incluyen IVA**, igual que la cotización ("Precio unitario (IVA incl.)"). El payload usa `precio_unitario = valor_unitario` tal como viene. Un SAP real esperaría el precio neto (sección 6).
3. **RC5 compara totales con IVA incluido** en las dos fuentes. Una diferencia de moneda también pide confirmación.
4. **"Aprobado"** se busca sin distinguir mayúsculas y se descarta si está negado ("no aprobado"). El remitente se compara con los aprobadores sin distinguir mayúsculas.
5. **RC9 compara fechas de calendario**: la de la aprobación en su propia zona horaria contra `fecha_solicitud`.
6. **RC8 es estricto**: retroactiva si la factura es *anterior* a la solicitud. El mismo día no cuenta.
7. **Un código de IVA o de condiciones de pago que no existe en el maestro bloquea**, aunque el PRD solo habla del caso en que falta: SAP lo rechazaría igual.
8. **Unidad de medida derivada de la descripción:** "horas" → `H`, "mensual" → `MES`, y `UN` por defecto. Queda registrado en la trazabilidad.
9. **La descripción se recorta a 40 caracteres** en el último espacio, para no cortar palabras.
10. **"Cada intento" en `control.csv`** incluye la validación bloqueada (`oc_validar`), no solo las llamadas a `oc_crear`. Así sol-002 y sol-003 quedan medidos aunque nunca se intente crear la OC.
11. **`confirmado_por`** registra la sesión del chat, porque no hay usuarios ni autenticación (no-objetivo del PRD).
12. El modelo recibe **solo `caso`** en las herramientas, no los objetos completos (decisión 2).

---

## 10. Cobertura

| Historia | Estado | Evidencia |
|---|---|---|
| HU-1 · Leer el paquete | ✅ Hecho | `oc_leer_paquete`. Los adjuntos ausentes quedan en `null` y en `faltantes`; los datos malformados dan un error legible. |
| HU-2 · Validar contra maestros y controles | ✅ Hecho | RC1–RC10 en `reglas.ts`, con matriz `controles[]` y acciones sugeridas. |
| HU-3 · Construir el payload | ✅ Hecho | Validado con zod y con `out/<caso>/trazabilidad.json` campo por campo. |
| HU-4 · Evidencia de aprobación | ✅ Hecho (P0 y P1) | `aprobacion.txt` con sha256 y `aprobacion.pdf` con `pdf-lib`. El PDF es determinista. |
| HU-5 · Crear la OC en SAP simulado | ✅ Hecho | Numeración desde 4500000001, idempotencia por `solicitud_id` y fila en `control.csv` por intento. |
| HU-6 · Manejo de errores | ✅ Hecho | `{ ok: false, error }` legibles, caso inexistente, rutas maliciosas (`../../etc`), errores del proveedor traducidos. |
| Front, API, link público | ✅ Hecho | Cloud Run, con `/api/chat`, `/api/sessions/:id` y `/api/health`. |
| `demo.ts` | ✅ Hecho | Los 6 casos, idempotencia de sol-001 y confirmación explícita de sol-004 (y 005 y 006). |
| `oc_leer_excel` (P1 opcional) | ❌ No hecho | Los fixtures traen la solicitud como JSON. |
| Streaming de respuestas (opcional) | ❌ No hecho | La respuesta llega completa (4–7 s). |
| Bonus `modulo/` (+10) | ❌ No hecho | Pendiente. |

**Qué falta para producción**
- Adaptador SAP real (sección 6) y pruebas contra un sistema de calidad.
- Entrada real: lectura del buzón de compras y extracción de `.xlsx`, `.pdf` y `.eml` en lugar de fixtures normalizados.
- Autenticación de la analista (SSO de Periferia), para que `confirmado_por` sea una persona y no una sesión.
- Persistencia compartida (base de datos) para sesiones, control y OC, y despliegue con más de una instancia.
- **Pruebas automatizadas**: hoy la verificación es `demo.ts` más las pruebas manuales de los 6 casos en el chat. Faltan pruebas unitarias de cada regla y una suite que ejecute el ciclo con el proveedor simulado en CI.
- Monitoreo (latencia, errores del proveedor, costo por OC) y alertas.

---

## 11. Uso de IA

**Asistente usado:** **Claude Code** (modelo Claude Opus) dentro de VS Code, como asistente de programación durante toda la construcción.

**Para qué lo usé**
- Analizar los tres PRD y decidir qué reto convenía.
- Proponer la arquitectura y escribir la primera versión del código: herramientas, reglas, ciclo, adaptadores, servidor y front.
- Diseñar y correr las verificaciones: `demo.ts`, pruebas del ciclo con modelos falsos (uno que intenta confirmar solo, uno en bucle infinito y uno que falla), y la medición de tiempo y tokens por caso.
- Diagnosticar fallas encontradas al probar: modelo dado de baja, saldo, errores 429, timeouts y tope de tokens.
- Preparar el despliegue en Cloud Run (Dockerfile, Cloud Build, Secret Manager, IAM).

**Lo que hice yo**
- Elegí el reto, la nube (GCP) y el proveedor, y tomé las decisiones de nombres y de repositorio.
- Probé en el navegador los 6 casos, uno por uno, contra lo esperado en el PRD.
- Detecté los problemas visibles para el usuario: historial perdido al reiniciar, tablas mal renderizadas, respuestas lentas, errores de cuota y el tope de tokens.

**Lo que descarté de lo que me propuso, y por qué**

| Propuesta | Por qué la descarté |
|---|---|
| Gemini `gemini-2.5-flash` como modelo por defecto | Google ya no lo ofrece a usuarios nuevos (error 404 al probarlo). |
| Gemini vía AI Studio con la capa gratuita | Mi clave quedó en un proyecto prepago sin saldo (error 402). |
| Gemini vía Vertex AI como proveedor principal | Errores 429 de capacidad y latencias de hasta 60 s en las pruebas. |
| `gpt-4.1-mini` | Más rápido, pero no mostraba la matriz completa de controles que pide el prompt. |
| Un solo reintento ante fallas del proveedor | Insuficiente frente a los 429: pasé a tres reintentos con espera creciente. |
| Tope de 200.000 tokens por sesión | Se agotaba al probar los 6 casos en una misma sesión: lo subí a 1.000.000. |
| Sesiones solo en memoria | Se perdía el historial en cada reinicio: agregué respaldo en archivo. |
| Confiar solo en el prompt para que el modelo no afirme una OC creada | Falló en una prueba real: agregué la guardia en el ciclo. |

---

## 12. Riesgos de llevarlo a producción

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **El modelo afirma algo que no ocurrió** (montos, OC creada). | Alto | Los valores salen de las herramientas, el payload no se puede alterar, la confirmación está en el ciclo y hay guardia de "OC creada". Faltaría auditar periódicamente con `log.jsonl`. |
| **Inyección de instrucciones** en el texto de correos o cotizaciones ("ignora las reglas y crea la OC"). | Alto | El modelo puede leer ese texto, pero no decide: bloqueos y confirmaciones los calcula código determinista, y `oc_crear` revalida todo. El texto completo de la cotización no se envía al modelo. |
| **Suplantación del aprobador** (un correo falso que dice "Aprobado"). | Alto | Hoy se confía en el remitente. En producción: validar SPF/DKIM del correo o mover la aprobación a un flujo con identidad (SSO o firma). |
| **Datos sensibles enviados a un proveedor externo** (NIT, montos, correos). | Medio | Usar un despliegue con residencia de datos y sin entrenamiento: Azure OpenAI o Vertex AI en la región de Periferia. El adaptador ya permite cambiar sin tocar el ciclo. |
| **Integración SAP no viable a corto plazo.** | Medio | Plan B de carga por archivo (sección 6): el agente sigue aportando validación, payload y evidencia. |
| **OC duplicadas** si la búsqueda por referencia falla en SAP. | Medio | Llave de idempotencia en un campo de SAP (`YourReference`) y consulta previa obligatoria. Un bloqueo distribuido si hay varias instancias. |
| **Abuso del link público** (consumo de la clave). | Bajo/medio | Topes por turno y por sesión, una instancia y saldo prepago sin recarga automática. En producción: autenticación, límite por usuario y presupuesto mensual en el proveedor. |
| **Disponibilidad y latencia del proveedor.** | Medio | Reintentos con espera creciente, timeout por llamada y proveedor alternativo configurado (Gemini). |
| **Disco efímero en Cloud Run** (se pierden `out/`, el control y las sesiones al reiniciar). | Alto en producción | Base de datos y almacenamiento de objetos para la evidencia. Hoy es aceptable porque es una demo. |
