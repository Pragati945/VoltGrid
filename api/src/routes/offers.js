const express = require('express');
const { authenticate } = require('../middleware/auth');
const { pendingOffers, acceptOffer, declineOffer } = require('../scheduler');

const router = express.Router();

// GET /offers - my open offers (so a driver who logs in later still sees them)
router.get('/', authenticate, async (req, res) => {
  try {
    res.json(await pendingOffers(req.user.id));
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Failed to fetch offers' });
  }
});

// POST /offers/:id/accept - "yes, I want the charger now"
router.post('/:id/accept', authenticate, async (req, res) => {
  const r = await acceptOffer(req.user.id, Number(req.params.id));
  res.status(r.status).json(r.body);
});

// POST /offers/:id/decline - "no thanks"; the charger is offered to the next candidate
router.post('/:id/decline', authenticate, async (req, res) => {
  const r = await declineOffer(req.user.id, Number(req.params.id));
  res.status(r.status).json(r.body);
});

module.exports = router;
