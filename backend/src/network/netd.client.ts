import { HttpException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { request } from 'http';

const SOCKET = process.env.NETD_SOCKET ?? '/run/kalimasada-netd/netd.sock';

@Injectable()
export class NetdClient {
  call<T>(method: string, path: string, body?: unknown, clientIp?: string): Promise<T> {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const headers: Record<string, string | number> = {};
    if (payload) {
      headers['content-type'] = 'application/json';
      headers['content-length'] = Buffer.byteLength(payload);
    }
    if (clientIp) headers['x-client-ip'] = clientIp;
    return new Promise<T>((resolve, reject) => {
      const req = request({ socketPath: SOCKET, method, path, headers, timeout: 120_000 }, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (chunk: Buffer) => chunks.push(chunk));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let data: { message?: string } | null = null;
          try {
            data = text ? JSON.parse(text) : null;
          } catch {
            data = { message: text };
          }
          const status = res.statusCode ?? 500;
          if (status >= 400) reject(new HttpException(data?.message || 'Layanan jaringan gagal', status));
          else resolve(data as T);
        });
      });
      req.on('timeout', () => req.destroy(new Error('Layanan jaringan tidak menjawab')));
      req.on('error', (error: NodeJS.ErrnoException) => {
        const missing = error.code === 'ENOENT' || error.code === 'ECONNREFUSED' || error.code === 'EACCES';
        reject(new ServiceUnavailableException(missing ? 'Layanan jaringan (kalimasada-netd) belum berjalan' : error.message));
      });
      if (payload) req.write(payload);
      req.end();
    });
  }
}
