import { z } from "zod"

// ── Maestros (fixtures/reto-03/maestros) ─────────────────────────────────────

export const ProveedorMaestro = z.object({
  codigo_sap: z.string(),
  nit: z.string(),
  nombre: z.string(),
  condiciones_pago_default: z.string(),
  indicador_iva_default: z.string(),
  activo: z.boolean(),
})
export type ProveedorMaestro = z.infer<typeof ProveedorMaestro>

export const CentroCosto = z.object({
  centro_costo: z.string(),
  nombre: z.string(),
  subareas: z.array(z.string()),
  aprobadores: z.array(z.object({ email: z.string(), nombre: z.string(), tope: z.number() })),
})
export type CentroCosto = z.infer<typeof CentroCosto>

export const IndicadorIva = z.object({ codigo: z.string(), descripcion: z.string(), tasa: z.number() })
export const CondicionPago = z.object({ codigo: z.string(), descripcion: z.string(), dias: z.number() })

export type Maestros = {
  proveedores: ProveedorMaestro[]
  centrosCosto: CentroCosto[]
  indicadoresIva: z.infer<typeof IndicadorIva>[]
  condicionesPago: z.infer<typeof CondicionPago>[]
}

// ── Paquete normalizado (PRD 7.1 y 7.2) ──────────────────────────────────────

const fechaISO = z.string().regex(/^\d{4}-\d{2}-\d{2}/, "fecha en formato YYYY-MM-DD")

export const Solicitud = z.object({
  solicitud_id: z.string().min(1),
  solicitante: z.string(),
  proveedor_nombre: z.string().min(1),
  proveedor_nit: z.string().optional(),
  descripcion: z.string().min(1),
  centro_costo: z.string().min(1),
  subarea: z.string().min(1),
  cantidad: z.number({ error: "cantidad debe ser numérica" }).positive(),
  valor_unitario: z.number({ error: "valor_unitario debe ser numérico" }).nonnegative(),
  valor_total: z.number({ error: "valor_total debe ser numérico" }).positive(),
  moneda: z.enum(["COP", "USD"]),
  indicador_iva: z.string().optional(),
  condiciones_pago: z.string().optional(),
  fecha_solicitud: fechaISO,
})
export type Solicitud = z.infer<typeof Solicitud>

export const CorreoEntrada = z.object({
  id: z.string(),
  de: z.string(),
  asunto: z.string(),
  fecha: z.string(),
})

export const AprobacionCruda = z.object({
  de: z.string(),
  para: z.string(),
  cc: z.array(z.string()).optional(),
  fecha: fechaISO,
  asunto: z.string(),
  cuerpo: z.string(),
})
export type AprobacionCruda = z.infer<typeof AprobacionCruda>

export type Cotizacion = {
  numero: string | null
  proveedor: string
  nit: string | null
  total: number
  moneda: string
  fecha: string | null
  validez_hasta: string | null
  texto: string
}

export type Aprobacion = { de: string; fecha: string; aprobado: boolean; texto: string }
export type Factura = { numero: string; fecha: string; total: number }

export type Paquete = {
  correo: z.infer<typeof CorreoEntrada>
  solicitud: Solicitud
  cotizacion: Cotizacion | null
  aprobacion: Aprobacion | null
  factura: Factura | null
  /** Adjuntos esperados que no llegaron (HU-1: se reportan, no se lanza excepción). */
  faltantes: string[]
}

// ── Validación (PRD 7.3) ─────────────────────────────────────────────────────

export type CodigoRegla = "RC1" | "RC2" | "RC3" | "RC4" | "RC5" | "RC6" | "RC7" | "RC8" | "RC9" | "RC10"

export type Hallazgo = {
  codigo: CodigoRegla
  detalle: string
  accion_sugerida: string
  valores?: Record<string, string | number | null>
}

export type EstadoControl = "ok" | "bloqueo" | "confirmacion" | "derivado" | "no_aplica"

export type Derivado<T> = { valor: T; fuente: string }

export type Derivados = {
  proveedor?: Derivado<{ codigo_sap: string; nit: string; nombre: string }>
  indicador_iva?: Derivado<string>
  condiciones_pago?: Derivado<string>
}

export type Validacion = {
  solicitud_id: string
  apta: boolean
  bloqueos: Hallazgo[]
  confirmaciones: Hallazgo[]
  derivados: Derivados
  retroactiva: boolean
  /** Matriz completa: qué pasó cada regla, para mostrar "qué validaciones pasó y cuáles no". */
  controles: Array<{ codigo: CodigoRegla; estado: EstadoControl; detalle: string }>
}

// ── Orden de compra (PRD 7.4) ────────────────────────────────────────────────

export const OrdenCompra = z.object({
  referencia: z.object({
    solicitud_id: z.string(),
    correo_id: z.string(),
    cotizacion_ref: z.string().nullable(),
  }),
  sociedad: z.literal("1000"),
  organizacion_compras: z.literal("1000"),
  proveedor: z.object({ codigo_sap: z.string(), nit: z.string(), nombre: z.string() }),
  moneda: z.enum(["COP", "USD"]),
  condiciones_pago: z.string().regex(/^Z\d{3}$/),
  aprobador: z.object({
    email: z.string().email(),
    fecha_aprobacion: z.string(),
    evidencia_sha256: z.string().regex(/^[a-f0-9]{64}$/),
  }),
  posiciones: z
    .array(
      z.object({
        numero: z.number().int().positive(),
        descripcion: z.string().min(1).max(40),
        cantidad: z.number().positive(),
        unidad: z.enum(["UN", "H", "MES"]),
        precio_unitario: z.number().nonnegative(),
        centro_costo: z.string(),
        subarea: z.string(),
        indicador_iva: z.string(),
      }),
    )
    .min(1),
  excepciones: z.array(
    z.object({ codigo: z.string(), detalle: z.string(), confirmado_por: z.string().nullable() }),
  ),
})
export type OrdenCompra = z.infer<typeof OrdenCompra>
