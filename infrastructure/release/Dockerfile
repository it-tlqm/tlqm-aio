FROM node:24.20.0-alpine@sha256:e67514e5d0f6c46656005e1b693b2ec9d52e80b641307de684d4a015ba7a4eaf AS patched
RUN apk add --no-cache --upgrade \
    libcrypto3=3.5.9-r0 libssl3=3.5.9-r0 \
    musl=1.2.6-r3 musl-utils=1.2.6-r3 zlib=1.4-r0

FROM patched AS dependencies
WORKDIR /app
COPY . .
ARG ARTIFACT_SHA256
RUN node infrastructure/release/verify-artifact.mjs /app "${ARTIFACT_SHA256}" \
    && npm ci --omit=dev --ignore-scripts --no-audit --no-fund

FROM patched
WORKDIR /app
RUN rm -rf /usr/local/lib/node_modules/npm /usr/local/bin/npm /usr/local/bin/npx /opt/yarn-* /usr/local/bin/yarn /usr/local/bin/yarnpkg
COPY --from=dependencies /app /app
ARG ARTIFACT_SHA256
LABEL org.opencontainers.image.title="TLQM AIO" io.tlqm.aio.artifact-sha256="${ARTIFACT_SHA256}"
ENV NODE_ENV=production
USER node
ENTRYPOINT ["node", "dist/scripts/staging.js"]
