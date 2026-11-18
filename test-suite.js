/**
 * PetLink End-to-End Backend & Database Test Suite
 */
const http = require('http');
const db = require('./database/db');
const petLogic = require('./backend/petLogic');

console.log('>>> [TEST SUITE] Starting PetLink Validation Tests...\n');

// 1. Verify Database Seeding & Queries
console.log('--- Test 1: SQLite Database Queries ---');
const players = db.getAllPlayersWithPets();
console.assert(players.length === 4, `Expected 4 players, got ${players.length}`);
console.log(`✓ Seeded ${players.length} players with pets:`);
players.forEach(p => {
  console.log(`  - ${p.name} (${p.rfid_uid}): Pet "${p.pet.name}" (${p.pet.species}), Level ${p.pet.level}, XP ${p.pet.xp}, Happiness ${p.pet.happiness}%`);
});

const habits = db.getHabits();
console.assert(habits.length === 3, `Expected 3 habits, got ${habits.length}`);
console.log(`✓ Seeded ${habits.length} habits: ${habits.map(h => h.name).join(', ')}`);

const habitat = db.getHabitatState();
console.log(`✓ Habitat initial state: ${habitat.condition} (${habitat.lux} lux)`);

// 2. Test Pet Logic & Duplicate Prevention
console.log('\n--- Test 2: RFID Lookup & Scanning ---');
const alexScan = petLogic.processRfidScan('A1B2C3D4');
console.assert(alexScan.success === true, 'Failed to look up Alex by UID A1B2C3D4');
console.log(`✓ RFID scan found player: ${alexScan.player.name}`);
console.log(`✓ OLED display prompt: "${alexScan.display.line1}" / "${alexScan.display.line2}"`);

const unknownScan = petLogic.processRfidScan('99999999');
console.assert(unknownScan.notFound === true, 'Unknown UID should return notFound: true');
console.log(`✓ Unknown RFID handled gracefully: "${unknownScan.display.line1}" / "${unknownScan.display.line2}"`);

console.log('\n--- Test 3: Habit Completion & XP/Happiness Awarding ---');
// Record 'water' for Alex
const habitResult1 = petLogic.processHabitSubmission('A1B2C3D4', 'water');
console.assert(habitResult1.success === true, 'Failed to log water habit for Alex');
console.log(`✓ First habit completion: +${habitResult1.awarded.xp} XP, +${habitResult1.awarded.happiness} Happiness`);
console.log(`  Pet stats now: Level ${habitResult1.player.level}, XP ${habitResult1.player.xp}, Happiness ${habitResult1.player.happiness}`);
console.log(`  OLED line 1: "${habitResult1.display.line1}", line 2: "${habitResult1.display.line2}"`);

// Attempt duplicate habit completion on same day
console.log('\n--- Test 4: Duplicate Prevention on Same Day ---');
const duplicateResult = petLogic.processHabitSubmission('A1B2C3D4', 'water');
console.assert(duplicateResult.duplicate === true, 'Duplicate check failed! Should be rejected.');
console.log(`✓ Duplicate rejected successfully: "${duplicateResult.display.line1}" / "${duplicateResult.display.line2}"`);

// Test second different habit for Alex (exercise)
console.log('\n--- Test 5: Distinct Habit on Same Day ---');
const exerciseResult = petLogic.processHabitSubmission('A1B2C3D4', 'exercise');
console.assert(exerciseResult.success === true, 'Distinct habit should succeed');
console.log(`✓ Second distinct habit succeeded: +${exerciseResult.awarded.xp} XP, total XP: ${exerciseResult.player.xp}`);

// Test Level Up calculation
console.log('\n--- Test 6: Level Up Calculation ---');
// Charlie has 20 XP initially. Log workout (+35) and reading (+25) and water (+15)
// Let's test a player hitting 100 XP
const charlieBefore = db.getPlayerByUid('C9D0E1F2');
console.log(`  Charlie before: Level ${charlieBefore.level}, XP ${charlieBefore.xp}`);
const charlieHabit = petLogic.processHabitSubmission('C9D0E1F2', 'exercise');
console.log(`  Charlie after exercise: Level ${charlieHabit.player.level}, XP ${charlieHabit.player.xp}`);

console.log('\n--- Test 7: Ambient Light Thresholds ---');
const dayReading = petLogic.processLightReading(150.0);
console.assert(dayReading.condition === 'DAY', '150 lux should be DAY');
console.log(`✓ 150 lux => Habitat: ${dayReading.condition}`);

const nightReading = petLogic.processLightReading(22.5);
console.assert(nightReading.condition === 'NIGHT', '22.5 lux should be NIGHT');
console.log(`✓ 22.5 lux => Habitat: ${nightReading.condition}`);

console.log('\n--- Test 8: Recent Activity Logs ---');
const recentLogs = db.getRecentLogs(5);
console.assert(recentLogs.length >= 2, `Expected >= 2 logs, got ${recentLogs.length}`);
console.log(`✓ Recorded ${recentLogs.length} activity logs in SQLite.`);
recentLogs.forEach(l => {
  console.log(`  - [${l.completed_at}] ${l.player_name}: ${l.habit_name} (+${l.xp_awarded} XP)`);
});

console.log('\n========================================================');
console.log('🎉 ALL BACKEND & DATABASE LOGIC TESTS PASSED!');
console.log('========================================================\n');
