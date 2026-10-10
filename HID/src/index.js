'use strict';

const http = require('http');
const { loadConfig } = require('./config');
const { createApp } = require('./http');
const { createHidClient } = require('./hid');
const { attachHidSocket } = require('./hidProxy');

const config = loadConfig();
const hid = createHidClient(config);
const app = createApp({ config, hid });
const server = http.createServer(app);
attachHidSocket(server, { config, hid });

server.listen(config.port, config.host, () => {
  console.log(`Operator console listening on ${config.host}:${config.port}`);
});

function shutdown() {
  server.close(() => process.exit(0));
}

process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
