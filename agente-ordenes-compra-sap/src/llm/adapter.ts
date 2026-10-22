/**
 * Interfaz propia del proveedor LLM (PRD 6.1). El ciclo del agente solo conoce estos tipos:
 * cambiar de Gemini a otro proveedor es escribir otra implementación, sin tocar el ciclo.
 */

export type LlamadaHerramienta = { id: string; nombre: string; argumentos: Record<string, unknown> }

export type Mensaje =
  | { rol: "usuario"; texto: string }
  /** `crudo` guarda el mensaje original del proveedor (p. ej. firmas de razonamiento de Gemini) para reenviarlo intacto. */
  | { rol: "asistente"; texto: string; llamadas: LlamadaHerramienta[]; crudo?: unknown }
  | { rol: "herramientas"; resultados: Array<{ id: string; nombre: string; resultado: string }> }

export type DefinicionHerramienta = {
  nombre: string
  descripcion: string
  /** JSON Schema del objeto de argumentos (generado desde zod). */
  parametros: Record<string, unknown>
}

export type RespuestaModelo = {
  texto: string
  llamadas: LlamadaHerramienta[]
  crudo?: unknown
  tokens: { entrada: number; salida: number }
}

export type OpcionesEnvio = { sistema: string; signal?: AbortSignal }

export interface ProveedorLLM {
  readonly nombre: string
  readonly modelo: string
  enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaModelo>
}
