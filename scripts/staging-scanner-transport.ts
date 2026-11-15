import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { createConnection } from 'node:net';
import { connect } from 'node:tls';
import { promisify } from 'node:util';
import type { StagingScannerTls } from '../src/staging-file-scan.js';

export async function createStagingScannerCertificates(directory: string) {
  await mkdir(directory, { mode: 0o700 });
  await promisify(execFile)(
    'pwsh',
    [
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      `
foreach ($role in @("server", "client")) {
  $key = [System.Security.Cryptography.RSA]::Create(3072)
  $hash = [System.Security.Cryptography.HashAlgorithmName]::SHA256
  $padding = [System.Security.Cryptography.RSASignaturePadding]::Pkcs1
  $request = [System.Security.Cryptography.X509Certificates.CertificateRequest]::new("CN=aio-staging-scanner-$role", $key, $hash, $padding)
  $usage = [System.Security.Cryptography.OidCollection]::new()
  $eku = if ($role -eq "server") { "1.3.6.1.5.5.7.3.1" } else { "1.3.6.1.5.5.7.3.2" }
  $null = $usage.Add([System.Security.Cryptography.Oid]::new($eku))
  $request.CertificateExtensions.Add([System.Security.Cryptography.X509Certificates.X509EnhancedKeyUsageExtension]::new($usage, $true))
  if ($role -eq "server") {
    $san = [System.Security.Cryptography.X509Certificates.SubjectAlternativeNameBuilder]::new()
    $san.AddIpAddress([System.Net.IPAddress]::Loopback)
    $request.CertificateExtensions.Add($san.Build())
  }
  $cert = $request.CreateSelfSigned([DateTimeOffset]::UtcNow.AddMinutes(-10), [DateTimeOffset]::UtcNow.AddDays(1))
  [IO.File]::WriteAllText((Join-Path $env:AIO_STAGE_SCANNER_DIR "$role.pem"), $cert.ExportCertificatePem())
  [IO.File]::WriteAllText((Join-Path $env:AIO_STAGE_SCANNER_DIR "$role-key.pem"), $key.ExportPkcs8PrivateKeyPem())
  $cert.Dispose()
  $key.Dispose()
}
`,
    ],
    {
      env: { ...process.env, AIO_STAGE_SCANNER_DIR: directory },
      windowsHide: true,
      timeout: 15000,
    },
  );
}

export const scannerTlsRelay = `
import { readFileSync } from 'node:fs';
import { connect } from 'node:net';
import { createServer } from 'node:tls';
createServer({
  cert: readFileSync('/stage/server.pem'),
  key: readFileSync('/stage/server-key.pem'),
  ca: readFileSync('/stage/client.pem'),
  minVersion: 'TLSv1.3',
  requestCert: true,
  rejectUnauthorized: true,
  handshakeTimeout: 5000,
}, (client) => {
  if (!client.authorized) {
    client.destroy();
    return;
  }
  const scanner = connect(3310, '127.0.0.1');
  client.setTimeout(16000, () => client.destroy());
  client.on('error', () => scanner.destroy());
  scanner.on('error', () => client.destroy());
  client.on('close', () => scanner.destroy());
  scanner.on('close', () => client.destroy());
  client.pipe(scanner).pipe(client);
}).on('tlsClientError', () => {}).listen(3311, '0.0.0.0');
`;

export async function verifyStagingScannerTransport(port: number, tls: StagingScannerTls) {
  const endpoint = { host: '127.0.0.1', port };
  const probe = (socket: ReturnType<typeof createConnection>, event: string) =>
    new Promise<string>((resolve, reject) => {
      let response = '';
      socket.setTimeout(3000, () => socket.destroy(new Error('Scanner probe timed out.')));
      socket.once('error', reject);
      socket.once('close', () => resolve(response));
      socket.once(event, () => socket.write('zPING\0'));
      socket.on('data', (chunk: Buffer) => {
        response += chunk.toString('ascii');
        if (response.endsWith('\0')) socket.destroy();
      });
    });
  const options = { ...endpoint, minVersion: 'TLSv1.3' as const, rejectUnauthorized: true };
  const authorized = connect({ ...options, ...tls });
  let protocol: string | null = null;
  authorized.once('secureConnect', () => (protocol = authorized.getProtocol()));
  assert.equal(await probe(authorized, 'secureConnect'), 'PONG\0');
  assert.equal(protocol, 'TLSv1.3');
  await assert.rejects(probe(connect({ ...options, ca: tls.ca }), 'secureConnect'), {
    code: 'ERR_SSL_TLSV13_ALERT_CERTIFICATE_REQUIRED',
  });
  await assert.rejects(probe(connect({ ...options, ...tls, ca: tls.cert }), 'secureConnect'), {
    code: 'DEPTH_ZERO_SELF_SIGNED_CERT',
  });
  const plaintext = await probe(createConnection(endpoint), 'connect').catch((error) => {
    assert.equal((error as NodeJS.ErrnoException).code, 'ECONNRESET');
    return '';
  });
  assert.equal(plaintext, '');
  return {
    protocol: 'TLSv1.3',
    clientCertificateRequired: true,
    untrustedCertificateRejected: true,
    plaintextRejected: true,
    daemonLoopbackOnly: true,
  } as const;
}
