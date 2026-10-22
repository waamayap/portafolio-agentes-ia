import { readdir } from "node:fs/promises"
import { join } from "node:path"
import { z } from "zod"
import { escribirArchivo, PATRON_CASO, rutaRelativa, rutas } from "../lib/archivos"
import { SapMock } from "../sap/mock"
import { registrarControl } from "./control"
import { generarEvidencia } from "./evidencia"
import { definirHerramienta, exito, fallo } from "./herramienta"
import { cargarMaestros } from "./maestros"
import { leerAprobacionCruda, leerPaquete } from "./paquete"
import { construirOrden } from "./payload"
import { validarPaquete } from "./reglas"
import { OrdenCompra, type Validacion } from "./tipos"

// Cada export es una herramienta; el modelo la ve como `oc_<export>` (PRD 6.2).

const caso = z.string().regex(PATRON_CASO, "nombre de carpeta inválido").describe("Carpeta del caso en fixtures/reto-03/solicitudes/, por ejemplo \"sol-004\"")

/** Relee el caso desde disco y lo valida. Las herramientas nunca confían en datos que les pase el modelo. */
async function prepararCaso(dir: string, nombre: string) {
  const [paquete, maestros] = await Promise.all([leerPaquete(dir, nombre), cargarMaestros(dir)])
  return { paquete, validacion: validarPaquete(paquete, maestros) }
}

const codigos = (v: Validacion, tipo: "bloqueos" | "confirmaciones") => v[tipo].map((h) => `${h.codigo}: ${h.detalle}`)

export const listar_casos = definirHerramienta(
  "oc_listar_casos",
  "Lista las solicitudes de compra disponibles (carpeta, id de solicitud y asunto del correo).",
  {},
  async (_args, ctx) => {
    const carpetas = (await readdir(rutas.solicitudes(ctx.directory), { withFileTypes: true }))
      .filter((d) => d.isDirectory())
      .map((d) => d.name)
      .sort()
    const casos = await Promise.all(
      carpetas.map(async (c) => {
        try {
          const p = await leerPaquete(ctx.directory, c)
          return { caso: c, solicitud_id: p.solicitud.solicitud_id, asunto: p.correo.asunto }
        } catch (e) {
          return { caso: c, error: e instanceof Error ? e.message : String(e) }
        }
      }),
    )
    return exito({ casos }, `${casos.length} casos disponibles`)
  },
)

export const leer_paquete = definirHerramienta(
  "oc_leer_paquete",
  "Lee el correo, la solicitud, la cotización, la aprobación y la factura (si hay) de un caso y los devuelve normalizados.",
  { caso },
  async (args, ctx) => {
    const p = await leerPaquete(ctx.directory, args.caso)
    const resumen = `${p.solicitud.solicitud_id} · ${p.solicitud.proveedor_nombre} · ${p.solicitud.moneda} ${p.solicitud.valor_total.toLocaleString("es-CO")}${p.faltantes.length ? ` · faltan: ${p.faltantes.join(", ")}` : ""}${p.factura ? " · trae factura" : ""}`
    // El texto completo de la cotización no aporta al modelo y gasta tokens: se omite.
    const cotizacion = p.cotizacion ? { ...p.cotizacion, texto: undefined } : null
    return exito({ ...p, cotizacion }, resumen)
  },
)

export const validar = definirHerramienta(
  "oc_validar",
  "Aplica los controles RC1–RC10 al caso contra los maestros y devuelve si la OC es apta, sus bloqueos, las confirmaciones requeridas, los valores derivados y si es retroactiva.",
  {
    caso,
    paquete: z.unknown().optional().describe("Opcional. No es necesario: la herramienta relee el caso desde la fuente para que nadie altere los datos."),
  },
  async (args, ctx) => {
    const { validacion } = await prepararCaso(ctx.directory, args.caso)
    if (validacion.bloqueos.length > 0) {
      await registrarControl(ctx.directory, {
        solicitud_id: validacion.solicitud_id,
        resultado: "bloqueada",
        numero_oc: null,
        retroactiva: validacion.retroactiva,
        bloqueos: codigos(validacion, "bloqueos"),
        confirmaciones: codigos(validacion, "confirmaciones"),
      })
    }
    const resumen = validacion.apta
      ? `apta · ${validacion.confirmaciones.length} confirmación(es)${validacion.retroactiva ? " · RETROACTIVA" : ""}`
      : `NO apta · bloqueos: ${validacion.bloqueos.map((b) => b.codigo).join(", ")}`
    return exito(validacion, resumen)
  },
)

export const generar_evidencia = definirHerramienta(
  "oc_generar_evidencia",
  "Genera la evidencia de aprobación del líder (aprobacion.txt y aprobacion.pdf en out/<caso>/) y devuelve su sha256.",
  { caso },
  async (args, ctx) => {
    const { paquete } = await prepararCaso(ctx.directory, args.caso)
    const cruda = await leerAprobacionCruda(ctx.directory, args.caso)
    if (!cruda) return fallo("El caso no tiene correo de aprobación; no hay evidencia que generar. Pedir al solicitante la aprobación del líder.")
    const ev = await generarEvidencia(ctx.directory, args.caso, paquete.solicitud.solicitud_id, cruda)
    const data = {
      ruta: rutaRelativa(ctx.directory, ev.ruta_txt),
      ruta_pdf: rutaRelativa(ctx.directory, ev.ruta_pdf),
      sha256: ev.sha256,
    }
    return exito(data, `${data.ruta} · sha256 ${ev.sha256.slice(0, 12)}…`)
  },
)

/** Construye la OC del caso desde la fuente (paquete + validación + evidencia). Compartido por construir_payload y crear. */
async function ordenDelCaso(dir: string, nombre: string) {
  const { paquete, validacion } = await prepararCaso(dir, nombre)
  if (!validacion.apta) return { paquete, validacion, orden: null, trazabilidad: null, evidencia: null }
  const cruda = await leerAprobacionCruda(dir, nombre)
  if (!cruda) throw new Error("El caso no tiene correo de aprobación.")
  const evidencia = await generarEvidencia(dir, nombre, paquete.solicitud.solicitud_id, cruda)
  const { orden, trazabilidad } = construirOrden(paquete, validacion, evidencia.sha256)
  return { paquete, validacion, orden, trazabilidad, evidencia }
}

export const construir_payload = definirHerramienta(
  "oc_construir_payload",
  "Construye la orden de compra exactamente como quedaría en SAP (validada con zod), con la fuente de cada valor; no la crea.",
  {
    caso,
    paquete: z.unknown().optional().describe("Opcional. No es necesario: se relee desde la fuente."),
    derivados: z.unknown().optional().describe("Opcional. No es necesario: se recalculan con oc_validar."),
  },
  async (args, ctx) => {
    const { validacion, orden, trazabilidad } = await ordenDelCaso(ctx.directory, args.caso)
    if (!orden) {
      return fallo(`La solicitud tiene bloqueos y no se puede construir la OC: ${codigos(validacion, "bloqueos").join(" · ")}`, {
        bloqueos: validacion.bloqueos,
      })
    }
    const base = rutas.outCaso(ctx.directory, args.caso)
    await escribirArchivo(join(base, "payload.json"), JSON.stringify(orden, null, 2))
    await escribirArchivo(join(base, "trazabilidad.json"), JSON.stringify(trazabilidad, null, 2))
    const data = {
      orden,
      ruta_trazabilidad: rutaRelativa(ctx.directory, join(base, "trazabilidad.json")),
      trazabilidad,
      confirmaciones_pendientes: validacion.confirmaciones,
      retroactiva: validacion.retroactiva,
    }
    const p = orden.posiciones[0]!
    const total = p.cantidad * p.precio_unitario
    return exito(data, `${orden.proveedor.nombre} · ${orden.moneda} ${total.toLocaleString("es-CO")} · ${orden.excepciones.length} excepción(es)`)
  },
)

/** JSON con claves ordenadas, para comparar dos objetos sin importar el orden de sus campos. */
function canonico(valor: unknown): string {
  if (Array.isArray(valor)) return `[${valor.map(canonico).join(",")}]`
  if (valor !== null && typeof valor === "object") {
    const entradas = Object.entries(valor as Record<string, unknown>).sort(([a], [b]) => a.localeCompare(b))
    return `{${entradas.map(([k, v]) => `${JSON.stringify(k)}:${canonico(v)}`).join(",")}}`
  }
  return JSON.stringify(valor)
}

export const crear = definirHerramienta(
  "oc_crear",
  "Crea la orden de compra en SAP si no tiene bloqueos; si tiene confirmaciones, exige confirmado=true, que solo se envía después de que el usuario confirme explícitamente.",
  {
    caso,
    payload: z.unknown().optional().describe("Opcional. Si se envía, debe ser idéntico al de oc_construir_payload; si difiere, se rechaza."),
    confirmado: z.boolean().optional().describe("true solo si el usuario confirmó explícitamente las excepciones en su último mensaje."),
  },
  async (args, ctx) => {
    const sap = new SapMock(ctx.directory)
    const { paquete, validacion, orden, evidencia } = await ordenDelCaso(ctx.directory, args.caso)
    const solicitudId = paquete.solicitud.solicitud_id
    const control = {
      solicitud_id: solicitudId,
      retroactiva: validacion.retroactiva,
      bloqueos: codigos(validacion, "bloqueos"),
      confirmaciones: codigos(validacion, "confirmaciones"),
    }

    // Idempotencia: la misma solicitud nunca genera una segunda OC.
    const existente = await sap.buscarOrdenPorReferencia(solicitudId)
    if (existente) {
      await registrarControl(ctx.directory, { ...control, resultado: "idempotente", numero_oc: existente.numero_oc })
      return exito(
        {
          numero_oc: existente.numero_oc,
          fecha: null,
          idempotente: true,
          retroactiva: validacion.retroactiva,
          evidencia: evidencia ? rutaRelativa(ctx.directory, evidencia.ruta_pdf) : null,
        },
        `ya existía la OC ${existente.numero_oc} (idempotente)`,
      )
    }

    if (!orden || !evidencia) {
      await registrarControl(ctx.directory, { ...control, resultado: "bloqueada", numero_oc: null })
      return fallo(`No se crea la OC: ${control.bloqueos.join(" · ")}`, { bloqueos: validacion.bloqueos })
    }

    if (args.payload !== undefined) {
      const recibido = OrdenCompra.safeParse(args.payload)
      if (!recibido.success || canonico(recibido.data) !== canonico(orden)) {
        await registrarControl(ctx.directory, { ...control, resultado: "error", numero_oc: null })
        return fallo("El payload recibido no coincide con el validado por oc_construir_payload. Los valores de la OC solo salen de las herramientas; vuelve a llamar sin modificarlo.")
      }
    }

    if (validacion.confirmaciones.length > 0 && args.confirmado !== true) {
      await registrarControl(ctx.directory, { ...control, resultado: "pendiente_confirmacion", numero_oc: null })
      return fallo(`requiere confirmación explícita del usuario: ${control.confirmaciones.join(" · ")}`, {
        confirmaciones: validacion.confirmaciones,
      })
    }

    // Doble verificación contra SAP antes de crear (en producción el maestro puede haber cambiado).
    const enSap = await sap.consultarProveedor(orden.proveedor.nit)
    if (!enSap?.activo) {
      await registrarControl(ctx.directory, { ...control, resultado: "bloqueada", numero_oc: null })
      return fallo(`SAP reporta el proveedor ${orden.proveedor.nit} como inexistente o inactivo.`)
    }

    const final: OrdenCompra = {
      ...orden,
      excepciones: orden.excepciones.map((e) => ({ ...e, confirmado_por: `analista (sesión ${ctx.sessionId})` })),
    }
    const { numero_oc, fecha } = await sap.crearOrden(final)
    await escribirArchivo(join(rutas.outCaso(ctx.directory, args.caso), "orden-creada.json"), JSON.stringify({ numero_oc, fecha, orden: final }, null, 2))
    await registrarControl(ctx.directory, { ...control, resultado: "creada", numero_oc })
    return exito(
      {
        numero_oc,
        fecha,
        idempotente: false,
        retroactiva: validacion.retroactiva,
        evidencia: rutaRelativa(ctx.directory, evidencia.ruta_pdf),
        evidencia_sha256: evidencia.sha256,
      },
      `OC ${numero_oc} creada${validacion.retroactiva ? " · marcada RETROACTIVA" : ""}`,
    )
  },
)
