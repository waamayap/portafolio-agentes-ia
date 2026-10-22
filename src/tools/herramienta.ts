import { z } from "zod"
import { registrarLog } from "./control"

export type ContextoHerramienta = {
  /** Raíz del proyecto: todas las rutas se resuelven desde aquí. */
  directory: string
  sessionId: string
}

export type Resultado<T> = { ok: true; data: T; resumen: string } | { ok: false; error: string; data?: unknown }

/** Contrato del PRD 6.2: description + args zod + execute(args, ctx) → string JSON. Nunca lanza. */
export type Herramienta<S extends z.ZodRawShape = z.ZodRawShape> = {
  description: string
  args: S
  execute(args: z.infer<z.ZodObject<S>>, ctx: ContextoHerramienta): Promise<string>
}

/**
 * Envuelve la lógica de una herramienta: valida argumentos con zod, captura cualquier excepción
 * como `{ ok: false, error }` y deja cada llamada en out/log.jsonl con un resumen corto.
 */
export function definirHerramienta<S extends z.ZodRawShape>(
  nombre: string,
  description: string,
  args: S,
  logica: (args: z.infer<z.ZodObject<S>>, ctx: ContextoHerramienta) => Promise<Resultado<unknown>>,
): Herramienta<S> {
  const esquema = z.object(args)
  return {
    description,
    args,
    async execute(crudos, ctx) {
      let resultado: Resultado<unknown>
      const parseado = esquema.safeParse(crudos)
      if (!parseado.success) {
        resultado = { ok: false, error: `Argumentos inválidos: ${z.prettifyError(parseado.error)}` }
      } else {
        try {
          resultado = await logica(parseado.data, ctx)
        } catch (e) {
          resultado = { ok: false, error: e instanceof Error ? e.message : String(e) }
        }
      }
      const caso = typeof (crudos as { caso?: unknown }).caso === "string" ? (crudos as { caso: string }).caso : null
      await registrarLog(ctx.directory, {
        herramienta: nombre,
        caso,
        ok: resultado.ok,
        resumen: resultado.ok ? resultado.resumen : resultado.error,
        sesion: ctx.sessionId,
      }).catch(() => undefined)
      return JSON.stringify(resultado)
    },
  }
}

export const exito = <T>(data: T, resumen: string): Resultado<T> => ({ ok: true, data, resumen })
export const fallo = (error: string, data?: unknown): Resultado<never> =>
  data === undefined ? { ok: false, error } : { ok: false, error, data }
