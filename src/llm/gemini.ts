import { type Content, GoogleGenAI, type Part, ThinkingLevel } from "@google/genai"
import type { DefinicionHerramienta, Mensaje, OpcionesEnvio, ProveedorLLM, RespuestaModelo } from "./adapter"

/**
 * Gemini vía @google/genai. Dos modos, elegidos por variables de entorno:
 *  - API key de Google AI Studio (GEMINI_API_KEY), para desarrollo.
 *  - Vertex AI (GOOGLE_GENAI_USE_VERTEXAI=true), que en Cloud Run se autentica con la cuenta de servicio: sin clave.
 */
export class ProveedorGemini implements ProveedorLLM {
  readonly nombre: string
  private readonly cliente: GoogleGenAI

  constructor(readonly modelo: string) {
    const vertex = process.env.GOOGLE_GENAI_USE_VERTEXAI === "true"
    if (vertex) {
      this.cliente = new GoogleGenAI({
        vertexai: true,
        project: process.env.GOOGLE_CLOUD_PROJECT,
        location: process.env.GOOGLE_CLOUD_LOCATION ?? "us-central1",
      })
      this.nombre = "gemini (vertex ai)"
    } else {
      const apiKey = process.env.GEMINI_API_KEY
      if (!apiKey) throw new Error("Falta GEMINI_API_KEY (o GOOGLE_GENAI_USE_VERTEXAI=true). Ver .env.example.")
      this.cliente = new GoogleGenAI({ apiKey })
      this.nombre = "gemini (ai studio)"
    }
  }

  async enviar(mensajes: Mensaje[], herramientas: DefinicionHerramienta[], opciones: OpcionesEnvio): Promise<RespuestaModelo> {
    const respuesta = await this.cliente.models.generateContent({
      model: this.modelo,
      contents: mensajes.map(aContenido),
      config: {
        systemInstruction: opciones.sistema,
        abortSignal: opciones.signal,
        // El flujo es guiado por herramientas: con razonamiento bajo responde más rápido y gasta menos.
        thinkingConfig: { thinkingLevel: nivelRazonamiento() },
        tools:
          herramientas.length > 0
            ? [
                {
                  functionDeclarations: herramientas.map((h) => ({
                    name: h.nombre,
                    description: h.descripcion,
                    parametersJsonSchema: h.parametros,
                  })),
                },
              ]
            : undefined,
      },
    })

    const contenido = respuesta.candidates?.[0]?.content
    const partes = contenido?.parts ?? []
    const llamadas = partes
      .filter((p): p is Part & { functionCall: NonNullable<Part["functionCall"]> } => p.functionCall !== undefined)
      .map((p, i) => ({
        id: p.functionCall.id ?? `llamada-${Date.now()}-${i}`,
        nombre: p.functionCall.name ?? "",
        argumentos: p.functionCall.args ?? {},
      }))
    const texto = partes
      .filter((p) => typeof p.text === "string" && !p.thought)
      .map((p) => p.text)
      .join("")

    return {
      texto,
      llamadas,
      crudo: contenido,
      tokens: {
        entrada: respuesta.usageMetadata?.promptTokenCount ?? 0,
        salida: (respuesta.usageMetadata?.candidatesTokenCount ?? 0) + (respuesta.usageMetadata?.thoughtsTokenCount ?? 0),
      },
    }
  }
}

/** GEMINI_THINKING = MINIMAL | LOW | MEDIUM | HIGH (por defecto LOW). */
function nivelRazonamiento(): ThinkingLevel {
  const valor = (process.env.GEMINI_THINKING ?? "LOW").toUpperCase()
  return Object.values(ThinkingLevel).includes(valor as ThinkingLevel) ? (valor as ThinkingLevel) : ThinkingLevel.LOW
}

function aContenido(m: Mensaje): Content {
  switch (m.rol) {
    case "usuario":
      return { role: "user", parts: [{ text: m.texto }] }
    case "asistente":
      // Se reenvía el contenido original para conservar las firmas de razonamiento de Gemini.
      if (m.crudo) return m.crudo as Content
      return {
        role: "model",
        parts: [
          ...(m.texto ? [{ text: m.texto }] : []),
          ...m.llamadas.map((l) => ({ functionCall: { id: l.id, name: l.nombre, args: l.argumentos } })),
        ],
      }
    case "herramientas":
      return {
        role: "user",
        parts: m.resultados.map((r) => ({
          functionResponse: { id: r.id, name: r.nombre, response: comoObjeto(r.resultado) },
        })),
      }
  }
}

function comoObjeto(resultado: string): Record<string, unknown> {
  try {
    const v = JSON.parse(resultado) as unknown
    return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Record<string, unknown>) : { resultado: v }
  } catch {
    return { resultado }
  }
}
