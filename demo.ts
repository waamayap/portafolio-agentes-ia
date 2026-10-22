/**
 * Verificación sin modelo (PRD 6.6): procesa los 6 casos llamando directamente a las herramientas.
 * No necesita ninguna clave de proveedor LLM.   →   npm run demo
 */
import { rm } from "node:fs/promises"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { readFile } from "node:fs/promises"
import * as oc from "./src/tools/oc"
import type { Validacion } from "./src/tools/tipos"

const directory = fileURLToPath(new URL(".", import.meta.url)).replace(/[\\/]$/, "")
const ctx = { directory, sessionId: "demo" }

type Respuesta<T> = { ok: true; data: T; resumen: string } | { ok: false; error: string }
const llamar = async <T>(promesa: Promise<string>) => JSON.parse(await promesa) as Respuesta<T>

const titulo = (t: string) => console.log(`\n${"═".repeat(78)}\n${t}\n${"═".repeat(78)}`)
const linea = (etiqueta: string, valor: string) => console.log(`  ${etiqueta.padEnd(16)} ${valor}`)

async function procesar(caso: string, { confirmar }: { confirmar: boolean }) {
  titulo(`Caso ${caso}`)
  const paquete = await llamar(oc.leer_paquete.execute({ caso }, ctx))
  if (!paquete.ok) return linea("ERROR", paquete.error)
  linea("paquete", paquete.resumen)

  const v = await llamar<Validacion>(oc.validar.execute({ caso }, ctx))
  if (!v.ok) return linea("ERROR", v.error)
  linea("apta", String(v.data.apta))
  linea("retroactiva", String(v.data.retroactiva))
  for (const b of v.data.bloqueos) linea(`bloqueo ${b.codigo}`, `${b.detalle}\n${" ".repeat(19)}→ ${b.accion_sugerida}`)
  for (const c of v.data.confirmaciones) linea(`confirmar ${c.codigo}`, c.detalle)
  for (const [campo, d] of Object.entries(v.data.derivados)) {
    if (campo !== "proveedor") linea(`derivado`, `${campo} = ${JSON.stringify(d.valor)} (${d.fuente})`)
  }
  if (!v.data.apta) return linea("resultado", "NO se crea la OC")

  const ev = await llamar<{ ruta: string; sha256: string }>(oc.generar_evidencia.execute({ caso }, ctx))
  linea("evidencia", ev.ok ? ev.resumen : ev.error)
  const payload = await llamar(oc.construir_payload.execute({ caso }, ctx))
  linea("payload", payload.ok ? payload.resumen : payload.error)

  let creada = await llamar<{ numero_oc: string }>(oc.crear.execute({ caso }, ctx))
  if (!creada.ok && confirmar) {
    linea("sin confirmar", creada.error)
    linea("usuario", "\"confirmo\"  → oc_crear con confirmado = true")
    creada = await llamar(oc.crear.execute({ caso, confirmado: true }, ctx))
  }
  linea("resultado", creada.ok ? creada.resumen : creada.error)
}

await rm(join(directory, "out"), { recursive: true, force: true })

await procesar("sol-001", { confirmar: false })
titulo("Idempotencia: sol-001 por segunda vez")
const repetida = await llamar(oc.crear.execute({ caso: "sol-001" }, ctx))
linea("resultado", repetida.ok ? repetida.resumen : repetida.error)

await procesar("sol-002", { confirmar: false })
await procesar("sol-003", { confirmar: false })
await procesar("sol-004", { confirmar: true })
await procesar("sol-005", { confirmar: true })
await procesar("sol-006", { confirmar: true })

titulo("Errores legibles (HU-6)")
const inexistente = await llamar(oc.leer_paquete.execute({ caso: "sol-999" }, ctx))
linea("sol-999", inexistente.ok ? "?" : inexistente.error)
const ruta = await llamar(oc.leer_paquete.execute({ caso: "../../etc" }, ctx))
linea("../../etc", ruta.ok ? "?" : ruta.error)

titulo("out/control.csv")
console.log(await readFile(join(directory, "out", "control.csv"), "utf8"))
