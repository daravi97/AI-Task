// Pickup codes and their QR codes, used to check staff in at the collection desk.
const crypto = require('node:crypto');
const QRCode = require('qrcode');
const { settings } = require('./config');

// No 0/O, 1/I/L: easy to read aloud and type. 8 characters ≈ 8.5e11 combinations.
const ALPHABET = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789';

function newPickupCode() {
  const bytes = crypto.randomBytes(8);
  return Array.from(bytes, (b) => ALPHABET[b % ALPHABET.length]).join('');
}

// "K7PX9M2Q" -> "K7PX-9M2Q"
function formatCode(code) {
  return code ? `${code.slice(0, 4)}-${code.slice(4)}` : '';
}

// Accepts what a scanner or a person might give us: the raw code, "k7px-9m2q",
// or the full check-in URL from the QR code.
function parseCode(input) {
  const s = String(input ?? '').trim();
  const fromUrl = s.match(/checkin\/([A-Za-z0-9-]+)/);
  const code = (fromUrl ? fromUrl[1] : s).toUpperCase().replace(/[^A-Z0-9]/g, '');
  return code.length === 8 ? code : null;
}

// What the QR code contains: a link that opens the check-in screen for this order,
// so a phone's ordinary camera app works as a scanner for admins.
function checkinUrl(code) {
  return `${settings.appUrl}/#checkin/${code}`;
}

const QR_OPTIONS = { errorCorrectionLevel: 'M', margin: 2 };

function svg(code) {
  return QRCode.toString(checkinUrl(code), { ...QR_OPTIONS, type: 'svg' });
}

function png(code) {
  return QRCode.toBuffer(checkinUrl(code), { ...QR_OPTIONS, type: 'png', width: 360 });
}

module.exports = { newPickupCode, formatCode, parseCode, checkinUrl, svg, png };
