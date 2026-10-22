import type { LlamadaHerramienta, Mensaje, ProveedorLLM } from "../llm/adapter"
import { definicionesParaModelo, HERRAMIENTAS } from "./herramientas"

export type Limites = {
  /** CA1: vueltas herramienta → modelo por turno. */
  maxIteraciones: number
  /** Costo: tokens acumulados por sesión. */
  maxTokensSesion: number
  /** Robustez: espera máxima por respuesta del proveedor. */
  timeoutMs: number
}

/** Lo que el front muestra de cada llamada (CA4): nombre, argumentos y resultado resumido. */
export type EventoHerramienta = {
  nombre: string
  argumentos: Record<string, unknown>
  ok: boolean
  resumen: string
}

export type TurnoVisible = {
  rol: "usuario" | "agente"
  texto: string
  ts: string
  llamadas?: EventoHerramienta[]
  necesitaConfirmacion?: boolean
  error?: boolean
}

export type Sesion = {
  id: string
  mensajes: Mensaje[]
  visible: TurnoVisible[]
  tokens: number
  /** Casos que quedaron esperando confirmación humana al final del turno anterior (CA3). */
  pendientes: Set<string>
  ocupada: boolean
}

export type ResultadoTurno = {
  reply: string
  toolCalls: EventoHerramienta[]
  needsConfirmation: boolean
  pendientes: string[]
  error?: boolean
}

export function nuevaSesion(id: string): Sesion {
  return { id, mensajes: [], visible: [], tokens: 0, pendientes: new Set(), ocupada: false }
}

/** "confirmo", "sí, créala", "dale"… pero no "no", "espera" ni "cancela". */
export function esConfirmacion(texto: string): boolean {
  const t = texto.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase().trim()
  if (/^(no\b|espera|cancela|aun no|todavia no)|\bno (la )?(crees|confirmo)\b/.test(t)) return false
  return /\b(confirmo|confirmado|si|procede|proceder|adelante|dale|creala|crear la oc|de acuerdo|ok|okay|apruebo)\b/.test(t)
}

type Dependencias = { llm: ProveedorLLM; sistema: string; directorio: string; limites: Limites }

/**
 * Un turno del agente: mensaje del usuario → (modelo → herramientas)* → respuesta.
 * Las reglas de seguridad viven aquí, no en el prompt: el modelo no puede saltárselas.
 */
export async function ejecutarTurno(sesion: Sesion, textoUsuario: string, deps: Dependencias): Promise<ResultadoTurno> {
  const { llm, limites } = deps
  const inicio = sesion.mensajes.length
  const eventos: EventoHerramienta[] = []
  // CA3: confirmado=true solo vale si el usuario confirma justo después de que el agente preguntó.
  const confirmados = esConfirmacion(textoUsuario) ? new Set(sesion.pendientes) : new Set<string>()
  const pendientes = new Set(sesion.pendientes)

  sesion.mensajes.push({ rol: "usuario", texto: textoUsuario })
  sesion.visible.push({ rol: "usuario", texto: textoUsuario, ts: new Date().toISOString() })

  const terminar = (reply: string, error = false): ResultadoTurno => {
    sesion.pendientes = pendientes
    const needsConfirmation = !error && pendientes.size > 0
    sesion.visible.push({ rol: "agente", texto: reply, ts: new Date().toISOString(), llamadas: eventos, necesitaConfirmacion: needsConfirmation, error })
    return { reply, toolCalls: eventos, needsConfirmation, pendientes: [...pendientes], error }
  }

  if (sesion.tokens >= limites.maxTokensSesion) {
    sesion.mensajes.length = inicio
    return terminar(`Esta sesión alcanzó el tope de ${limites.maxTokensSesion.toLocaleString("es-CO")} tokens (control de costo). Pulsa **Nueva sesión** para continuar: lo ya creado se conserva.`, true)
  }

  let corregido = false
  try {
    for (let vuelta = 0; vuelta < limites.maxIteraciones; vuelta++) {
      const respuesta = await conReintento(() =>
        conTimeout(limites.timeoutMs, (signal) => llm.enviar(sesion.mensajes, definicionesParaModelo(), { sistema: deps.sistema, signal })),
      )
      sesion.tokens += respuesta.tokens.entrada + respuesta.tokens.salida
      sesion.mensajes.push({ rol: "asistente", texto: respuesta.texto, llamadas: respuesta.llamadas, crudo: respuesta.crudo })

      if (respuesta.llamadas.length === 0) {
        const texto = respuesta.texto.trim() || "(El modelo no devolvió texto.)"
        // CA2: el modelo no puede afirmar que creó una OC si oc_crear no lo confirmó en este turno.
        if (afirmaCreacion(texto) && !eventos.some((e) => e.nombre === "oc_crear" && e.ok)) {
          if (!corregido) {
            corregido = true
            sesion.mensajes.push({ rol: "usuario", texto: CORRECCION_CREACION })
            continue
          }
          return terminar(`${texto}\n\n> ⚠️ Verificación del sistema: en este turno no se ejecutó \`oc_crear\`, así que **la OC no fue creada**.`)
        }
        return terminar(texto)
      }

      const resultados = []
      for (const llamada of respuesta.llamadas) {
        const resultado = await ejecutarLlamada(llamada, sesion, confirmados, deps.directorio)
        actualizarPendientes(llamada, resultado, pendientes)
        eventos.push({ nombre: llamada.nombre, argumentos: llamada.argumentos, ok: resultado.ok, resumen: resultado.resumen })
        resultados.push({ id: llamada.id, nombre: llamada.nombre, resultado: resultado.json })
      }
      sesion.mensajes.push({ rol: "herramientas", resultados })

      if (sesion.tokens >= limites.maxTokensSesion) break
    }
    // CA1 / costo: tope alcanzado → se responde con lo que hay y lo que falta, sin otra llamada al modelo.
    const hecho = eventos.map((e) => `- ${e.nombre}: ${e.ok ? e.resumen : `error: ${e.resumen}`}`).join("\n")
    const porTokens = sesion.tokens >= limites.maxTokensSesion
    const motivo = porTokens
      ? `Esta sesión alcanzó el tope de ${limites.maxTokensSesion.toLocaleString("es-CO")} tokens (control de costo).`
      : `Alcancé el límite de ${limites.maxIteraciones} pasos en este turno.`
    const siguiente = porTokens
      ? 'Pulsa **Nueva sesión** y vuelve a pedir el caso: lo ya creado se conserva y la OC no se duplica.'
      : 'Escribe "continúa" si quieres que siga.'
    return terminar(`${motivo}\n\n**Lo que alcancé a hacer:**\n${hecho || "- (nada)"}\n\n**Falta:** terminar el caso. ${siguiente}`, porTokens)
  } catch (e) {
    // CA5: el error se muestra claro y la sesión sigue viva. Se descarta el turno incompleto del historial del modelo.
    sesion.mensajes.length = inicio
    return terminar(mensajeErrorProveedor(e, llm.nombre), true)
  }
}

const CORRECCION_CREACION =
  "[Verificación automática del sistema, no es un mensaje del usuario] Tu respuesta dice que la OC fue creada, pero en este turno no llamaste oc_crear o no tuvo éxito: la OC no existe. Si corresponde crearla (sin bloqueos, sin confirmaciones pendientes y sin que el usuario pidiera esperar), llama oc_crear ahora. Si no, corrige tu respuesta sin afirmar que se creó."

/** "OC creada", "se creó la orden de compra"… revisado frase por frase; "no se creó la OC" no cuenta. */
function afirmaCreacion(texto: string): boolean {
  const afirma = /\b(OC|orden(es)? de compra)\b[^|]{0,40}\b(cread[ao]|registrad[ao])\b|\bse (cre[oó]|registr[oó]) (la |una )?(OC|orden)/i
  return texto.split(/[.\n!?¡¿]/).some((frase) => afirma.test(frase) && !/\b(no|sin|nunca|a[uú]n no)\b/i.test(frase))
}

type ResultadoLlamada ={ ok: boolean; resumen: string; json: string; data?: unknown }

async function ejecutarLlamada(
  llamada: LlamadaHerramienta,
  sesion: Sesion,
  confirmados: Set<string>,
  directorio: string,
): Promise<ResultadoLlamada> {
  const herramienta = HERRAMIENTAS[llamada.nombre]
  if (!herramienta) return rechazo(`La herramienta "${llamada.nombre}" no existe. Disponibles: ${Object.keys(HERRAMIENTAS).join(", ")}.`)

  const caso = typeof llamada.argumentos.caso === "string" ? llamada.argumentos.caso : null
  if (llamada.nombre === "oc_crear" && llamada.argumentos.confirmado === true && (!caso || !confirmados.has(caso))) {
    return rechazo(
      "Bloqueado por el ciclo del agente: confirmado=true solo se acepta cuando el usuario confirma explícitamente en su último mensaje, después de que le preguntaste por este mismo caso. Muéstrale las confirmaciones y pregúntale.",
    )
  }

  // La herramienta valida sus argumentos con zod y nunca lanza (ver definirHerramienta).
  const json = await herramienta.execute(llamada.argumentos, { directory: directorio, sessionId: sesion.id })
  const r = JSON.parse(json) as { ok: boolean; resumen?: string; error?: string; data?: unknown }
  return { ok: r.ok, resumen: r.ok ? (r.resumen ?? "ok") : (r.error ?? "error"), json: quitarResumen(r), data: r.data }
}

/** El resumen es para la interfaz y el log; al modelo le basta { ok, data | error }. */
function quitarResumen(r: { resumen?: string }): string {
  const { resumen: _omitido, ...resto } = r
  return JSON.stringify(resto)
}

function rechazo(error: string): ResultadoLlamada {
  return { ok: false, resumen: error, json: JSON.stringify({ ok: false, error }) }
}

/** Qué casos quedan esperando confirmación humana después de esta llamada. */
function actualizarPendientes(llamada: LlamadaHerramienta, r: ResultadoLlamada, pendientes: Set<string>): void {
  const caso = typeof llamada.argumentos.caso === "string" ? llamada.argumentos.caso : null
  if (!caso) return
  if (llamada.nombre === "oc_crear") {
    if (r.ok) pendientes.delete(caso)
    else if (r.resumen.startsWith("requiere confirmación")) pendientes.add(caso)
    return
  }
  if (llamada.nombre === "oc_validar" && r.ok) {
    const v = r.data as { apta: boolean; confirmaciones: unknown[] }
    if (v.apta && v.confirmaciones.length > 0) pendientes.add(caso)
    else pendientes.delete(caso)
  }
}

const ESPERAS_REINTENTO_MS = [2_000, 4_000, 8_000]

/**
 * Hasta 3 reintentos con espera creciente ante fallas transitorias (timeout, 429 por capacidad, 5xx).
 * Credencial inválida o falta de saldo no se reintentan: repetir no lo arregla.
 */
async function conReintento<T>(fn: () => Promise<T>): Promise<T> {
  for (let intento = 0; ; intento++) {
    try {
      return await fn()
    } catch (e) {
      const mensaje = e instanceof Error ? e.message : String(e)
      const transitorio = /timeout|abort|429|5\d\d|unavailable|overloaded|deadline|resource_exhausted/i.test(mensaje)
      const sinSaldo = /insufficient_quota|credits|billing|prepay/i.test(mensaje)
      const espera = ESPERAS_REINTENTO_MS[intento]
      if (!transitorio || sinSaldo || espera === undefined) throw e
      await new Promise((r) => setTimeout(r, espera))
    }
  }
}

async function conTimeout<T>(ms: number, fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const control = new AbortController()
  const reloj = setTimeout(() => control.abort(new Error(`timeout de ${ms / 1000} s`)), ms)
  try {
    return await fn(control.signal)
  } finally {
    clearTimeout(reloj)
  }
}

function mensajeErrorProveedor(e: unknown, proveedor: string): string {
  const crudo = e instanceof Error ? e.message : String(e)
  // Nunca devolver la clave, aunque algún SDK la incluya en el mensaje.
  const limpio = crudo.replace(/(key=|api[_-]?key["':= ]+)[\w-]+/gi, "$1***").slice(0, 300)
  let causa = "error inesperado"
  if (/timeout|abort/i.test(crudo)) causa = "el modelo tardó demasiado en responder"
  else if (/402|insufficient_quota|credits|billing|prepay/i.test(crudo)) causa = "la cuenta del modelo no tiene saldo o facturación activa"
  else if (/429|quota|rate|resource_exhausted/i.test(crudo)) causa = "se alcanzó el límite de uso del modelo (cuota)"
  else if (/401|403|permission|api key/i.test(crudo)) causa = "la credencial del modelo no es válida o no tiene permisos"
  else if (/404|not found|no longer available/i.test(crudo)) causa = "el modelo configurado no está disponible (revisa GEMINI_MODEL)"
  else if (/5\d\d|unavailable|overloaded/i.test(crudo)) causa = "el servicio del modelo no está disponible en este momento"
  return `⚠️ No pude completar la respuesta: ${causa} (${proveedor}).\n\nTu sesión sigue activa; vuelve a intentarlo en unos segundos.\n\nDetalle técnico: ${limpio}`
}
