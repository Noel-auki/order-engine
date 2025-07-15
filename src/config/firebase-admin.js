const firebaseAdmin = require('firebase-admin');
const serviceAccountAdmin = require('./butler-69b62-firebase-adminsdk-m6v2e-9873df30f6.json');

firebaseAdmin.initializeApp({
    credential: firebaseAdmin.credential.cert(serviceAccountAdmin),
});

module.exports = firebaseAdmin; 