const express = require('express');
const cors = require('cors');

const authRoutes = require('./routes/auth');
const userRoutes = require('./routes/users');
const vehicleRoutes = require('./routes/vehicles');
const stationRoutes = require('./routes/stations');
const chargerRoutes = require('./routes/chargers');
const bookingRoutes = require('./routes/bookings');
const queueRoutes = require('./routes/queue');
const telemetryRoutes = require('./routes/telemetry');
const ledgerRoutes = require('./routes/ledger');

const app = express();

app.use(cors());
app.use(express.json());

app.get('/health', (req, res) => res.json({ status: 'ok' }));

app.use('/auth', authRoutes);
app.use('/users', userRoutes);
app.use('/vehicles', vehicleRoutes);
app.use('/stations', stationRoutes);
app.use('/chargers', chargerRoutes);
app.use('/bookings', bookingRoutes);
app.use('/queue', queueRoutes);
app.use('/telemetry', telemetryRoutes);
app.use('/ledger', ledgerRoutes);

// 404 fallback
app.use((req, res) => {
  res.status(404).json({ error: 'Route not found' });
});

// Central error handler (catches anything thrown synchronously outside routes)
app.use((err, req, res, next) => {
  console.error(err);
  res.status(500).json({ error: 'Internal server error' });
});

module.exports = app;
