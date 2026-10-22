import type { OrdenCompra, Validacion } from "../tools/tipos"
import type { DefinicionHerramienta, LlamadaHerramienta, Mensaje, OpcionesEnvio, ProveedorLLM, RespuestaModelo } from "./adapter"

type Resultado<T> = { ok: true; data: T } | { ok: false; error: string }
type Creada = { numero_oc: string; idempotente: boolean; retroactiva: boolean; evidencia?: string }

/**
 * Proveedor determinista sin modelo real (LLM_PROVIDER=simulado). Sigue un guion fijo
 * leer → validar → construir → (crear | preguntar) para probar el ciclo, el servidor y el front
 * sin clave. Demuestra además que el ciclo no depende del proveedor.
 */
export class ProveedorSimulado implements ProveedorLLM {
  readonly nombre = "simulado"
  readonly modelo = "guion-determinista"

  async enviar(mensajes: Mensaje[], _herramientas: DefinicionHerramienta[], _opciones: OpcionesEnvio): Promise<RespuestaModelo> {
    const iUsuario = mensajes.findLastIndex((m) => m.rol === "usuario")
    const usuario = mensajes[iUsuario]
    const texto = usuario?.rol === "usuario" ? usuario.texto : ""
    const resultados = new Map<string, unknown>()
    for (const m of mensajes.slice(iUsuario + 1)) {
      if (m.rol === "herramientas") for (const r of m.resultados) resultados.set(r.nombre, JSON.parse(r.resultado))
    }
    const obtener = <T>(nombre: string) => resultados.get(nombre) as Resultado<T> | undefined

    const casoEnTexto = texto.match(/sol-\d{3}/i)?.[0].toLowerCase() ?? null
    const confirma = /\b(confirmo|s[ií]|procede|adelante|dale|cr[eé]ala)\b/i.test(texto) && !/^\s*no\b/i.test(texto)

    if (/^\s*no\b/i.test(texto) && !casoEnTexto) return responder("Entendido, no creo la OC. Queda pendiente hasta que me confirmes.")

    if (confirma && !casoEnTexto) {
      const caso = ultimoCaso(mensajes)
      if (!caso) return responder("¿Qué solicitud quieres que confirme? Indícame el caso, por ejemplo sol-004.")
      const creada = obtener<Creada>("oc_crear")
      if (!creada) return llamar("oc_crear", { caso, confirmado: true })
      return responder(creada.ok ? textoCreada(creada.data) : `No se creó la OC: ${creada.error}`)
    }

    if (!casoEnTexto) {
      const lista = obtener<{ casos: Array<{ caso: string; asunto?: string }> }>("oc_listar_casos")
      if (!lista) return llamar("oc_listar_casos", {})
      if (!lista.ok) return responder(`No pude listar los casos: ${lista.error}`)
      const filas = lista.data.casos.map((c) => `| ${c.caso} | ${c.asunto ?? "—"} |`).join("\n")
      return responder(`Estas son las solicitudes disponibles:\n\n| Caso | Asunto |\n|---|---|\n${filas}\n\n¿Cuál proceso? Por ejemplo: "Procesa la solicitud sol-001".`)
    }

    const caso = casoEnTexto
    const paquete = obtener<unknown>("oc_leer_paquete")
    if (!paquete) return llamar("oc_leer_paquete", { caso })
    if (!paquete.ok) return responder(`No pude leer el caso ${caso}: ${paquete.error}`)

    const v = obtener<Validacion>("oc_validar")
    if (!v) return llamar("oc_validar", { caso })
    if (!v.ok) return responder(`No pude validar el caso: ${v.error}`)
    if (!v.data.apta) {
      const bloqueos = v.data.bloqueos.map((b) => `- **${b.codigo}**: ${b.detalle}\n  - Acción sugerida: ${b.accion_sugerida}`).join("\n")
      return responder(`**${v.data.solicitud_id}: no se puede crear la OC.**\n\n${tablaControles(v.data)}\n\n**Bloqueos**\n${bloqueos}`)
    }

    const p = obtener<{ orden: OrdenCompra }>("oc_construir_payload")
    if (!p) return llamar("oc_construir_payload", { caso })
    if (!p.ok) return responder(`No pude construir la OC: ${p.error}`)

    const resumen = `**${v.data.solicitud_id}** · OC como quedaría en SAP:\n\n${tablaOrden(p.data.orden)}\n\n**Validaciones**\n\n${tablaControles(v.data)}`
    const sinCrear = /no la crees|no crear|sin crear|solo valida|hasta que (yo )?(lo )?confirme/i.test(texto)
    const { confirmaciones } = v.data
    if (confirmaciones.length > 0 || sinCrear) {
      const lista = confirmaciones.map((c) => `- **${c.codigo}**: ${c.detalle}`).join("\n")
      const bloque = confirmaciones.length ? `**Requiere tu confirmación**\n${lista}\n\n` : ""
      return responder(`${resumen}\n\n${bloque}¿Confirmas que cree la OC${confirmaciones.length ? " con estas excepciones" : ""}?`)
    }

    const creada = obtener<Creada>("oc_crear")
    if (!creada) return llamar("oc_crear", { caso })
    return responder(`${resumen}\n\n${creada.ok ? textoCreada(creada.data) : `No se creó la OC: ${creada.error}`}`)
  }
}

function llamar(nombre: string, argumentos: Record<string, unknown>): RespuestaModelo {
  const llamada: LlamadaHerramienta = { id: `sim-${nombre}`, nombre, argumentos }
  return { texto: "", llamadas: [llamada], tokens: { entrada: 0, salida: 0 } }
}

function responder(texto: string): RespuestaModelo {
  return { texto, llamadas: [], tokens: { entrada: 0, salida: 0 } }
}

function ultimoCaso(mensajes: Mensaje[]): string | null {
  for (let i = mensajes.length - 1; i >= 0; i--) {
    const m = mensajes[i]!
    if (m.rol !== "asistente") continue
    const caso = m.llamadas.map((l) => l.argumentos.caso).find((c): c is string => typeof c === "string")
    if (caso) return caso
  }
  return null
}

const cop = (n: number) => n.toLocaleString("es-CO")

function textoCreada(d: Creada): string {
  if (d.idempotente) return `La OC ya existía: **${d.numero_oc}** (no se creó una segunda).`
  return `✅ OC creada: **${d.numero_oc}**${d.retroactiva ? " · marcada **retroactiva** en out/control.csv" : ""}.\nEvidencia de aprobación: \`${d.evidencia}\``
}

function tablaOrden(o: OrdenCompra): string {
  const p = o.posiciones[0]!
  return [
    "| Campo | Valor |",
    "|---|---|",
    `| Proveedor | ${o.proveedor.nombre} (SAP ${o.proveedor.codigo_sap}, NIT ${o.proveedor.nit}) |`,
    `| Descripción | ${p.descripcion} |`,
    `| Cantidad × precio | ${p.cantidad} ${p.unidad} × ${o.moneda} ${cop(p.precio_unitario)} |`,
    `| Total | ${o.moneda} ${cop(p.cantidad * p.precio_unitario)} |`,
    `| Centro de costo / subárea | ${p.centro_costo} / ${p.subarea} |`,
    `| IVA · condiciones de pago | ${p.indicador_iva} · ${o.condiciones_pago} |`,
    `| Aprobador | ${o.aprobador.email} (${o.aprobador.fecha_aprobacion}) |`,
  ].join("\n")
}

function tablaControles(v: Validacion): string {
  const icono = { ok: "✅", bloqueo: "⛔", confirmacion: "⚠️", derivado: "ℹ️", no_aplica: "—" } as const
  const filas = v.controles.map((c) => `| ${c.codigo} | ${icono[c.estado]} ${c.estado} | ${c.detalle} |`)
  return ["| Regla | Estado | Detalle |", "|---|---|---|", ...filas].join("\n")
}
