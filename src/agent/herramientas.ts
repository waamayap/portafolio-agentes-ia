import { z } from "zod"
import type { DefinicionHerramienta } from "../llm/adapter"
import type { Herramienta } from "../tools/herramienta"
import * as oc from "../tools/oc"

/** Nombre visible para el modelo: `<archivo>_<export>` (PRD 6.2). */
export const HERRAMIENTAS: Record<string, Herramienta> = Object.fromEntries(
  Object.entries(oc).map(([exportado, h]) => [`oc_${exportado}`, h as Herramienta]),
)

export function definicionesParaModelo(): DefinicionHerramienta[] {
  return Object.entries(HERRAMIENTAS).map(([nombre, h]) => {
    const { $schema: _omitido, ...parametros } = z.toJSONSchema(z.object(h.args)) as Record<string, unknown>
    return { nombre, descripcion: h.description, parametros }
  })
}
