FROM node:22-alpine AS builder
WORKDIR /app
COPY package*.json ./
RUN npm ci

FROM node:22-alpine AS runtime
ARG NODE_ENV=production
ENV NODE_ENV=${NODE_ENV}
ENV PORT=9876
WORKDIR /app
COPY --from=builder /app/node_modules ./node_modules
COPY dist/ ./dist/
EXPOSE 9876
LABEL maintainer="umbra"
ENTRYPOINT ["node", "dist/daemon/index.js"]
CMD ["--mode", "daemon"]
