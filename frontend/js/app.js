// PetLink Frontend Application Logic
const socket = io();

let currentPlayers = [];
let currentHabits = [];
let currentHabitat = { lux: 200, condition: 'DAY' };

// Elements
const bodyEl = document.body;
const celestialBodyEl = document.getElementById('celestialBody');
const habitatConditionEl = document.getElementById('habitatCondition');
const habitatLuxEl = document.getElementById('habitatLux');
const habitatIconEl = document.getElementById('habitatIcon');

const mqttDotEl = document.getElementById('mqttDot');
const mqttStatusTextEl = document.getElementById('mqttStatusText');
const mqttBrokerTextEl = document.getElementById('mqttBrokerText');

const oledL1 = document.getElementById('oledL1');
const oledL2 = document.getElementById('oledL2');
const oledL3 = document.getElementById('oledL3');
const oledL4 = document.getElementById('oledL4');

const playersGrid = document.getElementById('playersGrid');
const activityList = document.getElementById('activityList');
const toastContainer = document.getElementById('toastContainer');

// Modal Elements
const uidModal = document.getElementById('uidModal');
const modalPlayerName = document.getElementById('modalPlayerName');
const modalPlayerId = document.getElementById('modalPlayerId');
const modalUidInput = document.getElementById('modalUidInput');

// 1. Socket.IO Listeners
socket.on('connect', () => {
  console.log('[Socket.IO] Connected to backend server');
  setMqttStatus(true);
});

socket.on('disconnect', () => {
  console.warn('[Socket.IO] Disconnected from backend server');
  setMqttStatus(false, 'Disconnected');
});

socket.on('mqtt_status', (data) => {
  setMqttStatus(data.connected, data.reconnecting ? 'Reconnecting...' : (data.connected ? 'Connected' : 'Offline'), data.broker);
});

socket.on('initial_state', (payload) => {
  console.log('[Socket.IO] Received initial_state:', payload);
  currentPlayers = payload.players || [];
  currentHabits = payload.habits || [];
  currentHabitat = payload.habitat || { lux: 200, condition: 'DAY' };

  updateHabitatUI(currentHabitat);
  renderPlayers(currentPlayers);
  if (payload.recentLogs) {
    renderActivityList(payload.recentLogs);
  }
  if (payload.display) {
    updateOledDisplay(payload.display);
  }
  if (payload.mqttStatus) {
    setMqttStatus(payload.mqttStatus.connected, payload.mqttStatus.connected ? 'Connected' : 'Disconnected', payload.mqttStatus.broker);
  }
});

socket.on('habitat_update', (data) => {
  currentHabitat = data;
  updateHabitatUI(data);
});

socket.on('device_display', (displayData) => {
  updateOledDisplay(displayData);
});

socket.on('rfid_scanned', (data) => {
  if (data.success && data.player) {
    showToast(`💳 RFID Card scanned: ${data.player.name} (${data.player.pet_name})`, 'success');
    highlightPlayerCard(data.player.id);
  } else {
    showToast(`⚠️ Unregistered RFID Card scanned (UID: ${data.uid || 'Unknown'})`, 'warning');
  }
});

socket.on('habit_completed', (data) => {
  console.log('[Socket.IO] Habit completed:', data);
  if (data.leveledUp) {
    showToast(`🎉 LEVEL UP! ${data.player.pet_name} reached Level ${data.player.level}! (+${data.awarded.xp} XP)`, 'success');
  } else {
    showToast(`✅ ${data.player.name} completed ${data.habit.name}! (+${data.awarded.xp} XP, +${data.awarded.happiness} HP)`, 'success');
  }

  if (data.allPlayers) {
    currentPlayers = data.allPlayers;
    renderPlayers(currentPlayers);
  }
  if (data.recentLogs) {
    renderActivityList(data.recentLogs);
  }
});

socket.on('habit_duplicate', (data) => {
  showToast(`⏳ ${data.player.name} already logged ${data.habit.name} today!`, 'warning');
});

socket.on('habit_error', (data) => {
  showToast(`❌ Error: ${data.error}`, 'danger');
});

socket.on('player_updated', (data) => {
  if (data.allPlayers) {
    currentPlayers = data.allPlayers;
    renderPlayers(currentPlayers);
  }
});

socket.on('all_players_refresh', (data) => {
  currentPlayers = data.allPlayers;
  renderPlayers(currentPlayers);
  if (data.recentLogs) {
    renderActivityList(data.recentLogs);
  }
});

// 2. UI Update Functions
function updateHabitatUI(habitat) {
  const isDay = habitat.condition === 'DAY';
  const lux = parseFloat(habitat.lux || 0).toFixed(1);

  if (isDay) {
    bodyEl.className = 'habitat-day';
    celestialBodyEl.textContent = '☀️';
    habitatIconEl.textContent = '☀️';
    habitatConditionEl.textContent = 'DAY';
    habitatLuxEl.textContent = `${lux} lux (Daytime)`;
  } else {
    bodyEl.className = 'habitat-night';
    celestialBodyEl.textContent = '🌙';
    habitatIconEl.textContent = '🌙';
    habitatConditionEl.textContent = 'NIGHT';
    habitatLuxEl.textContent = `${lux} lux (Nighttime)`;
  }
}

function setMqttStatus(connected, text, broker) {
  if (connected) {
    mqttDotEl.textContent = '🟢';
    mqttStatusTextEl.textContent = text || 'Connected';
  } else {
    mqttDotEl.textContent = '🔴';
    mqttStatusTextEl.textContent = text || 'Offline';
  }
  if (broker) {
    mqttBrokerTextEl.textContent = broker.replace('mqtt://', '');
  }
}

function updateOledDisplay(display) {
  if (!display) return;
  oledL1.textContent = display.line1 || '';
  oledL2.textContent = display.line2 || '';
  oledL3.textContent = display.line3 || '';
  oledL4.textContent = display.line4 || '';
}

function renderPlayers(players) {
  if (!players || players.length === 0) {
    playersGrid.innerHTML = '<div class="empty-state">No players found in database.</div>';
    return;
  }

  playersGrid.innerHTML = players.map(p => {
    const pet = p.pet || {};
    const xp = pet.xp || 0;
    const level = pet.level || 1;
    const nextLevelXp = level * 100;
    const prevLevelXp = (level - 1) * 100;
    const xpProgressInLevel = Math.max(0, Math.min(100, Math.round(((xp - prevLevelXp) / (nextLevelXp - prevLevelXp)) * 100)));
    const happiness = Math.min(100, Math.max(0, pet.happiness || 50));
    const completedToday = p.completed_today || [];

    return `
      <div class="player-card" id="player-card-${p.id}">
        <div class="player-header">
          <div class="player-identity">
            <span class="player-avatar">${p.avatar || '👤'}</span>
            <span class="player-name">${escapeHtml(p.name)}</span>
          </div>
          <button class="uid-chip" title="Click to reassign card UID" onclick="openUidModal(${p.id}, '${escapeHtml(p.name)}', '${escapeHtml(p.rfid_uid)}')">
            UID: ${escapeHtml(p.rfid_uid)} ✏️
          </button>
        </div>

        <div class="pet-stage">
          <div class="pet-emoji">${pet.emoji || '🐾'}</div>
          <div class="pet-meta">
            <span class="pet-name-title">${escapeHtml(pet.name)}</span>
            <span class="pet-level-pill">Lv. ${level}</span>
          </div>
          <div class="pet-species">${escapeHtml(pet.species || 'Virtual Companion')}</div>
        </div>

        <div class="stat-bars">
          <!-- XP Bar -->
          <div class="stat-item">
            <div class="stat-label-row">
              <span>XP Progress</span>
              <span>${xp} / ${nextLevelXp} XP (${xpProgressInLevel}%)</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill xp" style="width: ${xpProgressInLevel}%"></div>
            </div>
          </div>

          <!-- Happiness Bar -->
          <div class="stat-item">
            <div class="stat-label-row">
              <span>Happiness</span>
              <span>${happiness}% ❤️</span>
            </div>
            <div class="progress-track">
              <div class="progress-fill happiness" style="width: ${happiness}%"></div>
            </div>
          </div>
        </div>

        <!-- Today's Habits -->
        <div class="habits-checklist-wrapper">
          <div class="checklist-title">Daily Habits (Today)</div>
          <div class="habit-checklist">
            ${renderHabitItems(p, completedToday)}
          </div>
        </div>
      </div>
    `;
  }).join('');
}

function renderHabitItems(player, completedList) {
  const habits = currentHabits.length > 0 ? currentHabits : [
    { id: 'water', name: 'Drink Water', icon: '💧', xp_reward: 15, happiness_reward: 10 },
    { id: 'exercise', name: 'Daily Workout', icon: '⚡', xp_reward: 35, happiness_reward: 20 },
    { id: 'reading', name: 'Read Book', icon: '📖', xp_reward: 25, happiness_reward: 15 }
  ];

  return habits.map(h => {
    const isDone = completedList.includes(h.id);
    return `
      <div class="habit-item ${isDone ? 'completed' : ''}">
        <div class="habit-info">
          <span>${h.icon}</span>
          <span>${escapeHtml(h.name)}</span>
        </div>
        ${isDone ? `
          <span class="habit-check-done">✓ Done</span>
        ` : `
          <button class="habit-action-btn" onclick="quickLogHabit('${escapeHtml(player.rfid_uid)}', '${h.id}')">
            +${h.xp_reward}XP Log
          </button>
        `}
      </div>
    `;
  }).join('');
}

function renderActivityList(logs) {
  if (!logs || logs.length === 0) {
    activityList.innerHTML = '<div class="empty-state">No habit logs recorded today yet. Scan a card to begin!</div>';
    return;
  }

  activityList.innerHTML = logs.map(l => {
    const timeFormatted = new Date(l.completed_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    return `
      <div class="activity-row">
        <div class="activity-main">
          <span>${l.player_avatar || '👤'}</span>
          <strong>${escapeHtml(l.player_name)}</strong>
          <span>completed <strong>${escapeHtml(l.habit_name)}</strong> ${l.habit_icon || '✨'}</span>
        </div>
        <div style="display: flex; align-items: center; gap: 12px;">
          <span class="activity-reward">+${l.xp_awarded} XP / +${l.happiness_awarded} HP</span>
          <span class="activity-time">${timeFormatted}</span>
        </div>
      </div>
    `;
  }).join('');
}

function highlightPlayerCard(playerId) {
  const card = document.getElementById(`player-card-${playerId}`);
  if (card) {
    card.classList.add('active-scanning');
    setTimeout(() => {
      card.classList.remove('active-scanning');
    }, 2500);
  }
}

// 3. Hardware Simulation Helpers
function simulateRfid(uid) {
  fetch('/api/rfid/scan', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid })
  }).catch(err => console.error('Simulate RFID failed:', err));
}

function quickLogHabit(uid, habit) {
  fetch('/api/habits/log', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ uid, habit })
  }).catch(err => console.error('Quick log habit failed:', err));
}

function updateLuxInput(val) {
  document.getElementById('luxSliderVal').textContent = `${val} lux`;
}

function sendSimulatedLux() {
  const luxVal = document.getElementById('luxSlider').value;
  fetch('/api/habitat/light', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lux: parseFloat(luxVal) })
  }).catch(err => console.error('Set lux failed:', err));
}

function toggleDayNightSim() {
  const targetLux = currentHabitat.condition === 'DAY' ? 15 : 220;
  document.getElementById('luxSlider').value = targetLux;
  updateLuxInput(targetLux);
  fetch('/api/habitat/light', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ lux: targetLux })
  }).catch(err => console.error('Toggle Day/Night failed:', err));
}

function resetTodayLogs() {
  if (!confirm("Are you sure you want to reset today's habit completions for all players?")) return;
  fetch('/api/reset-today', { method: 'POST' })
    .then(r => r.json())
    .then(data => {
      showToast('Daily logs reset for demonstration!', 'info');
    })
    .catch(err => console.error('Reset logs failed:', err));
}

// 4. Modal Handling for UID Editing
function openUidModal(playerId, playerName, currentUid) {
  modalPlayerId.value = playerId;
  modalPlayerName.textContent = playerName;
  modalUidInput.value = currentUid;
  uidModal.style.display = 'flex';
  modalUidInput.focus();
}

function closeUidModal() {
  uidModal.style.display = 'none';
}

function saveUidModal() {
  const playerId = modalPlayerId.value;
  const newUid = modalUidInput.value.trim().toUpperCase().replace(/[\s:-]/g, '');
  if (!newUid) {
    alert('Please enter a valid RFID UID');
    return;
  }

  fetch(`/api/players/${playerId}/uid`, {
    method: 'PUT',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ rfid_uid: newUid })
  })
    .then(r => r.json())
    .then(res => {
      if (res.success) {
        showToast(`Saved UID ${newUid} for ${modalPlayerName.textContent}!`, 'success');
        closeUidModal();
      } else {
        alert(res.error || 'Failed to update UID');
      }
    })
    .catch(err => {
      console.error('Update UID error:', err);
      alert('Error saving UID: ' + err.message);
    });
}

// Toast helper
function showToast(message, type = 'info') {
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  toastContainer.appendChild(toast);

  setTimeout(() => {
    toast.style.opacity = '0';
    toast.style.transform = 'translateY(10px)';
    setTimeout(() => toast.remove(), 300);
  }, 4000);
}

function escapeHtml(str) {
  if (!str) return '';
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}
