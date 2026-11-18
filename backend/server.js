require('dotenv').config();
const path = require('path');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');

const db = require('../database/db');
const petLogic = require('./petLogic');
const MqttService = require('./mqttService');
const { ReminderService } = require('./reminderService');
const apiRoutes = require('./routes/api');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: '*',
    methods: ['GET', 'POST', 'PUT']
  }
});

const PORT = process.env.PORT || 3000;
const MQTT_BROKER_URL = process.env.MQTT_BROKER_URL || 'mqtt://127.0.0.1:1883';

// Express middleware
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Serve frontend static files
app.use(express.static(path.join(__dirname, '../frontend')));

// Initialize MQTT Service
const mqttService = new MqttService(io, {
  brokerUrl: MQTT_BROKER_URL,
  clientId: process.env.MQTT_CLIENT_ID || `petlink_server_${process.pid}`
});

// Mount API routes
// Reminders pushed from the hub to the station (petlink/{device_id}/cmd)
const reminderService = new ReminderService(mqttService, io);
mqttService.onHabitLogged = (habitId) => reminderService.onHabitLogged(habitId);

app.use('/api', apiRoutes(mqttService, io, reminderService));

// Fallback route to frontend index.html
app.use((req, res, next) => {
  if (req.method !== 'GET') return next();
  if (req.path.startsWith('/api')) return next();
  res.sendFile(path.join(__dirname, '../frontend/index.html'));
});

// Socket.IO real-time connection handler
io.on('connection', (socket) => {
  console.log(`[Socket.IO] Client connected: ${socket.id}`);

  // Send initial state snapshot on client connect
  socket.emit('initial_state', {
    players: db.getAllPlayersWithPets(),
    habitat: db.getHabitatState(),
    habits: db.getHabits(),
    recentLogs: db.getRecentLogs(15),
    display: petLogic.getIdleDisplayState(),
    mqttStatus: { connected: mqttService.connected, broker: MQTT_BROKER_URL }
  });

  socket.on('request_state', () => {
    socket.emit('initial_state', {
      players: db.getAllPlayersWithPets(),
      habitat: db.getHabitatState(),
      habits: db.getHabits(),
      recentLogs: db.getRecentLogs(15),
      display: petLogic.getIdleDisplayState(),
      mqttStatus: { connected: mqttService.connected, broker: MQTT_BROKER_URL }
    });
  });

  socket.on('disconnect', () => {
    console.log(`[Socket.IO] Client disconnected: ${socket.id}`);
  });
});

// Start MQTT and HTTP server
mqttService.connect();
reminderService.start();

server.listen(PORT, () => {
  console.log('========================================================');
  console.log(`🐾 PetLink Backend Server is running!`);
  console.log(`🌐 Local Web Dashboard: http://localhost:${PORT}`);
  console.log(`📡 Connected to MQTT Broker: ${MQTT_BROKER_URL}`);
  console.log(`💾 Database: SQLite (WAL mode)`);
  console.log('========================================================');
});

// Graceful shutdown
process.on('SIGINT', () => {
  console.log('\n[Server] Shutting down gracefully...');
  if (mqttService.client) {
    mqttService.client.end(true);
  }
  db.db.close();
  server.close(() => {
    console.log('[Server] Server closed.');
    process.exit(0);
  });
});

