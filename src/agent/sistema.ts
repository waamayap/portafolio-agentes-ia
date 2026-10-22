import { readFile } from "node:fs/promises"
import { join } from "node:path"
import type { ProveedorLLM } from "../llm/adapter"
import { ProveedorGemini } from "../llm/gemini"
import { ProveedorOpenAI } from "../llm/openai"
import { ProveedorSimulado } from "../llm/simulado"

/** System prompt = comportamiento (agent/prompt.md) + conocimiento (src/knowledge/*.md, sin frontmatter). */
export async function cargarSistema(directorio: string): Promise<string> {
  const prompt = await readFile(join(directorio, "agent", "prompt.md"), "utf8")
  const conocimiento = await readFile(join(directorio, "src", "knowledge", "ordenes-compra.md"), "utf8")
  const sinFrontmatter = conocimiento.replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, "")
  return `${prompt.trim()}\n\n---\n\n# Conocimiento del proceso\n\n${sinFrontmatter.trim()}\n\nFecha de hoy: ${new Date().toISOString().slice(0, 10)}.`
}

export function crearProveedor(): ProveedorLLM {
  const proveedor = process.env.LLM_PROVIDER ?? "gemini"
  if (proveedor === "simulado") return new ProveedorSimulado()
  if (proveedor === "gemini") return new ProveedorGemini(process.env.GEMINI_MODEL ?? "gemini-3.8-flash")
  if (proveedor === "openai") return new ProveedorOpenAI(process.env.OPENAI_MODEL ?? "gpt-5.4-mini")
  throw new Error(`LLM_PROVIDER desconocido: "${proveedor}". Opciones: openai, gemini, simulado.`)
}

export function limitesDesdeEntorno() {
  const numero = (nombre: string, defecto: number) => {
    const v = Number(process.env[nombre])
    return Number.isFinite(v) && v > 0 ? v : defecto
  }
  return {
    maxIteraciones: numero("MAX_ITERACIONES", 25),
    maxTokensSesion: numero("MAX_TOKENS_SESION", 1_000_000),
    timeoutMs: numero("LLM_TIMEOUT_MS", 60_000),
  }
}
