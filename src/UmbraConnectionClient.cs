using System;
using System.Collections.Concurrent;
using System.Collections.Generic;
using System.Diagnostics;
using System.Linq;
using System.Net;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Grpc.Core;
using log4net;
using log4net.Core;
using LumosProtobuf.Udp;
using UmbraCommon;
using T = LumosProtobuf.I18N.TranslatableDataBuilder;

namespace LumosProtobuf.ConnectionClient
{
    public class UmbraConnectionClient
    {
        public event EventHandler<ClientEventArgs> UmbraUserChanged;
        public event EventHandler<BroadcastEventArgs> BroadcastReceived;
        public event EventHandler<ClientControlEventArgs> ClientControlRequestReceived;
        public event EventHandler<EventArgs> ConnectionLost;

        private CancellationTokenSource _cancellationTokenSource;
        private BlockingCollection<BroadcastMessage> _broadcastQueue;

        public ILog Logger { get; set; }

        public string SessionID { get; private set; } 

        public ClientProgramInfo ConnectedToUmbra { get; private set; }

        public UmbraConnectionClient()
        {
        }

        public IConnectionClientData DataProvider { get; set; }

        public async Task<UmbraLoginResponse> connectAsync(bool openConnections = true, CancellationToken token = default(CancellationToken))
        {
            var client = new ClientService.ClientServiceClient(DataProvider.UmbraChannel);
            var request = new UmbraLoginRequest()
            {
                Client = DataProvider.ClientProgramInfo
            };
            var sw = Stopwatch.StartNew();
            UmbraLoginResponse response;
            try
            {
                using (var comp = CancellationTokenSource.CreateLinkedTokenSource(token))
                {
                    comp.CancelAfter(3000);

                    response = await client.LoginAsync(request, DataProvider.HostMetadata, cancellationToken: comp.Token);

                    if (response.SessionId.ContainsNonAsciiCharacters(true))
                        throw new LoginException("Invalid SessionID", UmbraLoginResponse.Types.EReturnCode.Error, response.SessionId);

                    switch (response.ReturnCode)
                    {
                        case UmbraLoginResponse.Types.EReturnCode.NoError:
                        case UmbraLoginResponse.Types.EReturnCode.AlreadyLoggedIn: break;

                        default:
                            throw new LoginException(response.Message, response.ReturnCode, response.SessionId);
                    }

                    SessionID = response.SessionId;
                    ConnectedToUmbra = response.UmbraServer;
                }
            }
            catch (RpcException e)
            {
                switch (e.StatusCode)
                {
                    case StatusCode.PermissionDenied:
                        throw new LoginException(e.Message, UmbraLoginResponse.Types.EReturnCode.AccessDenied, null);
                    default:
                        throw new LoginException(e.Message, UmbraLoginResponse.Types.EReturnCode.Error, null);
                }
            }
            finally
            {
                sw.Stop();
                Logger?.DebugFormat("Login Call: {0} ms", sw.ElapsedMilliseconds);
            }

            if (openConnections)
                OpenConnectionsAfterConnect(token);

            return response;
        }

        public async Task ReportReadyToWorkAsync(ReadyToWorkState state)
        {
            var client = new ConnectedClientService.ConnectedClientServiceClient(DataProvider.UmbraChannel);
            var request = new UmbraClientReadyToWorkNotification()
            {
                State = state,
            };
            try
            {
                using (var cts = new CancellationTokenSource(3000))
                {
                    var response = await client.ReportReadyToWorkAsync(request, DataProvider.HostMetadata, cancellationToken: cts.Token);
                }
            }
            catch (Exception e)
            {
                Logger?.Debug(nameof(ReportReadyToWorkAsync), e);
            }
        }

        public async Task<ConfirmedResponse> SendClientControlRequest(ClientControlRequest request)
        {
            if (String.IsNullOrEmpty(request?.ControlClientRuntimeId)) return null;

            var cinfo = DataProvider.ClientProgramInfo.ClientInfo;

            if (request.ControlClientRuntimeId == cinfo.Runtimeid)
                throw new InvalidOperationException();

            request.Source = cinfo;

            var client = new ConnectedClientService.ConnectedClientServiceClient(DataProvider.UmbraChannel);
            try
            {
                using (var cts = new CancellationTokenSource(3000))
                {
                    var response = await client.ControlClientAsync(request, DataProvider.HostMetadata, cancellationToken: cts.Token);
                    return response;
                }
            }
            catch (Exception e)
            {
                Logger?.Debug(nameof(SendClientControlRequest), e);
                return null;
            }
        }

        public void Disconnect()
        {
            if (SessionID != null)
            {
                var client = new ClientService.ClientServiceClient(DataProvider.UmbraChannel);
                var request = new UmbraLogoffRequest()
                {
                    SessionId = SessionID,
                    Client = DataProvider.ClientProgramInfo
                };
                try
                {
                    var response = client.Logoff(request);
                    Logger?.InfoFormat("Disconnected from Umbra Server: {0}", response.Bye);
                }
                catch (Exception e)
                {
                    Logger?.Debug($"Unable to logoff: {e.Message}", e);
                }
            }

            SessionID = null;
            ConnectedToUmbra = null;

            _cancellationTokenSource?.Cancel();
        }

        public bool SendBroadcast(BroadcastMessage m)
        {
            if (m == null || _broadcastQueue == null || _broadcastQueue.IsAddingCompleted) return false;

            _broadcastQueue.Add(m);
            return true;
        }

        public void OpenConnectionsAfterConnect(CancellationToken connectionToken)
        {
            _cancellationTokenSource = CancellationTokenSource.CreateLinkedTokenSource(connectionToken);
            var token = _cancellationTokenSource.Token;

            var sw = Stopwatch.StartNew();

            OpenPing(token);

            OpenReceiveUserChanges(token);

            OpenBroadcast(token);

            OpenControlClient(token);

            sw.Stop();
            Logger?.DebugFormat("OpenConnectionsAfterConnect: {0} ms", sw.ElapsedMilliseconds);
        }

        private void OpenReceiveUserChanges(CancellationToken token)
        {
            var client = new ConnectedClientService.ConnectedClientServiceClient(DataProvider.UmbraChannel);

            var call = client.ReceiveClientChanges(new GetRequest(), DataProvider.HostMetadata);
            
            Task.Run(async () =>
            {
                try
                {
                    while (await call.ResponseStream.MoveNext(token))
                    {
                        var resp = call.ResponseStream.Current;
                        bool? login = null;
                        switch (resp.ReasonCase)
                        {
                            default:
                            case UmbraClientInfoMessage.ReasonOneofCase.None:
                                break;
                            case UmbraClientInfoMessage.ReasonOneofCase.Login:
                                if (!resp.Login)
                                {
                                    Logger?.Debug("Strange User Info call. Reason is Login, but Login is false???. Ignoring.");
                                    continue;
                                }
                                login = true;
                                goto default;
                            case UmbraClientInfoMessage.ReasonOneofCase.Logoff:
                                if (resp.Logoff == ELogoffReason.Unknown)
                                {
                                    Logger?.Debug("Strange User Info call. Reason is Logoff, but value is unknown???. Ignoring.");
                                    continue;
                                }
                                login = false;
                                goto default;
                        }

                        if (resp.Client?.ClientInfo == null) //Strange....
                        {
                            Logger?.Debug("Strange User Info call. No User provided. Ignoring.");
                            continue;
                        }

                        var args = new ClientEventArgs(resp.Client?.ClientInfo, login);
                        UmbraUserChanged?.Invoke(this, args);
                    }
                }
                catch (OperationCanceledException)
                {
                }
                catch (RpcException e) when (token.IsCancellationRequested || e.StatusCode == StatusCode.Unavailable)
                {
                }
                catch (RpcException e) when (e.StatusCode == StatusCode.Unknown || e.StatusCode == StatusCode.Cancelled)
                {
                    //Restart Stream
                    Logger?.Debug($"Unknown RpcError. Restarting {nameof(OpenReceiveUserChanges)}.", e);
                    call?.Dispose();
                    OpenReceiveUserChanges(token);
                }
                catch (Exception e)
                {
                    Logger?.Error($"ReceiveUserChanges Listener failed: {e.Message}", e);
                }
            });
        }

        private void OpenPing(CancellationToken token, bool retryOnDisconnect = false)
        {
            var client = new ConnectedClientService.ConnectedClientServiceClient(DataProvider.UmbraChannel);

            var pingpong = client.Ping(DataProvider.HostMetadata);
            var locker = new SemaphoreSlim(1);

            long counter = 0;
            Task.Run(async () =>
            {
                try
                {
                    while (!token.IsCancellationRequested && pingpong != null)
                    {
                        var ping = new PingPong
                        {
                            RequestCounter = Interlocked.Increment(ref counter),
                            Clientname = DataProvider.Clientname
                        };
                        await locker.WaitAsync(token);
                        try
                        {
                            var t = pingpong?.RequestStream.WriteAsync(ping);
                            if (t != null)
                                await t;
                        }
                        finally
                        {
                            locker.Release();
                        }

                        await Task.Delay(5000, token);
                    }
                }
                catch (Exception) when (token.IsCancellationRequested)
                {
                    /*Break here*/
                }
                catch (Exception) when (retryOnDisconnect)
                {
                    Logger?.Warn("Connection to Umbra lost.");
                    ConnectionLost?.Invoke(this, EventArgs.Empty);
                }
                catch (OperationCanceledException)
                {
                }
                catch (Exception ex)
                {
                    switch (ex)
                    {
                        case RpcException e when e.StatusCode == StatusCode.Unavailable || e.StatusCode == StatusCode.Unauthenticated:
                            Logger?.Info("Ping unavailable, maybe connection to Umbra lost?");
                            break;
                        case RpcException e when e.StatusCode == StatusCode.Unknown || e.StatusCode == StatusCode.Cancelled:
                            Logger?.Debug($"Unknown RpcError. Restarting {nameof(OpenPing)}.");
                            break;
                        default:
                            Logger?.Error($"Ping Sender failed: {ex.Message}", ex);
                            break;
                    }
                    if (pingpong != null)
                    {
                        var a = pingpong;
                        pingpong = null;
                        a?.Dispose();
                        OpenPing(token, true);
                    }
                }
                finally
                {
                    await locker.WaitAsync(); //No Token here!
                    try
                    {
                        var x = pingpong?.RequestStream.CompleteAsync();
                        if (x != null) await x;
                        pingpong = null;
                    }
                    finally
                    {
                        locker.Release();
                    }
                }
            });

            Task.Run(async () =>
            {
                try
                {
                    while (true)
                    {
                        var t = pingpong?.ResponseStream.MoveNext(token);
                        if (t == null || !await t) break;
                        
                        var pong = pingpong.ResponseStream.Current;
                        var n = DataProvider.Clientname;
                        if (pong.Clientname != n)
                        {
                            pong.Responder = n;
                            await locker.WaitAsync(token);
                            try
                            {
                                var t2 = pingpong?.RequestStream.WriteAsync(pong);
                                if (t2 != null)
                                    await t2;
                            }
                            finally
                            {
                                locker.Release();
                            }
                        }
                    }
                }
                catch (OperationCanceledException)
                {
                }
                catch (RpcException e) when (token.IsCancellationRequested || e.StatusCode == StatusCode.Unavailable)
                {
                }
                catch (RpcException e) when (e.StatusCode == StatusCode.Unknown || e.StatusCode == StatusCode.Cancelled)
                {
                    //Restart Stream
                    if (pingpong != null)
                    {
                        Logger?.Debug($"Unknown RpcError. Restarting {nameof(OpenPing)}.");
                        var a = pingpong;
                        pingpong = null;
                        a?.Dispose();
                        OpenPing(token);
                    }
                }
                catch (Exception e)
                {
                    Logger?.Error($"Ping Listener failed: {e.Message}", e);
                }
            });
        }

        private void OpenBroadcast(CancellationToken token, bool reconnect = false)
        {
            var client = new ConnectedClientService.ConnectedClientServiceClient(DataProvider.UmbraChannel);
            var broadcast = client.SendBroadcast(DataProvider.HostMetadata);
            var broadcastQueue = new BlockingCollection<BroadcastMessage>();

            var old = _broadcastQueue; 
            _broadcastQueue = broadcastQueue;
            while (reconnect && old != null && old.Count > 0)
            {
                //Takeover Elements from Last connection request
                broadcastQueue.Add(old.Take());
            }
            
            Task.Run(async () =>
            {
                try
                {
                    while (!broadcastQueue.IsCompleted)
                    {
                        while (broadcastQueue.TryTake(out var m, 10, token))
                        {
                            if (m != null)
                            {
                                var t = broadcast?.RequestStream.WriteAsync(m);
                                if (t != null)
                                    await t;
                            }
                        }
                        await Task.Delay(100, token);
                    }
                }
                catch (OperationCanceledException)
                {
                }
                catch (RpcException e) when (token.IsCancellationRequested || e.StatusCode == StatusCode.Unavailable)
                {
                }
                catch (RpcException e) when (e.StatusCode == StatusCode.Unknown || e.StatusCode == StatusCode.Cancelled)
                {
                    //Restart Stream
                    if (broadcast != null)
                    {
                        Logger?.Debug($"Unknown RpcError. Restarting {nameof(OpenBroadcast)}.");
                        var a = broadcast;
                        broadcast = null;
                        a?.Dispose();
                        OpenBroadcast(token, true);
                    }
                }
                catch (Exception e)
                {
                    Logger?.Error($"Broadcast Sender failed: {e.Message}", e);
                }
                finally
                {
                    var x = broadcast?.RequestStream.CompleteAsync();
                    if (x != null) await x;
                }
            });

            Task.Run(async () =>
            {
                try
                {
                    while (true)
                    {
                        var t = broadcast?.ResponseStream.MoveNext(token);
                        if (t == null || !await t) break;

                        var bc = broadcast.ResponseStream.Current;
                        BroadcastReceived?.Invoke(this, new BroadcastEventArgs(bc));
                    }
                }
                catch (OperationCanceledException)
                {
                }
                catch (RpcException e) when (token.IsCancellationRequested || e.StatusCode == StatusCode.Unavailable)
                {
                }
                catch (RpcException e) when (e.StatusCode == StatusCode.Unknown || e.StatusCode == StatusCode.Cancelled)
                {
                    //Restart Stream
                    if (broadcast != null)
                    {
                        Logger?.Debug($"Unknown RpcError. Restarting {nameof(OpenBroadcast)}.");
                        var a = broadcast;
                        broadcast = null;
                        a?.Dispose();
                        OpenBroadcast(token, true);
                    }
                }
                catch (Exception e)
                {
                    Logger?.Error($"Broadcast Listener failed: {e.Message}", e);
                }
                finally
                {
                    broadcastQueue.CompleteAdding();
                }
            });
        }

        private void OpenControlClient(CancellationToken token)
        {
            var client = new ConnectedClientService.ConnectedClientServiceClient(DataProvider.UmbraChannel);

            var clientControls = client.ProcessClientControls(DataProvider.HostMetadata);

            Task.Run(async () =>
            {
                try
                {
                    while (await clientControls.ResponseStream.MoveNext(token))
                    {
                        var req = clientControls.ResponseStream.Current;
                        var args = new ClientControlEventArgs(req);
                        var t = Task.Run(() => ClientControlRequestReceived?.Invoke(this, args));
                        var x = await Task.WhenAny(t, Task.Delay(500));
                        var timeout = !ReferenceEquals(x, t);

                        var resp = new ConfirmedResponse()
                        {
                            RequestId = req.RequestId,
                            Message =  timeout ? T._("Timeout") : 
                                args.Processed ? T._(args.Message ?? String.Empty) : T._("Not processed"),
                            Ok = !timeout && args.Processed && args.OK
                        };

                        await clientControls.RequestStream.WriteAsync(resp);
                    }
                }
                catch (OperationCanceledException)
                {
                }
                catch (RpcException e) when (token.IsCancellationRequested || e.StatusCode == StatusCode.Unavailable)
                {
                }
                catch (RpcException e) when (e.StatusCode == StatusCode.Unknown || e.StatusCode == StatusCode.Cancelled)
                {
                    //Restart Stream
                    Logger?.Debug($"Unknown RpcError. Restarting {nameof(OpenControlClient)}.");
                    clientControls?.Dispose();
                    clientControls = null;
                    OpenControlClient(token);
                }
                catch (Exception e)
                {
                    Logger?.Error($"ControlClient failed: {e.Message}", e);
                }
                finally
                {
                    var x = clientControls?.RequestStream.CompleteAsync();
                    if (x != null) await x;
                }
            });
        }

        public Task<IEnumerable<ClientInfo>> UmbraUsersAsync => GetUmbraUsersAsync();

        private async Task<IEnumerable<ClientInfo>> GetUmbraUsersAsync()
        {
            var client = new DMXCNetService.DMXCNetServiceClient(DataProvider.UmbraChannel);
            try
            {
                using (var cts = new CancellationTokenSource(3000))
                {
                    var res = await client.GetUmbraNetworkInfoAsync(new GetRequest(), DataProvider.HostMetadata, cancellationToken: cts.Token).ResponseAsync.ConfigureAwait(false);
                    return res.ConnectedClients.Select(c => c.ClientInfo);
                }
            }
            catch (Exception e)
            {
                Logger?.Error(String.Empty, e);
                return Enumerable.Empty<ClientInfo>();
            }
        }

        public async Task<ClientProgramInfo> GetClientProgramInfoAsync(string runtimeId)
        {
            var client = new ConnectedClientService.ConnectedClientServiceClient(DataProvider.UmbraChannel);
            try
            {
                using (var cts = new CancellationTokenSource(3000))
                {
                    var x = await client.GetClientProgramInfoAsync(new GetRequest() { RequestId = runtimeId }, DataProvider.HostMetadata, cancellationToken: cts.Token);
                    return x.Info;
                }
            }
            catch (Exception)
            {
                return null;
            }
        }

        private bool autoConnectionInProgress = false;

        public enum EAutoconnectResult
        {
            OK,
            Error,
            NotReady
        }

        public async Task ProcessDiscoveryBroadcast(UmbraDiscoveryBroadcastEventArgs args, Action<IEnumerable<SetNetworkPropertyRequest>> processRequests, Func<string, int, Task<EAutoconnectResult>> autoconnectFunction, IEnumerable<IPAddress> localIPs)
        {
            var dgram = args.Broadcast;
            var remoteEndpoint = args.EndPoint;

            var umbra = dgram.UmbraServer?.ClientInfo;
            if (umbra == null) return;

            var clientInfo = await DoTryAllIPs(InformUmbraAskForActions);

            //Are we already connected?
            if (!String.IsNullOrEmpty(SessionID))
            {
                if (Equals(umbra.Runtimeid, this.ConnectedToUmbra?.ClientInfo?.Runtimeid))
                {
                    if (!Equals(ConnectedToUmbra, dgram.UmbraServer))
                        ConnectedToUmbra = dgram.UmbraServer;
                }
                return;
            }

            if (autoconnectFunction == null) return;

            var nid = DataProvider.NetworkID;
            var unid = String.IsNullOrWhiteSpace(umbra.Networkid) ? clientInfo?.Networkid : umbra.Networkid;

            if (Equals(nid, unid) && !autoConnectionInProgress)
            {
                try
                {
                    autoConnectionInProgress = true;
                    await DoTryAllIPs(DoAutoconnect);
                }
                finally
                {
                    autoConnectionInProgress = false;
                }
            }

            //~~~~~~~~~~~~~~~~~~~ Local Functions ~~~~~~~~~~~~~~~~~~~

            async Task<T> DoTryAllIPs<T>(Func<string, int, Task<(bool?, T)>> action)
            {
                var targetUmbra = remoteEndpoint.Address.ToString();
                var toTry = new HashSet<string>(umbra.Ips);
                if (toTry.SetEquals(localIPs.Select(c => c.ToString())) && toTry.Contains(IPAddress.Loopback.ToString())) //Same IPs mean running on the same computer, therefore trying localhost first
                {
                    if (autoConnectionInProgress)
                        Logger?.InfoFormat("Same IP Addresses detected [{0}], prefering Localhost to connect first", String.Join(", ", umbra.Ips));
                    targetUmbra = IPAddress.Loopback.ToString();
                }

                bool? done = null;
                T result = default;
                if (toTry.Remove(targetUmbra))
                    (done, result) = await action(targetUmbra, umbra.UmbraPort);
                else
                    Logger?.WarnFormat("Received Umbra Broadcast from IP {0}, using IP {1} but that is not listed in Umbra IPs: [{2}]", remoteEndpoint.Address, targetUmbra, String.Join(", ", umbra.Ips));

                while (done == null && toTry.Count > 0)
                {
                    var ip = toTry.First();
                    toTry.Remove(ip);

                    (done, result) = await action(ip, umbra.UmbraPort);
                }

                if (done == null)
                    Logger?.WarnFormat("Unable to contact any of the Umbra {0} IPs: [{1}]", umbra.Clientname, String.Join(", ", umbra.Ips));

                return result;
            }


            async Task<(bool?, ClientInfo)> InformUmbraAskForActions(string targetUmbra, int port)
            {
                //Otherwise inform that we are here and read commands

                ChannelBase channel = null;
                try
                {
                    channel = DataProvider.CreateChannel(targetUmbra, port);
                    var client = new DMXCNetService.DMXCNetServiceClient(channel);
                    var a = new InformClientExistsRequest()
                    {
                        Info = DataProvider.ClientProgramInfo
                    };

                    using (var cts = new CancellationTokenSource(3000))
                    {
                        var res = await client.InformClientExistsAsync(a, DataProvider.HostMetadata, cancellationToken: cts.Token);
                        if (res.Requests.Count > 0)
                            processRequests?.Invoke(res.Requests);

                        return (true, res.Umbra?.ClientInfo);
                    }
                }
                catch (OperationCanceledException)
                {
                    Logger?.Debug($"Timeout when connecting to Umbra {umbra.Clientname} @ {targetUmbra}");
                }
                catch (RpcException e) when (e.StatusCode == StatusCode.Unavailable)
                {
                    Logger?.Info($"Unable to connect to Umbra {umbra.Clientname} @ {targetUmbra}");
                }
                catch (Exception e)
                {
                    Logger?.Warn($"Unable to inform Source Umbra {umbra.Clientname} @ {targetUmbra}...", e);
                }
                finally
                {
                    if (channel != null)
                        _ = Task.Run(() => channel.ShutdownAsync().ContinueWith(x => (channel as IDisposable)?.Dispose(), TaskContinuationOptions.ExecuteSynchronously));
                }

                return (null, null);
            }

            async Task<(bool?, object)> DoAutoconnect(string targetUmbra, int port)
            {
                try
                {
                    var erg = await autoconnectFunction(targetUmbra, umbra.UmbraPort);
                    switch (erg)
                    {
                        case EAutoconnectResult.OK: return (true, null);
                        case EAutoconnectResult.NotReady: return (false, null);
                    }
                }
                catch (LoginException e)
                {
                    Logger?.Error($"Unable to Login to Umbra Server: {e.Message}");
                }
                catch (OperationCanceledException)
                {
                    Logger?.Warn("Connect Request cancelled");
                }
                catch (Exception e)
                {
                    Logger?.Error($"Exception when connecting to Umbra Server: {e.Message}");
                }

                return (null, null);
            }
        }

        
    }

    public class ClientEventArgs : EventArgs
    {
        public readonly ClientInfo Client;

        private readonly bool? _login;

        public ClientEventArgs(ClientInfo client, bool? login = null)
        {
            this.Client = client;
            this._login = login;
        }

        public bool Login => _login == true;
        public bool Logoff => _login == false;
    }

    public class BroadcastEventArgs : EventArgs
    {
        public readonly BroadcastMessage Message;

        public BroadcastEventArgs(BroadcastMessage m)
        {
            this.Message = m;
        }
    }

    public class LoginException : Exception
    {
        public readonly UmbraLoginResponse.Types.EReturnCode ReturnCode;
        public readonly string SessionID;

        public LoginException(string message, UmbraLoginResponse.Types.EReturnCode returnCode, string sessionId) : base(message)
        {
            this.ReturnCode = returnCode;
            this.SessionID = sessionId;
        }
    }

    public class ClientControlEventArgs : EventArgs
    {
        public readonly ClientControlRequest Request;

        public ClientControlEventArgs(ClientControlRequest req)
        {
            this.Request = req;
        }

        public bool Processed { get; set; }

        public bool OK { get; set; }

        public string Message { get; set; }
    }
}
