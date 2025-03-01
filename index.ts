import * as net from 'net';
import * as tls from 'tls';
import * as fs from 'fs/promises';
import * as zlib from 'zlib';
import { promisify } from 'util';
const gunzip = promisify(zlib.gunzip);

interface CachedEntry {
  response: ParsedResponse;
  timestamp: number;
  maxAge?: number;

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
    console.log('Received body:', typeof body, body ? body.substring(0, 100) : 'undefined');
    if (url.isViewSource) {
      process.stdout.write(body);
      return;
    }
    if (!body) {
      throw new Error('Received empty body from request');
    }
    show(body);
  } catch (error) {
    console.error('Error loading URL:', error);
  }
}

class URL {
  private static socketCache: Map<string, net.Socket | tls.TLSSocket> = new Map();
  private static REDIRECT_MAX = 10;
  private static cachedResponse: Map<string, CachedEntry> = new Map();

  private isCacheable(response: ParsedResponse): boolean {
    if (response.status !== 200) return false;

    const cacheControl = response.headers['cache-control']?.toLowerCase();
    if (!cacheControl) return true;

    if (cacheControl.includes('no-store')) return false;

    return true;
  }

  private getMaxAge(response: ParsedResponse): number | undefined {
    const cacheControl = response.headers['cache-control'].toLowerCase();
    if (!cacheControl) return undefined;

    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    if (maxAgeMatch) {
      return parseInt(maxAgeMatch[1]);
    }
    return undefined;
  }

  private isCacheValid(cacheEntry: CachedEntry) {
    if (!cacheEntry.maxAge) return true;

    const age = (Date.now() - cacheEntry.timestamp) / 1000;
    return age < cacheEntry.maxAge;
  }

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
      'Host': this.host,
      'Connection': 'keep-alive',
      'User-Agent': 'Mozilla/5.0',
      'Accept': '*/*',
      'Accept-Encoding': 'gzip'
    }
  }

  private async handleCompressedResponse(data: Buffer): Promise<string> {
    try {
      console.log('Attempting to decompress data of length:', data.length);
      console.log('First bytes:', Array.from(data.slice(0, 4)));
      const decompressed = await gunzip(data);
      return decompressed.toString("utf-8");
    } catch (error) {
      console.error('Decompression error details:', error);
      throw new Error(`Failed to decompress response: ${error}`);
    }
  }

  private parseChunkedResponse(body: Buffer): Buffer {
    const chunks: Buffer[] = [];
    let pos = 0;

    while (pos < body.length) {
      const lineEnd = body.indexOf(Buffer.from('\r\n'), pos);
      if (lineEnd === -1) break;

      const sizeHex = body.slice(pos, lineEnd).toString();
      const size = parseInt(sizeHex, 16);

      if (size === 0) break;

      pos = lineEnd + 2;
      chunks.push(body.slice(pos, pos + size));
      pos = pos + size + 2;
    }

    return Buffer.concat(chunks);
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

  async request(redirectCount = 0): Promise<string> {
    const cacheKey = this.getSocketKey();
    const cacheEntry = URL.cachedResponse.get(cacheKey);
    
    if(cacheEntry && this.isCacheValid(cacheEntry)) {
      return cacheEntry.response.body;
    }

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
          headers['Connection'] = 'close';
          const headerLines = Object.entries(headers)
            .map(([key, value]) => `${key}: ${value}`)
            .join('\r\n');

          const request = [
            `GET ${this.path} HTTP/1.1`,
            headerLines,
            '\r\n'
          ].join('\r\n');

          console.log('Sending request:', request);

          socket.write(request);

          let responseData = Buffer.from('');
          socket.on('data', (data) => {
            responseData = Buffer.concat([responseData, data]);
            console.log('Received chunk:', data.length, 'bytes');
            
            const headerEnd = responseData.indexOf(Buffer.from('\r\n\r\n'));
            if (headerEnd === -1) {
              return; 
            }

            const headers = responseData.slice(0, headerEnd).toString();
            const contentLengthMatch = headers.match(/content-length:\s*(\d+)/i);
            const isChunked = headers.toLowerCase().includes('transfer-encoding: chunked');

            if (contentLengthMatch) {
              const contentLength = parseInt(contentLengthMatch[1], 10);
              const bodyLength = responseData.length - (headerEnd + 4);
              
              if (bodyLength >= contentLength) {
                socket.end();
              }
            } else if (isChunked && responseData.includes(Buffer.from('\r\n0\r\n\r\n'))) {
              socket.end();
            }
          });

          socket.on('end', async () => {
            try {
              const responseStr = responseData.toString();
              console.log('Raw response length:', responseStr.length);
              
              if (!responseStr.includes('\r\n')) {
                throw new Error('Invalid response format - no line endings found');
              }

              const [headersPart, ...bodyParts] = responseStr.split('\r\n\r\n');
              if (!headersPart) {
                throw new Error('No headers found in response');
              }

              console.log('Headers:', headersPart); 
              console.log('Body parts length:', bodyParts.length);

              const [statusLine, ...headerLines] = headersPart.split('\r\n');
              const [version, status, ...explanationParts] = statusLine.split(' ');

              let parsedResponse: ParsedResponse = {
                version,
                status: parseInt(status),
                explanation: explanationParts.join(' '),
                headers: {},
                body: ''
              };

              for (const line of headerLines) {
                const [header, ...valueParts] = line.split(':');
                if (header) {
                  parsedResponse.headers[header.toLowerCase()] = valueParts.join(':').trim();
                }
              }

              const isChunked = parsedResponse.headers['transfer-encoding']?.toLowerCase() === 'chunked';
              const isGzipped = parsedResponse.headers['content-encoding']?.toLowerCase() === 'gzip';

              const headerEnd = responseData.indexOf(Buffer.from('\r\n\r\n'));
              const body = responseData.slice(headerEnd + 4); 

              if (isChunked) {
                const chunks = this.parseChunkedResponse(body);
                parsedResponse.body = isGzipped ? 
                  await this.handleCompressedResponse(chunks) : 
                  chunks.toString();
              } else {
                console.log('Body length before decompression:', body.length);
                parsedResponse.body = isGzipped ? 
                  await this.handleCompressedResponse(body) : 
                  body.toString();
              }

              if (!parsedResponse.body) {
                console.log('Debug - parsed response:', parsedResponse);
                throw new Error('Failed to parse response - empty body');
              }

              // Handle caching
              if (this.isCacheable(parsedResponse)) {
                const maxAge = this.getMaxAge(parsedResponse);
                URL.cachedResponse.set(cacheKey, {
                  response: parsedResponse,
                  timestamp: Date.now(),
                  maxAge
                });
              }

              if (parsedResponse.status >= 300 && parsedResponse.status < 400 && parsedResponse.headers['location']) {
                let location = parsedResponse.headers['location'];
                let redirectURL: URL;
                const basePath = this.path.endsWith('/') ? this.path : this.path.substring(0, this.path.lastIndexOf('/') + 1);
                redirectURL = new URL(`${this.scheme}://${this.host}${basePath}${location}`);

                if (parsedResponse.headers['connection'] !== 'keep-alive') {
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
                if (parsedResponse.headers['connection'] !== 'keep-alive') {
                  socket.destroy();
                } else {
                  URL.socketCache.set(this.getSocketKey(), socket);
                }
                resolve(parsedResponse.body);
              }
            } catch (error) {
              console.error('Error processing response:', error);
              reject(error);
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
        /*
        How do I represent images, styles, scripts, files in general into a
        cache'able format? Do I just convert to a universal binary format...?

        -> CachedEntry interface to cache things
        Function to retrieve the cached entry
        Function to check if the cached entry is available or valid
        */
    // done  
    // Add support for HTTP compression -> Done
  }
}

if (require.main === module) {
  let urlStr = process.argv[2] || 'file://index.html';
  const url = new URL(urlStr);
  load(url).catch(error => {
    console.error('Error:', error);
    process.exit(1);
  });
}