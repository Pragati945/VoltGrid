// Holds the Socket.IO server instance so any route file can emit events
// without needing to import server.js directly (which would create a
// circular dependency: server.js -> app.js -> routes -> server.js).
//
// server.js calls initSocket(httpServer) once at startup.
// Any route file calls getIO() to emit an event, e.g.:
//   const { getIO } = require('../socket');
//   getIO().emit('booking:created', booking);

const { Server } = require('socket.io');

let io = null;

function initSocket(httpServer) {
  io = new Server(httpServer, {
    cors: {
      origin: '*', // open for local development; tighten this before any real deployment
    },
  });

  io.on('connection', (socket) => {
    console.log(`Socket connected: ${socket.id}`);

    // Clients can join a "room" for one station, so they only receive
    // events relevant to the station they're viewing (e.g. a driver
    // watching one station's chargers doesn't need every station's noise).
    socket.on('station:join', (stationId) => {
      socket.join(`station:${stationId}`);
    });

    socket.on('station:leave', (stationId) => {
      socket.leave(`station:${stationId}`);
    });

    socket.on('disconnect', () => {
      console.log(`Socket disconnected: ${socket.id}`);
    });
  });

  return io;
}

function getIO() {
  if (!io) {
    throw new Error('Socket.IO not initialized yet — initSocket(httpServer) must run first');
  }
  return io;
}

// Emit without ever breaking an API request: if the socket server isn't up
// (or an emit throws), log it and carry on. Always call this AFTER the DB
// commit so clients never hear about something that got rolled back.
function emitSafe(event, payload) {
  try {
    if (io) io.emit(event, payload);
  } catch (err) {
    console.error(`Socket emit failed for "${event}":`, err);
  }
}

module.exports = { initSocket, getIO, emitSafe };
