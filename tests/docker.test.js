'use strict';

// docker/: the deployment decisions docs/docker.md describes, pinned so a
// later edit of compose.yml cannot quietly undo them.

const assert = require('node:assert/strict');
const test = require('node:test');
const fs = require('node:fs');
const path = require('node:path');

const DOCKER_DIR = path.join(__dirname, '..', 'docker');
const read = (name) => fs.readFileSync(path.join(DOCKER_DIR, name), 'utf8');

// The lines of one service in compose.yml, up to the next service or section.
function service(compose, name) {
  const lines = compose.split('\n');
  const start = lines.findIndex((line) => line === `  ${name}:`);
  assert.notEqual(start, -1, `compose.yml has no ${name} service`);
  const end = lines.findIndex((line, index) => index > start && /^ {0,2}\S/.test(line));
  return lines.slice(start, end === -1 ? undefined : end).join('\n');
}

test('the hub is published on the host\'s port 80 and listens on 17321 inside', () => {
  const hub = service(read('compose.yml'), 'hub');
  assert.match(hub, /^ {6}- "\$\{TOKEN_MONITOR_HOST_PORT:-80\}:17321"$/m);
  // TOKEN_MONITOR_PORT is the port `npm run hub` listens on, read from the same
  // .env: passing it in would move the hub off the port it is published on.
  assert.doesNotMatch(hub, /^ {6}TOKEN_MONITOR_PORT:/m);
  const dockerfile = read('Dockerfile');
  assert.match(dockerfile, /TOKEN_MONITOR_PORT=17321/);
  assert.match(dockerfile, /^EXPOSE 17321$/m);
  assert.match(dockerfile, /^USER node$/m, 'unprivileged, which is why it cannot bind 80 itself');
});

test('PostgreSQL is reachable from the host\'s loopback unless .env opens it, and the hub waits for it', () => {
  const compose = read('compose.yml');
  const postgres = service(compose, 'postgres');
  assert.match(postgres, /^ {6}- "\$\{POSTGRES_HOST_BIND:-127\.0\.0\.1\}:\$\{POSTGRES_HOST_PORT:-5432\}:5432"$/m);
  // Over TCP: on its first start the image initialises the database with a
  // server that listens on its socket only.
  assert.match(postgres, /pg_isready -h 127\.0\.0\.1 /);
  assert.match(service(compose, 'hub'), /depends_on:\n {6}postgres:\n {8}condition: service_healthy/);
});

test('the hub image has a pg_dump as new as the server and keeps its backups in a volume of their own', () => {
  const compose = read('compose.yml');
  const major = /^ {4}image: postgres:(\d+)-alpine$/m.exec(service(compose, 'postgres'))[1];
  // The smoke test's throwaway server is the same one.
  const smoke = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'build-hub-image.js'), 'utf8');
  assert.ok(smoke.includes(`const POSTGRES_IMAGE = 'postgres:${major}-alpine';`));
  const dockerfile = read('Dockerfile');
  assert.ok(dockerfile.includes(`RUN apk add --no-cache postgresql${major}-client \\\n && pg_dump --version | grep -q 'PostgreSQL) ${major}\\.'`));
  assert.ok(dockerfile.indexOf('postgresql') < dockerfile.indexOf('USER node'), 'installed as root, before the switch');
  assert.match(dockerfile, /TOKEN_MONITOR_BACKUP_DIR=\/backups$/m);
  assert.match(dockerfile, /^RUN mkdir -p \/data \/cache \/backups && chown -R node:node \/data \/cache \/backups$/m);
  assert.match(dockerfile, /^VOLUME \["\/data", "\/backups"\]$/m);
  assert.match(service(compose, 'hub'), /^ {6}- hub-backups:\/backups$/m);
  assert.match(compose, /^ {2}hub-backups:$/m);
  // Not the database's volume: resetting the database leaves the backups.
  assert.doesNotMatch(service(compose, 'postgres'), /hub-backups/);
});

test('the first start creates the hub\'s own role and a read-only one, never the superuser for the hub', () => {
  const init = read(path.join('postgres', 'initdb', '10-token-monitor.sh'));
  assert.match(init, /CREATE ROLE token_monitor LOGIN PASSWORD :'app_password';/);
  assert.match(init, /CREATE SCHEMA token_monitor AUTHORIZATION token_monitor;/);
  assert.match(init, /CREATE ROLE token_monitor_readonly NOLOGIN;/);
  assert.match(init, /ALTER DEFAULT PRIVILEGES FOR ROLE token_monitor IN SCHEMA token_monitor\s+GRANT SELECT ON TABLES TO token_monitor_readonly;/);
  const hub = service(read('compose.yml'), 'hub');
  assert.match(hub, /TOKEN_MONITOR_DATABASE_URL: \$\{TOKEN_MONITOR_DATABASE_URL:-postgres:\/\/token_monitor:/, 'the hub connects as token_monitor');
  assert.doesNotMatch(hub, /postgres:\/\/postgres:/);
});
