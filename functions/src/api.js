const functions = require('firebase-functions');
const admin = require('firebase-admin');
const express = require('express');
const asyncHandler = require('express-async-handler');
const Cryptr = require('cryptr');

const db = require('./lib/db');
const vend = require('./lib/vend');

const payCodeSecret = functions.config().api.paycodesecret;
const payCodeCryptr = new Cryptr(payCodeSecret);

const app = express();

const verifyToken = asyncHandler(async (req, res, next) => {
  const authHeader = req.headers.authorization;

  if (!authHeader || !authHeader.includes('Bearer ')) {
    res.sendStatus(401);
    return;
  }

  const token = authHeader.slice('Bearer '.length);

  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.user = { id: decoded.uid };
    next();
  } catch (error) {
    res.sendStatus(401);
  }
});

app.get('/api/me', verifyToken, asyncHandler(async (req, res) => {
  const user = await db.getUser(req.user.id);

  if (!user) {
    res.json(null);
    return;
  }

  let points = null;
  if (user.payCode) {
    const code = payCodeCryptr.decrypt(user.payCode);
    points = await vend.checkPoints(code);
  }

  res.json({
    displayName: user.displayName,
    photoUrl: user.photoUrl,
    payCodeRegistered: !!user.payCode,
    points,
  });
}));

app.post('/api/verify-paycode', verifyToken, express.json(), asyncHandler(async (req, res) => {
  const { payCode } = req.body;

  if (!payCode) {
    res.sendStatus(400);
    return;
  }

  const points = await vend.checkPoints(payCode);
  res.json({ payCode, valid: points >= 0 });
}));

app.post('/api/register-paycode', verifyToken, express.json(), asyncHandler(async (req, res) => {
  const { payCode } = req.body;

  if (!payCode) {
    res.sendStatus(400);
    return;
  }

  const points = await vend.checkPoints(payCode);

  if (points < 0) {
    res.json({ success: false, error: 'invalid paycode' });
    return;
  }

  await db.updateOrCreateUser({
    id: req.user.id,
    payCode: payCodeCryptr.encrypt(payCode),
  });

  res.json({ success: true });
}));

app.get('/api/machine/:machineId', verifyToken, asyncHandler(async (req, res) => {
  const { machineId } = req.params;

  if (!machineId) {
    res.sendStatus(400);
    return;
  }

  const machineData = await vend.checkMachineAmount(machineId);
  res.json(machineData);
}));

app.post('/api/pay', verifyToken, express.json(), asyncHandler(async (req, res) => {
  const { machineId } = req.body;

  if (!machineId) {
    res.sendStatus(400);
    return;
  }

  const machineData = await vend.checkMachineAmount(machineId);

  if (machineData.defaultAmount === 0) {
    res.json({ success: false, error: 'no amount to pay' });
    return;
  }

  const user = await db.getUser(req.user.id);
  if (!user.payCode) {
    res.json({ success: false, error: 'no pay code saved for user' });
    return;
  }

  const payCode = payCodeCryptr.decrypt(user.payCode);
  const result = await vend.pay(machineId, payCode, machineData.defaultAmount);

  console.log(`Payment complete result=${JSON.stringify(result)}`);

  if (result.status !== 'success') {
    res.json({ success: false, error: 'error paying with vendor' });
    return;
  }

  res.json({ success: true });
}));

module.exports = functions.https.onRequest(app);
