import { CallOptions, Channel, ClientError, createChannel, createClient, Metadata, Status } from "nice-grpc-web";

/** A nice-grpc-web transport, e.g. `FetchTransport()` (the default) or `NodeHttpTransport()`. */
export type Transport = Channel["transport"];
import { ConfirmedResponse } from "../Common/Types/CommonTypes.js";
import {
  ClientControlRequest,
  ClientInfo,
  ClientProgramInfo,
  ELogoffReason,
  ReadyToWorkState,
  UmbraClientInfoMessage,
  UmbraLoginResponse,
  UmbraLoginResponse_EReturnCode,
} from "../Common/Types/UmbraServiceTypes.js";
import {
  ClientServiceClient,
  ClientServiceDefinition,
  ConnectedClientServiceClient,
  ConnectedClientServiceDefinition,
  DMXCNetServiceClient,
  DMXCNetServiceDefinition,
} from "../Common/UmbraClientService.js";
import { Logger } from "../shared/Logger.js";
import { NetConstants } from "../shared/NetConstants.js";
import { containsNonAsciiCharacters } from "../shared/ProtobufTools.js";
import { Emitter } from "./Emitter.js";

const CALL_TIMEOUT_MS = 3000;
const PING_INTERVAL_MS = 5000;
/** Delay before a failed stream is reopened, so a persistent error cannot spin the browser. */
const STREAM_RESTART_DELAY_MS = 1000;

/**
 * Header Umbra expects the session ID from the login in, on every call after the login
 * (otherwise it answers INVALID_ARGUMENT "SessionID missing in Headers").
 */
export const SESSION_ID_HEADER = "sessionid";

/** Supplies everything the connection client needs to talk to Umbra. */
export interface IConnectionClientData {
  /** gRPC-Web channel to the Umbra server, see {@link createUmbraChannel}. */
  readonly umbraChannel: Channel;
  /**
   * Metadata sent with every call. After the login, the client adds the session ID
   * ({@link SESSION_ID_HEADER}) unless this metadata already contains one.
   */
  readonly hostMetadata: Metadata;
  readonly clientProgramInfo: ClientProgramInfo;
  readonly clientname: string;
}

/**
 * Creates a gRPC-Web channel to an Umbra server. `transport` defaults to nice-grpc-web's
 * fetch based transport.
 */
export function createUmbraChannel(host: string, port: number = NetConstants.UMBRA_LISTEN_PORT, secure = false, transport?: Transport): Channel {
  const h = host.includes(":") && !host.startsWith("[") ? `[${host}]` : host; // IPv6
  return createChannel(`${secure ? "https" : "http"}://${h}:${port}`, transport);
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

export interface UmbraConnectionClientEvents {
  umbraUserChanged: [ClientEventArgs];
  connectionLost: [];
}

function errorMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

function isAbortError(e: unknown): boolean {
  return e instanceof Error && e.name === "AbortError";
}

function abortError(): Error {
  const e = new Error("The operation was aborted");
  e.name = "AbortError";
  return e;
}

/**
 * nice-grpc-web reports a failed fetch (server down, CORS rejected, ...) as UNKNOWN with
 * "Transport error" details; grpc-js reports the same situation as UNAVAILABLE.
 */
function isUnavailable(e: unknown): boolean {
  if (!(e instanceof ClientError)) return false;
  return e.code === Status.UNAVAILABLE || (e.code === Status.UNKNOWN && e.details.startsWith("Transport error"));
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    const t = setTimeout(done, ms);
    signal.addEventListener("abort", done, { once: true });
    function done() {
      clearTimeout(t);
      signal.removeEventListener("abort", done);
      resolve();
    }
  });
}

/**
 * Connects a client to an Umbra server over gRPC-Web: logs in, keeps the mandatory ping
 * alive (via `PingUnary`) and emits client change notifications.
 *
 * Compared to the Node package, broadcasts, client control requests (both bidirectional
 * streams) and UDP discovery are not available, because browsers support neither.
 */
export class UmbraConnectionClient extends Emitter<UmbraConnectionClientEvents> {
  logger?: Logger;
  dataProvider!: IConnectionClientData;

  private _sessionID: string | undefined;
  private _connectedToUmbra: ClientProgramInfo | undefined;
  private abortController: AbortController | undefined;

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

  private clientService(): ClientServiceClient {
    return createClient(ClientServiceDefinition, this.dataProvider.umbraChannel);
  }

  private connectedClient(): ConnectedClientServiceClient {
    return createClient(ConnectedClientServiceDefinition, this.dataProvider.umbraChannel);
  }

  private netClient(): DMXCNetServiceClient {
    return createClient(DMXCNetServiceDefinition, this.dataProvider.umbraChannel);
  }

  /** The host metadata plus the session ID once logged in. Use it for your own calls to Umbra. */
  callMetadata(): Metadata {
    const md = Metadata(this.dataProvider.hostMetadata);
    if (this._sessionID && !md.has(SESSION_ID_HEADER)) md.set(SESSION_ID_HEADER, this._sessionID);
    return md;
  }

  /** Runs a unary call with the call metadata, a 3 s deadline and an optional abort signal. */
  private async unary<Res>(name: string, fn: (options: CallOptions) => Promise<Res>, signal?: AbortSignal, timeoutMs = CALL_TIMEOUT_MS): Promise<Res> {
    if (signal?.aborted) throw abortError();
    const controller = new AbortController();
    const onAbort = () => controller.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      controller.abort();
    }, timeoutMs);
    try {
      return await fn({ metadata: this.callMetadata(), signal: controller.signal });
    } catch (e) {
      if (timedOut) throw new ClientError(name, Status.DEADLINE_EXCEEDED, "Deadline exceeded");
      throw signal?.aborted ? abortError() : e;
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }

  /** Logs in to Umbra. Throws {@link LoginException} if the login fails. */
  async connect(openConnections = true, signal?: AbortSignal): Promise<UmbraLoginResponse> {
    const client = this.clientService();
    const start = Date.now();
    let response: UmbraLoginResponse;
    try {
      response = await this.unary("Login", (o) => client.login({ client: this.dataProvider.clientProgramInfo }, o), signal);
    } catch (e) {
      if (e instanceof ClientError) {
        const code = e.code === Status.PERMISSION_DENIED ? UmbraLoginResponse_EReturnCode.AccessDenied : UmbraLoginResponse_EReturnCode.Error;
        throw new LoginException(e.details, code, undefined);
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
    try {
      await this.unary("ReportReadyToWork", (o) => client.reportReadyToWork({ state }, o));
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
      return await this.unary("ControlClient", (o) => client.controlClient(request, o));
    } catch (e) {
      this.logger?.debug("sendClientControlRequest", e);
      return undefined;
    }
  }

  /** Logs off from Umbra and stops the ping and the client change stream. */
  async disconnect(): Promise<void> {
    if (this._sessionID !== undefined) {
      const client = this.clientService();
      try {
        const response = await this.unary("Logoff", (o) => client.logoff({ client: this.dataProvider.clientProgramInfo }, o));
        this.logger?.info(`Disconnected from Umbra Server: ${response.bye}`);
      } catch (e) {
        this.logger?.debug(`Unable to logoff: ${errorMessage(e)}`, e);
      }
    }

    this._sessionID = undefined;
    this._connectedToUmbra = undefined;

    this.abortController?.abort();
    this.abortController = undefined;
  }

  /** Starts the ping and opens the client change stream. */
  openConnectionsAfterConnect(signal?: AbortSignal): void {
    this.abortController?.abort();
    const controller = new AbortController();
    this.abortController = controller;
    if (signal) {
      if (signal.aborted) controller.abort();
      else signal.addEventListener("abort", () => controller.abort(), { once: true });
    }
    const s = controller.signal;

    void this.runPing(s);
    void this.runReceiveUserChanges(s);
  }

  /**
   * Pings Umbra every 5 s with `PingUnary` (the alternative to the bidirectional `Ping`
   * stream for gRPC-Web clients). A failed ping is retried once right away; if that fails
   * too, `connectionLost` is emitted and pinging stops, like the Node package does.
   */
  private async runPing(signal: AbortSignal): Promise<void> {
    const client = this.connectedClient();
    let counter = 0;
    let retry = false;
    while (!signal.aborted) {
      try {
        await this.unary("PingUnary", (o) => client.pingUnary({ requestCounter: ++counter, clientname: this.dataProvider.clientname }, o), signal);
        retry = false;
      } catch (e) {
        if (signal.aborted) return;
        if (retry) {
          this.logger?.warn("Connection to Umbra lost.");
          this.emit("connectionLost");
          return;
        }
        if (isUnavailable(e) || (e instanceof ClientError && e.code === Status.UNAUTHENTICATED)) this.logger?.info("Ping unavailable, maybe connection to Umbra lost?");
        else this.logger?.error(`Ping failed: ${errorMessage(e)}`);
        retry = true;
        continue;
      }
      await delay(PING_INTERVAL_MS, signal);
    }
  }

  /**
   * Receives client change notifications (a server stream, which gRPC-Web supports).
   * The stream ends quietly when aborted, closed by the server or unavailable, is reopened
   * on UNKNOWN / CANCELLED and logged otherwise.
   */
  private async runReceiveUserChanges(signal: AbortSignal): Promise<void> {
    const client = this.connectedClient();
    while (!signal.aborted) {
      try {
        const stream = client.receiveClientChanges({}, { metadata: this.callMetadata(), signal });
        for await (const resp of stream) this.handleClientChange(resp);
        return;
      } catch (e) {
        if (signal.aborted || isAbortError(e) || isUnavailable(e)) return;
        if (e instanceof ClientError && (e.code === Status.UNKNOWN || e.code === Status.CANCELLED)) {
          this.logger?.debug("Unknown RpcError. Restarting ReceiveUserChanges.");
          await delay(STREAM_RESTART_DELAY_MS, signal);
          continue;
        }
        this.logger?.error(`ReceiveUserChanges failed: ${errorMessage(e)}`);
        return;
      }
    }
  }

  private handleClientChange(resp: UmbraClientInfoMessage): void {
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
  }

  /** The clients currently connected to Umbra (empty on failure). */
  async getUmbraUsers(): Promise<ClientInfo[]> {
    const client = this.netClient();
    try {
      const res = await this.unary("GetUmbraNetworkInfo", (o) => client.getUmbraNetworkInfo({}, o));
      return res.connectedClients.map((c) => c.clientInfo).filter((c): c is ClientInfo => c !== undefined);
    } catch (e) {
      this.logger?.error(errorMessage(e), e);
      return [];
    }
  }

  async getClientProgramInfo(runtimeId: string): Promise<ClientProgramInfo | undefined> {
    const client = this.connectedClient();
    try {
      const x = await this.unary("GetClientProgramInfo", (o) => client.getClientProgramInfo({ requestId: runtimeId }, o));
      return x.info;
    } catch {
      return undefined;
    }
  }
}
