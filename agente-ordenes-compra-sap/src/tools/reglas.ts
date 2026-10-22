import { buscarProveedor } from "./maestros"
import type { CodigoRegla, Derivados, EstadoControl, Hallazgo, Maestros, Paquete, Validacion } from "./tipos"

/** Parámetros de negocio. Cambiar una tolerancia no toca el servidor ni el agente. */
export const PARAMETROS = {
  /** RC5: diferencia máxima entre cotización y solicitud. */
  toleranciaCotizacion: 0.02,
  /** RC10: diferencia máxima entre cantidad × valor_unitario y valor_total. */
  toleranciaAritmetica: 1,
} as const

const fmt = (n: number) => n.toLocaleString("es-CO", { maximumFractionDigits: 2 })
const soloFecha = (iso: string) => iso.slice(0, 10)

/** Aplica RC1–RC10 (PRD 7.3) a un paquete. Función pura: no lee ni escribe archivos. */
export function validarPaquete(paquete: Paquete, maestros: Maestros): Validacion {
  const { solicitud: s, cotizacion, aprobacion, factura } = paquete
  const bloqueos: Hallazgo[] = []
  const confirmaciones: Hallazgo[] = []
  const derivados: Derivados = {}
  const controles: Validacion["controles"] = []
  const registrar = (codigo: CodigoRegla, estado: EstadoControl, detalle: string) =>
    controles.push({ codigo, estado, detalle })
  const bloquear = (h: Hallazgo) => {
    bloqueos.push(h)
    registrar(h.codigo, "bloqueo", h.detalle)
  }
  const confirmar = (h: Hallazgo) => {
    confirmaciones.push(h)
    registrar(h.codigo, "confirmacion", h.detalle)
  }

  // RC1 · Proveedor existe (por NIT; si no hay NIT, por nombre normalizado) y está activo.
  const encontrado = buscarProveedor(maestros, s.proveedor_nit, s.proveedor_nombre)
  const proveedor = encontrado?.proveedor ?? null
  if (!encontrado) {
    const criterio = s.proveedor_nit ? `NIT ${s.proveedor_nit}` : `nombre "${s.proveedor_nombre}"`
    bloquear({
      codigo: "RC1",
      detalle: `El proveedor "${s.proveedor_nombre}" (${criterio}) no existe en el maestro de proveedores.`,
      accion_sugerida:
        "Solicitar a Compras la creación del proveedor en SAP (RUT, cámara de comercio y certificación bancaria) o confirmar con el solicitante el NIT correcto.",
      valores: { proveedor_nombre: s.proveedor_nombre, proveedor_nit: s.proveedor_nit ?? null },
    })
  } else if (!encontrado.proveedor.activo) {
    bloquear({
      codigo: "RC1",
      detalle: `El proveedor ${encontrado.proveedor.nombre} (código SAP ${encontrado.proveedor.codigo_sap}) está inactivo.`,
      accion_sugerida: "Solicitar a Compras la reactivación del proveedor o elegir un proveedor activo.",
    })
  } else {
    const p = encontrado.proveedor
    derivados.proveedor = {
      valor: { codigo_sap: p.codigo_sap, nit: p.nit, nombre: p.nombre },
      fuente: encontrado.por === "nit" ? "maestro.proveedores (por NIT)" : "maestro.proveedores (por nombre normalizado, la solicitud no trae NIT)",
    }
    registrar("RC1", "ok", `Proveedor ${p.nombre} (código SAP ${p.codigo_sap}) encontrado por ${encontrado.por} y activo.`)
  }

  // RC4 · El centro de costo existe y la subárea le pertenece.
  const centro = maestros.centrosCosto.find((c) => c.centro_costo === s.centro_costo) ?? null
  if (!centro) {
    bloquear({
      codigo: "RC4",
      detalle: `El centro de costo ${s.centro_costo} no existe en el maestro.`,
      accion_sugerida: `Pedir al solicitante un centro de costo válido: ${maestros.centrosCosto.map((c) => `${c.centro_costo} (${c.nombre})`).join(", ")}.`,
    })
  } else if (!centro.subareas.includes(s.subarea)) {
    const otro = maestros.centrosCosto.find((c) => c.subareas.includes(s.subarea))
    bloquear({
      codigo: "RC4",
      detalle: `La subárea "${s.subarea}" no pertenece a ${centro.centro_costo} (${centro.nombre}).`,
      accion_sugerida: otro
        ? `"${s.subarea}" pertenece a ${otro.centro_costo} (${otro.nombre}); confirmar con el solicitante el centro correcto. Subáreas de ${centro.centro_costo}: ${centro.subareas.join(", ")}.`
        : `Subáreas válidas de ${centro.centro_costo}: ${centro.subareas.join(", ")}.`,
    })
  } else {
    registrar("RC4", "ok", `La subárea ${s.subarea} pertenece a ${centro.centro_costo} (${centro.nombre}).`)
  }

  // RC2 · Aprobación existe, dice "Aprobado" y viene de un aprobador del centro de costo.
  // RC3 · valor_total ≤ tope de ese aprobador en ese centro.
  const capaces = centro?.aprobadores.filter((a) => a.tope >= s.valor_total) ?? []
  const sugerirAprobador = () =>
    !centro
      ? "Corregir primero el centro de costo."
      : capaces.length > 0
        ? `Solicitar la aprobación a ${capaces.map((a) => `${a.nombre} (${a.email}, tope ${fmt(a.tope)})`).join(" o ")}.`
        : `Ningún aprobador de ${centro.centro_costo} tiene tope suficiente para ${fmt(s.valor_total)} (máximo ${fmt(Math.max(...centro.aprobadores.map((a) => a.tope)))}); escalar a la dirección financiera o dividir la compra.`

  if (!aprobacion) {
    bloquear({ codigo: "RC2", detalle: "No llegó el correo de aprobación del líder.", accion_sugerida: sugerirAprobador() })
    registrar("RC3", "no_aplica", "Sin aprobación no se puede verificar el tope.")
  } else if (!aprobacion.aprobado) {
    bloquear({
      codigo: "RC2",
      detalle: `El correo de ${aprobacion.de} no contiene la palabra "Aprobado".`,
      accion_sugerida: "Pedir al líder una respuesta explícita con \"Aprobado\".",
    })
    registrar("RC3", "no_aplica", "Sin aprobación válida no se puede verificar el tope.")
  } else {
    const aprobador = centro?.aprobadores.find((a) => a.email.toLowerCase() === aprobacion.de) ?? null
    if (!aprobador) {
      const otroCentro = maestros.centrosCosto.find((c) => c.aprobadores.some((a) => a.email.toLowerCase() === aprobacion.de))
      bloquear({
        codigo: "RC2",
        detalle: `${aprobacion.de} no es aprobador de ${s.centro_costo}${otroCentro ? ` (solo aprueba ${otroCentro.centro_costo} · ${otroCentro.nombre})` : ""}.`,
        accion_sugerida: sugerirAprobador(),
        valores: { aprobador: aprobacion.de, centro_costo: s.centro_costo },
      })
      registrar("RC3", "no_aplica", "El aprobador no está autorizado para este centro de costo.")
    } else {
      registrar("RC2", "ok", `Aprobado por ${aprobador.nombre} (${aprobador.email}), aprobador de ${s.centro_costo}.`)
      if (s.valor_total > aprobador.tope) {
        bloquear({
          codigo: "RC3",
          detalle: `El valor ${fmt(s.valor_total)} supera el tope de ${aprobador.nombre} (${fmt(aprobador.tope)}) en ${s.centro_costo}.`,
          accion_sugerida: sugerirAprobador(),
          valores: { valor_total: s.valor_total, tope: aprobador.tope },
        })
      } else {
        registrar("RC3", "ok", `${fmt(s.valor_total)} ≤ tope ${fmt(aprobador.tope)}.`)
      }
    }
  }

  // RC5 · Cotización vs solicitud dentro del 2 %.
  if (!cotizacion) {
    confirmar({
      codigo: "RC5",
      detalle: "No hay cotización del proveedor (o no se pudo leer su total).",
      accion_sugerida: "Confirmar que se crea la OC sin cotización, o pedir la cotización al solicitante.",
      valores: { solicitud: s.valor_total, cotizacion: null },
    })
  } else {
    const diferencia = Math.abs(cotizacion.total - s.valor_total) / s.valor_total
    const pct = Math.round(diferencia * 10000) / 100
    const monedaDistinta = cotizacion.moneda !== s.moneda
    if (diferencia > PARAMETROS.toleranciaCotizacion || monedaDistinta) {
      confirmar({
        codigo: "RC5",
        detalle: monedaDistinta
          ? `La cotización está en ${cotizacion.moneda} y la solicitud en ${s.moneda}.`
          : `La cotización (${fmt(cotizacion.total)}) difiere ${pct} % de la solicitud (${fmt(s.valor_total)}); la tolerancia es ${PARAMETROS.toleranciaCotizacion * 100} %.`,
        accion_sugerida:
          "Confirmar que la OC se crea por el valor de la solicitud (el aprobado por el líder), o pedir al solicitante que corrija la solicitud y vuelva a aprobarla.",
        valores: { solicitud: s.valor_total, cotizacion: cotizacion.total, diferencia_pct: pct },
      })
    } else {
      registrar("RC5", "ok", `Cotización ${fmt(cotizacion.total)} vs solicitud ${fmt(s.valor_total)} (diferencia ${pct} %).`)
    }
  }

  // RC6 · Indicador de IVA: si falta, se deriva del proveedor y se confirma.
  if (s.indicador_iva) {
    if (maestros.indicadoresIva.some((i) => i.codigo === s.indicador_iva)) {
      registrar("RC6", "ok", `Indicador de IVA ${s.indicador_iva} informado en la solicitud.`)
    } else {
      bloquear({
        codigo: "RC6",
        detalle: `El indicador de IVA "${s.indicador_iva}" no existe en el maestro.`,
        accion_sugerida: `Usar un código válido: ${maestros.indicadoresIva.map((i) => `${i.codigo} (${i.descripcion})`).join(", ")}.`,
      })
    }
  } else if (proveedor) {
    const iva = maestros.indicadoresIva.find((i) => i.codigo === proveedor.indicador_iva_default)
    derivados.indicador_iva = { valor: proveedor.indicador_iva_default, fuente: "maestro.proveedores.indicador_iva_default" }
    confirmar({
      codigo: "RC6",
      detalle: `La solicitud no trae indicador de IVA; se propone ${proveedor.indicador_iva_default}${iva ? ` (${iva.descripcion})` : ""}, el predeterminado de ${proveedor.nombre.replace(/\.$/, "")}.`,
      accion_sugerida: "Confirmar el indicador de IVA propuesto o indicar otro.",
      valores: { indicador_iva_propuesto: proveedor.indicador_iva_default },
    })
  } else {
    registrar("RC6", "no_aplica", "Sin proveedor válido no se puede derivar el IVA.")
  }

  // RC7 · Condiciones de pago: si faltan, se derivan del proveedor (solo se informa).
  if (s.condiciones_pago) {
    if (maestros.condicionesPago.some((c) => c.codigo === s.condiciones_pago)) {
      registrar("RC7", "ok", `Condiciones de pago ${s.condiciones_pago} informadas en la solicitud.`)
    } else {
      bloquear({
        codigo: "RC7",
        detalle: `La condición de pago "${s.condiciones_pago}" no existe en el maestro.`,
        accion_sugerida: `Usar un código válido: ${maestros.condicionesPago.map((c) => `${c.codigo} (${c.descripcion})`).join(", ")}.`,
      })
    }
  } else if (proveedor) {
    const cond = maestros.condicionesPago.find((c) => c.codigo === proveedor.condiciones_pago_default)
    derivados.condiciones_pago = { valor: proveedor.condiciones_pago_default, fuente: "maestro.proveedores.condiciones_pago_default" }
    registrar("RC7", "derivado", `Sin condiciones de pago en la solicitud; se usa ${proveedor.condiciones_pago_default}${cond ? ` (${cond.descripcion})` : ""} del proveedor.`)
  } else {
    registrar("RC7", "no_aplica", "Sin proveedor válido no se pueden derivar las condiciones de pago.")
  }

  // RC8 · Factura anterior a la solicitud → OC retroactiva.
  const retroactiva = factura !== null && factura.fecha < s.fecha_solicitud
  if (retroactiva && factura) {
    confirmar({
      codigo: "RC8",
      detalle: `OC retroactiva: la factura ${factura.numero} es del ${factura.fecha}, anterior a la solicitud (${s.fecha_solicitud}). Se registra en el control de desvíos.`,
      accion_sugerida: "Confirmar la creación sabiendo que queda marcada como retroactiva para Auditoría.",
      valores: { fecha_factura: factura.fecha, fecha_solicitud: s.fecha_solicitud },
    })
  } else {
    registrar("RC8", factura ? "ok" : "no_aplica", factura ? `La factura ${factura.numero} (${factura.fecha}) no es anterior a la solicitud.` : "No llegó factura con el paquete.")
  }

  // RC9 · La aprobación no puede ser anterior a la solicitud.
  if (aprobacion) {
    const fechaAprobacion = soloFecha(aprobacion.fecha)
    if (fechaAprobacion < s.fecha_solicitud) {
      confirmar({
        codigo: "RC9",
        detalle: `La aprobación (${fechaAprobacion}) es anterior a la fecha de la solicitud (${s.fecha_solicitud}).`,
        accion_sugerida: "Confirmar que la aprobación corresponde a esta solicitud.",
        valores: { fecha_aprobacion: fechaAprobacion, fecha_solicitud: s.fecha_solicitud },
      })
    } else {
      registrar("RC9", "ok", `Aprobación del ${fechaAprobacion}, no anterior a la solicitud (${s.fecha_solicitud}).`)
    }
  } else {
    registrar("RC9", "no_aplica", "Sin aprobación.")
  }

  // RC10 · cantidad × valor_unitario = valor_total (± 1).
  const calculado = s.cantidad * s.valor_unitario
  if (Math.abs(calculado - s.valor_total) > PARAMETROS.toleranciaAritmetica) {
    bloquear({
      codigo: "RC10",
      detalle: `${fmt(s.cantidad)} × ${fmt(s.valor_unitario)} = ${fmt(calculado)}, distinto del valor total ${fmt(s.valor_total)}.`,
      accion_sugerida: "Pedir al solicitante que corrija cantidad, valor unitario o valor total en la solicitud.",
      valores: { calculado, valor_total: s.valor_total },
    })
  } else {
    registrar("RC10", "ok", `${fmt(s.cantidad)} × ${fmt(s.valor_unitario)} = ${fmt(s.valor_total)}.`)
  }

  const orden: CodigoRegla[] = ["RC1", "RC2", "RC3", "RC4", "RC5", "RC6", "RC7", "RC8", "RC9", "RC10"]
  controles.sort((a, b) => orden.indexOf(a.codigo) - orden.indexOf(b.codigo))

  return { solicitud_id: s.solicitud_id, apta: bloqueos.length === 0, bloqueos, confirmaciones, derivados, retroactiva, controles }
}
