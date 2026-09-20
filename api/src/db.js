const { Pool } = require('pg');
require('dotenv').config();

// Connection pool sitting between the API and Postgres, matching the
// "pg-pool" component in the VoltGrid architecture diagram.
const pool = new Pool({
  host: process.env.PGHOST,
  port: process.env.PGPORT,
  database: process.env.PGDATABASE,
  user: process.env.PGUSER,
  password: process.env.PGPASSWORD,
  max: 10,
  idleTimeoutMillis: 30000,
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle Postgres client', err);
});

module.exports = pool;
