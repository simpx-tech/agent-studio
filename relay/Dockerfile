FROM node:24-alpine
WORKDIR /app
COPY relay/package.json relay/package-lock.json ./
RUN npm ci --omit=dev --ignore-scripts && mkdir /data && chown node:node /data
COPY relay/server.ts relay/start.ts ./relay/
COPY src/lib/domain.ts src/lib/fleet.ts src/lib/sync.ts ./src/lib/
ENV AGENT_STUDIO_RELAY_HOST=0.0.0.0 AGENT_STUDIO_RELAY_PORT=4317 AGENT_STUDIO_RELAY_DATA=/data
USER node
EXPOSE 4317
CMD ["node", "relay/start.ts"]
