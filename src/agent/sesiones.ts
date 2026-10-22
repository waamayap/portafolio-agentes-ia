import { join } from "node:path"
import { escribirArchivo, leerJsonOpcional, rutas } from "../lib/archivos"
import { nuevaSesion, type Sesion } from "./ciclo"

/** Id de sesión seguro como nombre de archivo. */
export const PATRON_SESION = /^[\w-]{8,64}$/

type SesionGuardada = Omit<Sesion, "pendientes" | "ocupada"> & { pendientes: string[] }

const ruta = (dir: string, id: string) => join(rutas.out(dir), "sesiones", `${id}.json`)

/**
 * Sesiones en memoria con respaldo en out/sesiones/<id>.json: sobreviven a reinicios del servidor
 * (recarga en desarrollo, nueva revisión en Cloud Run) sin necesidad de base de datos.
 */
export class AlmacenSesiones {
  private readonly memoria = new Map<string, Sesion>()

  constructor(
    private readonly directorio: string,
    private readonly maximo = 200,
  ) {}

  async obtener(id: string): Promise<Sesion | null> {
    const enMemoria = this.memoria.get(id)
    if (enMemoria) return enMemoria
    const guardada = (await leerJsonOpcional(ruta(this.directorio, id)).catch(() => null)) as SesionGuardada | null
    if (!guardada) return null
    const sesion: Sesion = { ...guardada, pendientes: new Set(guardada.pendientes), ocupada: false }
    this.recordar(sesion)
    return sesion
  }

  async obtenerOCrear(id: string): Promise<Sesion> {
    const existente = await this.obtener(id)
    if (existente) return existente
    const sesion = nuevaSesion(id)
    this.recordar(sesion)
    return sesion
  }

  async guardar(sesion: Sesion): Promise<void> {
    const { ocupada: _omitido, pendientes, ...resto } = sesion
    const datos: SesionGuardada = { ...resto, pendientes: [...pendientes] }
    await escribirArchivo(ruta(this.directorio, sesion.id), JSON.stringify(datos))
  }

  private recordar(sesion: Sesion): void {
    if (this.memoria.size >= this.maximo) this.memoria.delete(this.memoria.keys().next().value!)
    this.memoria.set(sesion.id, sesion)
  }
}
