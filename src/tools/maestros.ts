import { join } from "node:path"
import { z } from "zod"
import { leerJsonOpcional, rutas } from "../lib/archivos"
import { CentroCosto, CondicionPago, IndicadorIva, type Maestros, ProveedorMaestro } from "./tipos"

export async function cargarMaestros(dir: string): Promise<Maestros> {
  const base = rutas.maestros(dir)
  const leer = async <T>(archivo: string, esquema: z.ZodType<T>): Promise<T[]> => {
    const crudo = await leerJsonOpcional(join(base, archivo))
    if (crudo === null) throw new Error(`Falta el maestro ${archivo}`)
    const r = z.array(esquema).safeParse(crudo)
    if (!r.success) throw new Error(`Maestro ${archivo} con formato inválido: ${r.error.issues[0]?.message}`)
    return r.data
  }
  return {
    proveedores: await leer("proveedores.json", ProveedorMaestro),
    centrosCosto: await leer("centros-costo.json", CentroCosto),
    indicadoresIva: await leer("indicadores-iva.json", IndicadorIva),
    condicionesPago: await leer("condiciones-pago.json", CondicionPago),
  }
}

/** NIT sin puntos, espacios ni dígito de verificación: "900.555.111-2" → "900555111". */
export function normalizarNit(nit: string): string {
  return nit.split("-")[0]!.replace(/\D/g, "")
}

/** Nombre comparable: sin tildes, sin mayúsculas, sin signos ni sufijos societarios. */
export function normalizarNombre(nombre: string): string {
  return nombre
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[.,]/g, "")
    .replace(/\b(sas|sa|ltda|s en c|eu)\b/g, "")
    .replace(/\s+/g, " ")
    .trim()
}

export type BusquedaProveedor = { proveedor: ProveedorMaestro; por: "nit" | "nombre" } | null

export function buscarProveedor(maestros: Maestros, nit: string | undefined, nombre: string): BusquedaProveedor {
  if (nit) {
    const n = normalizarNit(nit)
    const p = maestros.proveedores.find((x) => normalizarNit(x.nit) === n)
    return p ? { proveedor: p, por: "nit" } : null
  }
  const objetivo = normalizarNombre(nombre)
  const p = maestros.proveedores.find((x) => normalizarNombre(x.nombre) === objetivo)
  return p ? { proveedor: p, por: "nombre" } : null
}
