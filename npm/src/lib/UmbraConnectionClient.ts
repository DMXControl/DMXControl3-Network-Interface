import {
  CallOptions,
  Channel,
  ChannelCredentials,
  ChannelInterface,
  ClientDuplexStream,
  ClientOptions,
  ClientReadableStream,
  ClientUnaryCall,
  credentials,
  Metadata,
  ServiceError,
  status,
  StatusObject,
} from "@grpc/grpc-js";
import { EventEmitter } from "events";
import { BroadcastMessage } from "../Common/Types/BroadcastServiceTypes";
import { ConfirmedResponse, GetRequest } from "../Common/Types/CommonTypes";
import {
  ClientControlRequest,
  ClientInfo,
  ClientProgramInfo,
  ELogoffReason,
  InformClientExistsRequest,
  PingPong,
  ReadyToWorkState,
  SetNetworkPropertyRequest,
  UmbraClientInfoMessage,
  UmbraClientReadyToWorkNotification,
  UmbraLoginRequest,
  UmbraLoginResponse,
  UmbraLoginResponse_EReturnCode,
  UmbraLogoffRequest,
} from "../Common/Types/UmbraServiceTypes";
import { ClientServiceClient, ConnectedClientServiceClient, DMXCNetServiceClient } from "../Common/UmbraClientService";
import { _ } from "./I18N";
import { Logger } from "./Logger";
import { NetConstants } from "./NetConstants";
import { containsNonAsciiCharacters } from "./ProtobufTools";
import { UmbraDiscoveryBroadcastEventArgs } from "./Udp";

const CALL_TIMEOUT_MS = 3000;
const PING_INTERVAL_MS = 5000;
const CLIENT_CONTROL_TIMEOUT_MS = 500;

/** Supplies everything the connection client needs to talk to Umbra. */
export interface IConnectionClientData {
  /** Channel to the Umbra server the client is connected to. */
  readonly umbraChannel: ChannelInterface;
  /** Creates a channel to another (potential) Umbra server, used during discovery. */
  createChannel(host: string, port: number): ChannelInterface;
  /** Metadata sent with every call. */
  readonly hostMetadata: Metadata;
  readonly clientProgramInfo: ClientProgramInfo;
  readonly clientname: string;
  readonly networkID: string;
}

/** Creates a channel to an Umbra server with DMXControl's maximum message size. */
export function createUmbraChannel(
  host: string,
  port: number = NetConstants.UMBRA_LISTEN_PORT,
  channelCredentials: ChannelCredentials = credentials.createInsecure(),
): Channel {
  return new Channel(`${host}:${port}`, channelCredentials, {
    "grpc.max_send_message_length": NetConstants.MAX_MESSAGE_SIZE,
    "grpc.max_receive_message_length": NetConstants.MAX_MESSAGE_SIZE,
  });
}

export class LoginException extends Error {
  constructor(
    message: string,
    readonly returnCode: UmbraLoginResponse_EReturnCode,
    readonly sessionID: string | undefined,
  ) {
    super(message);
    this.name = "LoginException";
  }
}

export class ClientEventArgs {
  constructor(
    readonly client: ClientInfo,
    private readonly _login?: boolean,
  ) {}

  get login(): boolean {
    return this._login === true;
  }

  get logoff(): boolean {
    return this._login === false;
  }
}

export interface BroadcastEventArgs {
  message: BroadcastMessage;
}

/**
 * Passed to `clientControlRequestReceived` listeners. Set `processed`, `ok` and `message`
 * (listeners may be async) within 500 ms to answer the request.
 */
export class ClientControlEventArgs {
  processed = false;
  ok = false;
  message: string | undefined;

  constructor(readonly request: ClientControlRequest) {}
}

export enum EAutoconnectResult {
  OK,
  Error,
  NotReady,
}

export interface UmbraConnectionClientEvents {
  umbraUserChanged: [ClientEventArgs];
  broadcastReceived: [BroadcastEventArgs];
  clientControlRequestReceived: [ClientControlEventArgs];
  connectionLost: [];
}

type ClientCtor<T> = new (address: string, credentials: ChannelCredentials, options?: Partial<ClientOptions>) => T;
type UnaryFn<Req, Res> = (req: Req, md: Metadata, opts: Partial<CallOptions>, cb: (e: ServiceError | null, r: Res) => void) => ClientUnaryCall;

function isServiceError(e: unknown): e is ServiceError {
  return e instanceof Error && typeof (e as ServiceError).code === "number";
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

function unary<Req, Res>(fn: UnaryFn<Req, Res>, req: Req, md: Metadata, signal?: AbortSignal, timeoutMs = CALL_TIMEOUT_MS): Promise<Res> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(abortError());
    const onAbort = () => call.cancel();
    const call = fn(req, md, { deadline: Date.now() + timeoutMs }, (e, r) => {
      signal?.removeEventListener("abort", onAbort);
      if (e) reject(signal?.aborted ? abortError() : e);
      else resolve(r);
    });
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * Connects a client to an Umbra server: logs in, keeps the mandatory ping alive, and
 * handles broadcasts, client control requests and client change notifications.
 */
export class UmbraConnectionClient extends EventEmitter<UmbraConnectionClientEvents> {
  logger?: Logger;
  dataProvider!: IConnectionClientData;

  private _sessionID: string | undefined;
  private _connectedToUmbra: ClientProgramInfo | undefined;
  private abortController: AbortController | undefined;
  private broadcastQueue: BroadcastMessage[] | undefined;
  private broadcastCall: ClientDuplexStream<BroadcastMessage, BroadcastMessage> | undefined;
  private autoConnectionInProgress = false;

  constructor(dataProvider?: IConnectionClientData) {
    super();
    if (dataProvider) this.dataProvider = dataProvider;
  }

  get sessionID(): string | undefined {
    return this._sessionID;
  }

  get connectedToUmbra(): ClientProgramInfo | undefined {
    return this._connectedToUmbra;
  }

  private makeClient<T>(ctor: ClientCtor<T>, channel: ChannelInterface = this.dataProvider.umbraChannel): T {
    return new ctor(channel.getTarget(), credentials.createInsecure(), { channelOverride: channel });
  }

  private connectedClient(): ConnectedClientServiceClient {
    return this.makeClient(ConnectedClientServiceClient);
  }

  /** Logs in to Umbra. Throws {@link LoginException} if the login fails. */
  async connect(openConnections = true, signal?: AbortSignal): Promise<UmbraLoginResponse> {
    const client = this.makeClient(ClientServiceClient);
    const request = UmbraLoginRequest.fromPartial({ client: this.dataProvider.clientProgramInfo });
    const start = Date.now();
    let response: UmbraLoginResponse;
    try {
      response = await unary(client.login.bind(client), request, this.dataProvider.hostMetadata, signal);
    } catch (e) {
      if (isServiceError(e)) {
        const code = e.code === status.PERMISSION_DENIED ? UmbraLoginResponse_EReturnCode.AccessDenied : UmbraLoginResponse_EReturnCode.Error;
        throw new LoginException(e.message, code, undefined);
      }
      throw e;
    } finally {
      this.logger?.debug(`Login Call: ${Date.now() - start} ms`);
    }

    if (containsNonAsciiCharacters(response.sessionId, true)) {
      throw new LoginException("Invalid SessionID", UmbraLoginResponse_EReturnCode.Error, response.sessionId);
    }

    switch (response.returnCode) {
      case UmbraLoginResponse_EReturnCode.NoError:
      case UmbraLoginResponse_EReturnCode.AlreadyLoggedIn:
        break;
      default:
        throw new LoginException(response.message, response.returnCode, response.sessionId);
    }

    this._sessionID = response.sessionId;
    this._connectedToUmbra = response.umbraServer;

    if (openConnections) this.openConnectionsAfterConnect(signal);

    return response;
  }

  async reportReadyToWork(state: ReadyToWorkState): Promise<void> {
    const client = this.connectedClient();
    const request = UmbraClientReadyToWorkNotification.fromPartial({ state });
    try {
      await unary(client.reportReadyToWork.bind(client), request, this.dataProvider.hostMetadata);
    } catch (e) {
      this.logger?.debug("reportReadyToWork", e);
    }
  }

  /** Asks Umbra to forward a control request to another client. Returns undefined on failure. */
  async sendClientControlRequest(request: ClientControlRequest): Promise<ConfirmedResponse | undefined> {
    if (!request?.controlClientRuntimeId) return undefined;

    const cinfo = this.dataProvider.clientProgramInfo.clientInfo;
    if (request.controlClientRuntimeId === cinfo?.runtimeid) throw new Error("Cannot send a client control request to yourself");

    request.source = cinfo;

    const client = this.connectedClient();
    try {
      return await unary(client.controlClient.bind(client), request, this.dataProvider.hostMetadata);
    } catch (e) {
      this.logger?.debug("sendClientControlRequest", e);
      return undefined;
    }
  }

  /** Logs off from Umbra and closes all streams. */
  async disconnect(): Promise<void> {
    if (this._sessionID !== undefined) {
      const client = this.makeClient(ClientServiceClient);
      const request = UmbraLogoffRequest.fromPartial({ client: this.dataProvider.clientProgramInfo });
      try {
        const response = await unary(client.logoff.bind(client), request, this.dataProvider.hostMetadata);
        this.logger?.info(`Disconnected from Umbra Server: ${response.bye}`);
      } catch (e) {
        this.logger?.debug(`Unable to logoff: ${errorMessage(e)}`, e);
      }
    }

    this._sessionID = undefined;
    this._connectedToUmbra = undefined;

    this.broadcastQueue = undefined;
    this.broadcastCall = undefined;
    this.abortController?.abort();
    this.abortController = undefined;
  }

  /** Queues a broadcast for all clients. Returns false if the broadcast stream is not open. */
  sendBroadcast(m: BroadcastMessage): boolean {
    if (!m || !this.broadcastQueue) return false;
    this.broadcastQueue.push(m);
    this.flushBroadcasts();
    return true;
  }

  /** Opens the ping, client change, broadcast and client control streams. */
  openConnectionsAfterConnect(signal?: AbortSignal): void {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const s = controller.signal;

    const start = Date.now();
    this.openPing(s);
    this.openReceiveUserChanges(s);
    this.openBroadcast(s);
    this.openControlClient(s);
    this.logger?.debug(`OpenConnectionsAfterConnect: ${Date.now() - start} ms`);
  }

  /**
   * Shared handling for the end of a stream: ignored when aborted or unavailable, restarted
   * on UNKNOWN / CANCELLED, logged otherwise.
   */
  private handleStreamStatus(name: string, signal: AbortSignal, st: StatusObject, restart: () => void): void {
    if (signal.aborted || st.code === status.OK || st.code === status.UNAVAILABLE) return;
    if (st.code === status.UNKNOWN || st.code === status.CANCELLED) {
      this.logger?.debug(`Unknown RpcError. Restarting ${name}.`);
      restart();
      return;
    }
    this.logger?.error(`${name} failed: ${st.details}`);
  }

  /** Cancels `call` when `signal` aborts; returns a function that removes the hook. */
  private cancelOnAbort(signal: AbortSignal, call: { cancel(): void }): () => void {
    const onAbort = () => call.cancel();
    signal.addEventListener("abort", onAbort, { once: true });
    return () => signal.removeEventListener("abort", onAbort);
  }

  private openReceiveUserChanges(signal: AbortSignal): void {
    if (signal.aborted) return;
    const client = this.connectedClient();
    const call: ClientReadableStream<UmbraClientInfoMessage> = client.receiveClientChanges(GetRequest.fromPartial({}), this.dataProvider.hostMetadata);
    const unhook = this.cancelOnAbort(signal, call);

    call.on("data", (resp: UmbraClientInfoMessage) => {
      let login: boolean | undefined;
      if (resp.login !== undefined) {
        if (!resp.login) {
          this.logger?.debug("Strange User Info call. Reason is Login, but Login is false???. Ignoring.");
          return;
        }
        login = true;
      } else if (resp.logoff !== undefined) {
        if (resp.logoff === ELogoffReason.ELogoffReason_Unknown) {
          this.logger?.debug("Strange User Info call. Reason is Logoff, but value is unknown???. Ignoring.");
          return;
        }
        login = false;
      }

      const info = resp.client?.clientInfo;
      if (!info) {
        this.logger?.debug("Strange User Info call. No User provided. Ignoring.");
        return;
      }

      this.emit("umbraUserChanged", new ClientEventArgs(info, login));
    });
    call.on("error", () => {
      /* handled in status */
    });
    call.on("status", (st: StatusObject) => {
      unhook();
      this.handleStreamStatus("ReceiveUserChanges", signal, st, () => this.openReceiveUserChanges(signal));
    });
  }

  private openPing(signal: AbortSignal, retryOnDisconnect = false): void {
    if (signal.aborted) return;
    const client = this.connectedClient();
    const call: ClientDuplexStream<PingPong, PingPong> = client.ping(this.dataProvider.hostMetadata);
    const unhook = this.cancelOnAbort(signal, call);
    let counter = 0;
    let closed = false;

    const sendPing = () => {
      if (closed) return;
      call.write(PingPong.fromPartial({ requestCounter: ++counter, clientname: this.dataProvider.clientname }));
    };
    sendPing();
    const timer = setInterval(sendPing, PING_INTERVAL_MS);

    call.on("data", (pong: PingPong) => {
      // a successful exchange: the next failure gets a retry again
      retryOnDisconnect = false;
      const n = this.dataProvider.clientname;
      if (pong.clientname !== n && !closed) {
        pong.responder = n;
        call.write(pong);
      }
    });
    call.on("error", () => {
      /* handled in status */
    });
    call.on("status", (st: StatusObject) => {
      closed = true;
      clearInterval(timer);
      unhook();
      if (signal.aborted) return;

      if (retryOnDisconnect) {
        this.logger?.warn("Connection to Umbra lost.");
        this.emit("connectionLost");
        return;
      }

      switch (st.code) {
        case status.UNAVAILABLE:
        case status.UNAUTHENTICATED:
          this.logger?.info("Ping unavailable, maybe connection to Umbra lost?");
          break;
        case status.UNKNOWN:
        case status.CANCELLED:
        case status.OK:
          this.logger?.debug("Unknown RpcError. Restarting Ping.");
          break;
        default:
          this.logger?.error(`Ping failed: ${st.details}`);
          break;
      }
      this.openPing(signal, true);
    });
  }

  private flushBroadcasts(): void {
    const q = this.broadcastQueue;
    const call = this.broadcastCall;
    if (!q || !call) return;
    while (q.length > 0) call.write(q.shift()!);
  }

  private openBroadcast(signal: AbortSignal, reconnect = false): void {
    if (signal.aborted) return;
    const client = this.connectedClient();
    const call: ClientDuplexStream<BroadcastMessage, BroadcastMessage> = client.sendBroadcast(this.dataProvider.hostMetadata);
    const unhook = this.cancelOnAbort(signal, call);

    // on reconnect, take over the messages that were not sent yet
    const queue: BroadcastMessage[] = reconnect && this.broadcastQueue ? this.broadcastQueue : [];
    this.broadcastQueue = queue;
    this.broadcastCall = call;
    this.flushBroadcasts();

    call.on("data", (bc: BroadcastMessage) => this.emit("broadcastReceived", { message: bc }));
    call.on("error", () => {
      /* handled in status */
    });
    call.on("status", (st: StatusObject) => {
      unhook();
      if (this.broadcastCall === call) {
        this.broadcastCall = undefined;
        this.broadcastQueue = undefined;
      }
      this.handleStreamStatus("Broadcast", signal, st, () => {
        this.broadcastQueue = queue;
        this.openBroadcast(signal, true);
      });
    });
  }

  private openControlClient(signal: AbortSignal): void {
    if (signal.aborted) return;
    const client = this.connectedClient();
    const call: ClientDuplexStream<ConfirmedResponse, ClientControlRequest> = client.processClientControls(this.dataProvider.hostMetadata);
    const unhook = this.cancelOnAbort(signal, call);
    let closed = false;

    call.on("data", async (req: ClientControlRequest) => {
      const args = new ClientControlEventArgs(req);
      const handlers = this.listeners("clientControlRequestReceived");
      const all = Promise.all(handlers.map((h) => Promise.resolve().then(() => h(args)).catch(() => undefined)));

      let timer: NodeJS.Timeout | undefined;
      const timeout = await Promise.race([
        all.then(() => false),
        new Promise<boolean>((r) => (timer = setTimeout(() => r(true), CLIENT_CONTROL_TIMEOUT_MS))),
      ]);
      clearTimeout(timer);

      const resp = ConfirmedResponse.fromPartial({
        requestId: req.requestId,
        message: timeout ? _("Timeout") : args.processed ? _(args.message ?? "") : _("Not processed"),
        ok: !timeout && args.processed && args.ok,
      });
      if (!closed) call.write(resp);
    });
    call.on("error", () => {
      /* handled in status */
    });
    call.on("status", (st: StatusObject) => {
      closed = true;
      unhook();
      this.handleStreamStatus("ControlClient", signal, st, () => this.openControlClient(signal));
    });
  }

  /** The clients currently connected to Umbra (empty on failure). */
  async getUmbraUsers(): Promise<ClientInfo[]> {
    const client = this.makeClient(DMXCNetServiceClient);
    try {
      const res = await unary(client.getUmbraNetworkInfo.bind(client), GetRequest.fromPartial({}), this.dataProvider.hostMetadata);
      return res.connectedClients.map((c) => c.clientInfo).filter((c): c is ClientInfo => c !== undefined);
    } catch (e) {
      this.logger?.error(errorMessage(e), e);
      return [];
    }
  }

  async getClientProgramInfo(runtimeId: string): Promise<ClientProgramInfo | undefined> {
    const client = this.connectedClient();
    try {
      const x = await unary(client.getClientProgramInfo.bind(client), GetRequest.fromPartial({ requestId: runtimeId }), this.dataProvider.hostMetadata);
      return x.info;
    } catch {
      return undefined;
    }
  }

  /**
   * Handles an Umbra discovery broadcast: informs that Umbra that this client exists (passing
   * any network property requests it returns to `processRequests`) and, if this client is not
   * connected yet and the network IDs match, calls `autoconnectFunction` for each Umbra IP
   * until one succeeds.
   *
   * @param localIPs the local IP addresses including loopback; if they equal the Umbra's IPs,
   *                 localhost is tried first.
   */
  async processDiscoveryBroadcast(
    args: UmbraDiscoveryBroadcastEventArgs,
    processRequests: ((requests: SetNetworkPropertyRequest[]) => void) | undefined,
    autoconnectFunction: ((host: string, port: number) => Promise<EAutoconnectResult>) | undefined,
    localIPs: readonly string[],
  ): Promise<void> {
    const dgram = args.broadcast;
    const remoteEndpoint = args.endPoint;

    const umbra = dgram.umbraServer?.clientInfo;
    if (!umbra) return;

    const LOOPBACK = "127.0.0.1";

    const doTryAllIPs = async <T>(action: (host: string, port: number) => Promise<[boolean | undefined, T | undefined]>): Promise<T | undefined> => {
      let targetUmbra = remoteEndpoint.address;
      const toTry = new Set(umbra.ips);
      const local = new Set(localIPs);
      const sameIPs = toTry.size === local.size && [...toTry].every((ip) => local.has(ip));
      if (sameIPs && toTry.has(LOOPBACK)) {
        // same IPs mean running on the same computer, therefore trying localhost first
        if (this.autoConnectionInProgress) this.logger?.info(`Same IP Addresses detected [${umbra.ips.join(", ")}], prefering Localhost to connect first`);
        targetUmbra = LOOPBACK;
      }

      let done: boolean | undefined;
      let result: T | undefined;
      if (toTry.delete(targetUmbra)) {
        [done, result] = await action(targetUmbra, umbra.umbraPort);
      } else {
        this.logger?.warn(`Received Umbra Broadcast from IP ${remoteEndpoint.address}, using IP ${targetUmbra} but that is not listed in Umbra IPs: [${umbra.ips.join(", ")}]`);
      }

      for (const ip of toTry) {
        if (done !== undefined) break;
        [done, result] = await action(ip, umbra.umbraPort);
      }

      if (done === undefined) this.logger?.warn(`Unable to contact any of the Umbra ${umbra.clientname} IPs: [${umbra.ips.join(", ")}]`);

      return result;
    };

    const informUmbraAskForActions = async (targetUmbra: string, port: number): Promise<[boolean | undefined, ClientInfo | undefined]> => {
      let channel: ChannelInterface | undefined;
      try {
        channel = this.dataProvider.createChannel(targetUmbra, port);
        const client = this.makeClient(DMXCNetServiceClient, channel);
        const a = InformClientExistsRequest.fromPartial({ info: this.dataProvider.clientProgramInfo });
        const res = await unary(client.informClientExists.bind(client), a, this.dataProvider.hostMetadata);
        if (res.requests.length > 0) processRequests?.(res.requests);
        return [true, res.umbra?.clientInfo];
      } catch (e) {
        if (isServiceError(e)) {
          switch (e.code) {
            case status.DEADLINE_EXCEEDED:
              this.logger?.debug(`Timeout when connecting to Umbra ${umbra.clientname} @ ${targetUmbra}`);
              break;
            case status.UNAVAILABLE:
              this.logger?.info(`Unable to connect to Umbra ${umbra.clientname} @ ${targetUmbra}`);
              break;
            case status.CANCELLED:
              break;
            default:
              this.logger?.debug(`Unable to inform Source Umbra ${umbra.clientname} @ ${targetUmbra}...`, e);
          }
        } else {
          this.logger?.debug(`Unable to inform Source Umbra ${umbra.clientname} @ ${targetUmbra}...`, e);
        }
      } finally {
        channel?.close();
      }
      return [undefined, undefined];
    };

    const doAutoconnect = async (targetUmbra: string): Promise<[boolean | undefined, undefined]> => {
      try {
        const erg = await autoconnectFunction!(targetUmbra, umbra.umbraPort);
        switch (erg) {
          case EAutoconnectResult.OK:
            return [true, undefined];
          case EAutoconnectResult.NotReady:
            return [false, undefined];
        }
      } catch (e) {
        if (e instanceof LoginException) this.logger?.error(`Unable to Login to Umbra Server: ${e.message}`);
        else if (e instanceof Error && e.name === "AbortError") this.logger?.warn("Connect Request cancelled");
        else this.logger?.error(`Exception when connecting to Umbra Server: ${errorMessage(e)}`);
      }
      return [undefined, undefined];
    };

    const clientInfo = await doTryAllIPs(informUmbraAskForActions);

    // are we already connected?
    if (this._sessionID) {
      if (umbra.runtimeid === this._connectedToUmbra?.clientInfo?.runtimeid) this._connectedToUmbra = dgram.umbraServer;
      return;
    }

    if (!autoconnectFunction) return;

    const nid = this.dataProvider.networkID;
    const unid = umbra.networkid.trim() === "" ? clientInfo?.networkid : umbra.networkid;

    if (nid === unid && !this.autoConnectionInProgress) {
      try {
        this.autoConnectionInProgress = true;
        await doTryAllIPs(doAutoconnect);
      } finally {
        this.autoConnectionInProgress = false;
      }
    }
  }
}
