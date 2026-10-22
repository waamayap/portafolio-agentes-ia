import { join } from "node:path"
import { agregarLinea, leerTextoOpcional, rutas } from "../lib/archivos"
import { cargarMaestros, normalizarNit } from "../tools/maestros"
import type { OrdenCompra } from "../tools/tipos"
import type { SapAdapter } from "./adapter"

const PRIMER_NUMERO_OC = 4500000001

type RegistroOrden = { numero_oc: string; fecha: string; orden: OrdenCompra }

/** SAP simulado sobre out/sap/ordenes.jsonl: numeración secuencial desde 4500000001. */
export class SapMock implements SapAdapter {
  constructor(private readonly directorio: string) {}

  private get archivo(): string {
    return join(rutas.sap(this.directorio), "ordenes.jsonl")
  }

  private async ordenes(): Promise<RegistroOrden[]> {
    const texto = await leerTextoOpcional(this.archivo)
    if (!texto) return []
    return texto
      .split("\n")
      .filter((l) => l.trim() !== "")
      .map((l) => JSON.parse(l) as RegistroOrden)
  }

  async consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null> {
    const { proveedores } = await cargarMaestros(this.directorio)
    const p = proveedores.find((x) => normalizarNit(x.nit) === normalizarNit(nit))
    return p ? { codigo_sap: p.codigo_sap, activo: p.activo } : null
  }

  async buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null> {
    const existente = (await this.ordenes()).find((o) => o.orden.referencia.solicitud_id === solicitud_id)
    return existente ? { numero_oc: existente.numero_oc } : null
  }

  async crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }> {
    const ordenes = await this.ordenes()
    const numero_oc = String(PRIMER_NUMERO_OC + ordenes.length)
    const fecha = new Date().toISOString()
    await agregarLinea(this.archivo, JSON.stringify({ numero_oc, fecha, orden } satisfies RegistroOrden))
    return { numero_oc, fecha }
  }
}
