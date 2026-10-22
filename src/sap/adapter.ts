import type { OrdenCompra } from "../tools/tipos"

/** Interfaz obligatoria del PRD (7.4). El mock la implementa con archivos; producción, con SAP real (ver SOLUCION.md). */
export interface SapAdapter {
  consultarProveedor(nit: string): Promise<{ codigo_sap: string; activo: boolean } | null>
  crearOrden(orden: OrdenCompra): Promise<{ numero_oc: string; fecha: string }>
  buscarOrdenPorReferencia(solicitud_id: string): Promise<{ numero_oc: string } | null>
}
