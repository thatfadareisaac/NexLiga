FROM node:24-alpine
WORKDIR /app
ENV NODE_ENV=production
ENV HOST=0.0.0.0
ENV PORT=4173
ENV FAIRDRAFT_DATA_DIR=/data
COPY . .
RUN mkdir -p /data && chown -R node:node /app /data
USER node
EXPOSE 4173
VOLUME ["/data"]
CMD ["node", "server.mjs"]
