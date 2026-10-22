import { OrdenCompra, type Paquete, type Validacion } from "./tipos"

export const LIMITE_DESCRIPCION_SAP = 40

/** Fuente de cada valor del payload (HU-3): solicitud, cotizacion, maestro.<nombre> o derivado. */
export type Trazabilidad = Record<string, string>

/** Unidad de medida a partir de la descripción: horas → H, meses de servicio → MES, resto → UN. */
export function derivarUnidad(descripcion: string): { unidad: "UN" | "H" | "MES"; regla: string } {
  if (/\bhoras?\b/i.test(descripcion)) return { unidad: "H", regla: "la descripción habla de horas" }
  if (/\b(mensualidad|mensual(es)?|por mes)\b/i.test(descripcion)) return { unidad: "MES", regla: "la descripción habla de meses de servicio" }
  return { unidad: "UN", regla: "unidad por defecto" }
}

/** Texto breve SAP: máximo 40 caracteres, cortando en el último espacio si es posible. */
export function textoBreve(descripcion: string): string {
  const limpio = descripcion.replace(/\s+/g, " ").trim()
  if (limpio.length <= LIMITE_DESCRIPCION_SAP) return limpio
  const corte = limpio.slice(0, LIMITE_DESCRIPCION_SAP)
  const espacio = corte.lastIndexOf(" ")
  return (espacio > 20 ? corte.slice(0, espacio) : corte).replace(/[\s,:;.-]+$/, "")
}

/**
 * Construye la OC (PRD 7.4) a partir del paquete ya validado. Solo se llama con `apta = true`.
 * Devuelve el payload validado con zod y su trazabilidad campo por campo.
 */
export function construirOrden(
  paquete: Paquete,
  validacion: Validacion,
  evidenciaSha256: string,
): { orden: OrdenCompra; trazabilidad: Trazabilidad } {
  const s = paquete.solicitud
  const proveedor = validacion.derivados.proveedor
  if (!proveedor) throw new Error("No hay proveedor validado; ejecuta oc_validar y resuelve los bloqueos primero.")
  if (!paquete.aprobacion) throw new Error("No hay aprobación en el paquete.")

  const indicadorIva = s.indicador_iva ?? validacion.derivados.indicador_iva?.valor
  const condicionesPago = s.condiciones_pago ?? validacion.derivados.condiciones_pago?.valor
  if (!indicadorIva || !condicionesPago) throw new Error("Faltan indicador de IVA o condiciones de pago y no se pudieron derivar.")

  const unidad = derivarUnidad(s.descripcion)
  const descripcion = textoBreve(s.descripcion)

  const orden = OrdenCompra.parse({
    referencia: {
      solicitud_id: s.solicitud_id,
      correo_id: paquete.correo.id,
      cotizacion_ref: paquete.cotizacion?.numero ?? null,
    },
    sociedad: "1000",
    organizacion_compras: "1000",
    proveedor: proveedor.valor,
    moneda: s.moneda,
    condiciones_pago: condicionesPago,
    aprobador: {
      email: paquete.aprobacion.de,
      fecha_aprobacion: paquete.aprobacion.fecha,
      evidencia_sha256: evidenciaSha256,
    },
    posiciones: [
      {
        numero: 10,
        descripcion,
        cantidad: s.cantidad,
        unidad: unidad.unidad,
        precio_unitario: s.valor_unitario,
        centro_costo: s.centro_costo,
        subarea: s.subarea,
        indicador_iva: indicadorIva,
      },
    ],
    excepciones: validacion.confirmaciones.map((c) => ({ codigo: c.codigo, detalle: c.detalle, confirmado_por: null })),
  })

  const trazabilidad: Trazabilidad = {
    "referencia.solicitud_id": "solicitud.solicitud_id",
    "referencia.correo_id": "correo.id",
    "referencia.cotizacion_ref": paquete.cotizacion?.numero ? "cotizacion.numero" : "derivado: sin cotización",
    sociedad: "derivado: constante de configuración (sociedad 1000)",
    organizacion_compras: "derivado: constante de configuración (organización de compras 1000)",
    "proveedor.codigo_sap": proveedor.fuente,
    "proveedor.nit": proveedor.fuente,
    "proveedor.nombre": proveedor.fuente,
    moneda: "solicitud.moneda",
    condiciones_pago: s.condiciones_pago ? "solicitud.condiciones_pago" : `derivado: ${validacion.derivados.condiciones_pago?.fuente}`,
    "aprobador.email": "aprobacion.de",
    "aprobador.fecha_aprobacion": "aprobacion.fecha",
    "aprobador.evidencia_sha256": "derivado: sha256 de out/<caso>/aprobacion.txt",
    "posiciones[0].numero": "derivado: primera posición SAP (10)",
    "posiciones[0].descripcion":
      descripcion === s.descripcion ? "solicitud.descripcion" : `derivado: solicitud.descripcion recortada a ${LIMITE_DESCRIPCION_SAP} caracteres`,
    "posiciones[0].cantidad": "solicitud.cantidad",
    "posiciones[0].unidad": `derivado: ${unidad.regla}`,
    "posiciones[0].precio_unitario": "solicitud.valor_unitario",
    "posiciones[0].centro_costo": "solicitud.centro_costo (validado contra maestro.centros-costo)",
    "posiciones[0].subarea": "solicitud.subarea (validado contra maestro.centros-costo)",
    "posiciones[0].indicador_iva": s.indicador_iva ? "solicitud.indicador_iva" : `derivado: ${validacion.derivados.indicador_iva?.fuente}`,
    excepciones: "derivado: confirmaciones de oc_validar",
  }

  return { orden, trazabilidad }
}
