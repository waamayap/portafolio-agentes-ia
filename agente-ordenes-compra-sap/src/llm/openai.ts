import OpenAI from "openai"
import type { ChatCompletionMessageParam } from "openai/resources/chat/completions"
import type { DefinicionHerramienta, Mensaje, OpcionesEnvio, ProveedorLLM, RespuestaModelo } from "./adapter"

/** OpenAI vía Chat Completions con function calling. La clave solo se lee de OPENAI_API_KEY en el backend. */
export class ProveedorOpenAI implements ProveedorLLM {
  readonly nombre = "openai"
  private readonly cliente: OpenAI

  constructor(readonly modelo: string) {
    const apiKey = process.env.OPENAI_API_KEY
    if (!apiKey) throw new Error("Falta OPENAI_API_KEY. Ver .env.example.")
    // Sin reintentos del SDK: los maneja el ciclo del agente, con su propio timeout por intento.
    this.cliente = new OpenAI({ apiKey, maxRetries: 0 })
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaModelo> {
    const respuesta = await this.cliente.chat.completions.create(
      {
        model: this.modelo,
        // Solo modelos con razonamiento (familia gpt-5, o*) aceptan este parámetro: OPENAI_REASONING=none|minimal|low|medium|high.
        ...(process.env.OPENAI_REASONING ? { reasoning_effort: process.env.OPENAI_REASONING as "low" } : {}),
        messages: [{ role: "system", content: opciones.sistema }, ...mensajes.flatMap(aMensajesOpenAI)],
        tools:
          herramientas.length > 0
            ? herramientas.map((h) => ({
                type: "function" as const,
                function: { name: h.nombre, description: h.descripcion, parameters: h.parametros },
              }))
            : undefined,
      },
      { signal: opciones.signal },
    )

    const mensaje = respuesta.choices[0]?.message
    const llamadas = (mensaje?.tool_calls ?? [])
      .filter((l) => l.type === "function")
      .map((l) => ({ id: l.id, nombre: l.function.name, argumentos: parsearArgumentos(l.function.arguments) }))

    return {
      texto: mensaje?.content ?? "",
      llamadas,
      tokens: { entrada: respuesta.usage?.prompt_tokens ?? 0, salida: respuesta.usage?.completion_tokens ?? 0 },
    }
  }
}

function aMensajesOpenAI(m: Mensaje): ChatCompletionMessageParam[] {
  switch (m.rol) {
    case "usuario":
      return [{ role: "user", content: m.texto }]
    case "asistente":
      return [
        {
          role: "assistant",
          content: m.texto || null,
          tool_calls:
            m.llamadas.length > 0
              ? m.llamadas.map((l) => ({
                  id: l.id,
                  type: "function" as const,
                  function: { name: l.nombre, arguments: JSON.stringify(l.argumentos) },
                }))
              : undefined,
        },
      ]
    case "herramientas":
      return m.resultados.map((r) => ({ role: "tool" as const, tool_call_id: r.id, content: r.resultado }))
  }
}

/** Argumentos que no son JSON válido llegan como objeto vacío; zod los rechaza y el error vuelve al modelo. */
function parsearArgumentos(texto: string): Record<string, unknown> {
  try {
    const v = JSON.parse(texto) as unknown
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : {}
  } catch {
    return {}
  }
}
