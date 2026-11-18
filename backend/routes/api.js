const express = require('express');
const router = express.Router();
const db = require('../../database/db');
const petLogic = require('../petLogic');
const reliability = require('../deviceReliability');

module.exports = function(mqttService, io) {
  // Station online/offline + store-and-forward counters
  router.get('/devices', (req, res) => {
    try {
      res.json({ success: true, data: { devices: reliability.listDevices(), events: reliability.getEventStats() } });
    } catch (err) {
      console.error('[API] /devices error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 1. Get full initial state for dashboard load
  router.get('/state', (req, res) => {
    try {
      const players = db.getAllPlayersWithPets();
      const habits = db.getHabits();
      const habitat = db.getHabitatState();
      const recentLogs = db.getRecentLogs(15);
      const idleDisplay = petLogic.getIdleDisplayState();

      res.json({
        success: true,
        data: {
          players,
          habits,
          habitat,
          recentLogs,
          display: idleDisplay,
          today: db.getLocalDateString()
        }
      });
    } catch (err) {
      console.error('[API] /state error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 2. Update a player's RFID UID (useful to map real physical cards)
  router.put('/players/:id/uid', (req, res) => {
    try {
      const playerId = parseInt(req.params.id, 10);
      const { rfid_uid } = req.body;

      if (!rfid_uid || typeof rfid_uid !== 'string') {
        return res.status(400).json({ success: false, error: 'Valid rfid_uid string is required' });
      }

      db.updatePlayerUid(playerId, rfid_uid);
      const updatedPlayer = db.getPlayerById(playerId);

      // Broadcast update
      if (io) {
        io.emit('player_updated', { player: updatedPlayer, allPlayers: db.getAllPlayersWithPets() });
      }

      res.json({ success: true, message: `Updated UID for player #${playerId}`, player: updatedPlayer });
    } catch (err) {
      console.error('[API] Update UID error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 3. Web simulation / manual trigger for RFID scan
  router.post('/rfid/scan', (req, res) => {
    try {
      const { uid, deviceId } = req.body;
      if (!uid) {
        return res.status(400).json({ success: false, error: 'UID is required' });
      }

      // Delegate through mqttService handler logic
      if (mqttService) {
        const payloadBuffer = Buffer.from(JSON.stringify({
          uid,
          deviceId: deviceId || 'web-sim-station',
          timestamp: Date.now()
        }));
        mqttService.handleIncomingMessage('petlink/device/rfid', payloadBuffer);
      }

      res.json({ success: true, message: `Simulated scan for UID ${uid}` });
    } catch (err) {
      console.error('[API] /rfid/scan error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 4. Web simulation / manual trigger for habit completion
  router.post('/habits/log', (req, res) => {
    try {
      const { uid, habit, deviceId } = req.body;
      if (!uid || !habit) {
        return res.status(400).json({ success: false, error: 'Both "uid" and "habit" are required' });
      }

      if (mqttService) {
        const payloadBuffer = Buffer.from(JSON.stringify({
          uid,
          habit,
          deviceId: deviceId || 'web-sim-station',
          timestamp: Date.now()
        }));
        mqttService.handleIncomingMessage('petlink/device/habit', payloadBuffer);
      }

      res.json({ success: true, message: `Logged habit "${habit}" for UID "${uid}"` });
    } catch (err) {
      console.error('[API] /habits/log error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 5. Web simulation / manual trigger for light sensor
  router.post('/habitat/light', (req, res) => {
    try {
      const { lux, deviceId } = req.body;
      if (lux === undefined || isNaN(Number(lux))) {
        return res.status(400).json({ success: false, error: 'Numeric lux is required' });
      }

      if (mqttService) {
        const payloadBuffer = Buffer.from(JSON.stringify({
          lux: Number(lux),
          deviceId: deviceId || 'web-sim-sensor',
          timestamp: Date.now()
        }));
        mqttService.handleIncomingMessage('petlink/habitat/light', payloadBuffer);
      }

      res.json({ success: true, lux: Number(lux) });
    } catch (err) {
      console.error('[API] /habitat/light error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  // 6. Convenience reset for today's logs (helpful for demonstration / testing)
  router.post('/reset-today', (req, res) => {
    try {
      const today = db.getLocalDateString();
      db.db.prepare('DELETE FROM habit_logs WHERE log_date = ?').run(today);

      const allPlayers = db.getAllPlayersWithPets();
      if (io) {
        io.emit('all_players_refresh', { allPlayers, recentLogs: db.getRecentLogs(15) });
      }

      res.json({ success: true, message: `Cleared habit logs for today (${today})` });
    } catch (err) {
      console.error('[API] /reset-today error:', err);
      res.status(500).json({ success: false, error: err.message });
    }
  });

  return router;
};
