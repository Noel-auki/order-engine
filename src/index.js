// Database utilities
const db = require('./config/db');
const redis = require('./config/redis');

// Core utilities
const arrayUtils = require('./utils/array');
const billUtils = require('./utils/bill');
const orderUtils = require('./utils/order');
const offerUtils = require('./utils/offerUtils');
const redisUtils = require('./utils/redis');
const notificationUtils = require('./utils/notificationsUtil');
const sendNotifications = require('./utils/sendNotifications');

module.exports = {
    // Database connections
    db,
    redis,

    // Core utilities
    arrayUtils,
    billUtils,
    orderUtils,
    offerUtils,
    redisUtils,
    notificationUtils,
    sendNotifications
}; 