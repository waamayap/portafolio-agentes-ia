import { createHash } from "node:crypto"
import { join } from "node:path"
import { PDFDocument, type PDFFont, StandardFonts } from "pdf-lib"
import { escribirArchivo, rutas } from "../lib/archivos"
import type { AprobacionCruda } from "./tipos"

export type Evidencia = { ruta_txt: string; ruta_pdf: string; sha256: string }

/** Texto canónico de la evidencia: encabezados + cuerpo. El sha256 se calcula sobre esto. */
export function contenidoEvidencia(solicitudId: string, a: AprobacionCruda): string {
  const encabezados = [
    `EVIDENCIA DE APROBACIÓN — ${solicitudId}`,
    `De: ${a.de}`,
    `Para: ${a.para}`,
    ...(a.cc && a.cc.length > 0 ? [`CC: ${a.cc.join(", ")}`] : []),
    `Fecha: ${a.fecha}`,
    `Asunto: ${a.asunto}`,
  ]
  return `${encabezados.join("\n")}\n\n${a.cuerpo.trim()}\n`
}

export function sha256(texto: string): string {
  return createHash("sha256").update(texto, "utf8").digest("hex")
}

/** HU-4: escribe out/<caso>/aprobacion.txt (P0) y aprobacion.pdf (P1) con el mismo contenido. */
export async function generarEvidencia(dir: string, caso: string, solicitudId: string, a: AprobacionCruda): Promise<Evidencia> {
  const contenido = contenidoEvidencia(solicitudId, a)
  const hash = sha256(contenido)
  const pie = `\n---\nSHA-256 del contenido anterior: ${hash}\n`
  const base = rutas.outCaso(dir, caso)
  const rutaTxt = join(base, "aprobacion.txt")
  const rutaPdf = join(base, "aprobacion.pdf")
  await escribirArchivo(rutaTxt, contenido + pie)
  await escribirArchivo(rutaPdf, await renderizarPdf(contenido + pie, a.fecha))
  return { ruta_txt: rutaTxt, ruta_pdf: rutaPdf, sha256: hash }
}

async function renderizarPdf(texto: string, fecha: string): Promise<Uint8Array> {
  const pdf = await PDFDocument.create()
  // Metadatos fijos: el PDF es idéntico entre ejecuciones (determinismo de demo.ts).
  const fechaFija = new Date(fecha)
  pdf.setTitle("Evidencia de aprobación")
  pdf.setProducer("agente-ordenes-compra-sap")
  pdf.setCreator("agente-ordenes-compra-sap")
  pdf.setCreationDate(fechaFija)
  pdf.setModificationDate(fechaFija)

  const fuente = await pdf.embedFont(StandardFonts.Helvetica)
  const tamano = 10
  const margen = 50
  const alto = 792
  const ancho = 612
  const interlineado = tamano * 1.4
  let pagina = pdf.addPage([ancho, alto])
  let y = alto - margen

  for (const linea of envolver(aWinAnsi(texto), fuente, tamano, ancho - margen * 2)) {
    if (y < margen) {
      pagina = pdf.addPage([ancho, alto])
      y = alto - margen
    }
    pagina.drawText(linea, { x: margen, y, size: tamano, font: fuente })
    y -= interlineado
  }
  return pdf.save({ useObjectStreams: false })
}

/** Helvetica estándar solo admite WinAnsi; se reemplazan los pocos caracteres fuera de ese juego. */
function aWinAnsi(texto: string): string {
  return texto.replace(/≤/g, "<=").replace(/≥/g, ">=").replace(/[^\n\x20-\x7e -ÿ—–‘’“”•…€]/g, "?")
}

function envolver(texto: string, fuente: PDFFont, tamano: number, anchoMax: number): string[] {
  const lineas: string[] = []
  for (const parrafo of texto.split("\n")) {
    let actual = ""
    for (const palabra of parrafo.split(" ")) {
      const candidata = actual ? `${actual} ${palabra}` : palabra
      if (fuente.widthOfTextAtSize(candidata, tamano) > anchoMax && actual) {
        lineas.push(actual)
        actual = palabra
      } else {
        actual = candidata
      }
    }
    lineas.push(actual)
  }
  return lineas
}
