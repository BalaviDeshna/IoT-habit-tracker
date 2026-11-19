const Database = require('better-sqlite3');
const path = require('path');
const fs = require('fs');

const dbPath = process.env.DB_PATH || path.join(__dirname, 'petlink.db');
const db = new Database(dbPath);

// Enable foreign keys and WAL mode for better concurrency and durability
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

function initDb() {
  db.exec(`
    CREATE TABLE IF NOT EXISTS players (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      rfid_uid TEXT UNIQUE NOT NULL,
      name TEXT NOT NULL,
      avatar TEXT NOT NULL DEFAULT '👤',
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS pets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL UNIQUE,
      name TEXT NOT NULL,
      species TEXT NOT NULL,
      emoji TEXT NOT NULL DEFAULT '🐾',
      xp INTEGER NOT NULL DEFAULT 0,
      happiness INTEGER NOT NULL DEFAULT 70,
      level INTEGER NOT NULL DEFAULT 1,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS habits (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      icon TEXT NOT NULL,
      xp_reward INTEGER NOT NULL,
      happiness_reward INTEGER NOT NULL,
      description TEXT
    );

    CREATE TABLE IF NOT EXISTS habit_logs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      player_id INTEGER NOT NULL,
      habit_id TEXT NOT NULL,
      log_date TEXT NOT NULL,
      xp_awarded INTEGER NOT NULL,
      happiness_awarded INTEGER NOT NULL,
      completed_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE,
      FOREIGN KEY (habit_id) REFERENCES habits(id),
      UNIQUE (player_id, habit_id, log_date)
    );

    CREATE TABLE IF NOT EXISTS device_assignments (
      device_id TEXT PRIMARY KEY,
      player_id INTEGER NOT NULL,
      assigned_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (player_id) REFERENCES players(id) ON DELETE CASCADE
    );

    CREATE TABLE IF NOT EXISTS habitat_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      lux REAL DEFAULT 150.0,
      condition TEXT DEFAULT 'DAY',
      last_updated DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `);

  // Seed habits
  const habitCount = db.prepare('SELECT COUNT(*) as count FROM habits').get().count;
  if (habitCount === 0) {
    const insertHabit = db.prepare(`
      INSERT INTO habits (id, name, icon, xp_reward, happiness_reward, description)
      VALUES (@id, @name, @icon, @xp_reward, @happiness_reward, @description)
    `);

    const defaultHabits = [
      { id: 'water', name: 'Drink Water', icon: '💧', xp_reward: 15, happiness_reward: 10, description: 'Stay hydrated with a fresh glass of water' },
      { id: 'exercise', name: 'Daily Workout', icon: '⚡', xp_reward: 35, happiness_reward: 20, description: '20 minutes of exercise or stretching' },
      { id: 'reading', name: 'Read Book', icon: '📖', xp_reward: 25, happiness_reward: 15, description: '15 minutes of focused reading' }
    ];

    for (const h of defaultHabits) {
      insertHabit.run(h);
    }
    console.log('[DB] Seeded default habits: water, exercise, reading.');
  }

  // Ensure the revised PetLink habits exist even in databases created by the older version.
  const addHabit = db.prepare(`INSERT OR IGNORE INTO habits (id, name, icon, xp_reward, happiness_reward, description) VALUES (?, ?, ?, ?, ?, ?)`);
  [
    ['meals', 'Eat a Meal', '🍽️', 15, 8, 'Log a meal'],
    ['mood', 'Mood Check-in', '🙂', 10, 8, 'Record a mood check-in'],
    ['outdoor_walk', 'Outdoor Walk', '🚶', 30, 20, 'Sensor-verified outdoor walking']
  ].forEach(h => addHabit.run(...h));

  // Seed 4 predefined players and pets
  const playerCount = db.prepare('SELECT COUNT(*) as count FROM players').get().count;
  if (playerCount === 0) {
    const insertPlayer = db.prepare(`
      INSERT INTO players (rfid_uid, name, avatar) VALUES (?, ?, ?)
    `);
    const insertPet = db.prepare(`
      INSERT INTO pets (player_id, name, species, emoji, xp, happiness, level)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `);

    const defaultPlayers = [
      {
        uid: 'A1B2C3D4',
        name: 'Alex',
        avatar: '🦊',
        pet: { name: 'Sparky', species: 'Fox Sprite', emoji: '🦊', xp: 45, happiness: 85, level: 1 }
      },
      {
        uid: 'E5F6A7B8',
        name: 'Bella',
        avatar: '🐱',
        pet: { name: 'Mochi', species: 'Star Cat', emoji: '🐱', xp: 60, happiness: 90, level: 1 }
      },
      {
        uid: 'C9D0E1F2',
        name: 'Charlie',
        avatar: '🦖',
        pet: { name: 'Rex', species: 'Mini Dino', emoji: '🦖', xp: 20, happiness: 75, level: 1 }
      },
      {
        uid: '3A4B5C6D',
        name: 'Diana',
        avatar: '🦉',
        pet: { name: 'Luna', species: 'Moon Owl', emoji: '🦉', xp: 120, happiness: 95, level: 2 }
      }
    ];

    const seedTransaction = db.transaction(() => {
      for (const p of defaultPlayers) {
        const info = insertPlayer.run(p.uid, p.name, p.avatar);
        const playerId = info.lastInsertRowid;
        insertPet.run(
          playerId,
          p.pet.name,
          p.pet.species,
          p.pet.emoji,
          p.pet.xp,
          p.pet.happiness,
          p.pet.level
        );
      }
    });

    seedTransaction();
    console.log('[DB] Seeded 4 predefined players with virtual pets.');
  }

  // Seed initial habitat state
  const habitatExists = db.prepare('SELECT COUNT(*) as count FROM habitat_state WHERE id = 1').get().count;
  if (habitatExists === 0) {
    db.prepare(`
      INSERT INTO habitat_state (id, lux, condition) VALUES (1, 200.0, 'DAY')
    `).run();
    console.log('[DB] Initialized habitat state: DAY (200 lux).');
  }
}

// Initialize on module load
initDb();

// Helper to get local date string YYYY-MM-DD
function getLocalDateString() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// Queries & Mutations
function getAllPlayersWithPets() {
  const today = getLocalDateString();
  const players = db.prepare(`
    SELECT 
      p.id, p.rfid_uid, p.name, p.avatar, p.created_at,
      pt.id as pet_id, pt.name as pet_name, pt.species as pet_species,
      pt.emoji as pet_emoji, pt.xp, pt.happiness, pt.level, pt.updated_at as pet_updated_at
    FROM players p
    JOIN pets pt ON pt.player_id = p.id
    ORDER BY p.id ASC
  `).all();

  // Attach today's completed habit IDs
  const todayHabitsStmt = db.prepare(`
    SELECT habit_id, completed_at FROM habit_logs 
    WHERE player_id = ? AND log_date = ?
  `);

  return players.map(p => {
    const todayLogs = todayHabitsStmt.all(p.id, today);
    return {
      id: p.id,
      rfid_uid: p.rfid_uid,
      name: p.name,
      avatar: p.avatar,
      pet: {
        id: p.pet_id,
        name: p.pet_name,
        species: p.pet_species,
        emoji: p.pet_emoji,
        xp: p.xp,
        happiness: p.happiness,
        level: p.level,
        next_level_xp: p.level * 100
      },
      completed_today: todayLogs.map(l => l.habit_id),
      today_logs: todayLogs
    };
  });
}

function getPlayerByUid(uid) {
  if (!uid) return null;
  const normalizedUid = uid.toString().trim().toUpperCase().replace(/[\s:-]/g, '');
  return db.prepare(`
    SELECT 
      p.id, p.rfid_uid, p.name, p.avatar,
      pt.id as pet_id, pt.name as pet_name, pt.species as pet_species,
      pt.emoji as pet_emoji, pt.xp, pt.happiness, pt.level
    FROM players p
    JOIN pets pt ON pt.player_id = p.id
    WHERE UPPER(REPLACE(REPLACE(REPLACE(p.rfid_uid, ' ', ''), ':', ''), '-', '')) = ?
  `).get(normalizedUid);
}

function getPlayerById(id) {
  return db.prepare(`
    SELECT 
      p.id, p.rfid_uid, p.name, p.avatar,
      pt.id as pet_id, pt.name as pet_name, pt.species as pet_species,
      pt.emoji as pet_emoji, pt.xp, pt.happiness, pt.level
    FROM players p
    JOIN pets pt ON pt.player_id = p.id
    WHERE p.id = ?
  `).get(id);
}

function updatePlayerUid(playerId, newUid) {
  const normalized = newUid.toString().trim().toUpperCase().replace(/[\s:-]/g, '');
  return db.prepare(`UPDATE players SET rfid_uid = ? WHERE id = ?`).run(normalized, playerId);
}

function assignDeviceToPlayer(deviceId, playerId) {
  if (!deviceId || !Number.isInteger(Number(playerId))) throw new Error('deviceId and playerId are required');
  const player = getPlayerById(Number(playerId));
  if (!player) throw new Error('Player not found');
  db.prepare(`INSERT INTO device_assignments (device_id, player_id) VALUES (?, ?) ON CONFLICT(device_id) DO UPDATE SET player_id=excluded.player_id, assigned_at=CURRENT_TIMESTAMP`).run(String(deviceId), Number(playerId));
  return getPlayerByDeviceId(deviceId);
}

function getPlayerByDeviceId(deviceId) {
  if (!deviceId) return null;
  return db.prepare(`SELECT p.id, p.rfid_uid, p.name, p.avatar, pt.id AS pet_id, pt.name AS pet_name, pt.species AS pet_species, pt.emoji AS pet_emoji, pt.xp, pt.happiness, pt.level FROM device_assignments a JOIN players p ON p.id=a.player_id JOIN pets pt ON pt.player_id=p.id WHERE a.device_id=?`).get(String(deviceId)) || null;
}

function getHabits() {
  return db.prepare('SELECT * FROM habits ORDER BY id ASC').all();
}

function getHabitById(habitId) {
  return db.prepare('SELECT * FROM habits WHERE id = ?').get(habitId);
}

function hasCompletedToday(playerId, habitId, logDate) {
  const today = logDate || getLocalDateString();
  const row = db.prepare(`
    SELECT id FROM habit_logs 
    WHERE player_id = ? AND habit_id = ? AND log_date = ?
  `).get(playerId, habitId, today);
  return !!row;
}

// logDate (optional, YYYY-MM-DD): the day the habit was actually done.
// Used for events synced later from the ESP32's offline queue.
function recordHabitCompletion(playerId, habitId, logDate) {
  const today = logDate || getLocalDateString();
  const habit = getHabitById(habitId);
  if (!habit) {
    throw new Error(`Unknown habit: ${habitId}`);
  }

  // Check duplicate
  if (hasCompletedToday(playerId, habitId, today)) {
    return {
      success: false,
      duplicate: true,
      message: `Habit "${habit.name}" has already been logged today!`
    };
  }

  const player = getPlayerById(playerId);
  if (!player) {
    throw new Error(`Player not found with ID ${playerId}`);
  }

  // Calculate new stats
  const addedXp = habit.xp_reward;
  const addedHappiness = habit.happiness_reward;
  const currentXp = player.xp + addedXp;
  const currentHappiness = Math.min(100, player.happiness + addedHappiness);
  
  // Level formula: Level 1: 0-99 XP, Level 2: 100-199 XP, Level N: floor(XP / 100) + 1
  const newLevel = Math.max(1, Math.floor(currentXp / 100) + 1);
  const leveledUp = newLevel > player.level;

  const tx = db.transaction(() => {
    // 1. Insert habit log
    db.prepare(`
      INSERT INTO habit_logs (player_id, habit_id, log_date, xp_awarded, happiness_awarded)
      VALUES (?, ?, ?, ?, ?)
    `).run(playerId, habitId, today, addedXp, addedHappiness);

    // 2. Update pet stats
    db.prepare(`
      UPDATE pets 
      SET xp = ?, happiness = ?, level = ?, updated_at = CURRENT_TIMESTAMP
      WHERE player_id = ?
    `).run(currentXp, currentHappiness, newLevel, playerId);
  });

  tx();

  const updatedPlayer = getPlayerById(playerId);

  return {
    success: true,
    duplicate: false,
    leveledUp,
    habit,
    player: updatedPlayer,
    awarded: {
      xp: addedXp,
      happiness: addedHappiness
    },
    message: leveledUp 
      ? `Level UP! ${player.pet_name} reached Level ${newLevel}! (+${addedXp} XP, +${addedHappiness} Happiness)`
      : `Great job! Logged ${habit.name}! (+${addedXp} XP, +${addedHappiness} Happiness)`
  };
}

function getRecentLogs(limit = 15) {
  return db.prepare(`
    SELECT 
      hl.id, hl.completed_at, hl.log_date, hl.xp_awarded, hl.happiness_awarded,
      p.name as player_name, p.avatar as player_avatar,
      pt.name as pet_name, pt.emoji as pet_emoji,
      h.name as habit_name, h.icon as habit_icon, h.id as habit_id
    FROM habit_logs hl
    JOIN players p ON p.id = hl.player_id
    JOIN pets pt ON pt.player_id = p.id
    JOIN habits h ON h.id = hl.habit_id
    ORDER BY hl.completed_at DESC, hl.id DESC
    LIMIT ?
  `).all(limit);
}

function updateHabitatState(lux, condition) {
  const safeLux = Math.max(0, parseFloat(lux) || 0);
  const safeCondition = (condition || (safeLux >= 50.0 ? 'DAY' : 'NIGHT')).toUpperCase();

  db.prepare(`
    UPDATE habitat_state 
    SET lux = ?, condition = ?, last_updated = CURRENT_TIMESTAMP
    WHERE id = 1
  `).run(safeLux, safeCondition);

  return { lux: safeLux, condition: safeCondition };
}

function getHabitatState() {
  const row = db.prepare('SELECT lux, condition, last_updated FROM habitat_state WHERE id = 1').get();
  return row || { lux: 200.0, condition: 'DAY', last_updated: new Date().toISOString() };
}

module.exports = {
  db,
  initDb,
  getLocalDateString,
  getAllPlayersWithPets,
  getPlayerByUid,
  getPlayerById,
  assignDeviceToPlayer,
  getPlayerByDeviceId,
  updatePlayerUid,
  getHabits,
  getHabitById,
  hasCompletedToday,
  recordHabitCompletion,
  getRecentLogs,
  updateHabitatState,
  getHabitatState
};
