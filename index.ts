import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs/promises';
import { stat } from 'fs';
import { parse } from 'path';
import { redirect } from 'next/dist/server/api-utils';
interface ServerToClientEvents {
  noArg: () => void;
  basicEmit: (a: number, b: string, c: Buffer) => void;
  withAck: (d: string, callback: (e: number) => void) => void;
}

interface ClientToServerEvents {
  hello: () => void;
}

interface InterServerEvents {
  ping: () => void;
}

interface SocketData {
  name: string;
  age: number;
}

interface ParsedResponse {
  version: string;
  status: number;
  explanation: string;
  headers: Record<string, string>;
  body: string;
}

function show(body: string): void {
  let i = 0;
  let inTag = false;

  while (i < body.length) {
    const c = body[i];

    if (c === '&' && i + 4 < body.length) { 
      const entity = body.substring(i, i + 4);
      if (entity === '&lt;') {
        process.stdout.write('<');
        i += 4;
        continue;
      } else if (entity === '&gt;') {
        process.stdout.write('>');
        i += 4;
        continue;
      }
    }
    if (c === '<') {
      inTag = true;
    } else if (c === '>') {
      inTag = false;
    } else if (!inTag) {
      process.stdout.write(c);
    }
    i++;
  }
}
async function load(url: URL): Promise<void> {
  try {
    const body = await url.request();
    if (url.isViewSource) {
      // depending on then schema then figure out what to show
      process.stdout.write(body);
      return;
    }
    show(body);
  } catch (error) {
    console.error('Error loading URL:', error);
  }
}

class URL {
  private static socketCache: Map<string, net.Socket | tls.TLSSocket> = new Map();
  private static REDIRECT_MAX = 10;

  private getSocketKey(): string {
    return `${this.scheme}://${this.host}:${this.port}`;
  }
  // url: string;
  scheme: string;
  host: string;
  path: string;
  port: number;
  isViewSource: boolean = false;
  socket: net.Socket | tls.TLSSocket | undefined

  private createHeader(): Record<string, string> {
    return {
      'host': this.host,
      'Connection': 'keep-alive',
      'User-Agent': 'Sal',
      // other optional headers
    }
  }

  constructor(url: string = 'file://default.html') {
    try {
      if (url.startsWith('data:')) {
        this.scheme = 'data';
        this.host = '';
        this.port = -1;
        this.path = url.slice(5);
        return;
      }
      const [scheme, remaining] = url.split("://", 2);
      this.scheme = scheme;
      
      if (!['http','https','data','file', 'view-source'].includes(this.scheme)) {
        throw new Error('Invalid URL scheme');
      }


      if (this.scheme === 'view-source') {
        const actualUrl = new URL(remaining);
        this.scheme = actualUrl.scheme;
        this.host = actualUrl.host;
        this.path = actualUrl.path;
        this.port = actualUrl.port;
        this.isViewSource = true;
}
      if (this.scheme === 'file') {
        this.host = '';
        this.path = remaining;
        this.port = -1;
        return;
      }

      this.port = this.scheme === 'https' ? 443 : 80;
      let urlPath = remaining;
      if (!urlPath.includes("/")) {
        urlPath = urlPath + "/";
      }
      
      const [host, ...pathParts] = urlPath.split("/");
      this.host = host;
      this.path = "/" + pathParts.join("/");

      if (this.host.includes(":")) {
        const [hostname, portStr] = this.host.split(":");
        this.host = hostname;
        this.port = parseInt(portStr, 10);
      }
    } catch (error) {
      console.error("Malformed URL found, falling back to the WBE home page.");
      console.error("  URL was: " + url);
      this.scheme = "https";
      this.host = "browser.engineering";
      this.path = "/";
      this.port = 443;
    }
  }

  async request(redirectCount?: number = 0): Promise<string> {
    if (redirectCount >= URL.REDIRECT_MAX) {
      throw new Error("Too many Redirects");
    }
    if (this.scheme === 'data') {
      const [mediaType, ...dataParts] = this.path.split(',');
      return Promise.resolve(decodeURIComponent(dataParts.join(',')));
    }

    if (this.scheme === 'file') {
      return fs.readFile(this.path, 'utf-8').catch(error => {
        throw new Error(`Failed to read file: ${error}`);
      });
    }
    // ensure we check if socket exists based on domain before creating
    // a socket.
    // 
    return new Promise((resolve, reject) => {
      let socket: net.Socket | tls.TLSSocket;
      try {
        let key = this.getSocketKey();
        let value = URL.socketCache.get(key);
        if (value) {
          socket = value;
        } else {
          if (this.scheme === 'https') {
            socket = tls.connect({
              host: this.host,
              port: this.port,
              servername: this.host,
            });
          } else {``
            socket = new net.Socket({
              fd: undefined,
              allowHalfOpen: false,
              readable: true,
              writable: true
            });
            socket.connect({
              host: this.host,
              port: this.port,
              family: 4,
            });
          }
        }
          const headers = this.createHeader();
          const request = [
            `GET ${this.path} HTTP/1.0`,
            headers,
            '',
          ].join('\r\n');
          socket.write(request);

          let response = '';
          socket.on('data', (data) => {
            response += data.toString('utf8');

            if (response.includes('\r\n\r\n')) {
              const [headers] = response.split('\r\n\r\n', 1);
              const contentLengthMatch = headers.match(/content-length: (\d+)/i);
              if (contentLengthMatch) {
                const lengthMatch = parseInt(contentLengthMatch[1]);
                const [...body] = response.split('\r\n\r\n');
                const currentLength = Buffer.from(body.join('\r\n\r\n')).length;
                if (currentLength >= lengthMatch) {
                  socket.emit('end');
                }
              }
            }
          });

          socket.on('end', () => {
            const [statusLine, ...rest] = response.split('\r\n');
            const [version, status, ...explanationParts] = statusLine.split(' ');
            const explanation = explanationParts.join(' ');
            let statusCode = parseInt(status);

            const parsedResponse: ParsedResponse = {
              version,
              status: statusCode,
              explanation,
              headers: {},
              body: ''
            };
            let isBody = false;
            for (const line of rest) {
              if (line === '') {
                isBody = true;
                continue;
              }
              if (!isBody) {
                const [header, ...valueParts] = line.split(':');
                const value = valueParts.join(':').trim();
                parsedResponse.headers[header.toLowerCase()] = value;
              } else {
                parsedResponse.body += line + '\r\n';
              }
            }
             if (statusCode>= 300 && statusCode < 400 && parsedResponse.headers['location']) {
              let location = parsedResponse.headers['location'];

              let redirectURL: URL;

              if (location.startsWith("http://")) {
                redirectURL = new URL(location);
              } else if (location.startsWith("/")) {
                redirectURL = new URL(`${this.scheme}://${this.host}${this.path}`);
              } else {
                redirectURL = new URL(`${this.scheme}://${this.host}${this.path}/${location}`);
              }

              if (headers["Connection"] !== 'keep-alive') {
                socket.destroy();
              } else {
                URL.socketCache.set(this.getSocketKey(), socket);
              }

              try {
                const redirectResponse = await redirectURL.request(redirectCount + 1);
                resolve(redirectResponse);
              } catch (error) {
                reject(error);
              }
            } else {
                if (headers["Connection"] !== 'keep-alive') {
                socket.destroy();
              } else {
                URL.socketCache.set(`${this.scheme}://${this.host}:${this.port}`, socket);
              }
              resolve(parsedResponse.body);
            }
          });

          socket.on('error', (error) => {
            socket.destroy();
            reject(error);
          });
      } catch (error) {
        if (error instanceof Error) {
          reject(new Error(`Failed to make request: ${error.message}`));
        } else {
          reject(new Error(`Failed to make request: ${error}`));
        }
      }
    });
    // Todos:
    // Parse the entirety of the response and display the html -> done 
    // Show the body -> done
    // Encrypt the connection using ssl -> done
    // Add support for file Urls -> done.
    // add data schema -> done. -> done
    // Add support for less-than and greater than entities -> done
    // add view-source scheme to see the html source instead of rendered page -> Done
    // keep-alive: Reuse the same socket -> done
    // Redirect: Add Location header when 300 error range occurs -> done.
    // Implement caching in browser using w/ Cache-Control header
    // Add support for HTTP compression2
  }
}

if (require.main === module) {
  const url = new URL(process.argv[2]);
  load(url).catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}