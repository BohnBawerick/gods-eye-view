# Production container: bundled, minified assets served by `vite preview`, which also
# runs every /api provider. Browser keys (GOOGLE_MAPS_API_KEY, CESIUM_ION_TOKEN) are
# compiled into the bundle, so the build runs at container start from the runtime
# environment and no key is ever baked into the image.
#
#   docker build -t gods-eye-view .
#   docker run -p 4173:4173 --env-file .env gods-eye-view
#
# The server brokers every configured key to anyone who can reach it. Keep it on a
# trusted network, set GEV_ALLOWED_HOSTS to the names clients use, and see SECURITY.md.
FROM node:24-bookworm-slim

WORKDIR /app
RUN chown node:node /app
USER node

COPY --chown=node:node package.json package-lock.json ./
RUN npm ci --no-audit --no-fund

COPY --chown=node:node . .

ENV HOST=0.0.0.0 \
    PORT=4173 \
    OPENSKY_AUTH_MODE=anon

EXPOSE 4173
HEALTHCHECK --interval=30s --timeout=10s --start-period=120s --retries=3 \
  CMD node -e "fetch('http://127.0.0.1:4173/').then(r=>process.exit(r.ok?0:1)).catch(()=>process.exit(1))"

CMD ["sh", "-c", "npm run build && exec npm run preview"]
