import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { join, relative } from "node:path"
import { fileURLToPath } from "node:url"
import { serve } from "@hono/node-server"
import { serveStatic } from "@hono/node-server/serve-static"
import { Hono } from "hono"
import { z } from "zod"
import { ejecutarTurno } from "./agent/ciclo"
import { AlmacenSesiones, PATRON_SESION } from "./agent/sesiones"
import { cargarSistema, crearProveedor, limitesDesdeEntorno } from "./agent/sistema"

// .env local (en Cloud Run las variables vienen del servicio y este archivo no existe).
try {
  process.loadEnvFile()
} catch {
  /* sin .env */
}

const DIRECTORIO = fileURLToPath(new URL("..", import.meta.url)).replace(/[\\/]$/, "")
const MAX_LARGO_MENSAJE = 2_000

const llm = crearProveedor()
const limites = limitesDesdeEntorno()
const sesiones = new AlmacenSesiones(DIRECTORIO)

const CuerpoChat = z.object({
  sessionId: z.string().regex(PATRON_SESION).optional(),
  message: z.string().trim().min(1, "mensaje vacío").max(MAX_LARGO_MENSAJE, `máximo ${MAX_LARGO_MENSAJE} caracteres`),
})

const app = new Hono()

app.get("/api/health", (c) => c.json({ ok: true, provider: llm.nombre, model: llm.modelo }))

app.post("/api/chat", async (c) => {
  const cuerpo = CuerpoChat.safeParse(await c.req.json().catch(() => null))
  if (!cuerpo.success) return c.json({ error: z.prettifyError(cuerpo.error) }, 400)

  const sesion = await sesiones.obtenerOCrear(cuerpo.data.sessionId ?? randomUUID())
  if (sesion.ocupada) return c.json({ error: "La sesión está procesando otro mensaje; espera la respuesta." }, 409)

  sesion.ocupada = true
  try {
    // El system prompt se relee en cada turno: editar agent/prompt.md o el conocimiento no exige reiniciar.
    const sistema = await cargarSistema(DIRECTORIO)
    const resultado = await ejecutarTurno(sesion, cuerpo.data.message, { llm, sistema, directorio: DIRECTORIO, limites })
    await sesiones.guardar(sesion)
    return c.json({ sessionId: sesion.id, ...resultado })
  } finally {
    sesion.ocupada = false
  }
})

app.get("/api/sessions/:id", async (c) => {
  const id = c.req.param("id")
  const sesion = PATRON_SESION.test(id) ? await sesiones.obtener(id) : null
  if (!sesion) return c.json({ error: "Sesión no encontrada" }, 404)
  return c.json({ sessionId: sesion.id, historial: sesion.visible, pendientes: [...sesion.pendientes], tokens: sesion.tokens })
})

app.onError((e, c) => {
  console.error(e)
  return c.json({ error: "Error interno del servidor" }, 500)
})

// serveStatic resuelve `root` relativo al directorio de trabajo.
app.use("/*", serveStatic({ root: relative(process.cwd(), join(DIRECTORIO, "web")).split("\\").join("/") || "." }))

await mkdir(join(DIRECTORIO, "out"), { recursive: true })
const puerto = Number(process.env.PORT ?? 8080)
serve({ fetch: app.fetch, port: puerto }, () => {
  console.log(`Agente de Órdenes de Compra SAP → http://localhost:${puerto}  (proveedor: ${llm.nombre} · ${llm.modelo})`)
})
