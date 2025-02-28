import * as net from 'net';
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

  constructor(url: string) {
    try {
      const [scheme, remaining] = url.split("://", 2);
      this.scheme = scheme;
      
      if (this.scheme !== 'http' && this.scheme !== 'https') {
        throw new Error('Invalid URL scheme. Only "http" and "https" are allowed.');
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
    return new Promise((resolve, reject) => {
      const socket = new net.Socket({
        fd: undefined,
        allowHalfOpen: false,
        readable: true,
        writable: true
      });

      try {
        socket.connect({
          host: this.host,
          port: this.scheme === 'https' ? 443 : 80,
          family: 4,
        });

        const request = [
          `GET ${this.path} HTTP/1.0`,
          `Host: ${this.host}`,
          '',
          ''
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
    // Parse the entirety of the response and display the html
    // Show the body
    // 
    // 
    //

  }
}

if (require.main === module) {
  const url = new URL(process.argv[2]);
  load(url).catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}
