# Build from the repository root using npm run build:tessera-image.
# syntax=docker/dockerfile:1
ARG NODE_IMAGE=node:22-bookworm-slim
FROM ${NODE_IMAGE} AS build
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci
COPY tsconfig.json ./
COPY src ./src
COPY scripts ./scripts
RUN npm run build

FROM ${NODE_IMAGE} AS runtime
RUN apt-get update && apt-get install -y --no-install-recommends ca-certificates curl \
  && rm -rf /var/lib/apt/lists/*
WORKDIR /app
COPY package.json package-lock.json ./
RUN npm ci --omit=dev
COPY --from=build /app/dist ./dist

# Build stamp (passed from scripts/build-args.sh; after the dist COPY so the
# slow layers above stay cached). Empty = unknown.
ARG MARCH_GIT_SHA=""
ARG MARCH_GIT_DESCRIBE=""
ARG MARCH_BUILD_TIME=""
ENV MARCH_GIT_SHA=$MARCH_GIT_SHA \
    MARCH_GIT_DESCRIBE=$MARCH_GIT_DESCRIBE \
    MARCH_BUILD_TIME=$MARCH_BUILD_TIME
LABEL org.opencontainers.image.revision=$MARCH_GIT_SHA \
      org.opencontainers.image.version=$MARCH_GIT_DESCRIBE \
      org.opencontainers.image.created=$MARCH_BUILD_TIME
RUN ln -sf /app/dist/cli.js /usr/local/bin/march \
  && mkdir -p /march/logs && chown node:node /march/logs
USER node
ENTRYPOINT ["march"]
CMD ["tessera", "serve", "--host", "0.0.0.0"]
