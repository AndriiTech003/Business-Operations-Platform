FROM node:22-bookworm-slim AS base
ENV PNPM_HOME=/pnpm PATH=/pnpm:$PATH
RUN corepack enable && corepack prepare pnpm@10.34.6 --activate

FROM base AS build
WORKDIR /src
COPY 03-node-realtime-engine 03-node-realtime-engine
COPY 05-business-operations-platform 05-business-operations-platform
RUN cd 03-node-realtime-engine && pnpm install --frozen-lockfile && pnpm --filter @ashamrai/realtime-server... run build
RUN cd 05-business-operations-platform && pnpm install --frozen-lockfile && pnpm turbo run build --filter=@bop/realtime

FROM base AS runtime
WORKDIR /src
COPY --from=build /src /src
USER node
EXPOSE 4520
CMD ["node", "05-business-operations-platform/apps/realtime/dist/main.js"]
