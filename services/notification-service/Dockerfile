FROM node:26-alpine
WORKDIR /app
COPY package.json ./
COPY src ./src
RUN mkdir -p /data && chown -R node:node /data /app
USER node
ENV NODE_ENV=production
ENV SERVICE_NAME=notification-service
EXPOSE 5002
CMD ["node", "src/app.ts"]