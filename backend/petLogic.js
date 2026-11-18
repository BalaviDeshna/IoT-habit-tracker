const db = require('../database/db');

// Habit business logic and validation
function processRfidScan(uid) {
  if (!uid || typeof uid !== 'string') {
    return {
      success: false,
      error: 'Invalid or missing RFID UID'
    };
  }

  const cleanUid = uid.trim().toUpperCase().replace(/[\s:-]/g, '');
  const player = db.getPlayerByUid(cleanUid);

  if (!player) {
    return {
      success: false,
      notFound: true,
      uid: cleanUid,
      display: {
        status: 'unknown',
        line1: 'CARD NOT FOUND',
        line2: `UID: ${cleanUid.slice(0, 10)}`,
        line3: 'Not registered in DB',
        line4: 'Try another card'
      }
    };
  }

  const today = db.getLocalDateString();
  const completedToday = db.db.prepare(`
    SELECT habit_id FROM habit_logs WHERE player_id = ? AND log_date = ?
  `).all(player.id, today).map(r => r.habit_id);

  return {
    success: true,
    player,
    completedToday,
    display: {
      status: 'ready',
      playerId: player.id,
      player: player.name,
      pet: player.pet_name,
      level: player.level,
      line1: `Hi ${player.name}!`,
      line2: `${player.pet_emoji} ${player.pet_name} Lv${player.level}`,
      line3: 'Select habit [NEXT]',
      line4: 'Press [CONFIRM]'
    }
  };
}

function processHabitSubmission(uid, habitKey, logDate) {
  if (!uid || typeof uid !== 'string') {
    return { success: false, error: 'Missing or invalid UID' };
  }
  if (!habitKey || typeof habitKey !== 'string') {
    return { success: false, error: 'Missing or invalid habit key' };
  }

  const cleanUid = uid.trim().toUpperCase().replace(/[\s:-]/g, '');
  const cleanHabit = habitKey.trim().toLowerCase();

  const player = db.getPlayerByUid(cleanUid);
  if (!player) {
    return {
      success: false,
      notFound: true,
      display: {
        status: 'error',
        line1: 'ERROR: USER UNKNOWN',
        line2: 'Scan registered card',
        line3: 'to log your habit',
        line4: ''
      }
    };
  }

  const habit = db.getHabitById(cleanHabit);
  if (!habit) {
    return {
      success: false,
      error: `Unknown habit "${cleanHabit}"`,
      display: {
        status: 'error',
        line1: 'INVALID HABIT',
        line2: cleanHabit.slice(0, 16),
        line3: 'Water / Exercise / Read',
        line4: ''
      }
    };
  }

  const result = db.recordHabitCompletion(player.id, cleanHabit, logDate);

  if (result.duplicate) {
    return {
      success: false,
      duplicate: true,
      player,
      habit,
      display: {
        status: 'duplicate',
        line1: 'ALREADY LOGGED!',
        line2: `${habit.icon} ${habit.name.slice(0, 13)}`,
        line3: 'Already done today!',
        line4: `Lv${player.level} (${player.xp} XP)`
      }
    };
  }

  return {
    success: true,
    leveledUp: result.leveledUp,
    player: result.player,
    habit: result.habit,
    awarded: result.awarded,
    message: result.message,
    display: {
      status: 'success',
      line1: result.leveledUp ? '★ LEVEL UP! ★' : `${habit.icon} WELL DONE!`,
      line2: `+${result.awarded.xp}XP +${result.awarded.happiness}HP`,
      line3: `${result.player.pet_name}: Lv${result.player.level}`,
      line4: `Total XP: ${result.player.xp}`
    }
  };
}

function processLightReading(lux) {
  const numericLux = Number(lux);
  if (isNaN(numericLux) || numericLux < 0) {
    return null;
  }

  // Day/Night threshold: >= 50 lux is DAY, < 50 lux is NIGHT
  const condition = numericLux >= 50.0 ? 'DAY' : 'NIGHT';
  const updated = db.updateHabitatState(numericLux, condition);

  return {
    lux: updated.lux,
    condition: updated.condition,
    timestamp: new Date().toISOString()
  };
}

function getIdleDisplayState() {
  const habitat = db.getHabitatState();
  return {
    status: 'idle',
    line1: '== PETLINK STATION ==',
    line2: `Habitat: ${habitat.condition} (${Math.round(habitat.lux)} lx)`,
    line3: '>> Scan RFID Card <<',
    line4: 'Ready to track!'
  };
}

module.exports = {
  processRfidScan,
  processHabitSubmission,
  processLightReading,
  getIdleDisplayState
};
