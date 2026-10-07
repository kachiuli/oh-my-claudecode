import { spawnSync } from 'node:child_process';
import { realpathSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, relative, basename } from 'node:path';
import tls from 'node:tls';

/** Local non-provider TLS material; keys are temporary and never logged. */
export function createNativeBodyTlsFixture(): { directory: string; ca: Buffer; cert: Buffer; key: Buffer; context: tls.SecureContext; close(): void } {
  const candidates = process.platform === 'win32' ? ['C:/Program Files/Git/usr/bin/openssl.exe', 'openssl'] : ['openssl'];
  const openssl = candidates.find(command => spawnSync(command, ['version'], { stdio: 'ignore', windowsHide: true }).status === 0);
  if (!openssl) throw new Error('native_body_test_openssl_unavailable');
  const directory = realpathSync(mkdtempSync(join(tmpdir(), 'native-body-tls-')));
  const cleanup = () => { const target = resolve(directory), within = relative(realpathSync(tmpdir()), target); if (!within || within.startsWith('..') || !basename(target).startsWith('native-body-tls-')) throw new Error('native_body_test_cleanup_target'); rmSync(target, { recursive: true, force: true }); };
  const run = (args: string[]) => { if (spawnSync(openssl, args, { cwd: directory, stdio: 'ignore', windowsHide: true }).status !== 0) throw new Error('native_body_test_certificate_failed'); };
  try {
    run(['req', '-x509', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'ca.key.pem', '-out', 'ca.cert.pem', '-days', '1', '-subj', '/CN=Native Local Test CA', '-addext', 'basicConstraints=critical,CA:TRUE']);
    run(['req', '-newkey', 'rsa:2048', '-nodes', '-keyout', 'leaf.key.pem', '-out', 'leaf.csr', '-subj', '/CN=chatgpt.com']);
    writeFileSync(join(directory, 'leaf.ext'), 'subjectAltName=DNS:chatgpt.com\nbasicConstraints=critical,CA:FALSE\nkeyUsage=digitalSignature,keyEncipherment\nextendedKeyUsage=serverAuth\n');
    run(['x509', '-req', '-in', 'leaf.csr', '-CA', 'ca.cert.pem', '-CAkey', 'ca.key.pem', '-CAcreateserial', '-out', 'leaf.cert.pem', '-days', '1', '-extfile', 'leaf.ext']);
    const ca = readFileSync(join(directory, 'ca.cert.pem')), cert = readFileSync(join(directory, 'leaf.cert.pem')), key = readFileSync(join(directory, 'leaf.key.pem'));
    return { directory, ca, cert, key, context: tls.createSecureContext({ key, cert }), close: cleanup };
  } catch (error) { cleanup(); throw error; }
}
