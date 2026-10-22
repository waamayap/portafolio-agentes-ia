import { join } from "node:path"
import type { z } from "zod"
import { leerJsonOpcional, leerTextoOpcional, rutas } from "../lib/archivos"
import { normalizarNit } from "./maestros"
import {
  type Aprobacion,
  AprobacionCruda,
  type Cotizacion,
  CorreoEntrada,
  type Factura,
  type Paquete,
  Solicitud,
} from "./tipos"

/**
 * Lee los adjuntos normalizados de un caso (PRD 7.1) y los devuelve como `Paquete` (PRD 7.2).
 * Un adjunto opcional ausente queda en `null` y se lista en `faltantes`; los obligatorios
 * (correo y solicitud) o un dato malformado lanzan un Error con mensaje legible.
 */
export async function leerPaquete(dir: string, caso: string): Promise<Paquete> {
  const base = rutas.caso(dir, caso)
  const faltantes: string[] = []

  const correoCrudo = await leerJsonOpcional(join(base, "correo.json"))
  if (correoCrudo === null) throw new Error(`El caso "${caso}" no existe o no tiene correo.json`)
  const correo = parsear(CorreoEntrada, correoCrudo, "correo.json")

  const solicitudCruda = await leerJsonOpcional(join(base, "solicitud.json"))
  if (solicitudCruda === null) throw new Error("Falta la solicitud (solicitud.xlsx / solicitud.json)")
  const solicitud = parsear(Solicitud, solicitudCruda, "solicitud.json")

  const textoCotizacion = await leerTextoOpcional(join(base, "cotizacion.txt"))
  if (textoCotizacion === null) faltantes.push("cotizacion (cotizacion.pdf)")
  const cotizacion = textoCotizacion === null ? null : parsearCotizacion(textoCotizacion)

  const aprobacionCruda = await leerJsonOpcional(join(base, "aprobacion.json"))
  if (aprobacionCruda === null) faltantes.push("aprobacion (aprobacion.eml)")
  const aprobacion =
    aprobacionCruda === null ? null : normalizarAprobacion(parsear(AprobacionCruda, aprobacionCruda, "aprobacion.json"))

  const textoFactura = await leerTextoOpcional(join(base, "factura.txt"))
  const factura = textoFactura === null ? null : parsearFactura(textoFactura)

  return { correo: { id: correo.id, de: correo.de, asunto: correo.asunto, fecha: correo.fecha }, solicitud, cotizacion, aprobacion, factura, faltantes }
}

export async function leerAprobacionCruda(dir: string, caso: string): Promise<AprobacionCruda | null> {
  const cruda = await leerJsonOpcional(join(rutas.caso(dir, caso), "aprobacion.json"))
  return cruda === null ? null : parsear(AprobacionCruda, cruda, "aprobacion.json")
}

function parsear<T>(esquema: z.ZodType<T>, valor: unknown, archivo: string): T {
  const r = esquema.safeParse(valor)
  if (r.success) return r.data
  const problemas = r.error.issues.map((i) => `${i.path.join(".") || "(raíz)"}: ${i.message}`).join("; ")
  throw new Error(`${archivo} inválido → ${problemas}`)
}

/** "Aprobado" en el cuerpo, salvo que esté negado ("no aprobado"). */
export function contieneAprobado(texto: string): boolean {
  return /\baprobad[oa]\b/i.test(texto) && !/\bno\s+(est[aá]\s+)?aprobad[oa]\b/i.test(texto)
}

function normalizarAprobacion(a: AprobacionCruda): Aprobacion {
  return { de: a.de.trim().toLowerCase(), fecha: a.fecha, aprobado: contieneAprobado(a.cuerpo), texto: a.cuerpo }
}

/** Monto en formato colombiano: "COP 11.400.000" → 11400000; "1.234,50" → 1234.5. */
export function parsearMonto(texto: string): number | null {
  const limpio = texto.replace(/[^\d.,]/g, "").replace(/\./g, "").replace(",", ".")
  if (limpio === "") return null
  const n = Number(limpio)
  return Number.isFinite(n) ? n : null
}

function campo(texto: string, etiqueta: RegExp): string | null {
  const m = texto.match(etiqueta)
  return m?.[1]?.trim() ?? null
}

export function parsearCotizacion(texto: string): Cotizacion | null {
  const lineaTotal = campo(texto, /^TOTAL[^:\n]*:\s*(.+)$/im)
  const total = lineaTotal === null ? null : parsearMonto(lineaTotal)
  if (total === null) return null
  const nit = campo(texto, /^NIT:\s*(.+)$/im)
  const fecha = campo(texto, /^Fecha:\s*(\d{4}-\d{2}-\d{2})/im)
  const dias = campo(texto, /^Validez[^:\n]*:\s*(\d+)\s*d[ií]as/im)
  return {
    numero: campo(texto, /^COTIZACI[ÓO]N\s+(\S+)/im),
    proveedor: campo(texto, /^Proveedor:\s*(.+)$/im) ?? "",
    nit: nit === null ? null : normalizarNit(nit),
    total,
    moneda: lineaTotal?.match(/\b(COP|USD)\b/)?.[1] ?? "COP",
    fecha,
    validez_hasta: fecha && dias ? sumarDias(fecha, Number(dias)) : null,
    texto,
  }
}

export function parsearFactura(texto: string): Factura | null {
  const numero = campo(texto, /No\.\s*(\S+)/i)
  const fecha = campo(texto, /^Fecha[^:\n]*:\s*(\d{4}-\d{2}-\d{2})/im)
  const lineaTotal = campo(texto, /^TOTAL[^:\n]*:\s*(.+)$/im)
  const total = lineaTotal === null ? null : parsearMonto(lineaTotal)
  if (!numero || !fecha || total === null) return null
  return { numero, fecha, total }
}

function sumarDias(fechaISO: string, dias: number): string {
  const d = new Date(`${fechaISO}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + dias)
  return d.toISOString().slice(0, 10)
}
