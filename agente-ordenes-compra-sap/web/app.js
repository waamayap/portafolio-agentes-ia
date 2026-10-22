const $ = (id) => document.getElementById(id)
const mensajes = $("mensajes")
const formulario = $("formulario")
const texto = $("texto")
const enviar = $("enviar")
const confirmacion = $("confirmacion")

const CLAVE_SESION = "oc-sap-sesion"
let sesionId = leerSesion()
let ocupado = false

function leerSesion() {
  try {
    const guardada = localStorage.getItem(CLAVE_SESION)
    if (guardada) return guardada
  } catch {}
  return nuevaSesionId()
}

function nuevaSesionId() {
  const id = crypto.randomUUID()
  try {
    localStorage.setItem(CLAVE_SESION, id)
  } catch {}
  return id
}

const escapar = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;")

function limpiarVacio() {
  mensajes.querySelector(".vacio")?.remove()
}

function bajar() {
  mensajes.scrollTop = mensajes.scrollHeight
}

function pintarUsuario(contenido) {
  limpiarVacio()
  const div = document.createElement("div")
  div.className = "mensaje usuario"
  div.textContent = contenido
  mensajes.append(div)
  bajar()
}

function pintarHerramientas(llamadas) {
  if (!llamadas || llamadas.length === 0) return ""
  const items = llamadas
    .map(
      (l) => `<details class="herramienta ${l.ok ? "ok" : "error"}">
        <summary><span class="icono">${l.ok ? "✔" : "✖"}</span><span class="nombre">${escapar(l.nombre)}</span><span class="res">${escapar(l.resumen)}</span></summary>
        <pre>${escapar(JSON.stringify(l.argumentos, null, 2))}</pre>
      </details>`,
    )
    .join("")
  return `<div class="herramientas">${items}</div>`
}

function pintarAgente({ texto: contenido, llamadas, necesitaConfirmacion, error }) {
  limpiarVacio()
  document.querySelectorAll(".mensaje.espera").forEach((m) => m.classList.remove("espera"))
  document.querySelectorAll(".etiqueta-espera").forEach((m) => m.remove())
  const div = document.createElement("div")
  div.className = `mensaje agente${necesitaConfirmacion ? " espera" : ""}${error ? " fallo" : ""}`
  div.innerHTML =
    (necesitaConfirmacion ? `<span class="etiqueta-espera">⚠️ Esperando tu confirmación</span>` : "") +
    pintarHerramientas(llamadas) +
    window.renderizarMarkdown(contenido || "")
  mensajes.append(div)
  confirmacion.hidden = !necesitaConfirmacion
  bajar()
}

function indicador(mostrar) {
  $("pensando")?.remove()
  if (!mostrar) return
  const div = document.createElement("div")
  div.id = "pensando"
  div.className = "pensando"
  div.textContent = "El agente está trabajando"
  mensajes.append(div)
  bajar()
}

async function mandar(mensaje) {
  if (ocupado || !mensaje.trim()) return
  ocupado = true
  enviar.disabled = true
  confirmacion.hidden = true
  pintarUsuario(mensaje)
  indicador(true)
  try {
    const r = await fetch("/api/chat", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sessionId: sesionId, message: mensaje }),
    })
    const datos = await r.json()
    indicador(false)
    if (!r.ok) {
      pintarAgente({ texto: `⚠️ ${datos.error ?? "Error del servidor"}`, error: true })
    } else {
      pintarAgente({ texto: datos.reply, llamadas: datos.toolCalls, necesitaConfirmacion: datos.needsConfirmation, error: datos.error })
    }
  } catch {
    indicador(false)
    pintarAgente({ texto: "⚠️ No pude conectar con el servidor. Revisa tu conexión e inténtalo de nuevo.", error: true })
  } finally {
    ocupado = false
    enviar.disabled = false
    texto.focus()
  }
}

async function restaurar() {
  try {
    const r = await fetch(`/api/sessions/${sesionId}`)
    if (!r.ok) return
    const { historial } = await r.json()
    for (const t of historial) {
      if (t.rol === "usuario") pintarUsuario(t.texto)
      else pintarAgente(t)
    }
  } catch {}
}

async function cargarSalud() {
  try {
    const r = await fetch("/api/health")
    const s = await r.json()
    $("proveedor").textContent = `${s.provider} · ${s.model}`
  } catch {
    $("proveedor").textContent = "sin conexión"
  }
}

function cargarCasos() {
  const casos = ["sol-001", "sol-002", "sol-003", "sol-004", "sol-005", "sol-006"]
  $("casos").innerHTML = casos.map((c) => `<button class="caso" type="button" data-texto="Procesa la solicitud ${c}">${c}</button>`).join("")
}

formulario.addEventListener("submit", (e) => {
  e.preventDefault()
  const valor = texto.value
  texto.value = ""
  mandar(valor)
})

texto.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault()
    formulario.requestSubmit()
  }
})

document.addEventListener("click", (e) => {
  const boton = e.target.closest("[data-texto]")
  if (boton) mandar(boton.dataset.texto)
})

$("si").addEventListener("click", () => mandar("Confirmo, crea la OC."))
$("no").addEventListener("click", () => mandar("No, no la crees."))
$("nueva").addEventListener("click", () => {
  sesionId = nuevaSesionId()
  mensajes.innerHTML = '<div class="vacio"><p>Sesión nueva. ¿Qué solicitud proceso?</p></div>'
  confirmacion.hidden = true
})

cargarCasos()
cargarSalud()
restaurar()
