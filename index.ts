import { Server } from 'socket.io'
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
class URL {
  url: string;
  scheme: string;
  host: string;
  path: string;
  constructor(url: string) {
    const ref = url.split("://");
    this.scheme = ref[0];
    this.url = ref[1];
    if (this.scheme !== 'http') {
      throw new Error('Invalid URL scheme. Only "http" is allowed.');
    }
    if (!this.url.includes("/")) {
      this.url += "/";
    }
    const refPath = url.split('/');
    this.host = refPath[1];
    this.path = "/" + refPath;
  }

  request() {
    const socket = new net.Socket();

    try {
      socket.connect({
        host: this.host,
        port: this.scheme === 'http' ? 443 : 80
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
        response += data.toString();
      });

      socket.on('end', () => {
        socket.destroy();
        return response;
      });
    } catch (error) {
      if (error instanceof Error) {
        throw new Error(`Failed to make request: ${error.message}`);
      } else {
        throw new Error(`Failed to make request: ${error}`);
      }
    }
    
  }
}