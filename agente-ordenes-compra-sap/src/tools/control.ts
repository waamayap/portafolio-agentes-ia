import { join } from "node:path"
import { agregarLinea, leerTextoOpcional, rutas } from "../lib/archivos"

export type ResultadoIntento = "creada" | "idempotente" | "bloqueada" | "pendiente_confirmacion" | "error"

export type FilaControl = {
  solicitud_id: string
  resultado: ResultadoIntento
  numero_oc: string | null
  retroactiva: boolean
  bloqueos: string[]
  confirmaciones: string[]
}

const COLUMNAS = ["solicitud_id", "resultado", "numero_oc", "retroactiva", "bloqueos", "confirmaciones", "ts"] as const

const celda = (v: string) => (/[",\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v)

/** HU-5: cada intento (creado, bloqueado o pendiente) agrega una fila a out/control.csv. */
export async function registrarControl(dir: string, fila: FilaControl): Promise<void> {
  const ruta = join(rutas.out(dir), "control.csv")
  if ((await leerTextoOpcional(ruta)) === null) await agregarLinea(ruta, COLUMNAS.join(","))
  const valores = [
    fila.solicitud_id,
    fila.resultado,
    fila.numero_oc ?? "",
    String(fila.retroactiva),
    fila.bloqueos.join(" | "),
    fila.confirmaciones.join(" | "),
    new Date().toISOString(),
  ]
  await agregarLinea(ruta, valores.map(celda).join(","))
}

/** CA4 / RN: toda llamada a herramienta queda en out/log.jsonl. */
export async function registrarLog(
  dir: string,
  entrada: { herramienta: string; caso: string | null; ok: boolean; resumen: string; sesion: string },
): Promise<void> {
  await agregarLinea(join(rutas.out(dir), "log.jsonl"), JSON.stringify({ ts: new Date().toISOString(), ...entrada }))
}
