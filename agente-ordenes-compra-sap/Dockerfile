FROM node:22-alpine

WORKDIR /app

# Dependencias primero para aprovechar la caché de capas
COPY package.json package-lock.json ./
RUN npm ci --omit=dev

COPY agent ./agent
COPY src ./src
COPY web ./web
COPY fixtures ./fixtures
COPY demo.ts tsconfig.json ./
# out/ es el único directorio escribible (SAP simulado, evidencias, control.csv, log.jsonl)
RUN mkdir -p out && chown node:node out

# Cloud Run inyecta PORT (8080 por defecto). La clave del modelo llega como variable o secreto, nunca en la imagen.
ENV NODE_ENV=production PORT=8080
EXPOSE 8080

USER node
CMD ["npx", "tsx", "src/server.ts"]
