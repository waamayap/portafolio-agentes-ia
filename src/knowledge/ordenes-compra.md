---
name: ordenes-compra
description: Conocimiento del proceso de órdenes de compra de Periferia IT Group — paquete de entrada, controles RC1–RC10, campos SAP y qué pedir en cada excepción.
---

# Proceso de órdenes de compra (OC)

## Actores
- **Solicitante**: envía por correo a compras@ el paquete: solicitud (Excel), cotización del proveedor (PDF) y correo de aprobación de su líder.
- **Líder aprobador**: responde el correo con "Aprobado". Cada centro de costo tiene aprobadores con un **tope** de monto.
- **Analista administrativa**: usuaria del agente. Crea la OC en SAP y confirma las excepciones.
- **Contabilidad / Auditoría**: consume `out/control.csv`, donde queda cada intento y las OC retroactivas.

## Controles
| Regla | Qué verifica | Tipo | Qué pedir si falla |
|---|---|---|---|
| RC1 | El proveedor existe en el maestro (por NIT; sin NIT, por nombre) y está activo. | Bloqueo | Creación o reactivación del proveedor en SAP por Compras (RUT, cámara de comercio, certificación bancaria), o el NIT correcto. |
| RC2 | Hay aprobación, dice "Aprobado" y viene de un aprobador del centro de costo. | Bloqueo | Aprobación de un aprobador válido del centro con tope suficiente. |
| RC3 | El valor total no supera el tope del aprobador en ese centro. | Bloqueo | Aprobación de alguien con tope suficiente, o escalar / dividir la compra. |
| RC4 | El centro de costo existe y la subárea le pertenece. | Bloqueo | Centro y subárea correctos. |
| RC5 | Cotización y solicitud difieren como máximo 2 %. Sin cotización también se confirma. | Confirmación | Confirmar el valor de la solicitud (el aprobado) o corregir la solicitud. |
| RC6 | Sin indicador de IVA → se propone el del proveedor. | Confirmación + derivado | Confirmar el IVA propuesto. |
| RC7 | Sin condiciones de pago → se usan las del proveedor. | Derivado (informativo) | Nada; solo se informa. |
| RC8 | Factura con fecha anterior a la solicitud → OC **retroactiva**. | Confirmación | Confirmar sabiendo que queda marcada para Auditoría. |
| RC9 | La aprobación no puede ser anterior a la solicitud. | Confirmación | Confirmar que la aprobación corresponde a esta solicitud. |
| RC10 | Cantidad × valor unitario = valor total (± 1). | Bloqueo | Corregir la solicitud. |

**Bloqueo** impide crear la OC. **Confirmación** permite crearla solo con la confirmación explícita de la analista. **Derivado** es un valor completado desde los maestros que se informa.

## OC retroactivas
Una OC es retroactiva cuando la factura llegó antes que la solicitud: se compró sin cotización ni aprobación previa y la OC se crea solo para poder radicar la factura. La dirección quiere medir cuántas hay, por eso se crean solo con confirmación y quedan con `retroactiva = true` en `out/control.csv`.

## Campos SAP de la OC
- **Sociedad** y **organización de compras**: 1000.
- **Proveedor**: código SAP del maestro, NIT y nombre.
- **Condiciones de pago**: códigos Z000 (inmediato), Z015, Z030 y Z060 (días fecha factura).
- **Indicador de IVA**: C0 (excluido), C1 (19 %), C2 (5 %).
- **Posición**: número 10, texto breve de máximo 40 caracteres, cantidad, unidad (UN, H, MES), precio unitario, centro de costo, subárea e indicador de IVA.
- **Aprobador**: correo, fecha de aprobación y sha256 de la evidencia de aprobación.
- **Excepciones**: confirmaciones aceptadas y quién las confirmó.
- La misma solicitud nunca genera dos OC: crear de nuevo devuelve el número existente.
