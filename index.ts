import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs/promises';
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
  let inTag = false;
  for (const c of body) {
    if (c === '<') {
      inTag = true;
    } else if (c === '>') {
      inTag = false;
    } else if (!inTag) {
      process.stdout.write(c);
    }
  }
}
async function load(url: URL): Promise<void> {
  try {
    const body = await url.request();
    show(body);
  } catch (error) {
    console.error('Error loading URL:', error);
  }
}

class URL {
  // url: string;
  scheme: string;
  host: string;
  path: string;
  port: number;

  private createHeader(): Record<string, string> {
    return {
      'host': this.host,
      'Connection': 'close',
      'User-Agent': 'Sal',
      // other headers
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
      
      if (!['http','https','data','file'].includes(this.scheme)) {
        throw new Error('Invalid URL scheme');
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

  request(): Promise<string> {
    if (this.scheme === 'data') {
      const [mediaType, ...dataParts] = this.path.split(',');
      return Promise.resolve(decodeURIComponent(dataParts.join(',')));
    }

    if (this.scheme === 'file') {
      return fs.readFile(this.path, 'utf-8').catch(error => {
        throw new Error(`Failed to read file: ${error}`);
      });
    }
    return new Promise((resolve, reject) => {
      let socket: net.Socket | tls.TLSSocket;
      try {
        if (this.scheme === 'https') {
          socket = tls.connect({
            host: this.host,
            port: this.port,
            servername: this.host,
          });
        } else {
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
        });

        socket.on('end', () => {
          const [statusLine, ...rest] = response.split('\r\n');
          const [version, status, ...explanationParts] = statusLine.split(' ');
          const explanation = explanationParts.join(' ');

          const parsedResponse: ParsedResponse = {
            version,
            status: parseInt(status),
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

          socket.destroy();
          resolve(parsedResponse.body);
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
    // add data schema -> done.
    // Add support for less-than and greater than entities
    // add view-source scheme to see the html source instead of rendered page
    // keep-alive: Reuse the same socket
    // Redirect: Add Location header when 300 error range occurs
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