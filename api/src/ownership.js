const pool = require('./db');

// Admins manage everything. Operators manage only stations where stations.operator_id = their user id.
async function ownsStation(user, stationId, db = pool) {
  if (user.role === 'admin') return true;
  if (user.role !== 'operator') return false;
  const r = await db.query('SELECT 1 FROM stations WHERE id = $1 AND operator_id = $2', [stationId, user.id]);
  return r.rows.length > 0;
}
async function ownsCharger(user, chargerId, db = pool) {
  if (user.role === 'admin') return true;
  if (user.role !== 'operator') return false;
  const r = await db.query(
    'SELECT 1 FROM chargers c JOIN stations s ON s.id = c.station_id WHERE c.id = $1 AND s.operator_id = $2',
    [chargerId, user.id]
  );
  return r.rows.length > 0;
}
module.exports = { ownsStation, ownsCharger };
