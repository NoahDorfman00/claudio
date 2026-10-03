// Encryption for users' saved Anthropic API keys: AES-256-GCM with a 32-byte data key from
// Secret Manager. The uid is bound in as associated data, so a ciphertext copied onto
// another account won't decrypt.

const crypto = require('crypto');

const VERSION = 'v1';

function dataKey(keyB64) {
    const key = Buffer.from(keyB64 || '', 'base64');
    if (key.length !== 32) {
        throw new Error('ANTHROPIC_KEY_ENCRYPTION_KEY must be 32 bytes, base64-encoded.');
    }
    return key;
}

function encryptApiKey(plaintext, uid, keyB64) {
    const iv = crypto.randomBytes(12);
    const cipher = crypto.createCipheriv('aes-256-gcm', dataKey(keyB64), iv);
    cipher.setAAD(Buffer.from(uid, 'utf8'));
    const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
    return [VERSION, iv.toString('base64'), cipher.getAuthTag().toString('base64'), ciphertext.toString('base64')].join(':');
}

function decryptApiKey(stored, uid, keyB64) {
    const [version, ivB64, tagB64, dataB64] = String(stored).split(':');
    if (version !== VERSION || !ivB64 || !tagB64 || !dataB64) {
        throw new Error('Unrecognized encrypted key format.');
    }
    const decipher = crypto.createDecipheriv('aes-256-gcm', dataKey(keyB64), Buffer.from(ivB64, 'base64'));
    decipher.setAAD(Buffer.from(uid, 'utf8'));
    decipher.setAuthTag(Buffer.from(tagB64, 'base64'));
    return Buffer.concat([decipher.update(Buffer.from(dataB64, 'base64')), decipher.final()]).toString('utf8');
}

function apiKeyHint(key) {
    return `…${key.slice(-4)}`;
}

module.exports = { encryptApiKey, decryptApiKey, apiKeyHint };
