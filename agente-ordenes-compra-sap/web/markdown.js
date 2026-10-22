// Markdown mínimo y seguro para las respuestas del agente: se escapa todo el HTML primero
// y solo se generan etiquetas conocidas (tablas, listas, títulos, negrita, cursiva, código).
;(function () {
  const escapar = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;")

  function enLinea(texto) {
    return escapar(texto)
      .replace(/`([^`]+)`/g, "<code>$1</code>")
      .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
      .replace(/(^|[^*])\*([^*\s][^*]*)\*/g, "$1<em>$2</em>")
  }

  // "\|" es una barra literal dentro de una celda, no un separador de columnas.
  const celdas = (linea) =>
    linea
      .trim()
      .replace(/^\|/, "")
      .replace(/(^|[^\\])\|$/, "$1")
      .split(/(?<!\\)\|/)
      .map((c) => c.replace(/\\\|/g, "|").trim())
  const esSeparador = (linea) => /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)*\|?\s*$/.test(linea)

  function renderizar(md) {
    const lineas = md.replace(/\r\n/g, "\n").split("\n")
    const html = []
    let i = 0
    while (i < lineas.length) {
      const linea = lineas[i]

      if (/^```/.test(linea)) {
        const bloque = []
        i++
        while (i < lineas.length && !/^```/.test(lineas[i])) bloque.push(lineas[i++])
        i++
        html.push(`<pre><code>${escapar(bloque.join("\n"))}</code></pre>`)
        continue
      }

      if (linea.includes("|") && i + 1 < lineas.length && esSeparador(lineas[i + 1])) {
        const cabecera = celdas(linea)
        i += 2
        const filas = []
        while (i < lineas.length && lineas[i].includes("|") && lineas[i].trim() !== "") filas.push(celdas(lineas[i++]))
        html.push(
          `<table><thead><tr>${cabecera.map((c) => `<th>${enLinea(c)}</th>`).join("")}</tr></thead><tbody>${filas
            .map((f) => `<tr>${f.map((c) => `<td>${enLinea(c)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`,
        )
        continue
      }

      if (/^\s*([-*_])(\s*\1){2,}\s*$/.test(linea)) {
        html.push("<hr>")
        i++
        continue
      }

      if (/^\s*>/.test(linea)) {
        const cita = []
        while (i < lineas.length && /^\s*>/.test(lineas[i])) cita.push(lineas[i++].replace(/^\s*>\s?/, ""))
        html.push(`<blockquote>${renderizar(cita.join("\n"))}</blockquote>`)
        continue
      }

      const titulo = linea.match(/^(#{1,4})\s+(.*)$/)
      if (titulo) {
        const nivel = Math.min(titulo[1].length + 2, 4)
        html.push(`<h${nivel}>${enLinea(titulo[2])}</h${nivel}>`)
        i++
        continue
      }

      if (/^\s*([-*]|\d+\.)\s+/.test(linea)) {
        const ordenada = /^\s*\d+\./.test(linea)
        const items = []
        while (i < lineas.length && /^\s*([-*]|\d+\.)\s+/.test(lineas[i])) {
          const sangria = /^\s{2,}/.test(lineas[i])
          const contenido = enLinea(lineas[i].replace(/^\s*([-*]|\d+\.)\s+/, ""))
          items.push(sangria ? `<ul><li>${contenido}</li></ul>` : `<li>${contenido}</li>`)
          i++
        }
        const etiqueta = ordenada ? "ol" : "ul"
        html.push(`<${etiqueta}>${items.join("")}</${etiqueta}>`)
        continue
      }

      if (linea.trim() === "") {
        i++
        continue
      }

      const parrafo = []
      while (i < lineas.length && lineas[i].trim() !== "" && !/^(```|#{1,4}\s|\s*>|\s*([-*]|\d+\.)\s|\s*([-*_])(\s*\3){2,}\s*$)/.test(lineas[i]) && !(lineas[i].includes("|") && i + 1 < lineas.length && esSeparador(lineas[i + 1]))) {
        parrafo.push(enLinea(lineas[i++]))
      }
      html.push(`<p>${parrafo.join("<br>")}</p>`)
    }
    return html.join("")
  }

  window.renderizarMarkdown = renderizar
})()
