FROM node:24-bookworm-slim

WORKDIR /app
RUN install -d -o root -g root -m 0555 /data

COPY admin.cjs accounts.cjs backup.cjs commands.cjs database.cjs roles.cjs schema.sql server.cjs settings.cjs store.cjs ./
COPY v2/app.js v2/data.js v2/workflow.js v2/login.js v2/manage.js v2/index.html v2/login.html v2/manage.html v2/styles.css v2/duty.css v2/production.css ./v2/

ENV NODE_ENV=production HOST=0.0.0.0 PORT=8080 INCIDENT_DB=/data/workspace.sqlite3
USER 1000:1000
EXPOSE 8080
CMD ["node", "server.cjs"]
