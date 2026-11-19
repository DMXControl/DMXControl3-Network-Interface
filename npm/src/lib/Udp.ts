import * as dgram from "dgram";
import { EventEmitter } from "events";
import * as os from "os";
import { UmbraUdpBroadcast } from "../Common/Types/UmbraServiceTypes";
import { Logger } from "./Logger";
import { NetConstants } from "./NetConstants";

export interface UdpEndPoint {
  address: string;
  port: number;
}

export interface UdpEventArgs {
  data: Buffer;
  endPoint: UdpEndPoint;
}

/** Returns the IPv4 addresses of all interfaces that are up. */
export function getLocalIPv4Addresses(includeLoopback = false): string[] {
  const result: string[] = [];
  for (const addrs of Object.values(os.networkInterfaces())) {
    for (const a of addrs ?? []) {
      if (a.family === "IPv4" && (includeLoopback || !a.internal)) result.push(a.address);
    }
  }
  return result;
}

/** UDP listener with address reuse and optional multicast membership. */
export class UdpListener extends EventEmitter<{ udpDataReceived: [UdpEventArgs]; error: [Error] }> {
  private readonly socket: dgram.Socket;
  private listening = false;
  private bound: Promise<void> | undefined;
  private _isDisposed = false;

  constructor(
    private readonly listenPort: number,
    private readonly multicastIP?: string,
  ) {
    super();
    this.socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    this.socket.on("message", (msg, rinfo) => {
      if (!this._isDisposed) this.emit("udpDataReceived", { data: msg, endPoint: { address: rinfo.address, port: rinfo.port } });
    });
    this.socket.on("error", (e) => {
      if (this.listenerCount("error") > 0) this.emit("error", e);
    });
  }

  get isDisposed(): boolean {
    return this._isDisposed;
  }

  /** Binds the socket. Resolves once it is listening. */
  startListen(): Promise<void> {
    if (this.listening) throw new Error("Already Listening");
    this.listening = true;
    this.bound = new Promise((resolve, reject) => {
      const onError = (e: Error) => reject(e);
      this.socket.once("error", onError);
      this.socket.bind(this.listenPort, () => {
        this.socket.off("error", onError);
        this.socket.setBroadcast(true);
        resolve();
      });
    });
    return this.bound;
  }

  /** Joins the multicast group given in the constructor on the interface with `ipAddress`. */
  async addMulticastListenIPAddress(ipAddress: string): Promise<void> {
    if (!this.multicastIP) throw new Error("MulticastIP not defined in constructor");
    if (!ipAddress) throw new TypeError("ipAddress");
    if (!this.bound) throw new Error("Call startListen() first");
    await this.bound;
    this.socket.addMembership(this.multicastIP, ipAddress);
  }

  dispose(): void {
    if (this._isDisposed) return;
    this._isDisposed = true;
    this.removeAllListeners("udpDataReceived");
    try {
      this.socket.close();
    } catch {
      /* ignore */
    }
  }
}

export interface UmbraDiscoveryBroadcastEventArgs {
  broadcast: UmbraUdpBroadcast;
  endPoint: UdpEndPoint;
}

/** Listens for the multicast discovery broadcasts Umbra servers send. */
export class UmbraDiscoveryClient extends EventEmitter<{ umbraDiscoveryBroadcastReceived: [UmbraDiscoveryBroadcastEventArgs] }> {
  private listener: UdpListener | undefined;
  private readonly receivedBroadcasts: UmbraUdpBroadcast[] = [];

  broadcastHistoryMax = 100;
  logger?: Logger;

  getBroadcastHistory(fromNewToOld: boolean, limit: number): UmbraUdpBroadcast[] {
    let list = [...this.receivedBroadcasts];
    if (fromNewToOld) list.reverse();
    if (limit > 0 && limit < list.length) list = list.slice(0, limit);
    return list;
  }

  /**
   * Starts listening. Without `listenAddresses`, the multicast group is joined on all
   * non-loopback IPv4 interfaces.
   */
  async startDiscovery(listenAddresses?: readonly string[]): Promise<void> {
    const addresses = listenAddresses ?? getLocalIPv4Addresses();

    this.listener?.dispose();

    const listener = new UdpListener(NetConstants.DMXCNET_MULTICAST_PORT, NetConstants.DMXCNET_MULTICAST_ADDRESS);
    this.listener = listener;
    listener.on("error", (e) => this.logger?.debug(`Discovery socket error: ${e.message}`));
    await listener.startListen();

    if (addresses.length === 0) {
      this.logger?.warn("Network not available. Only listening Broadcast");
    } else {
      for (const a of addresses) {
        try {
          this.logger?.info(`Listening on ${a} for Umbra Multicasts`);
          await listener.addMulticastListenIPAddress(a);
        } catch {
          this.logger?.warn(`Unable to Listen on IP Address: ${a}`);
        }
      }
    }

    listener.on("udpDataReceived", (args) => this.onUdpData(args));
  }

  dispose(): void {
    this.listener?.dispose();
    this.listener = undefined;
    this.removeAllListeners("umbraDiscoveryBroadcastReceived");
  }

  private onUdpData(args: UdpEventArgs): void {
    try {
      const d = UmbraUdpBroadcast.decode(args.data);
      d.sourceEndPoint = args.endPoint.address;
      this.receivedBroadcasts.push(d);
      while (this.receivedBroadcasts.length > this.broadcastHistoryMax) this.receivedBroadcasts.shift();

      this.emit("umbraDiscoveryBroadcastReceived", { broadcast: d, endPoint: args.endPoint });
    } catch (e) {
      this.logger?.debug(`Unable to deserialize Data: ${(e as Error).message}`, e);
    }
  }
}
