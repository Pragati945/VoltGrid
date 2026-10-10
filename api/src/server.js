require('dotenv').config();

if (!process.env.JWT_SECRET) {
  console.error('FATAL: JWT_SECRET is not set. Add it to your .env file.');
  process.exit(1);
}

const http = require('http');
const app = require('./app');
const { initSocket } = require('./socket');

const PORT = process.env.PORT || 4000;

// Socket.IO needs a raw HTTP server to attach to, rather than the Express app directly.
const httpServer = http.createServer(app);

initSocket(httpServer);

httpServer.listen(PORT, () => {
  console.log(`VoltGrid API listening on http://localhost:${PORT}`);
  console.log(`Socket.IO ready for real-time connections`);
});
