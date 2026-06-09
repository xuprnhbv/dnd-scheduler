'use strict';

const fs = require('fs');
const path = require('path');

const logger = require('../logger');

const DEFAULT_CERT_PATH = '.tls/cert.pem';
const DEFAULT_KEY_PATH = '.tls/key.pem';

/**
 * Ensure a TLS cert/key pair exists for the admin panel.
 *
 * If both files already exist they are loaded as-is — this is the
 * bring-your-own-cert path (e.g. drop a Let's Encrypt cert at the configured
 * paths). Otherwise a self-signed cert is generated and written to disk.
 *
 * Paths are resolved relative to process.cwd() (the bot directory).
 *
 * @param {{ certPath?: string, keyPath?: string }} opts
 * @returns {{ cert: string, key: string }}
 */
function ensureCert({ certPath, keyPath } = {}) {
  const certFile = path.resolve(process.cwd(), certPath || DEFAULT_CERT_PATH);
  const keyFile = path.resolve(process.cwd(), keyPath || DEFAULT_KEY_PATH);

  if (fs.existsSync(certFile) && fs.existsSync(keyFile)) {
    return {
      cert: fs.readFileSync(certFile, 'utf8'),
      key: fs.readFileSync(keyFile, 'utf8'),
    };
  }

  try {
    // eslint-disable-next-line global-require
    const selfsigned = require('selfsigned');
    const attrs = [{ name: 'commonName', value: 'dnd-poll-bot admin panel' }];
    const pems = selfsigned.generate(attrs, {
      days: 3650,
      keySize: 2048,
      algorithm: 'sha256',
      // SANs are cosmetic for a self-signed cert the admin click-accepts, but
      // they keep the warning to "untrusted issuer" rather than also "wrong host".
      extensions: [
        {
          name: 'subjectAltName',
          altNames: [
            { type: 2, value: 'localhost' },
            { type: 7, ip: '127.0.0.1' },
          ],
        },
      ],
    });

    fs.mkdirSync(path.dirname(certFile), { recursive: true });
    fs.mkdirSync(path.dirname(keyFile), { recursive: true });
    fs.writeFileSync(certFile, pems.cert, 'utf8');
    fs.writeFileSync(keyFile, pems.private, { encoding: 'utf8', mode: 0o600 });
    logger.info(`[admin] generated self-signed TLS cert at ${certFile}`);

    return { cert: pems.cert, key: pems.private };
  } catch (err) {
    logger.error('[admin] failed to generate self-signed TLS cert:', err);
    throw err;
  }
}

module.exports = { ensureCert };
