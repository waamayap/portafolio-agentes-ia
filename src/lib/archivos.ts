import { appendFile, mkdir, readFile, writeFile } from "node:fs/promises"
import { dirname, join } from "node:path"

/** Rutas del proyecto, siempre relativas a `ctx.directory` (nunca absolutas fijas). */
export const rutas = {
  maestros: (dir: string) => join(dir, "fixtures", "reto-03", "maestros"),
  solicitudes: (dir: string) => join(dir, "fixtures", "reto-03", "solicitudes"),
  caso: (dir: string, caso: string) => join(dir, "fixtures", "reto-03", "solicitudes", caso),
  out: (dir: string) => join(dir, "out"),
  outCaso: (dir: string, caso: string) => join(dir, "out", caso),
  sap: (dir: string) => join(dir, "out", "sap"),
}

/** Nombre de caso seguro: evita rutas como "../../etc". */
export const PATRON_CASO = /^[a-z0-9][a-z0-9-]{0,63}$/

export async function leerTextoOpcional(ruta: string): Promise<string | null> {
  try {
    return await readFile(ruta, "utf8")
  } catch (e) {
    if (esNoExiste(e)) return null
    throw e
  }
}

export async function leerJsonOpcional(ruta: string): Promise<unknown | null> {
  const texto = await leerTextoOpcional(ruta)
  if (texto === null) return null
  try {
    return JSON.parse(texto) as unknown
  } catch {
    throw new Error(`JSON malformado en ${nombreArchivo(ruta)}`)
  }
}

export async function escribirArchivo(ruta: string, contenido: string | Uint8Array): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await writeFile(ruta, contenido)
}

export async function agregarLinea(ruta: string, linea: string): Promise<void> {
  await mkdir(dirname(ruta), { recursive: true })
  await appendFile(ruta, linea.endsWith("\n") ? linea : `${linea}\n`, "utf8")
}

/** Ruta relativa al proyecto, con "/" para que se vea igual en Windows y Linux. */
export function rutaRelativa(dir: string, ruta: string): string {
  return ruta.slice(dir.length + 1).split("\\").join("/")
}

function nombreArchivo(ruta: string): string {
  return ruta.split(/[\\/]/).pop() ?? ruta
}

function esNoExiste(e: unknown): boolean {
  return typeof e === "object" && e !== null && "code" in e && e.code === "ENOENT"
}
